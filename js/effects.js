// Dust and other particles, anchored to the scenery so they drift with it.
import { ctx, scrollV, runnerSize } from './core.js';

export const fx = [];
export function dust(x, y, power) {
  const s = runnerSize(), n = Math.round(3 + power * 10);
  for (let i = 0; i < n && fx.length < 160; i++) {
    const dir = i % 2 ? 1 : -1, sp = s * (0.6 + Math.random() * 2.4) * (0.6 + power * 1.4);
    fx.push({ kind: 'dust', x: x + dir * s * 0.08 * Math.random(), y: y - s * 0.02, vx: dir * sp, vy: -s * (0.15 + Math.random() * 0.7),
      r: s * (0.045 + 0.04 * Math.random()) * (1 + power * 0.7), t: 0, life: 0.35 + Math.random() * 0.3 + power * 0.25 });
  }
  if (power > 0.5) fx.push({ kind: 'ring', x, y, r: s * 0.25, t: 0, life: 0.28 + power * 0.1 });
}
// A ninja smoke bomb: a burst of puffs that billow out and drift up
export function smoke(x, y, count) {
  const s = runnerSize();
  for (let i = 0; i < count && fx.length < 160; i++) {
    const a = Math.random() * Math.PI * 2, sp = s * (0.8 + Math.random() * 1.8);
    fx.push({ kind: 'smoke', x: x + Math.cos(a) * s * 0.1, y: y + Math.sin(a) * s * 0.15, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.7 - s * 0.4,
      lift: -s * 0.8, r: s * (0.12 + Math.random() * 0.1), t: 0, life: 0.55 + Math.random() * 0.35, shade: 200 + (Math.random() * 45 | 0) });
  }
}
// Little twinkles, for cloaking
export function sparkle(x, y) {
  const s = runnerSize();
  if (fx.length < 160) fx.push({ kind: 'spark', x, y, vx: 0, vy: -s * 0.3, r: s * (0.05 + Math.random() * 0.05), t: 0, life: 0.3 + Math.random() * 0.25 });
}
export function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const e = fx[i];
    e.t += dt;
    if (e.t >= e.life) { fx.splice(i, 1); continue; }
    e.x += scrollV * dt;
    if (e.vx !== undefined) {
      const drag = Math.exp(-dt * 4.5);
      e.x += e.vx * dt; e.y += e.vy * dt; e.vx *= drag; e.vy = e.vy * drag + (e.lift || 0) * dt;
    }
  }
}
export function drawFx() {
  for (const e of fx) {
    const p = e.t / e.life;
    if (e.kind === 'dust') {
      ctx.fillStyle = `rgba(238,231,216,${0.6 * (1 - p) * (1 - p)})`;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + p * 1.6), 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'smoke') {
      const c = e.shade;
      ctx.fillStyle = `rgba(${c},${c},${c + 8},${0.85 * (1 - p * p)})`;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (1 + p * 1.8), 0, Math.PI * 2); ctx.fill();
    } else if (e.kind === 'spark') {
      const k = e.r * Math.sin(Math.PI * p);
      ctx.strokeStyle = `rgba(220,248,255,${0.9 * (1 - p)})`; ctx.lineWidth = Math.max(1, k * 0.35); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(e.x - k, e.y); ctx.lineTo(e.x + k, e.y); ctx.moveTo(e.x, e.y - k); ctx.lineTo(e.x, e.y + k); ctx.stroke();
    } else if (e.kind === 'ring') {
      ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - p)})`; ctx.lineWidth = Math.max(1.5, e.r * 0.12 * (1 - p));
      ctx.beginPath(); ctx.ellipse(e.x, e.y, e.r * (1 + p * 3), e.r * 0.22 * (1 + p * 1.5), 0, 0, Math.PI * 2); ctx.stroke();
    }
  }
}
