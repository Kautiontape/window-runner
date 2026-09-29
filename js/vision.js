// Vision pipeline: downsampled edges + block-matching motion -> a skyline "terrain" the runner stands on.
import { clamp, lerp, smooth, ctx, settings, MARKER, dispW, dispH, drawCover } from './core.js';

const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
const edgeCanvas = document.createElement('canvas');
const ectx = edgeCanvas.getContext('2d');

// ---------- Buffers ----------
const B = 8, RING = 6, PIXELS = 16000;
// Processing resolution, the terrain skyline (processing-pixel rows per column) and motion state are read elsewhere
export let PW = 64, PH = 48, terrain, hasTerrain = false, motionActive = false, bandFlow = 0;
export let lastProcNow = 0, procMs = 0;
// How much the terrain can be trusted (0..1), and the cues behind it (shown in the debug HUD):
// share of columns that found a real edge, frame-to-frame skyline jumpiness, and mean brightness
export let groundConf = 0, coverage = 0, jitter = 0, lum = 128;
let GX = 1, GY = 1, DMAX = 6;
let ring = [], ringTime = [], ringHead = -1, ringCount = 0;
let gray, edge, rawY, medY, terrainTmp, flow, conf, inBand, bandEff, sadGrid, edgeImg;
let edgeThr = 12, edgeMean = 0;
let lastBand = null;
const win5 = new Float32Array(5);

// Size the processing buffers to roughly PIXELS samples at the display's aspect ratio
export function resizeVision(aspect) {
  PW = Math.max(64, Math.round(Math.sqrt(PIXELS * aspect)));
  PH = Math.max(48, Math.round(PW / aspect));
  proc.width = PW; proc.height = PH;
  const N = PW * PH;
  ring = []; ringTime = [];
  for (let i = 0; i < RING; i++) { ring.push(new Float32Array(N)); ringTime.push(0); }
  ringHead = -1; ringCount = 0;
  gray = new Float32Array(N); edge = new Float32Array(N);
  rawY = new Float32Array(PW); medY = new Float32Array(PW);
  terrain = new Float32Array(PW); terrainTmp = new Float32Array(PW);
  GX = Math.max(1, Math.floor(PW / B)); GY = Math.max(1, Math.floor(PH / B));
  flow = new Float32Array(GX * GY); conf = new Uint8Array(GX * GY);
  inBand = new Uint8Array(GX * GY); bandEff = new Uint8Array(GX * GY);
  DMAX = Math.max(6, Math.round(PW * 0.1));
  sadGrid = new Float32Array(3 * (2 * DMAX + 1));
  edgeCanvas.width = PW; edgeCanvas.height = PH;
  edgeImg = ectx.createImageData(PW, PH);
  resetVision(true);
}
// A new source starts from no confidence; a resize keeps it so the runner doesn't vanish and reappear
export function resetVision(keepConfidence) {
  ringHead = -1; ringCount = 0; hasTerrain = false; lastBand = null;
  motionActive = false; bandFlow = 0; lastProcNow = 0;
  if (!keepConfidence) groundConf = 0;
}
// The focus setting changed, so the remembered speed band no longer applies
export function forgetBand() { lastBand = null; }

// ---------- Vision pipeline ----------
function blur(src, out, tmp) {
  for (let y = 0; y < PH; y++) {
    const r = y * PW;
    for (let x = 0; x < PW; x++) {
      const xl = x > 0 ? x - 1 : x, xr = x < PW - 1 ? x + 1 : x;
      tmp[r + x] = (src[r + xl] + 2 * src[r + x] + src[r + xr]) * 0.25;
    }
  }
  for (let y = 0; y < PH; y++) {
    const ru = (y > 0 ? y - 1 : y) * PW, r = y * PW, rd = (y < PH - 1 ? y + 1 : y) * PW;
    for (let x = 0; x < PW; x++) out[r + x] = (tmp[ru + x] + 2 * tmp[r + x] + tmp[rd + x]) * 0.25;
  }
}

function sobel(s, out) {
  out.fill(0);
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      const a = s[i - PW - 1], b = s[i - PW], c = s[i - PW + 1], d = s[i - 1], f = s[i + 1], g = s[i + PW - 1], h = s[i + PW], k = s[i + PW + 1];
      const gx = (c + 2 * f + k) - (a + 2 * d + g);
      const gy = (g + 2 * h + k) - (a + 2 * b + c);
      const m = Math.abs(gx) + Math.abs(gy);
      out[i] = m; sum += m; sum2 += m * m; n++;
    }
  }
  edgeMean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - edgeMean * edgeMean));
  const k = 2.6 - (settings.sensitivity / 100) * 2.2;
  edgeThr = Math.max(12, edgeMean + k * sd);
}

// Block-matching horizontal motion per 8x8 block. Mid-ground = the dominant moving speed band.
function computeFlow(now) {
  conf.fill(0); flow.fill(0); inBand.fill(0); bandEff.fill(0);
  motionActive = false; bandFlow = 0;
  if (ringCount < 2) return;
  let refIdx = -1, age = 0;
  for (let k = 1; k < ringCount; k++) {
    const idx = (ringHead - k + RING) % RING;
    refIdx = idx; age = now - ringTime[idx];
    if (age >= 60) break;
  }
  if (refIdx < 0 || age <= 0 || age > 400) return;
  const cur = ring[ringHead], ref = ring[refIdx];
  const D = DMAX, span = 2 * D + 1, texMin = edgeMean * 1.1;
  for (let by = 0; by < GY; by++) for (let bx = 0; bx < GX; bx++) {
    const gi = by * GX + bx, x0 = bx * B, y0 = by * B;
    let tex = 0;
    for (let y = y0; y < y0 + B; y++) { const r = y * PW; for (let x = x0; x < x0 + B; x++) tex += edge[r + x]; }
    if (tex / (B * B) < texMin) continue;
    sadGrid.fill(Infinity);
    let best = Infinity, bestDx = 0, bestDy = 0, total = 0, cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ry0 = y0 - dy;
      if (ry0 < 0 || ry0 + B > PH) continue;
      for (let dx = -D; dx <= D; dx++) {
        const rx0 = x0 - dx;
        if (rx0 < 0 || rx0 + B > PW) continue;
        let sad = 0;
        for (let y = 0; y < B; y++) {
          const rc = (y0 + y) * PW + x0, rr = (ry0 + y) * PW + rx0;
          for (let x = 0; x < B; x++) sad += Math.abs(cur[rc + x] - ref[rr + x]);
        }
        sadGrid[(dy + 1) * span + dx + D] = sad;
        total += sad; cnt++;
        if (sad < best) { best = sad; bestDx = dx; bestDy = dy; }
      }
    }
    if (!cnt || bestDx <= -D || bestDx >= D || best > 0.6 * (total / cnt)) continue;
    const row = (bestDy + 1) * span + bestDx + D;
    const l = sadGrid[row - 1], r = sadGrid[row + 1];
    let sub = 0;
    if (isFinite(l) && isFinite(r)) { const den = l - 2 * best + r; if (den > 1e-6) sub = clamp(0.5 * (l - r) / den, -0.5, 0.5); }
    flow[gi] = (bestDx + sub) * 1000 / age; // processing px per second
    conf[gi] = 1;
  }

  const minMove = PW * 0.06;
  const moving = []; let signSum = 0;
  for (let gi = 0; gi < GX * GY; gi++) if (conf[gi] && Math.abs(flow[gi]) > minMove) { moving.push(Math.abs(flow[gi])); signSum += flow[gi]; }
  let band = null;
  if (moving.length >= 4) {
    moving.sort((a, b) => a - b);
    const refSpeed = moving[moving.length >> 1] * Math.pow(2, (50 - settings.focus) / 50);
    band = { lo: refSpeed * 0.5, hi: refSpeed * 1.8, dom: Math.sign(signSum) || 1, t: now };
    lastBand = band;
  } else if (lastBand && now - lastBand.t < 600) {
    band = lastBand; // brief hold so the filter doesn't flicker
  }
  if (!band) return;
  const vals = [];
  for (let gi = 0; gi < GX * GY; gi++) {
    if (!conf[gi]) continue;
    const v = flow[gi], av = Math.abs(v);
    if (Math.sign(v) === band.dom && av >= band.lo && av <= band.hi) { inBand[gi] = 1; vals.push(v); }
  }
  if (!vals.length) return;
  vals.sort((a, b) => a - b);
  bandFlow = vals[vals.length >> 1];
  motionActive = true;
  // Let untrackable blocks (plain rooflines, flat edges) borrow a neighbour's verdict
  for (let by = 0; by < GY; by++) for (let bx = 0; bx < GX; bx++) {
    const gi = by * GX + bx;
    if (inBand[gi]) { bandEff[gi] = 1; continue; }
    if (conf[gi]) continue;
    if ((by < GY - 1 && inBand[gi + GX]) || (bx > 0 && inBand[gi - 1]) || (bx < GX - 1 && inBand[gi + 1])) bandEff[gi] = 1;
  }
}

function accepted(x, y, useMotion) {
  if (!useMotion) return true;
  return bandEff[Math.min(GY - 1, (y / B) | 0) * GX + Math.min(GX - 1, (x / B) | 0)] === 1;
}

function skyline(dtProc) {
  const top0 = Math.round(PH * settings.ignoreTop / 100);
  const useMotion = settings.motionFilter && motionActive;
  const floorY = PH * 0.94;
  for (let x = 0; x < PW; x++) {
    let found = floorY;
    for (let y = Math.max(1, top0); y < PH - 1; y++) {
      if (edge[y * PW + x] > edgeThr && accepted(x, y, useMotion)) { found = y; break; }
    }
    rawY[x] = Math.min(found, floorY);
  }
  let covered = 0;
  for (let x = 0; x < PW; x++) {
    for (let k = -2; k <= 2; k++) win5[k + 2] = rawY[clamp(x + k, 0, PW - 1)];
    win5.sort(); medY[x] = win5[2];
    if (medY[x] < floorY - 0.5) covered++;
  }
  coverage = covered / PW;
  const shift = hasTerrain ? bandFlow * dtProc : 0;
  let jsum = 0, jn = 0;
  for (let x = 0; x < PW; x++) {
    const sx = x - shift;
    if (hasTerrain && sx >= 0 && sx <= PW - 1) {
      const i0 = sx | 0, f = sx - i0;
      const prev = terrain[i0] * (1 - f) + terrain[Math.min(PW - 1, i0 + 1)] * f;
      terrainTmp[x] = prev + (medY[x] - prev) * 0.5;
      jsum += Math.min(Math.abs(medY[x] - prev), PH * 0.3); jn++;
    } else terrainTmp[x] = medY[x];
  }
  jitter = jn ? jsum / jn / PH : 0;
  const t = terrain; terrain = terrainTmp; terrainTmp = t;
  hasTerrain = true;
}

export function processFrame(src, now) {
  const t0 = performance.now();
  const dtProc = lastProcNow ? Math.min(0.25, (now - lastProcNow) / 1000) : 0;
  lastProcNow = now;
  drawCover(pctx, src.el, src.w, src.h, PW, PH);
  const d = pctx.getImageData(0, 0, PW, PH).data;
  const N = PW * PH;
  let sum = 0;
  for (let i = 0, j = 0; i < N; i++, j += 4) { gray[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]; sum += gray[i]; }
  lum = sum / N;
  ringHead = (ringHead + 1) % RING; ringCount = Math.min(RING, ringCount + 1);
  ringTime[ringHead] = now;
  blur(gray, ring[ringHead], edge);
  sobel(ring[ringHead], edge);
  computeFlow(now);
  skyline(dtProc);
  // Coverage and stability carry the verdict; brightness only vetoes a near-black frame (phone face down),
  // so dim scenes like night driving still count. A stalled feed just freezes the verdict.
  const inst = smooth(0.1, 0.35, coverage) * (1 - smooth(0.06, 0.16, jitter)) * smooth(4, 12, lum);
  if (dtProc > 0) groundConf += (inst - groundConf) * (1 - Math.exp(-dtProc / 0.3));
  procMs = lerp(procMs, performance.now() - t0, 0.1);
}

// ---------- Terrain queries in display space ----------
// Terrain columns: the column under display x, its centre x, and its surface y
export const colOf = (x) => clamp(Math.floor(x / dispW * PW), 0, PW - 1);
export const colX = (i) => (i + 0.5) * dispW / PW;
export const colY = (i) => (hasTerrain ? (terrain[i] + 0.5) * dispH / PH : dispH * 0.92);
export function minSurface(x0, x1) {
  if (!hasTerrain) return dispH * 0.92;
  const i0 = clamp(Math.floor(Math.min(x0, x1) / dispW * PW), 0, PW - 1);
  const i1 = clamp(Math.ceil(Math.max(x0, x1) / dispW * PW), 0, PW - 1);
  let m = Infinity;
  for (let i = i0; i <= i1; i++) if (terrain[i] < m) m = terrain[i];
  return (m + 0.5) * dispH / PH;
}

// ---------- Overlays ----------
export function drawTerrain() {
  const sx = dispW / PW, sy = dispH / PH;
  ctx.beginPath();
  for (let i = 0; i < PW; i++) {
    const x = (i + 0.5) * sx, y = (terrain[i] + 0.5) * sy;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(12,18,28,0.45)'; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = MARKER; ctx.lineWidth = 2.5; ctx.stroke();
}
export function drawEdges() {
  const data = edgeImg.data, useMotion = settings.motionFilter && motionActive;
  const top0 = Math.round(PH * settings.ignoreTop / 100);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
    const i = y * PW + x, o = i * 4, m = edge[i];
    if (m > edgeThr && y >= top0 && accepted(x, y, useMotion)) { data[o] = 63; data[o + 1] = 212; data[o + 2] = 242; data[o + 3] = 255; }
    else { const v = Math.min(190, m * 0.3); data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 230; }
  }
  ectx.putImageData(edgeImg, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(edgeCanvas, 0, 0, dispW, dispH);
  ctx.imageSmoothingEnabled = true;
  if (top0 > 0) { ctx.fillStyle = 'rgba(15,22,32,0.5)'; ctx.fillRect(0, 0, dispW, top0 * dispH / PH); }
}
