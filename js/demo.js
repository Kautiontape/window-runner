// Procedural parallax scene that stands in for a car window.
import { mulberry32, smooth } from './core.js';

const TUNNEL_LEN = 5;

export const demo = {
  canvas: document.createElement('canvas'), c: null, W: 640, H: 360,
  acc: 0, t: 0, fresh: true, objs: [], posts: [], farOff: 0, rng: mulberry32(11), tunnelAt: 22,
  // Every so often the car goes through a tunnel, so the runner has to make himself scarce
  restart() { this.tunnelAt = this.t + 22; },
  resize(aspect) {
    if (aspect >= 1) { this.W = 640; this.H = Math.round(640 / aspect); } else { this.H = 640; this.W = Math.round(640 * aspect); }
    this.canvas.width = this.W; this.canvas.height = this.H; this.c = this.canvas.getContext('2d');
    this.objs = []; this.posts = [];
    let x = -this.W * 0.1; while (x < this.W * 1.5) x = this.spawn(x);
    for (let px = this.W * 0.2; px < this.W * 1.6; px += this.W * 0.45) this.posts.push(px);
    this.render(); this.fresh = true;
  },
  spawn(x) {
    const r = this.rng, W = this.W, H = this.H, roll = r();
    let o;
    if (roll < 0.45) {
      const palette = ['#6c7b8e', '#8b6f5b', '#5f6e5b', '#7c6f8b', '#9a7f62'];
      o = { kind: 'building', w: W * (0.12 + r() * 0.16), h: H * (0.14 + r() * 0.28), color: palette[(r() * palette.length) | 0], seed: (r() * 1e9) | 0 };
    } else if (roll < 0.78) {
      o = { kind: 'tree', w: W * (0.09 + r() * 0.07), h: H * (0.18 + r() * 0.15), seed: (r() * 1e9) | 0 };
    } else {
      const cars = ['#b8423a', '#3d6fa8', '#d7c9a8', '#4a4f57'];
      o = { kind: 'car', w: W * 0.14, h: H * 0.085, color: cars[(r() * cars.length) | 0] };
    }
    o.x = x; this.objs.push(o);
    return x + o.w + W * (0.02 + r() * 0.16);
  },
  tick(dt) {
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    const step = Math.min(this.acc, 0.1); this.acc = 0; this.t += step;
    const W = this.W, mid = W * 0.26 * step;
    for (const o of this.objs) o.x -= mid;
    this.objs = this.objs.filter((o) => o.x + o.w > -W * 0.2);
    let right = this.objs.length ? Math.max(...this.objs.map((o) => o.x + o.w)) : 0;
    while (right < W * 1.4) right = this.spawn(right + W * 0.05);
    this.farOff += W * 0.025 * step;
    const spacing = W * 0.45;
    for (let i = 0; i < this.posts.length; i++) {
      this.posts[i] -= W * 1.05 * step;
      if (this.posts[i] < -W * 0.05) this.posts[i] += spacing * this.posts.length;
    }
    this.render(); this.fresh = true;
  },
  render() {
    const c = this.c, W = this.W, H = this.H, gy = H * 0.8, t = this.t;
    c.save();
    c.translate(Math.sin(t * 7.3) * W * 0.003, Math.sin(t * 11.1) * H * 0.004 + Math.sin(t * 3.1) * H * 0.003);
    const sky = c.createLinearGradient(0, 0, 0, gy);
    sky.addColorStop(0, '#8fbfe0'); sky.addColorStop(1, '#dce9ef');
    c.fillStyle = sky; c.fillRect(-30, -30, W + 60, gy + 30);
    c.fillStyle = '#9fb3c3'; c.beginPath(); c.moveTo(-30, gy);
    for (let x = -30; x <= W + 30; x += 6) {
      const u = (x + this.farOff) / W;
      c.lineTo(x, H * 0.5 + Math.sin(u * 5.1) * H * 0.05 + Math.sin(u * 13.7 + 1) * H * 0.025);
    }
    c.lineTo(W + 30, gy); c.closePath(); c.fill();
    c.fillStyle = '#8a9a6c'; c.fillRect(-30, gy, W + 60, H);
    c.fillStyle = '#5d6462'; c.fillRect(-30, H * 0.9, W + 60, H);
    for (const o of this.objs) this.drawObj(c, o, gy);
    // near posts and a sagging wire: fast, close clutter the motion filter should ignore
    c.fillStyle = '#262b31';
    for (const px of this.posts) c.fillRect(px, H * 0.66, W * 0.018, H * 0.4);
    c.strokeStyle = 'rgba(30,30,32,0.7)'; c.lineWidth = 2; c.beginPath();
    const sorted = [...this.posts].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i] + W * 0.009, b = sorted[i + 1] + W * 0.009;
      c.moveTo(a, H * 0.67); c.quadraticCurveTo((a + b) / 2, H * 0.73, b, H * 0.67);
    }
    c.stroke();
    c.restore();
    const dark = smooth(0, 0.4, t - this.tunnelAt) * (1 - smooth(TUNNEL_LEN - 0.4, TUNNEL_LEN, t - this.tunnelAt));
    if (dark > 0) {
      c.fillStyle = `rgba(9,11,15,${0.96 * dark})`; c.fillRect(0, 0, W, H);
      // ceiling lights streaking past along the very top
      c.fillStyle = `rgba(255,196,110,${0.8 * dark})`;
      for (let x = -((t * W * 1.6) % (W * 0.3)); x < W; x += W * 0.3) c.fillRect(x, H * 0.025, W * 0.09, H * 0.012);
    }
    if (t - this.tunnelAt > TUNNEL_LEN) this.tunnelAt = t + 30 + this.rng() * 15;
  },
  drawObj(c, o, gy) {
    if (o.kind === 'building') {
      c.fillStyle = o.color; c.fillRect(o.x, gy - o.h, o.w, o.h);
      c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(o.x, gy - o.h, o.w, 4);
      const rr = mulberry32(o.seed);
      for (let y = gy - o.h + 10; y < gy - 14; y += 18) for (let x = o.x + 8; x < o.x + o.w - 12; x += 14) {
        c.fillStyle = rr() < 0.7 ? 'rgba(255,240,200,0.6)' : 'rgba(30,35,45,0.5)';
        c.fillRect(x, y, 7, 10);
      }
    } else if (o.kind === 'tree') {
      const cx = o.x + o.w / 2, rr = mulberry32(o.seed);
      c.fillStyle = '#5b4636'; c.fillRect(cx - o.w * 0.06, gy - o.h * 0.45, o.w * 0.12, o.h * 0.45);
      for (let i = 0; i < 7; i++) {
        c.fillStyle = i % 2 ? '#3e6538' : '#4f7d47';
        c.beginPath();
        c.arc(cx + (rr() - 0.5) * o.w * 0.5, gy - o.h * (0.55 + rr() * 0.25), o.w * (0.22 + rr() * 0.12), 0, Math.PI * 2);
        c.fill();
      }
    } else {
      const y = gy - o.h;
      c.fillStyle = o.color;
      c.fillRect(o.x, y + o.h * 0.35, o.w, o.h * 0.5);
      c.fillRect(o.x + o.w * 0.2, y, o.w * 0.55, o.h * 0.4);
      c.fillStyle = 'rgba(200,225,240,0.8)'; c.fillRect(o.x + o.w * 0.25, y + o.h * 0.07, o.w * 0.2, o.h * 0.27); c.fillRect(o.x + o.w * 0.5, y + o.h * 0.07, o.w * 0.2, o.h * 0.27);
      c.fillStyle = '#1e2126';
      c.beginPath(); c.arc(o.x + o.w * 0.22, gy - o.h * 0.1, o.h * 0.18, 0, 7); c.arc(o.x + o.w * 0.78, gy - o.h * 0.1, o.h * 0.18, 0, 7); c.fill();
    }
  }
};
