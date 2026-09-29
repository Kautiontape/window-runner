// Draws the stick figure from the runner's pose, with IK for hands pinned to the world.
import { clamp, lerp, ctx, dispW, dispH, scrollV, timeS, runnerSize, SCARF, INK } from './core.js';
import { runner } from './runner.js';
import { LIMB, runPose, landPose, DEFAULT_PIVOT } from './poses.js';

// Two-bone IK: elbow and hand reaching from (ax, ay) toward (tx, ty); bend picks the elbow side
function reach(ax, ay, tx, ty, l1, l2, bend) {
  const dx = tx - ax, dy = ty - ay, d0 = Math.hypot(dx, dy) || 1e-3;
  const d = clamp(d0, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const ang = Math.atan2(dy, dx) + bend * Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  return [{ x: ax + Math.cos(ang) * l1, y: ay + Math.sin(ang) * l1 }, { x: ax + dx / d0 * d, y: ay + dy / d0 * d }];
}
const mixPt = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

export function drawRunner(dt) {
  const r = runner, s = runnerSize(), f = r.facing, p = r.phase, look = r.look;
  // Ease toward the pose the current move asks for; the run cycle is blended in separately
  const k = 1 - Math.exp(-dt * (look.snap || 22));
  for (let i = 0; i < 9; i++) r.pose[i] += (look.pose[i] - r.pose[i]) * k;
  r.blend += (look.blend - r.blend) * (1 - Math.exp(-dt * 14));
  r.hipAlt += (look.hip - r.hipAlt) * k;
  r.feetW += ((look.feet ? 1 : 0) - r.feetW) * k;
  const pv = look.pivot || DEFAULT_PIVOT;
  r.pivot[0] += (pv[0] - r.pivot[0]) * k; r.pivot[1] += (pv[1] - r.pivot[1]) * k;
  r.ikW += ((r.grip ? 1 : 0) - r.ikW) * (1 - Math.exp(-dt * 28));
  const a = r.blend, run = runPose(p);
  let P = run.map((v, i) => lerp(v, r.pose[i], a));
  // Landing compression follows the leg spring directly, so impacts read instantly
  const c = r.squash, braceW = r.grip && r.grip.brace ? r.ikW : 0;
  const w = clamp(Math.abs(c) * 1.8 + braceW, 0, 1) * (1 - a);
  if (w > 0) { const LP = landPose(Math.max(0, c), braceW); P = P.map((v, i) => lerp(v, LP[i], w)); }
  const [lean, t1, k1, t2, k2, u1, e1, u2, e2] = P;
  const L1 = s * LIMB.thigh, L2 = s * LIMB.shin, T = s * LIMB.torso, U = s * LIMB.upper, F = s * LIMB.fore, R = s * LIMB.head;
  const leg = (t, kk) => [L1 * Math.sin(t), L1 * Math.cos(t), L1 * Math.sin(t) + L2 * Math.sin(t - kk), L1 * Math.cos(t) + L2 * Math.cos(t - kk)];
  const l1 = leg(t1, k1), l2 = leg(t2, k2);
  // On the ground the lowest foot touches runner.y; otherwise the move sets the hip height
  const drop = Math.max(l1[3], l2[3]);
  const bob = (1 - a) * Math.abs(Math.cos(p)) * s * 0.03;
  const hy = runner.y - lerp(lerp(drop + bob, r.hipAlt * s, a), drop, r.feetW);
  // Rotations (flips, rolls, vault pitch) turn about a pivot kept over runner.x
  const hx = runner.x - f * r.pivot[0] * s;
  const piv = { x: runner.x, y: hy + r.pivot[1] * s }, cr = Math.cos(r.rot), sr = Math.sin(r.rot);
  const P2 = (dx, dy) => { const x = hx + dx * f - piv.x, y = hy + dy - piv.y; return { x: piv.x + x * cr - y * sr, y: piv.y + x * sr + y * cr }; };
  const hip = P2(0, 0);
  const sh = { dx: Math.sin(lean) * T, dy: -Math.cos(lean) * T };
  const shoulder = P2(sh.dx, sh.dy);
  const headC = P2(sh.dx + Math.sin(lean) * (R + s * 0.05), sh.dy - Math.cos(lean) * (R + s * 0.05));
  const arm = (u, e) => {
    const ex = sh.dx + U * Math.sin(u), ey = sh.dy + U * Math.cos(u);
    return [P2(ex, ey), P2(ex + F * Math.sin(u + e), ey + F * Math.cos(u + e))];
  };
  let [el1, ha1] = arm(u1, e1), [el2, ha2] = arm(u2, e2);
  // Hands pinned to the world (vaults, ledge grabs, landing braces)
  const g = r.grip || r.lastGrip;
  if (g && r.ikW > 0.01) {
    const [ie1, ih1] = reach(shoulder.x, shoulder.y, g.x, g.y, U, F, g.bend * f);
    el1 = mixPt(el1, ie1, r.ikW); ha1 = mixPt(ha1, ih1, r.ikW);
    if (g.both) {
      const [ie2, ih2] = reach(shoulder.x, shoulder.y, g.x - f * s * 0.05, g.y, U, F, g.bend * f);
      el2 = mixPt(el2, ie2, r.ikW); ha2 = mixPt(ha2, ih2, r.ikW);
    }
  }
  if (r.grip) r.lastGrip = r.grip;
  const kn1 = P2(l1[0], l1[1]), ft1 = P2(l1[2], l1[3]);
  const kn2 = P2(l2[0], l2[1]), ft2 = P2(l2[2], l2[3]);
  r.head = headC;

  updateScarf(shoulder, dt, s);
  if (r.alpha <= 0.002) return;
  ctx.save();
  ctx.globalAlpha = r.alpha;
  if (r.clipY != null) { ctx.beginPath(); ctx.rect(-dispW, -dispH, dispW * 3, r.clipY + dispH); ctx.clip(); }

  // ground shadow
  const lift = clamp((r.under - runner.y) / (dispH * 0.4), 0, 1);
  if (r.clipY == null) {
    ctx.fillStyle = `rgba(0,0,0,${0.28 * (1 - lift)})`;
    ctx.beginPath(); ctx.ellipse(runner.x, r.under, s * 0.22 * (1 - lift * 0.5), s * 0.045, 0, 0, Math.PI * 2); ctx.fill();
  }

  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const limb = (pts, color) => {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = INK; ctx.lineWidth = s * 0.1; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = s * 0.055; ctx.stroke();
  };

  // scarf trails from the neck
  if (!r.scarfFree) drawScarf(s);
  limb([shoulder, el2, ha2], '#cfd5dc');
  limb([hip, kn2, ft2], '#cfd5dc');
  limb([hip, shoulder], '#ffffff');
  limb([hip, kn1, ft1], '#ffffff');
  ctx.beginPath(); ctx.arc(headC.x, headC.y, R, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = s * 0.03; ctx.stroke();
  limb([shoulder, el1, ha1], '#ffffff');
  ctx.restore();
}
export function drawLooseScarf(alpha) {
  if (!runner.scarf.length || alpha <= 0) return;
  ctx.save(); ctx.globalAlpha = alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  drawScarf(runnerSize());
  ctx.restore();
}
function drawScarf(s) {
  const sc = runner.scarf;
  ctx.beginPath(); ctx.moveTo(sc[0].x, sc[0].y);
  for (let i = 1; i < sc.length; i++) ctx.lineTo(sc[i].x, sc[i].y);
  ctx.strokeStyle = INK; ctx.lineWidth = s * 0.085; ctx.stroke();
  ctx.strokeStyle = SCARF; ctx.lineWidth = s * 0.05; ctx.stroke();
}

// Once it comes loose (runner.scarfFree) the scarf drifts off with the scenery and flutters down
function updateScarf(anchor, dt, s) {
  const n = 8, seg = s * 0.075, sc = runner.scarf, free = runner.scarfFree;
  if (sc.length !== n) { sc.length = 0; for (let i = 0; i < n; i++) sc.push({ x: anchor.x - runner.facing * seg * i, y: anchor.y, px: anchor.x - runner.facing * seg * i, py: anchor.y }); }
  if (!free) { sc[0].x = sc[0].px = anchor.x; sc[0].y = sc[0].py = anchor.y; }
  const h = Math.min(dt, 1 / 30);
  const wind = free ? 0 : -runner.facing * (dispH * 1.6 + Math.abs(scrollV) * 2);
  const grav = free ? dispH * 0.2 : dispH * 0.9;
  for (let i = free ? 0 : 1; i < n; i++) {
    const p = sc[i];
    const vx = (p.x - p.px) * 0.9, vy = (p.y - p.py) * 0.9;
    if (free) { p.x += scrollV * h; p.px += scrollV * h; }
    p.px = p.x; p.py = p.y;
    p.x += vx + wind * h * h + (free ? Math.sin(timeS * 7 + i) * s * 0.01 : 0);
    p.y += vy + grav * h * h + Math.sin(timeS * 19 + i * 0.9) * s * 0.006;
  }
  for (let it = 0; it < 4; it++) for (let i = 1; i < n; i++) {
    const a = sc[i - 1], b = sc[i];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1e-3;
    b.x = a.x + dx / d * seg; b.y = a.y + dy / d * seg;
  }
}
