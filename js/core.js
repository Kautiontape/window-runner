// Shared helpers, settings and the display/scroll state every module reads.
export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export const stage = $('stage');
export const ctx = stage.getContext('2d');

// Diagnostics (stats HUD, terrain/edge overlays, test keys) only with ?debug=1 or ?debug=true
export const DEBUG = /^(1|true)$/i.test(new URLSearchParams(location.search).get('debug') || '');
export const settings = { showLine: DEBUG, showEdges: false, motionFilter: true, focus: 50, sensitivity: 55, ignoreTop: 8 };
export const MARKER = '#3fd4f2', SCARF = '#ff5a36', INK = 'rgba(16,24,36,0.92)';

// Display size in CSS pixels, how fast the mid-ground scrolls across it (px/s), and elapsed time
export let dispW = 1, dispH = 1, dpr = 1, scrollV = 0, timeS = 0;
export function setView(w, h, ratio) { dispW = w; dispH = h; dpr = ratio; }
export function setScroll(v) { scrollV = v; }
export function advanceTime(dt) { timeS += dt; }
// Runner scale and gravity follow the display height
export const runnerSize = () => clamp(dispH * 0.11, 38, 100);
export const gravity = () => dispH * 3.2;

export function drawCover(c, src, sw, sh, tw, th) {
  const ta = tw / th, sa = sw / sh;
  let cx = 0, cy = 0, cw = sw, ch = sh;
  if (sa > ta) { cw = sh * ta; cx = (sw - cw) / 2; } else { ch = sw / ta; cy = (sh - ch) / 2; }
  c.drawImage(src, cx, cy, cw, ch, 0, 0, tw, th);
}
