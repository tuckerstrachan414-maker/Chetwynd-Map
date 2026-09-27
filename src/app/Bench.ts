import * as THREE from 'three';

/**
 * ?bench (or ?bench=<seconds> to shorten it): a fixed 70 s camera route (street level downtown, the Windrem Creek greenbelt, a low pass
 * over the Pine River, then a high view of the valley) that records every frame time and reports
 * average FPS and 1 % / 0.1 % lows. Shown on screen and copied to the clipboard.
 */
const ROUTE: { x: number; z: number; h: number; t: number }[] = [
  { x: -1300, z: -620, h: 1.7, t: 0 },
  { x: -880, z: -790, h: 1.7, t: 12 },
  { x: -300, z: -620, h: 1.7, t: 22 },
  { x: 240, z: -330, h: 1.7, t: 32 },
  { x: 700, z: -600, h: 25, t: 40 },
  { x: 1400, z: 600, h: 60, t: 50 },
  { x: 2900, z: 3500, h: 120, t: 60 },
  { x: 1000, z: -800, h: 400, t: 70 },
];

export interface BenchResult {
  avgFps: number;
  low1: number;
  low01: number;
  frames: number;
  gpu: string;
  resolution: string;
  quality: string;
}

export class Bench {
  private times: number[] = [];
  private t = -2; // warm-up seconds before recording
  done = false;
  result: BenchResult | null = null;

  /** Route time scale (1 = the full 70 s). */
  private readonly k: number;

  constructor(private readonly gpu: string, private readonly quality: string, seconds = 70) {
    this.k = Math.max(0.05, seconds / ROUTE[ROUTE.length - 1].t);
  }

  /** Advance the route; place the camera. `ground` gives terrain height. */
  update(dt: number, camera: THREE.PerspectiveCamera, ground: (x: number, z: number) => number, canvas: HTMLCanvasElement): void {
    if (this.done) return;
    this.t += dt;
    if (this.t > 0) this.times.push(dt * 1000);
    const tt = Math.max(0, this.t) / this.k;
    let i = 0;
    while (i < ROUTE.length - 2 && ROUTE[i + 1].t < tt) i++;
    const a = ROUTE[i], b = ROUTE[i + 1];
    const k = THREE.MathUtils.smootherstep(Math.min(1, (tt - a.t) / (b.t - a.t)), 0, 1);
    const x = THREE.MathUtils.lerp(a.x, b.x, k);
    const z = THREE.MathUtils.lerp(a.z, b.z, k);
    const g = ground(x, z);
    const y = (Number.isFinite(g) ? g : camera.position.y) + THREE.MathUtils.lerp(a.h, b.h, k);
    camera.position.set(x, y, z);
    // Look ahead along the route, slightly down when high.
    const ax = b.x - a.x, az = b.z - a.z;
    const pitch = -Math.atan2(THREE.MathUtils.lerp(a.h, b.h, k), 600) * 0.8;
    camera.rotation.set(pitch, Math.atan2(-ax, -az), 0, 'YXZ');
    if (tt >= ROUTE[ROUTE.length - 1].t) this.finish(canvas);
  }

  private finish(canvas: HTMLCanvasElement): void {
    this.done = true;
    const s = [...this.times].sort((p, q) => q - p);
    const total = this.times.reduce((p, q) => p + q, 0);
    const pct = (f: number) => {
      const n = Math.max(1, Math.floor(s.length * f));
      return 1000 / (s.slice(0, n).reduce((p, q) => p + q, 0) / n);
    };
    this.result = {
      avgFps: Math.round((this.times.length / total) * 1000 * 10) / 10,
      low1: Math.round(pct(0.01) * 10) / 10,
      low01: Math.round(pct(0.001) * 10) / 10,
      frames: this.times.length,
      gpu: this.gpu,
      resolution: `${canvas.width}x${canvas.height}`,
      quality: this.quality,
    };
    const r = this.result;
    if (typeof document === 'undefined') return;
    const text = `Chetwynd 3D benchmark: ${r.avgFps} fps average, ${r.low1} fps 1% low, ${r.low01} fps 0.1% low (${r.frames} frames, ${r.resolution}, ${r.quality} quality, ${r.gpu})`;
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);background:rgba(10,14,20,.92);color:#eef;padding:18px 22px;border-radius:10px;font:15px/1.5 system-ui,sans-serif;z-index:30;max-width:min(560px,calc(100vw - 32px))';
    el.innerHTML = `<b>Benchmark complete</b><br>${r.avgFps} fps average · ${r.low1} fps 1% low · ${r.low01} fps 0.1% low<br><small>${r.frames} frames at ${r.resolution}, ${r.quality} quality<br>${r.gpu}</small><br><small>Copied to the clipboard.</small>`;
    document.body.appendChild(el);
    navigator.clipboard?.writeText(text).catch(() => {});
    console.info(text);
  }
}
