// The runner's state machine: reading the terrain ahead, parkour moves over it, landings and rolls,
// and how far along the screen he's managed to get.
import { clamp, lerp, smooth, easeInOut, DEBUG, dispW, dispH, scrollV, runnerSize, gravity } from './core.js';
import { PW, minSurface, colOf, colX, colY } from './vision.js';
import { dust } from './effects.js';
import { POSE, AIR_HIP, airPose } from './poses.js';

// Fluid running gains ground on screen and costly moves lose it. Both are fractions of screen width,
// scaled by how fast the scenery moves, so a slow scene drifts less.
const GAIN = 0.05, ROLL_GAIN = 0.07;
const COST = { hop: 0.003, jump: 0.012, flip: 0.018, speed: 0.003, dive: 0.006, climb: 0.006, leap: 0.002, hard: 0.01 };

export const runner = {
  x: 0, y: 0, vy: 0, state: 'air', style: 'fall', move: '', t: 0, facing: 1, phase: 0,
  squash: 0, squashV: 0, brace: 0, rot: 0, spin: null, kicks: 0, under: 0, lastUnder: 0, scarf: [],
  debt: 0, flowT: 0, vFwd: 0, plan: null, act: null, climb: null, hold: false, force: null,
  // drawing state: eased pose, run-cycle blend, hip height (× size), IK weight for pinned hands
  pose: airPose(1), blend: 1, hipAlt: AIR_HIP, feetW: 0, pivot: [0, -0.12], ikW: 0, grip: null, lastGrip: null,
  look: { pose: airPose(1), blend: 1, hip: AIR_HIP },
  // visibility (see vanish.js): hidden until the ground can be trusted
  vis: 'hidden', alpha: 0, clipY: null, scarfFree: false, head: null,
  reset() {
    this.x = dispW * 0.3; this.y = -runnerSize(); this.vy = 0; this.facing = 1;
    this.state = 'air'; this.style = 'fall'; this.move = ''; this.t = 0;
    this.rot = 0; this.spin = null; this.squash = this.squashV = this.brace = 0; this.grip = null; this.scarf = [];
    this.debt = 0; this.flowT = 0; this.vFwd = 0; this.plan = this.act = this.climb = null;
    this.vis = 'hidden'; this.alpha = 0; this.clipY = null; this.scarfFree = false;
  },
  // The display changed size: keep him where he was, proportionally, and drop anything mid-move
  refit(sx, sy) {
    this.x *= sx; this.y *= sy; this.lastUnder *= sy; this.vy *= sy; this.debt = 0;
    this.plan = this.act = this.climb = this.grip = null; this.scarf = [];
    if (this.state === 'plant' || this.state === 'climb') { this.state = 'air'; this.style = 'fall'; this.rot = 0; }
  }
};

// ---------- Screen band ----------
// He may drift between `back` and `front`, measured forward from the trailing edge of the screen
function band() {
  const s = runnerSize(), back = Math.max(dispW * 0.12, s * 0.6);
  return { back, front: Math.max(back + s, dispW * 0.62) };
}
const fwdX = (x) => (runner.facing > 0 ? x : dispW - x);
export function leadRatio() { const b = band(); return clamp((fwdX(runner.x) - b.back) / (b.front - b.back), 0, 1); }
// Scenery speed toward his back (px/s), and a pace factor that scales screen gains and costs by it
const approach = () => Math.max(0, -scrollV * runner.facing);
const pace = () => clamp(approach() / (dispW * 0.2), 0, 1.5);
// Costs fade out near the back of the band, so he can't be pushed off screen by a run of jumps
function spend(frac) { runner.debt += frac * dispW * pace() * smooth(0, 0.35, leadRatio()); }

// Move forward along the screen by d px: never past the band's edges, but never snapped back into it either
function moveFwd(d) {
  const r = runner, b = band(), X0 = fwdX(r.x), slack = dispW * 0.03;
  const X = clamp(X0 + d, Math.min(b.back - slack, X0), Math.max(b.front + slack, X0));
  r.x = r.facing > 0 ? X : dispW - X;
  return X - X0;
}
function drift(dt) {
  const r = runner, b = band(), L = leadRatio(), X = fwdX(r.x);
  let v = 0;
  if (r.state === 'run' && !r.hold) {
    r.flowT += dt;
    v += GAIN * dispW * pace() * smooth(0.2, 1.4, r.flowT) * (1 - smooth(0.6, 1, L));
  } else if (r.state === 'roll') v += ROLL_GAIN * dispW * pace() * (1 - smooth(0.6, 1, L));
  // Soft walls (these also bring him back in after he turns around)
  if (X < b.back) v += (b.back - X) * 4; else if (X > b.front) v -= (X - b.front) * 4;
  const pay = r.debt * Math.min(1, dt * 5);
  r.debt -= pay;
  r.vFwd = moveFwd(v * dt - pay) / dt;
}

// ---------- Ballistics ----------
const vFor = (h) => Math.sqrt(2 * gravity() * Math.max(0, h));
const tApex = (h) => Math.sqrt(2 * Math.max(0, h) / gravity());
// Seconds after takeoff (apex height h) until the feet have risen dy
const tRise = (h, dy) => { const v = vFor(h); return (v - Math.sqrt(Math.max(0, v * v - 2 * gravity() * Math.min(dy, h)))) / gravity(); };
// Seconds until a jump of apex height h comes down to landY
function airTime(h, landY) {
  const g = gravity(), fall = Math.max(runnerSize() * 0.1, landY - (runner.y - h));
  return Math.sqrt(2 * h / g) + Math.sqrt(2 * fall / g);
}
// Apex height for an arc that covers `dist` at approach speed rel and comes down at landY
function arcFor(dist, rel, landY) {
  const g = gravity(), T = dist / rel, v0 = (runner.y - landY) / T + g * T / 2;
  return v0 > 0 ? v0 * v0 / (2 * g) : 0;
}

function takeoff(h, style) {
  const r = runner, s = runnerSize();
  h = clamp(h, s * 0.2, dispH * 0.6);
  h = Math.max(s * 0.2, Math.min(h, r.y - s * 1.35)); // keep the head on screen
  r.vy = -vFor(h);
  r.state = 'air'; r.style = style; r.t = 0; r.rot = 0; r.spin = null; r.grip = null; r.brace = 0;
  if (r.act) r.act.v0 = -r.vy;
  return h;
}
function flip(dur) { const r = runner; r.spin = { a0: 0, a1: r.facing * Math.PI * 2, t: 0, dur }; }

// Impact is judged by how far he effectively fell: small drops squash, mid drops brace a hand, big drops roll
function touchDown(y) {
  const r = runner, s = runnerSize(), g = gravity();
  const drop = r.vy > 0 ? r.vy * r.vy / (2 * g) / s : 0;
  r.y = y; r.vy = 0; r.kicks = 0; r.t = 0; r.act = null;
  dust(r.x, y, clamp((drop - 0.4) / 3, 0, 1));
  const midSpin = r.spin && r.spin.t < r.spin.dur * 0.8;
  // Rolling keeps momentum, so he's keener to roll when he's behind
  if (r.style === 'dive' || drop > 2.6 || (drop > 1.5 && Math.random() < 0.3 + 0.4 * (1 - leadRatio()))) { startRoll(drop, true); return; }
  if (midSpin) { startRoll(drop, false); return; }
  r.state = 'run'; r.style = 'run'; r.move = ''; r.spin = null; r.rot = 0;
  r.squashV += 3 + 11 * Math.min(drop, 2.2);
  if (drop > 1.1) {
    r.brace = 0.34; r.grip = { x: r.x + r.facing * s * 0.36, y, bend: -1, brace: true };
    spend(COST.hard * drop); r.flowT = 0;
  }
}
// Carry any flip that's still turning into the roll; a proper roll turns at least most of the way round,
// otherwise he just finishes the turn he's in
function startRoll(drop, fullTurn) {
  const r = runner, f = r.facing, full = Math.PI * 2;
  let to = f * full * (Math.floor(r.rot * f / full) + 1);
  if (fullTurn && (to - r.rot) * f < full * 0.6) to += f * full;
  const turns = (to - r.rot) * f / full;
  r.state = 'roll'; r.style = 'roll'; r.move = 'roll'; r.t = 0; r.grip = null; r.brace = 0;
  r.squash = r.squashV = 0;
  r.spin = { a0: r.rot, a1: to, t: 0, dur: (0.42 + 0.14 * clamp(drop / 5, 0, 1)) * turns };
}

// ---------- Reading the terrain ahead ----------
// The next thing to deal with: a rise (its front distance, top, width, and the level beyond it),
// or a drop (and, if it's a gap, how wide and where the far side is). Notches too narrow to matter are skipped.
function scanAhead() {
  const r = runner, s = runnerSize(), f = r.facing, y0 = r.y, stepH = s * 0.3, cw = dispW / PW;
  const inRange = (i) => i >= 0 && i < PW;
  const dist = (i) => (colX(i) - r.x) * f - cw * 0.5;
  for (let i = colOf(r.x + f * s * 0.16); inRange(i); i += f) {
    const y = colY(i);
    if (y < y0 - stepH) {
      let top = y, j = i + f, down = 0, back = -1;
      for (; inRange(j); j += f) {
        const yj = colY(j);
        if (yj > y0 - stepH * 0.5) { if (++down * cw >= s * 0.35) { back = j - f * (down - 1); break; } }
        else { down = 0; if (yj < top) top = yj; }
      }
      if (back < 0 && down > 0) back = j - f * down;
      const open = back < 0;
      return { kind: 'rise', d: dist(i), top, rise: y0 - top, width: open ? Infinity : (back - i) * f * cw, farY: open ? null : colY(back) };
    }
    if (y > y0 + s * 0.9) {
      let j = i, deep = y;
      for (; inRange(j) && colY(j) > y0 + s * 0.5; j += f) deep = Math.max(deep, colY(j));
      const w = (j - i) * f * cw;
      if (inRange(j) && w < s * 0.4) { i = j - f; continue; } // a notch he can run over
      return { kind: 'drop', d: dist(i), gap: inRange(j) ? w : Infinity, farY: inRange(j) ? colY(j) : null, deep };
    }
  }
  return null;
}

function pick(opts) {
  let sum = 0;
  for (const o of opts) sum += Math.max(0, o[1]);
  let x = Math.random() * sum;
  for (const o of opts) { x -= Math.max(0, o[1]); if (x <= 0 && o[1] > 0) return o[0]; }
  return opts[0][0];
}
const climbable = () => leadRatio() > 0.25 && approach() < dispW * 0.5;
const gapJumpable = (sc, rel) => sc.gap < Infinity && rel > runnerSize() && arcFor(sc.gap + runnerSize() * 0.4, rel, sc.farY) < runnerSize() * 2.2;

// Pick a move for what's ahead. Near the front of the band he shows off (flips, climbs, dive rolls),
// which costs ground; near the back he picks the efficient ones (kong vaults, rolls) to catch up.
// Debug: whether a forced move makes sense for what's ahead
function suits(move, sc) {
  const s = runnerSize();
  if (move === 'leap' || move === 'flip') return sc.kind === 'drop';
  if (sc.kind !== 'rise') return false;
  if (move === 'climb') return sc.rise > s * 1.1 && sc.rise < s * 2.8;
  return move === 'hop' ? sc.rise < s * 0.8 : sc.rise > s * 0.4 && sc.rise < s * 1.5;
}
function choose(sc, rel) {
  const s = runnerSize(), L = leadRatio();
  if (DEBUG && runner.force && suits(runner.force, sc)) return runner.force;
  if (sc.kind === 'drop') {
    if (gapJumpable(sc, rel)) return pick([['leap', 1], ['drop', 0.15]]);
    return pick([['drop', 0.9], ['leap', 0.8], ['flip', 0.15 + 0.6 * L]]);
  }
  const h = sc.rise / s, w = sc.width / s;
  if (h < 0.6) return pick([['hop', 1], ['speed', w < 1.5 ? 0.5 : 0]]);
  if (h < 1.6) {
    if (w < 1.8) return pick([['kong', 1.2 - 0.5 * L], ['speed', h < 1.3 ? 0.8 : 0.3], ['dive', w > 0.6 ? 0.4 + 0.7 * L : 0], ['jump', 0.25 + 0.5 * L]]);
    return pick([['jump', 0.7], ['kong', 0.7], ['dive', 0.3 + 0.6 * L], ['climb', h > 1.1 && climbable() ? 0.4 + L : 0]]);
  }
  if (h < 2.8) return pick([['jump', 1], ['climb', climbable() ? 0.4 + 1.2 * L : 0]]);
  return 'jump';
}

// How close (px) the obstacle's edge should be when he takes off, so the move lines up with it
function leadFor(p, sc, rel) {
  const s = runnerSize(), clear = sc.kind === 'rise' ? sc.rise + s * 0.05 : 0;
  switch (p.move) {
    case 'hop': return rel * tRise(sc.rise + s * 0.25, clear) + s * 0.17;
    case 'jump': return rel * tRise(sc.rise + s * (p.flip ? 0.6 : 0.35), clear) + s * 0.17;
    // hands land just past the front edge at the top of the arc
    case 'kong': return rel * tApex(sc.rise + s * 0.1) + s * 0.22;
    case 'speed': return rel * tApex(sc.rise + s * 0.2) - s * 0.05;
    // come down onto the top a little past its front edge, shoulder first
    case 'dive': {
      const h = sc.rise + s * 0.3, tLand = tApex(h) + tApex(s * 0.3), aim = clamp(sc.width * 0.4, s * 0.15, s * 0.5);
      return Math.max(rel * tLand - aim, rel * tRise(h, clear) + s * 0.17);
    }
    case 'climb': return rel * tApex(Math.max(s * 0.25, sc.rise - s * 0.9)) + s * 0.22;
    case 'leap': case 'flip': return s * 0.08 + rel * 0.03; // right at the edge
    default: return -Infinity; // 'drop': just run off it
  }
}

function planAhead() {
  const r = runner, s = runnerSize(), sc = scanAhead();
  if (!sc) { r.plan = null; return; }
  const rel = approach() + Math.max(0, r.vFwd);
  const p = r.plan;
  const same = p && p.kind === sc.kind && sc.d <= p.sc.d + s * 0.3 &&
    (sc.kind === 'drop' || (Math.abs(p.sc.rise - sc.rise) < s * 0.5 && (p.sc.width === Infinity) === (sc.width === Infinity)));
  if (same) p.sc = sc;
  else {
    const move = choose(sc, rel);
    r.plan = { kind: sc.kind, move, sc, flip: move === 'jump' && sc.rise > s * 1.1 && Math.random() < 0.15 + 0.5 * leadRatio() };
  }
  // Too slow to time anything (a still scene); rises under his feet are still caught by the run state
  if (rel < s * 1.2) return;
  if (sc.d <= leadFor(r.plan, sc, rel)) execute(r.plan, sc, rel);
}

function execute(p, sc, rel) {
  const r = runner, s = runnerSize();
  r.plan = null;
  r.act = { move: p.move, sc, v0: 1 };
  r.move = p.move;
  switch (p.move) {
    case 'hop': takeoff(sc.rise + s * 0.25, 'hop'); spend(COST.hop); r.flowT *= 0.85; break;
    case 'jump': {
      const h = takeoff(sc.rise + s * (p.flip ? 0.6 : 0.35), 'jump');
      spend(COST.jump + 0.004 * sc.rise / s); r.flowT *= 0.3;
      if (p.flip) { flip(Math.min(0.7, airTime(h, sc.top) * 0.9)); spend(COST.flip); }
      break;
    }
    case 'kong': takeoff(sc.rise + s * 0.1, 'kong'); break; // the fastest vault: free
    case 'speed': takeoff(sc.rise + s * 0.2, 'speed'); spend(COST.speed); r.flowT *= 0.9; break;
    case 'dive': takeoff(sc.rise + s * 0.3, 'dive'); spend(COST.dive); break;
    case 'climb': takeoff(Math.max(s * 0.25, sc.rise - s * 0.9), 'reach'); spend(COST.climb); r.flowT = 0; break;
    case 'leap': {
      const h = gapJumpable(sc, rel) ? arcFor(sc.gap + s * 0.4, rel, sc.farY) : s * 0.35;
      takeoff(clamp(h, s * 0.3, s * 2.2), 'leap'); spend(COST.leap); r.flowT *= 0.85;
      break;
    }
    case 'flip': {
      const h = takeoff(s * 0.6, 'leap');
      flip(clamp(airTime(h, sc.deep) * 0.85, 0.4, 0.6)); spend(COST.flip); r.flowT = 0;
      break;
    }
  }
}

// ---------- Hands on things ----------
// Kong and speed vaults: once the obstacle's top is under the hands near the top of the arc, plant on it
function tryPlant() {
  const r = runner, s = runnerSize(), f = r.facing, kong = r.style === 'kong';
  const hx = r.x + f * s * (kong ? 0.3 : -0.05);
  const top = minSurface(hx - s * 0.06, hx + s * 0.06);
  if (top > r.y + s * 0.35 || top < r.y - s * 0.45) return false;
  r.state = 'plant'; r.t = 0; r.vy = 0;
  r.grip = { x: hx, y: top, both: kong, bend: 1 };
  r.plantY = r.y; r.rot0 = r.rot;
  return true;
}
// Push off the planted hands hard enough to clear whatever's left of the obstacle, or hop onto a wide top
function pushOff() {
  const r = runner, s = runnerSize(), g = gravity(), f = r.facing, top = r.grip.y;
  const rel = Math.max(approach(), s * 1.2);
  let back = null;
  for (let i = colOf(r.x); i >= 0 && i < PW; i += f) {
    const d = (colX(i) - r.x) * f;
    if (d > s * 3) break;
    if (colY(i) > top + s * 0.3) { back = d; break; }
  }
  // Clear what's left if it's short; on a long top, just hop up onto it and run
  let h = s * 0.3;
  if (back !== null && back < s * 0.9) { const T = (Math.max(0, back) + s * 0.35) / rel; h = clamp(g * T * T / 8, s * 0.2, s * 1.2); }
  r.vy = -vFor(h); r.state = 'air'; r.style = r.style === 'kong' ? 'push' : 'exit'; r.t = 0; r.grip = null;
  if (r.act) r.act.v0 = -r.vy;
}
// Climb: grab the ledge of the wall ahead if the raised hands can reach it
function tryGrab() {
  const r = runner, s = runnerSize(), f = r.facing, cw = dispW / PW;
  for (let i = colOf(r.x); i >= 0 && i < PW; i += f) {
    if ((colX(i) - r.x) * f - cw * 0.5 > s * 0.5) return false;
    if (colY(i) >= r.y - s * 0.5) continue;
    const edge = colX(i) - f * cw * 0.5;
    const ledge = minSurface(edge, edge + f * s * 0.15);
    const hands = r.y - (AIR_HIP + 0.63) * s;
    if (ledge < hands - s * 0.35 || ledge > hands + s * 0.45) return false;
    r.state = 'climb'; r.t = 0; r.vy = 0; r.rot = 0;
    r.grip = { x: edge + f * s * 0.06, y: ledge, both: true, bend: -1 };
    // Hanging on the wall carries him back with it; in fast scenes the hands slip rather than lose half the screen
    r.climb = { dur: 0.46, pinK: Math.min(1, dispW * 0.25 / Math.max(1, approach())), off: (r.x - r.grip.x) * f };
    return true;
  }
  return false;
}
function climbing(dt) {
  const r = runner, s = runnerSize(), f = r.facing, c = r.climb, g0 = r.grip;
  const p = clamp(r.t / c.dur, 0, 1);
  // Hip goes from hanging below the ledge, in front of the wall, to crouched on top just past the edge
  const off = lerp(-0.24 * s, 0.08 * s, smooth(0.3, 0.85, p));
  const moved = moveFwd(scrollV * f * dt * c.pinK + (off - c.off));
  g0.x += f * (moved - (off - c.off));
  c.off = off;
  const hipY = lerp(g0.y + 0.55 * s, g0.y - 0.28 * s, smooth(0.25, 0.85, p));
  r.y = hipY + AIR_HIP * s;
  if (p >= 1) {
    r.state = 'run'; r.style = 'run'; r.move = ''; r.y = g0.y; r.grip = null; r.climb = null; r.act = null;
    r.squashV += 6;
  }
}

// ---------- Update ----------
export function updateRunner(dt) {
  const r = runner, s = runnerSize(), stepH = s * 0.3, fh = s * 0.14, f = r.facing;
  if (r.state === 'run') {
    if (scrollV < -dispW * 0.02) r.facing = 1;
    else if (scrollV > dispW * 0.02) r.facing = -1;
  }
  r.phase += dt * (10 + Math.min(12, Math.abs(scrollV) / dispW * 16) + Math.max(0, r.vFwd) / s * 2);
  // r.hold (set by vanish.js) means the terrain can't be trusted right now: keep to the last good ground
  const under = r.hold ? r.lastUnder : minSurface(r.x - fh, r.x + fh);
  r.under = r.lastUnder = under;
  r.t += dt;

  if (r.state === 'run') {
    drift(dt);
    if (!r.hold) planAhead();
    if (r.state === 'run') {
      if (under < r.y - stepH) { r.act = null; r.move = 'jump'; takeoff(r.y - under + s * 0.3, 'jump'); }
      else if (under > r.y + stepH * 1.2) { r.state = 'air'; r.style = 'fall'; r.vy = 0; r.t = 0; }
      else r.y += (under - r.y) * Math.min(1, dt * 16);
    }
  } else if (r.state === 'roll') {
    drift(dt);
    if (under > r.y + stepH * 1.5) { r.state = 'air'; r.style = 'tuck'; r.vy = 0; } // rolled off an edge
    else r.y += (under - r.y) * Math.min(1, dt * 16);
    if (!r.spin) { r.state = 'run'; r.style = 'run'; r.move = ''; r.squashV += 4; }
  } else if (r.state === 'plant') {
    drift(dt);
    const g0 = r.grip, kong = r.style === 'kong', p = clamp(r.t / 0.2, 0, 1);
    g0.x += scrollV * dt;
    r.y = lerp(r.plantY, g0.y - s * 0.02, smooth(0, 1, p));
    r.rot = lerp(r.rot0, f * (kong ? 0.25 : -0.5), easeInOut(p));
    // Stay on the hands for a beat, until they're well behind the hip
    if ((r.t > 0.1 && (r.x - g0.x) * f > s * 0.25) || r.t > 0.26) pushOff();
  } else if (r.state === 'climb') {
    climbing(dt);
  } else {
    drift(dt);
    airborne(dt);
    if (r.state === 'air' && r.vy > 0 && r.y >= under) {
      // The surface rose past him mid-air (a wall scrolled in): kick off it rather than teleporting up
      if (r.y - under > s * 0.7 && r.kicks < 2) { r.kicks++; r.act = null; takeoff(r.y - under + s * 0.4, 'jump'); }
      else touchDown(under);
    }
    if (r.y > dispH + s) touchDown(Math.min(under, dispH));
  }

  if (r.spin) {
    const sp = r.spin; sp.t += dt;
    const p = clamp(sp.t / sp.dur, 0, 1);
    r.rot = lerp(sp.a0, sp.a1, r.state === 'roll' ? p * p * (3 - 2 * p) : easeInOut(p));
    if (p >= 1) { r.spin = null; r.rot = 0; }
  }
  // Legs act as a damped spring after impact
  r.squashV += (-240 * r.squash - 19 * r.squashV) * dt;
  r.squash = clamp(r.squash + r.squashV * dt, -0.15, 1.15);
  if (r.brace > 0) {
    r.brace -= dt;
    if (r.grip) { r.grip.x += scrollV * dt; if (r.brace <= 0) r.grip = null; }
  }
  runnerLook();
}

function airborne(dt) {
  const r = runner, g = gravity(), f = r.facing, v0 = r.act ? r.act.v0 : 1;
  r.vy += g * dt;
  r.y += r.vy * dt;
  switch (r.style) {
    case 'kong': case 'speed':
      // Pitch into the vault; plant near the top of the arc, or give up and just come down
      r.rot = r.style === 'kong' ? f * 1.0 * smooth(0, 0.25, r.t) : -f * 0.4 * smooth(0, 0.2, r.t);
      if (r.vy > -v0 * 0.25 && tryPlant()) return;
      if (r.vy > v0 * 0.6) r.style = 'fall';
      break;
    case 'dive': r.rot = f * (0.2 + 0.8 * smooth(0.05, 0.35, r.t)); break;
    case 'reach':
      if (r.vy > -v0 * 0.3 && tryGrab()) return;
      if (r.vy > v0 * 0.5) r.style = 'fall';
      break;
    case 'tuck': if (!r.spin) r.style = 'fall'; break;
    default: if (!r.spin) r.rot *= Math.exp(-dt * 10);
  }
}

// What the figure should look like this frame; drawing eases toward it
const PIVOT_ROLL = [0.15, -0.1];
function runnerLook() {
  const r = runner, fall = clamp(r.vy / (dispH * 1.4), 0, 1);
  let look;
  switch (r.state) {
    case 'run': look = { pose: r.pose, blend: 0, hip: AIR_HIP }; break;
    case 'roll': look = { pose: POSE.tuck, blend: 1, hip: 0.16, pivot: PIVOT_ROLL, snap: 30 }; break;
    case 'plant': look = r.style === 'kong' ? { pose: POSE.kongTuck, blend: 1, hip: 0.24, snap: 26 } : { pose: POSE.speed, blend: 1, hip: 0.06, snap: 26 }; break;
    case 'climb': {
      const p = r.t / r.climb.dur;
      look = { pose: p < 0.3 ? POSE.hang : POSE.mantle, blend: 1, hip: AIR_HIP, snap: 16 };
      break;
    }
    default:
      if (r.spin) { look = { pose: POSE.tuck, blend: 1, hip: AIR_HIP * 0.7, pivot: PIVOT_ROLL, snap: 26 }; break; }
      switch (r.style) {
        case 'tuck': look = { pose: POSE.tuck, blend: 1, hip: 0.16, pivot: PIVOT_ROLL, snap: 30 }; break;
        case 'hop': look = { pose: POSE.hop, blend: 1, hip: AIR_HIP }; break;
        case 'kong': look = { pose: POSE.kong, blend: 1, hip: AIR_HIP, snap: 26 }; break;
        case 'speed': look = { pose: POSE.speed, blend: 1, hip: AIR_HIP, snap: 26 }; break;
        // after a vault: kong brings the knees through first, then both reach down for the landing
        case 'push': look = { pose: r.t < 0.14 ? POSE.push : POSE.vaultExit, blend: 1, hip: AIR_HIP, snap: 16 }; break;
        case 'exit': look = { pose: POSE.vaultExit, blend: 1, hip: AIR_HIP, snap: 14 }; break;
        case 'dive': look = { pose: POSE.dive, blend: 1, hip: AIR_HIP }; break;
        case 'reach': look = { pose: POSE.reach, blend: 1, hip: AIR_HIP }; break;
        case 'leap': look = { pose: POSE.leap, blend: 1, hip: AIR_HIP, snap: 18 }; break;
        default: look = { pose: airPose(fall), blend: 1, hip: AIR_HIP };
      }
  }
  r.look = look;
}
