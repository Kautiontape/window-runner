// Sources (camera, video file, demo), the frame loop and the UI.
import { $, lerp, ctx, stage, DEBUG, settings, dispW, dispH, dpr, scrollV, setView, setScroll, advanceTime, drawCover } from './core.js';
import { demo } from './demo.js';
import { PW, PH, hasTerrain, motionActive, bandFlow, lastProcNow, procMs, groundConf, coverage, jitter, lum,
  processFrame, resizeVision, resetVision, forgetBand, drawTerrain, drawEdges } from './vision.js';
import { runner, updateRunner, leadRatio } from './runner.js';
import { updateVanish, resetVanish, drawVanishUnder, drawVanishOver, vanishState, toggleForcedLoss } from './vanish.js';
import { updateFx, drawFx } from './effects.js';
import { drawRunner } from './figure.js';

const video = $('feed');

// ---------- Sources ----------
let mode = 'demo';
let objectUrl = null;

function currentSource() {
  if (mode === 'demo') return { el: demo.canvas, w: demo.canvas.width, h: demo.canvas.height };
  if (video.readyState >= 2 && video.videoWidth) return { el: video, w: video.videoWidth, h: video.videoHeight };
  return null;
}

const vfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
let vfcFlag = false, lastVT = -1;
if (vfc) { const cb = () => { vfcFlag = true; video.requestVideoFrameCallback(cb); }; video.requestVideoFrameCallback(cb); }
function newFrameAvailable(now) {
  if (mode === 'demo') { if (demo.fresh) { demo.fresh = false; return true; } return false; }
  if (vfcFlag) { vfcFlag = false; lastVT = video.currentTime; return true; }
  // Fallback when frame callbacks are unavailable or not firing
  if ((!vfc || now - lastProcNow > 90) && video.currentTime !== lastVT) { lastVT = video.currentTime; return true; }
  return false;
}

// ---------- Loop ----------
const hud = $('hud');
let lastT = performance.now(), fps = 60, hudT = 0;
function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
  lastT = now; advanceTime(dt);
  fps = lerp(fps, 1 / dt, 0.05);
  if (mode === 'demo') demo.tick(dt);
  const src = currentSource();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (src) {
    if (newFrameAvailable(now)) processFrame(src, now);
    drawCover(ctx, src.el, src.w, src.h, dispW, dispH);
  } else {
    ctx.fillStyle = '#1b2533'; ctx.fillRect(0, 0, dispW, dispH);
  }
  setScroll(scrollV + ((motionActive ? bandFlow * dispW / PW : 0) - scrollV) * Math.min(1, dt * 6));
  if (settings.showEdges && hasTerrain) drawEdges();
  if (settings.showLine && hasTerrain) drawTerrain();
  if (updateVanish(dt)) updateRunner(dt);
  updateFx(dt);
  drawVanishUnder();
  drawFx();
  drawRunner(dt);
  drawVanishOver();
  if (!hud.hidden && now - hudT > 250) {
    hudT = now;
    const motion = !settings.motionFilter ? 'Motion filter off' : motionActive ? 'Tracking mid-distance' : 'Motion filter waiting for movement';
    const pct = (v) => `${Math.round(v * 100)}%`;
    hud.textContent = `${Math.round(fps)} fps\nVision ${procMs.toFixed(1)} ms per frame at ${PW}×${PH}\nScroll ${Math.round(scrollV)} px/s\n${motion}` +
      `\nGround ${pct(groundConf)} (edges ${pct(coverage)}, jitter ${pct(jitter)}, light ${Math.round(lum)})` +
      `\nRunner ${vanishState()} · ${runner.state}${runner.move ? ' ' + runner.move : ''} · lead ${pct(leadRatio())}` +
      (runner.force ? `\nForcing ${runner.force} (M to cycle)` : '');
  }
  requestAnimationFrame(frame);
}

// Resizing (rotation, a collapsing URL bar) keeps the runner where he is; only a new source starts over
function resize() {
  const oldW = dispW, oldH = dispH;
  setView(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), Math.min(window.devicePixelRatio || 1, 2));
  stage.width = Math.round(dispW * dpr); stage.height = Math.round(dispH * dpr);
  const aspect = dispW / dispH;
  resizeVision(aspect);
  demo.resize(aspect);
  setScroll(0);
  runner.refit(dispW / oldW, dispH / oldH);
}
function resetTracking() {
  resetVision();
  setScroll(0);
  runner.reset();
  resetVanish();
}

// ---------- UI ----------
const start = $('start'), status = $('status'), tuneBtn = $('tune'), panel = $('panel'), fileInput = $('file');
function setStatus(msg, isError) { status.textContent = msg || ''; status.classList.toggle('error', !!isError); }
function enterRun() { start.hidden = true; panel.hidden = true; tuneBtn.hidden = false; hud.hidden = !DEBUG; setStatus(''); }
function showStart() { start.hidden = false; panel.hidden = true; tuneBtn.hidden = true; hud.hidden = true; }
function stopStream() {
  const so = video.srcObject;
  if (so && so.getTracks) so.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}
function cameraError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Camera access was blocked. Some viewers don\'t allow the camera inside embedded pages. Open this page on its own over HTTPS, or play a video instead.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No usable camera was found on this device.';
  if (n === 'NotReadableError') return 'The camera is in use by another app. Close it and try again.';
  return `The camera couldn't start (${n || 'unknown error'}). Try playing a video instead.`;
}

$('btnCamera').addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Camera isn\'t available here. It needs a secure (HTTPS) page. Play a video instead.', true); return;
  }
  setStatus('Asking for camera access…');
  try {
    stopStream();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false
    });
    video.removeAttribute('src'); video.srcObject = stream;
    await video.play();
    mode = 'video'; resetTracking(); enterRun();
  } catch (e) { mode = 'demo'; setStatus(cameraError(e), true); }
});
$('btnVideo').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    stopStream();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    await video.play();
    mode = 'video'; resetTracking(); enterRun();
  } catch (e) { setStatus('That video couldn\'t be played. Try an MP4 or WebM file.', true); }
});
$('btnDemo').addEventListener('click', () => { stopStream(); video.pause(); mode = 'demo'; demo.restart(); resetTracking(); enterRun(); });
tuneBtn.addEventListener('click', () => { panel.hidden = false; tuneBtn.hidden = true; $(DEBUG ? 'optLine' : 'optMotion').focus(); });
$('btnDone').addEventListener('click', () => { panel.hidden = true; tuneBtn.hidden = false; tuneBtn.focus(); });
$('btnSources').addEventListener('click', () => { showStart(); $('btnCamera').focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) $('btnDone').click(); });
if (DEBUG) {
  // Test keys: G pretends the ground is lost (exits/entrances), M cycles a forced move
  const moves = [null, 'kong', 'speed', 'dive', 'climb', 'jump', 'hop', 'leap', 'flip'];
  document.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input')) return;
    if (e.key === 'g' || e.key === 'G') toggleForcedLoss();
    if (e.key === 'm' || e.key === 'M') runner.force = moves[(moves.indexOf(runner.force) + 1) % moves.length];
  });
}

const focusInput = $('optFocus');
$('debugOpts').hidden = !DEBUG;
$('optLine').checked = settings.showLine;
$('optLine').addEventListener('change', (e) => { settings.showLine = e.target.checked; });
$('optEdges').addEventListener('change', (e) => { settings.showEdges = e.target.checked; });
$('optMotion').addEventListener('change', (e) => { settings.motionFilter = e.target.checked; focusInput.disabled = !e.target.checked; });
focusInput.addEventListener('input', (e) => { settings.focus = +e.target.value; forgetBand(); });
$('optSens').addEventListener('input', (e) => { settings.sensitivity = +e.target.value; });
$('optTop').addEventListener('input', (e) => { settings.ignoreTop = +e.target.value; });

window.addEventListener('resize', resize);
resize();
resetTracking();
requestAnimationFrame(frame);
