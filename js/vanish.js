// When the ground can't be seen (phone put down, a dark tunnel) the runner makes an exit instead of
// running on nothing, and makes an entrance once it's back.
import { clamp, smooth, ctx, dispW, scrollV, runnerSize, gravity } from './core.js';
import { hasTerrain, groundConf, lum, minSurface } from './vision.js';
import { runner } from './runner.js';
import { smoke, sparkle } from './effects.js';
import { drawLooseScarf } from './figure.js';
import { POSE, AIR_HIP, airPose } from './poses.js';

// Below LOST he stops trusting the terrain and holds his level; if that lasts LOST_AFTER s he exits.
// Above FOUND for FOUND_AFTER s he comes back. Appearing is kept a little easier than vanishing.
const LOST = 0.4, FOUND = 0.5, LOST_AFTER = 0.7, FOUND_AFTER = 0.6;
const EXIT_LEN = { hole: 1.15, poof: 0.9, cloak: 1.0, eyes: 1.4 };
const ENTER_LEN = { drop: 0, hole: 0.85, poof: 0.3, cloak: 0.8, eyes: 1.0 };

let lostT = 0, foundT = 0, forced = false;
// The running exit/entrance: its kind, clock, and props (a hole in the ground, glowing eyes, a loose scarf)
const act = { kind: null, t: 0, hole: null, eyes: 0, blink: 1, scarfA: 0, last: 'drop' };

export const vanishState = () => (act.kind ? `${runner.vis} ${act.kind}` : runner.vis);
// Debug: pretend the ground is gone
export function toggleForcedLoss() { forced = !forced; return forced; }
export function resetVanish() { lostT = foundT = 0; act.kind = null; act.hole = null; act.eyes = 0; act.scarfA = 0; act.last = 'drop'; }

const pick = (opts) => opts[(Math.random() * opts.length) | 0];

// Runs before the runner's own update; returns false while an animation is moving him itself
export function updateVanish(dt) {
  const r = runner, conf = forced ? 0 : groundConf;
  r.hold = forced || !hasTerrain || conf < LOST;
  if (conf < LOST) { lostT += dt; foundT = 0; } else if (conf > FOUND) { foundT += dt; lostT = 0; } else { lostT = 0; foundT = 0; }
  if (act.scarfA > 0) act.scarfA = Math.max(0, act.scarfA - dt / 1.3);

  if (r.vis === 'shown' && lostT > LOST_AFTER && (r.state === 'run' || lostT > 2.5)) {
    // In the dark he fades to a pair of eyes; otherwise a hole, a smoke bomb, or a cloak
    startExit(lum < 30 ? pick(['eyes', 'eyes', 'cloak']) : pick(['hole', 'poof', 'cloak']));
  } else if (r.vis === 'hidden' && foundT > FOUND_AFTER && hasTerrain) {
    // Come back the way he left, unless that doesn't suit the light any more (eyes need the dark)
    const dark = lum < 30;
    startEnter(dark ? pick(['eyes', 'cloak']) : act.last === 'eyes' || Math.random() < 0.25 ? pick(['drop', 'poof', 'cloak']) : act.last);
  }
  if (r.vis === 'out') return exiting(dt);
  if (r.vis === 'in') return entering(dt);
  return r.vis === 'shown';
}

function startExit(kind) {
  const r = runner;
  act.kind = kind; act.t = 0; act.last = kind; act.eyes = 0; act.blink = 1;
  r.vis = 'out';
  if (kind === 'hole') act.hole = { x: r.x, y: r.y, rx: 0 };
  if (kind !== 'cloak') { r.state = 'scripted'; r.vy = 0; r.rot = 0; r.spin = null; r.grip = null; r.act = r.plan = r.climb = null; }
}
function exiting(dt) {
  const r = runner, s = runnerSize(), t = (act.t += dt), len = EXIT_LEN[act.kind];
  switch (act.kind) {
    case 'hole': {
      // A hole opens at his feet, he hops and drops straight in, then it closes over him
      const h = act.hole;
      h.rx = s * 0.42 * smooth(0, 0.2, t) * (1 - smooth(0.85, 1.1, t));
      r.clipY = h.y;
      if (t > 0.18 && t - dt <= 0.18) r.squashV += 6;
      if (t > 0.3) {
        if (t - dt <= 0.3) r.vy = -Math.sqrt(2 * gravity() * s * 0.45);
        r.vy += gravity() * dt; r.y += r.vy * dt;
        r.look = { pose: airPose(0.9), blend: 1, hip: AIR_HIP };
      } else r.look = { pose: POSE.stand, blend: 1, hip: AIR_HIP, feet: true };
      if (r.y - s * 1.2 > h.y) r.alpha = 0;
      break;
    }
    case 'poof': {
      // Crouch, smoke bomb, gone; the scarf is left fluttering down
      if (t < 0.15) { if (t - dt <= 0) r.squashV += 9; r.look = { pose: POSE.stand, blend: 1, hip: AIR_HIP, feet: true }; }
      else if (r.alpha > 0) {
        smoke(r.x, r.y - s * 0.45, 18);
        r.alpha = 0; r.scarfFree = true; act.scarfA = 1;
      }
      break;
    }
    case 'cloak': {
      // Keeps running while the cloak flickers on, with a few twinkles
      const on = hash(Math.floor(t * 24)) > t * 0.95;
      r.alpha = (1 - smooth(0.1, len, t)) * (on ? 1 : 0.2);
      if (Math.random() < dt * 14) sparkle(r.x + (Math.random() - 0.5) * s * 0.5, r.y - Math.random() * s);
      break;
    }
    case 'eyes': {
      // Stops, and fades into the dark until only his eyes are left; they blink, then shut
      r.look = { pose: POSE.stand, blend: 1, hip: AIR_HIP, feet: true };
      r.alpha = 1 - smooth(0, 0.45, t);
      act.eyes = smooth(0.1, 0.3, t);
      act.blink = blinkAt(t, 0.75) * (1 - smooth(1.12, 1.24, t));
      break;
    }
  }
  if (t >= len) {
    r.vis = 'hidden'; r.alpha = 0; r.clipY = null; act.kind = null; act.hole = null; act.eyes = 0;
    return false;
  }
  return act.kind === 'cloak';
}

function startEnter(kind) {
  // Face the way the scenery is going now; it may have changed while he was away
  const r = runner, s = runnerSize(), f = scrollV < -dispW * 0.02 ? 1 : scrollV > dispW * 0.02 ? -1 : r.facing;
  const home = f > 0 ? dispW * 0.3 : dispW * 0.7;
  const ground = minSurface(home - s * 0.14, home + s * 0.14);
  r.reset(); r.facing = f;
  r.x = home; r.lastUnder = ground; r.scarfFree = false;
  act.kind = kind; act.t = 0; act.eyes = 0; act.blink = 1;
  r.vis = 'in'; r.alpha = 1;
  if (kind === 'drop') {
    // From above the top of the screen, straight into a landing roll
    r.y = -s * 1.2; r.state = 'air'; r.style = 'fall'; r.vis = 'shown'; act.kind = null;
    return;
  }
  r.state = 'run'; r.style = 'run'; r.y = ground;
  if (kind === 'hole') { act.hole = { x: home, y: ground, rx: 0 }; r.state = 'scripted'; r.alpha = 0; }
  if (kind === 'poof') { smoke(home, ground - s * 0.45, 14); r.squash = 1; }
  if (kind === 'cloak' || kind === 'eyes') r.alpha = 0;
}
function entering(dt) {
  const r = runner, s = runnerSize(), t = (act.t += dt), len = ENTER_LEN[act.kind];
  switch (act.kind) {
    case 'hole': {
      // A hole opens and he springs out of it
      const h = act.hole;
      h.rx = s * 0.42 * smooth(0, 0.18, t) * (1 - smooth(0.55, 0.8, t));
      if (r.state === 'scripted') {
        r.look = { pose: airPose(0.2), blend: 1, hip: AIR_HIP };
        if (t >= 0.18) {
          r.alpha = 1; r.y = h.y + s * 1.2; r.state = 'air'; r.style = 'jump';
          r.vy = -Math.sqrt(2 * gravity() * s * 2.6);
        }
        return false;
      }
      r.clipY = r.y > h.y - 1 ? h.y : null; // hidden below the rim until he's out
      break;
    }
    case 'cloak': {
      const on = hash(Math.floor(t * 24) + 7) < t * 1.1;
      r.alpha = smooth(0, len, t) * (on ? 1 : 0.25);
      if (Math.random() < dt * 10) sparkle(r.x + (Math.random() - 0.5) * s * 0.5, r.y - Math.random() * s);
      break;
    }
    case 'eyes': {
      // Eyes open in the dark, blink, then the rest of him fades in
      act.eyes = 1 - smooth(0.6, 0.95, t);
      act.blink = smooth(0, 0.15, t) * blinkAt(t, 0.4);
      r.alpha = smooth(0.5, 0.95, t);
      break;
    }
  }
  if (t >= len) { r.vis = 'shown'; r.alpha = 1; r.clipY = null; act.kind = null; act.hole = null; act.eyes = 0; }
  return true;
}

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// Eyelid openness around a blink at time b
const blinkAt = (t, b) => clamp(Math.abs(t - b) / 0.06, 0, 1);

// Drawn under the runner: the hole
export function drawVanishUnder() {
  const h = act.hole;
  if (!h || h.rx < 0.5) return;
  const ry = h.rx * 0.26;
  ctx.fillStyle = '#07090d';
  ctx.beginPath(); ctx.ellipse(h.x, h.y, h.rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = Math.max(1, ry * 0.25);
  ctx.beginPath(); ctx.ellipse(h.x, h.y, h.rx, ry, 0, 0.1, Math.PI - 0.1); ctx.stroke();
}
// Drawn over the runner: the eyes in the dark, and a scarf left behind
export function drawVanishOver() {
  drawLooseScarf(act.scarfA);
  const r = runner, hd = r.head;
  if (act.eyes <= 0.01 || !hd) return;
  const s = runnerSize(), R = s * 0.1, f = r.facing;
  ctx.save();
  ctx.globalAlpha = act.eyes;
  ctx.fillStyle = '#fffbe8'; ctx.shadowColor = 'rgba(255,245,200,0.9)'; ctx.shadowBlur = R * 0.8;
  for (const dx of [-0.05, 0.6]) {
    ctx.beginPath();
    ctx.ellipse(hd.x + f * dx * R, hd.y - R * 0.1, Math.max(1.2, R * 0.26), Math.max(0.5, R * 0.42 * act.blink), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
