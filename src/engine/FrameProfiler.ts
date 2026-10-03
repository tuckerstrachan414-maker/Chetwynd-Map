import type * as THREE from 'three';

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

interface FrameQuery {
  q: WebGLQuery;
  name: string;
}

export interface Hitch {
  /** Seconds since the profiler started. */
  t: number;
  ms: number;
  /** The biggest CPU sections of that frame, and shader programs compiled in it. */
  what: string;
}

export interface ProfileSummary {
  frames: number;
  /** Average frame interval (ms). */
  frameMs: number;
  /** Average main-thread CPU time per frame, by section (ms). */
  cpu: Record<string, number>;
  /** Average GPU time per frame, by section (ms); null when the browser has no GPU timer queries. */
  gpu: Record<string, number> | null;
  /** Average draw calls per frame, by pass and scene part. */
  draws: Record<string, number>;
  /** Average triangles per frame by pass and scene part (with draw counting on). */
  trisBy: Record<string, number>;
  tris: number;
  programs: number;
  hitches: Hitch[];
}

const HITCH_MS = 50;
/** GPU timer queries run on one frame in this many. */
const GPU_EVERY = 12;

/**
 * Where the frame time goes: main-thread CPU sections, GPU time per pass (EXT_disjoint_timer_query_webgl2,
 * where the browser offers it), draw calls per pass and scene part, and a log of long frames.
 * GPU queries cannot nest, so `gpu(name)` switches the running section.
 *
 * Timer queries are not free: on ANGLE/Direct3D 11 each one splits the GPU's command stream, and a frame
 * with dozens of them (one per post pass, two per shadow-map check) ran several times slower on an
 * integrated GPU. So GPU timing only runs on sampled frames (one in GPU_EVERY): per section while
 * profiling (?prof, ?bench), else one query around the whole frame when dynamic resolution needs the
 * GPU time (`timeFrames`). `excludeFrame` marks the frames a sample disturbed, which the benchmark skips.
 */
export class FrameProfiler {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt | null;
  /** One query around the whole frame when not profiling in detail (feeds dynamic resolution). */
  timeFrames = false;
  private frameQuery: WebGLQuery | null = null;
  private frameNo = 0;
  /** This frame runs GPU timer queries. */
  private sampling = false;
  /** Frames left that a recent GPU sample may still be slowing down. */
  private disturbed = 0;
  /** The frame just measured was disturbed by GPU timing (statistics should skip it). */
  excludeFrame = false;
  private readonly pool: WebGLQuery[] = [];
  private readonly inflight: FrameQuery[][] = [];
  private frameQueries: FrameQuery[] = [];
  private active: FrameQuery | null = null;
  private gpuName = '';
  private readonly cpuOpen = new Map<string, number>();
  private readonly cpuFrame = new Map<string, number>();
  private readonly cats = new WeakMap<THREE.Object3D, string>();
  /** Current pass label for draw counting. */
  pass = 'main';
  private readonly t0 = performance.now();
  private programsSeen = 0;
  /** GPU time of the most recently measured frame (ms); NaN until timer results arrive or without the extension. */
  lastGpuMs = NaN;
  /** Main-thread CPU time of the last frame (the 'frame' section, ms). */
  lastCpuMs = 0;

  // Accumulators since the last summary.
  private frames = 0;
  private frameMsSum = 0;
  private readonly cpuSum = new Map<string, number>();
  private readonly gpuSum = new Map<string, number>();
  private gpuFrames = 0;
  /** Draws and triangles by pass, then scene part (no allocation per draw). */
  private readonly counts = new Map<string, Map<string, { draws: number; tris: number }>>();
  private trisSum = 0;
  private hitches: Hitch[] = [];

  /** `detailed`: count draw calls by pass and scene part and time GPU sections (on for ?prof and the benchmark). */
  constructor(private readonly renderer: THREE.WebGLRenderer, private readonly detailed: boolean) {
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    // Triangle counts cover the whole frame (all passes); frameStart() resets them.
    renderer.info.autoReset = false;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    this.programsSeen = renderer.info.programs?.length ?? 0;
    if (detailed) {
      type Draw = (cam: unknown, scene: unknown, geo: unknown, mat: unknown, obj: THREE.Object3D, group: unknown) => void;
      const r = renderer as unknown as { renderBufferDirect: Draw };
      const orig = r.renderBufferDirect.bind(renderer);
      r.renderBufferDirect = (cam: unknown, scene: unknown, geo: unknown, mat: unknown, obj: THREE.Object3D, group: unknown) => {
        let byCat = this.counts.get(this.pass);
        if (!byCat) this.counts.set(this.pass, (byCat = new Map()));
        const cat = this.category(obj);
        let c = byCat.get(cat);
        if (!c) byCat.set(cat, (c = { draws: 0, tris: 0 }));
        c.draws++;
        const t0 = this.renderer.info.render.triangles;
        orig(cam, scene, geo, mat, obj, group);
        c.tris += this.renderer.info.render.triangles - t0;
      };
    }
    // Shadow maps render inside renderer.render(): give them their own sections. Every render call
    // (each post pass too) goes through here, so only calls with shadow-casting lights are timed.
    const sm = renderer.shadowMap as unknown as { render: (lights: unknown[], ...a: unknown[]) => void };
    const origShadow = sm.render.bind(renderer.shadowMap);
    sm.render = (lights: unknown[], ...a: unknown[]) => {
      if (!lights.length || (!renderer.shadowMap.autoUpdate && !renderer.shadowMap.needsUpdate)) {
        origShadow(lights, ...a);
        return;
      }
      const prevPass = this.pass;
      const prevGpu = this.gpuName;
      this.pass = 'shadow';
      this.gpu('shadow');
      this.begin('shadow');
      origShadow(lights, ...a);
      this.end('shadow');
      this.pass = prevPass;
      if (prevGpu) this.gpu(prevGpu);
      else this.gpuStop();
    };
  }

  get hasGpuTimer(): boolean {
    return this.ext !== null;
  }

  /** The top-level scene node an object belongs to (terrain, forest, chunks, ...). */
  private category(o: THREE.Object3D): string {
    let c = this.cats.get(o);
    if (c) return c;
    let n: THREE.Object3D = o;
    while (n.parent && n.parent.parent) n = n.parent;
    c = n.parent ? n.name || n.type : 'post';
    this.cats.set(o, c);
    return c;
  }

  begin(name: string): void {
    this.cpuOpen.set(name, performance.now());
  }

  end(name: string): void {
    const s = this.cpuOpen.get(name);
    if (s === undefined) return;
    this.cpuOpen.delete(name);
    this.cpuFrame.set(name, (this.cpuFrame.get(name) ?? 0) + performance.now() - s);
  }

  /** Start timing GPU work under `name`, ending the running section (only while profiling in detail). */
  gpu(name: string): void {
    if (!this.ext || !this.detailed || !this.sampling) {
      this.gpuName = name;
      return;
    }
    const gl = this.gl;
    if (this.active) gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    const q = this.pool.pop() ?? gl.createQuery();
    if (!q) return;
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { q, name };
    this.frameQueries.push(this.active);
    this.gpuName = name;
  }

  gpuStop(): void {
    if (this.ext && this.active) this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = null;
    this.gpuName = '';
  }

  frameStart(): void {
    this.cpuFrame.clear();
    this.renderer.info.reset();
    this.pass = 'main';
    // The interval measured at this frame's start belongs to the previous frame.
    this.excludeFrame = this.disturbed > 0;
    if (this.disturbed > 0) this.disturbed--;
    this.sampling = this.ext !== null && (this.detailed || this.timeFrames) && this.frameNo++ % GPU_EVERY === 0;
    if (this.sampling) this.disturbed = 2;
    // Without detailed profiling, a single query times the whole frame for dynamic resolution.
    if (this.ext && !this.detailed && this.timeFrames && this.sampling) {
      this.frameQuery = this.pool.pop() ?? this.gl.createQuery();
      if (this.frameQuery) this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.frameQuery);
    }
  }

  /** `frameMs`: the real interval since the last frame. */
  frameEnd(frameMs: number): void {
    this.gpuStop();
    if (this.frameQuery && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.frameQueries.push({ q: this.frameQuery, name: 'frame' });
      this.frameQuery = null;
    }
    if (this.frameQueries.length) this.inflight.push(this.frameQueries);
    this.frameQueries = [];
    this.collectGpu();
    this.frames++;
    this.frameMsSum += frameMs;
    this.lastCpuMs = this.cpuFrame.get('frame') ?? 0;
    for (const [k, v] of this.cpuFrame) this.cpuSum.set(k, (this.cpuSum.get(k) ?? 0) + v);
    this.trisSum += this.renderer.info.render.triangles;
    const programs = this.renderer.info.programs?.length ?? 0;
    const compiled = programs - this.programsSeen;
    this.programsSeen = programs;
    if (frameMs > HITCH_MS && this.hitches.length < 40) {
      const top = [...this.cpuFrame].filter(([k]) => k !== 'frame').sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k} ${v.toFixed(0)}`);
      if (compiled > 0) top.unshift(`${compiled} shader${compiled > 1 ? 's' : ''} compiled`);
      this.hitches.push({ t: Math.round((performance.now() - this.t0) / 100) / 10, ms: Math.round(frameMs), what: top.join(', ') });
    }
  }

  /** Read finished GPU queries (results arrive a frame or more later). */
  private collectGpu(): void {
    if (!this.ext) return;
    const gl = this.gl;
    while (this.inflight.length) {
      const f = this.inflight[0];
      const last = f[f.length - 1];
      if (!gl.getQueryParameter(last.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.inflight.shift();
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        let total = 0;
        for (const { q, name } of f) {
          const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
          total += ms;
          this.gpuSum.set(name, (this.gpuSum.get(name) ?? 0) + ms);
        }
        this.lastGpuMs = total;
        this.gpuFrames++;
      }
      for (const { q } of f) this.pool.push(q);
    }
    // Never let the backlog grow without bound (e.g. a lost context).
    while (this.inflight.length > 8) for (const { q } of this.inflight.shift()!) this.pool.push(q);
  }

  private flatten(f: 'draws' | 'tris'): Map<string, number> {
    const out = new Map<string, number>();
    for (const [pass, byCat] of this.counts) for (const [cat, c] of byCat) if (c[f]) out.set(`${pass}:${cat}`, c[f]);
    return out;
  }

  /** Averages since the last call; `reset` starts a new window. */
  summary(reset = true): ProfileSummary {
    const n = Math.max(1, this.frames);
    const avg = (m: Map<string, number>, d: number) => {
      const o: Record<string, number> = {};
      for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) o[k] = Math.round((v / d) * 100) / 100;
      return o;
    };
    const s: ProfileSummary = {
      frames: this.frames,
      frameMs: Math.round((this.frameMsSum / n) * 100) / 100,
      cpu: avg(this.cpuSum, n),
      gpu: this.ext && this.gpuFrames ? avg(this.gpuSum, this.gpuFrames) : null,
      draws: avg(this.flatten('draws'), n),
      trisBy: avg(this.flatten('tris'), n),
      tris: Math.round(this.trisSum / n),
      programs: this.renderer.info.programs?.length ?? 0,
      hitches: [...this.hitches],
    };
    if (reset) {
      this.frames = 0;
      this.frameMsSum = 0;
      this.cpuSum.clear();
      this.gpuSum.clear();
      this.gpuFrames = 0;
      this.counts.clear();
      this.trisSum = 0;
      this.hitches = [];
    }
    return s;
  }
}
