import * as THREE from 'three';
import type { FrameProfiler, ProfileSummary } from '../engine/FrameProfiler';

/**
 * ?bench (or ?bench=<seconds> to shorten it): a fixed 70 s camera route (street level downtown, the Windrem Creek greenbelt, a low pass
 * over the Pine River, then a high view of the valley) that records every frame time and reports
 * average FPS and 1 % / 0.1 % lows, FPS per stretch of the route, and where the frame time went
 * (main-thread CPU and GPU time by section, draw calls, long frames). Shown on screen and copied to the clipboard.
 */
const ROUTE: { x: number; z: number; h: number; t: number; leg: string }[] = [
  { x: -1300, z: -620, h: 1.7, t: 0, leg: 'downtown' },
  { x: -880, z: -790, h: 1.7, t: 12, leg: 'downtown' },
  { x: -300, z: -620, h: 1.7, t: 22, leg: 'greenbelt' },
  { x: 240, z: -330, h: 1.7, t: 32, leg: 'greenbelt' },
  { x: 700, z: -600, h: 25, t: 40, leg: 'river' },
  { x: 1400, z: 600, h: 60, t: 50, leg: 'river' },
  { x: 2900, z: 3500, h: 120, t: 60, leg: 'valley' },
  { x: 1000, z: -800, h: 400, t: 70, leg: 'valley' },
];

export interface BenchResult {
  avgFps: number;
  low1: number;
  low01: number;
  frames: number;
  gpu: string;
  resolution: string;
  quality: string;
  /** Average FPS per stretch of the route. */
  legs: Record<string, number>;
  /** Longest single frame (ms). */
  worstMs: number;
  profile: ProfileSummary | null;
}

export class Bench {
  private times: number[] = [];
  private readonly legTimes = new Map<string, number[]>();
  private t = -2; // warm-up seconds before recording
  done = false;
  result: BenchResult | null = null;

  /** Route time scale (1 = the full 70 s). */
  private readonly k: number;

  constructor(private readonly gpu: string, private readonly quality: string, seconds = 70) {
    this.k = Math.max(0.05, seconds / ROUTE[ROUTE.length - 1].t);
  }

  /**
   * Advance the route and place the camera. `dt` drives the route (clamped by the caller); `frameMs`
   * is the real interval since the last frame, recorded as is so long frames count in full.
   */
  update(dt: number, frameMs: number, camera: THREE.PerspectiveCamera, ground: (x: number, z: number) => number, canvas: HTMLCanvasElement,
    prof?: FrameProfiler): void {
    if (this.done) return;
    const wasWarm = this.t <= 0;
    this.t += dt;
    if (this.t > 0 && wasWarm) prof?.summary(true); // start the profile with the route
    const tt = Math.max(0, this.t) / this.k;
    let i = 0;
    while (i < ROUTE.length - 2 && ROUTE[i + 1].t < tt) i++;
    const a = ROUTE[i], b = ROUTE[i + 1];
    // Frames slowed by the profiler's sampled GPU timing are left out of the frame-rate statistics.
    if (this.t > 0 && !wasWarm && !prof?.excludeFrame) {
      this.times.push(frameMs);
      const leg = this.legTimes.get(a.leg) ?? [];
      leg.push(frameMs);
      this.legTimes.set(a.leg, leg);
    }
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
    if (tt >= ROUTE[ROUTE.length - 1].t) this.finish(canvas, prof);
  }

  private finish(canvas: HTMLCanvasElement, prof?: FrameProfiler): void {
    this.done = true;
    const s = [...this.times].sort((p, q) => q - p);
    const total = this.times.reduce((p, q) => p + q, 0);
    const pct = (f: number) => {
      const n = Math.max(1, Math.floor(s.length * f));
      return 1000 / (s.slice(0, n).reduce((p, q) => p + q, 0) / n);
    };
    const r1 = (v: number) => Math.round(v * 10) / 10;
    const legs: Record<string, number> = {};
    for (const [name, t] of this.legTimes) legs[name] = r1((t.length / t.reduce((p, q) => p + q, 0)) * 1000);
    this.result = {
      avgFps: r1((this.times.length / total) * 1000),
      low1: r1(pct(0.01)),
      low01: r1(pct(0.001)),
      frames: this.times.length,
      gpu: this.gpu,
      resolution: `${canvas.width}x${canvas.height}`,
      quality: this.quality,
      legs,
      worstMs: Math.round(s[0] ?? 0),
      profile: prof ? prof.summary(true) : null,
    };
    const r = this.result;
    if (typeof document === 'undefined') return;
    const text = benchText(r);
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);background:rgba(10,14,20,.92);color:#eef;padding:18px 22px;border-radius:10px;font:15px/1.5 system-ui,sans-serif;z-index:30;max-width:min(640px,calc(100vw - 32px))';
    el.innerHTML = `<b>Benchmark complete</b><br>${r.avgFps} fps average · ${r.low1} fps 1% low · ${r.low01} fps 0.1% low<br><small>${r.frames} frames at ${r.resolution}, ${r.quality} quality<br>${r.gpu}</small><br><small>The full report (with where the frame time went) is copied to the clipboard.</small>`;
    document.body.appendChild(el);
    navigator.clipboard?.writeText(text).catch(() => {});
    console.info(text);
  }
}

/** One-paragraph report: the headline numbers, then the breakdown a developer needs. */
export function benchText(r: BenchResult): string {
  const top = (o: Record<string, number>, n: number) => Object.entries(o).filter(([k]) => k !== 'frame').slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ');
  const parts = [
    `Chetwynd 3D benchmark: ${r.avgFps} fps average, ${r.low1} fps 1% low, ${r.low01} fps 0.1% low (${r.frames} frames, ${r.resolution}, ${r.quality} quality, ${r.gpu})`,
    `legs: ${Object.entries(r.legs).map(([k, v]) => `${k} ${v}`).join(', ')}; worst frame ${r.worstMs} ms`,
  ];
  const p = r.profile;
  if (p) {
    parts.push(`CPU ${(p.cpu.frame ?? 0).toFixed(1)} ms/frame (${top(p.cpu, 8)})`);
    if (p.gpu) {
      const g = Object.values(p.gpu).reduce((a, b) => a + b, 0);
      parts.push(`GPU ${g.toFixed(1)} ms/frame (${top(p.gpu, 8)})`);
    } else parts.push('GPU timer n/a');
    const draws = Object.values(p.draws).reduce((a, b) => a + b, 0);
    parts.push(`draws ${Math.round(draws)} (${Object.entries(p.draws).slice(0, 8).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}), ${(p.tris / 1e6).toFixed(1)} M tris, ${p.programs} programs`);
    if (p.hitches.length) {
      const worst = [...p.hitches].sort((a, b) => b.ms - a.ms).slice(0, 4);
      parts.push(`long frames ${p.hitches.length}: ${worst.map((h) => `${h.ms} ms at ${h.t}s (${h.what})`).join('; ')}`);
    }
  }
  return parts.join(' | ');
}
