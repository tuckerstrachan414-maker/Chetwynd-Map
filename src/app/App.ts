import * as THREE from 'three';
import { Post } from '../engine/Post';
import { DynamicResolution, detectQuality, gpuName, QUALITY, QUALITY_LEVELS, saveQuality, type QualityLevel } from '../engine/Quality';
import { FlyController } from '../sim/FlyController';
import { Input } from '../sim/Input';
import { Physics } from '../sim/Physics';
import { Player } from '../sim/Player';
import { Hud } from '../ui/Hud';
import { Settings } from '../ui/Settings';
import { grassUniforms } from '../world/vegetation/Grass';
import type { BuildingRec } from '../world/buildings/BuildingGen';
import { WEATHERS, type WeatherKind } from '../world/Weather';
import { Bench } from './Bench';
import { type Mode, Modes } from './Modes';
import { readParams, type Params } from './params';
import { SEASONS, World } from './World';

declare global {
  interface Window {
    __cw?: { ready: boolean; stats: () => Record<string, unknown>; app: App };
  }
}

export type { Mode } from './Modes';

/** Browser storage can be unavailable (private windows, blocked site data). */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference lasts for this session */
  }
}

/** Top-level application: renderer, frame loop, control modes, physics and UI. */
export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly params: Params;
  private readonly timer = new THREE.Timer();
  world!: World;
  private post!: Post;
  private input!: Input;
  private hud!: Hud;
  private physics!: Physics;
  private player!: Player;
  private fly!: FlyController;
  private modes!: Modes;
  /** World time stands still (photo mode). */
  private paused = false;
  mode: Mode = 'walk';
  private spawned = false;
  private time = 0;
  private readyFrames = 0;
  private frameCount = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;
  /** Headless test: walk forward for this many seconds after spawning. */
  private autoWalk = 0;
  private walked = 0;
  private startModeDone = false;
  private quality: QualityLevel = 'high';
  private basePixelRatio = 1;
  private dynRes: DynamicResolution | null = null;
  private bench: Bench | null = null;
  private settings!: Settings;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: HTMLElement,
  ) {
    this.params = readParams();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      reversedDepthBuffer: true,
      preserveDrawingBuffer: this.params.headless,
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera = new THREE.PerspectiveCamera(this.params.fov, 1, 0.1, 200000);
    window.addEventListener('resize', () => this.resize());
    if (new URLSearchParams(location.search).has('gldebug')) this.installGlDebug();
  }

  /** Debug aid (?gldebug): report the first GL errors together with the material that drew. */
  private installGlDebug(): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    let reported = 0;
    const wrap = (name: 'drawElements' | 'drawArrays' | 'drawElementsInstanced' | 'drawArraysInstanced') => {
      const orig = (gl[name] as (...a: unknown[]) => void).bind(gl);
      (gl as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
        orig(...args);
        if (reported >= 12) return;
        const err = gl.getError();
        if (err === gl.NO_ERROR) return;
        reported++;
        const cur = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
        const progs = (this.renderer.info.programs ?? []) as unknown as { program: WebGLProgram; name: string; cacheKey: string }[];
        const p = progs.find((x) => x.program === cur);
        console.error(`GL error 0x${err.toString(16)} in ${name} program=${p?.name ?? '?'} key=${(p?.cacheKey ?? '').slice(0, 80)}`);
      };
    };
    wrap('drawElements');
    wrap('drawArrays');
    wrap('drawElementsInstanced');
    wrap('drawArraysInstanced');
  }

  async start(): Promise<void> {
    const p = this.params;
    this.hud = new Hud(this.ui);
    this.hud.setStartVisible(!p.headless);
    if (p.headless) this.hud.setVisible(false);
    // Quality: ?q=, else a saved choice or the GPU tier (headless tests render at High).
    this.quality = p.quality && (QUALITY_LEVELS as string[]).includes(p.quality) ? (p.quality as QualityLevel)
      : p.headless ? 'high' : detectQuality(this.renderer);
    const qs = QUALITY[this.quality];
    this.basePixelRatio = p.headless ? 1 : Math.min(window.devicePixelRatio, this.quality === 'ultra' ? 2 : 1.5);
    this.renderer.setPixelRatio(this.basePixelRatio * (p.headless ? 1 : qs.scale));
    this.world = new World(this.renderer, this.scene);
    const chunkR = Number(new URLSearchParams(location.search).get('chunkR') ?? 0);
    await this.world.init({ chunkRadius: chunkR || undefined });
    this.post = new Post(this.renderer, this.world.atmosphere, { msaa: p.headless ? 0 : qs.msaa, fxaa: p.headless || qs.fxaa, ao: qs.ao });
    this.physics = new Physics();
    await this.physics.init();
    this.player = new Player(this.physics);
    this.player.water = (x, z) => this.world.water.sample(x, z);
    this.input = new Input(this.canvas);
    this.fly = new FlyController(this.camera, this.canvas);
    this.fly.enabled = false;
    this.hud.onStartClick(() => {
      this.hud.setStartVisible(false);
      this.input.requestLock();
    });
    this.canvas.addEventListener('click', () => {
      // The editor and photo mode keep the cursor for their panels (right-drag looks around).
      if (this.mode !== 'photo' && this.mode !== 'edit' && !this.modes.menuOpen) this.input.requestLock();
    });

    const w = this.world;
    w.sky.year = p.date[0];
    w.sky.month = p.date[1];
    w.sky.day = p.date[2];
    w.sky.hour = p.hour;
    if (p.season && (SEASONS as readonly string[]).includes(p.season)) w.setSeason(p.season as (typeof SEASONS)[number]);
    if (p.weather && (WEATHERS as string[]).includes(p.weather)) w.weather.set(p.weather as WeatherKind, true);

    w.chunks.onChunkLoaded = (key, raw) => this.physics.addBuildings(key, (raw.buildings ?? []) as BuildingRec[]);
    w.chunks.onChunkUnloaded = (key) => this.physics.removeBuildings(key);
    w.roads.onColliders = (key, meshes) => this.physics.addMeshes(`road_${key}`, meshes);
    w.roads.onUnload = (key) => this.physics.removeMeshes(`road_${key}`);
    this.physics.addWalls([...w.fences.boxes.values()].flat());
    this.modes = new Modes({
      camera: this.camera, renderer: this.renderer, scene: this.scene, canvas: this.canvas, ui: this.ui, world: w,
      physics: this.physics, input: this.input, hud: this.hud, post: this.post, fly: this.fly,
      spawnWalker: (x, z, yaw) => this.spawnWalker(x, z, yaw),
      setPaused: (v) => (this.paused = v),
    });
    this.applyQuality(this.quality, !!chunkR);
    // Saved view preferences.
    const fov = Number(stored('cw.fov') ?? 0);
    if (fov >= 50 && fov <= 100 && !new URLSearchParams(location.search).has('fov')) this.setFov(fov);
    this.setSensitivity(Number(stored('cw.sens') ?? 1) || 1);
    const app = this.settingsHost();
    this.settings = new Settings(this.ui, app);
    if (new URLSearchParams(location.search).has('bench')) {
      this.bench = new Bench(gpuName(this.renderer), this.quality, Number(new URLSearchParams(location.search).get('bench')) || 70);
      this.hud.setVisible(false);
      this.hud.setStartVisible(false);
    }

    const [x, z] = p.at ?? [560, -330];
    this.camera.position.set(x, 1200, z);
    this.player.yaw = THREE.MathUtils.degToRad(-p.yaw);
    this.player.pitch = THREE.MathUtils.degToRad(p.pitch);
    this.fly.yaw = this.player.yaw;
    this.fly.pitch = this.player.pitch;
    const q = new URLSearchParams(location.search);
    this.autoWalk = Number(q.get('autowalk') ?? 0);
    this.mode = (p.headless && !this.autoWalk) || this.bench ? 'fly' : 'walk';
    this.hud.setMode(this.mode);

    window.__cw = { ready: false, stats: () => this.stats(), app: this };
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Apply a quality preset to everything that can change at run time. */
  private applyQuality(level: QualityLevel, keepChunkRadius = false): void {
    const q = QUALITY[level];
    this.quality = level;
    const w = this.world;
    if (w.sun.shadow.mapSize.x !== q.shadowMap) {
      w.sun.shadow.mapSize.set(q.shadowMap, q.shadowMap);
      w.sun.shadow.map?.dispose();
      w.sun.shadow.map = null;
    }
    this.post.settings.ao = q.ao;
    w.water.uniforms.uSSR.value = q.ssr ? 1 : 0;
    grassUniforms.uDensity.value = q.grass;
    w.forest.setRadii(q.treeNear, q.treeLod0, q.shrubs);
    if (!keepChunkRadius) {
      w.chunks.loadRadius = q.chunks;
      w.chunks.unloadRadius = q.chunks + 400;
    }
    this.dynRes = this.params.headless ? null : new DynamicResolution(q.targetMs);
    if (!this.params.headless) {
      this.renderer.setPixelRatio(this.basePixelRatio * q.scale);
      this.resize();
    }
  }

  private setFov(deg: number): void {
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
    if (this.modes) this.modes.baseFov = deg;
  }

  private setSensitivity(k: number): void {
    this.player.sensitivity = 0.0022 * k;
    this.fly.sensitivity = 0.0022 * k;
  }

  private settingsHost() {
    const app = () => this;
    return {
      get quality() { return app().quality; },
      gpu: gpuName(this.renderer),
      setQuality: (q: QualityLevel) => {
        saveQuality(q);
        this.applyQuality(q);
      },
      get fov() { return app().modes.baseFov; },
      setFov: (d: number) => {
        this.setFov(d);
        store('cw.fov', String(d));
      },
      get sensitivity() { return app().player.sensitivity / 0.0022; },
      setSensitivity: (s: number) => {
        this.setSensitivity(s);
        store('cw.sens', String(s));
      },
    };
  }

  stats(): Record<string, unknown> {
    const info = this.renderer.info;
    return {
      frame: this.frameCount,
      fps: Math.round(this.fps),
      calls: info.render.calls,
      tris: info.render.triangles,
      cam: this.camera.position.toArray().map((v) => Math.round(v * 10) / 10),
      mode: this.mode,
      walked: Math.round(this.walked * 10) / 10,
      player: this.player ? this.player.position.toArray().map((v) => Math.round(v * 100) / 100) : null,
      ground: Math.round(this.world.groundHeight(this.camera.position.x, this.camera.position.z) * 100) / 100,
      ...this.world.stats(),
    };
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const pr = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.post?.setSize(Math.floor(w * pr), Math.floor(h * pr));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Put the walker at (x, z) facing `yaw`; it lands on the ground once the terrain is there. */
  private spawnWalker(x: number, z: number, yaw: number): void {
    if (this.mode !== 'walk') this.setMode('walk');
    const g = this.world.groundHeight(x, z);
    this.camera.position.set(x, Number.isFinite(g) ? g + 1.7 : this.camera.position.y, z);
    this.player.yaw = yaw;
    this.player.pitch = 0;
    this.player.despawn();
    this.spawned = false;
  }

  setMode(m: Mode): void {
    if (m === this.mode) return;
    const from = this.mode;
    const next = this.modes.enter(m, from);
    if (next !== m) return;
    if (m !== 'walk' && m !== 'fly') {
      this.fly.enabled = m === 'photo' || m === 'edit';
      this.player.despawn();
      this.spawned = false;
      this.mode = m;
      this.hud.setMode(m);
      return;
    }
    if (from !== 'walk' && from !== 'fly') {
      // Coming back from another mode: face where its camera looked.
      const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.player.yaw = Math.atan2(-f.x, -f.z);
      this.player.pitch = 0;
      this.fly.yaw = this.player.yaw;
      this.fly.pitch = 0;
    }
    if (m === 'fly') {
      this.fly.yaw = this.player.yaw;
      this.fly.pitch = this.player.pitch;
      this.fly.enabled = true;
    } else {
      this.fly.enabled = false;
      const g = this.world.groundHeight(this.camera.position.x, this.camera.position.z);
      if (Number.isFinite(g)) this.player.spawn(this.camera.position.x, g, this.camera.position.z);
      this.player.yaw = this.fly.yaw;
      this.player.pitch = this.fly.pitch;
      this.spawned = Number.isFinite(g);
    }
    this.mode = m;
    this.hud.setMode(m);
  }

  private handleKeys(): void {
    const i = this.input;
    if (i.hit('KeyF')) this.setMode(this.mode === 'fly' ? 'walk' : 'fly');
    if (i.hit('KeyV')) this.setMode(this.mode === 'drive' ? 'walk' : 'drive');
    if (i.hit('KeyG')) this.setMode(this.mode === 'drone' ? 'walk' : 'drone');
    if (i.hit('KeyP')) this.setMode(this.mode === 'photo' ? (this.modes.photoFrom ?? 'walk') : 'photo');
    // E is yaw in the drone and up in fly mode, so the editor opens from walking.
    if (i.hit('KeyE') && (this.mode === 'walk' || this.mode === 'edit')) this.setMode(this.mode === 'edit' ? 'walk' : 'edit');
    if (i.hit('KeyN')) this.modes.toggleMenu();
    if (this.modes.menuOpen) for (let k = 1; k <= 9; k++) if (i.hit(`Digit${k}`)) this.modes.goto(k - 1);
    if (i.hit('KeyH')) this.hud.toggleHelp();
    if (i.hit('KeyO')) this.settings.toggle();
    if (i.hit('KeyT')) this.world.sky.hour = (this.world.sky.hour + (i.down('ShiftLeft') ? -1 : 1) + 24) % 24;
    if (i.hit('KeyU')) this.world.weather.cycle();
    if (i.hit('KeyY')) {
      const k = (SEASONS.indexOf(this.world.season) + 1) % SEASONS.length;
      this.world.setSeason(SEASONS[k]);
    }
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    if (!this.paused) this.time += dt;
    this.frameCount++;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    const p = this.params;
    this.input.pollGamepad();
    this.handleKeys();
    const cam = this.camera.position;

    if (this.mode === 'walk') {
      if (!this.spawned) {
        const g = this.world.groundHeight(cam.x, cam.z);
        if (Number.isFinite(g) && this.world.store.levelAt(cam.x, cam.z) === 0) {
          this.physics.updateTerrain(this.world.store, cam.x, cam.z);
          this.player.spawn(cam.x, g, cam.z);
          this.spawned = true;
        } else {
          cam.y = Number.isFinite(g) ? g + 1.7 : cam.y;
        }
      }
      if (this.spawned) {
        this.physics.updateTerrain(this.world.store, cam.x, cam.z);
        this.physics.updateTrunks(this.world.forest.treesNear(cam.x, cam.z, 45), cam.x, cam.z);
        if (this.autoWalk > 0 && this.walked < this.autoWalk) {
          this.input.keys.add('KeyW');
          this.walked += 1 / 30;
          this.player.update(1 / 30, this.input, this.camera);
        } else {
          this.input.keys.delete('KeyW');
          this.player.update(dt, this.input, this.camera);
        }
        this.physics.step();
      }
    } else if (this.mode !== 'fly') {
      this.modes.update(this.mode, dt, this.time);
    } else if (this.bench && this.world.ready) {
      this.bench.update(dt, this.camera, (x, z) => this.world.groundHeight(x, z), this.canvas);
    } else {
      this.fly.update(dt);
      const g = this.world.groundHeight(cam.x, cam.z);
      if (Number.isFinite(g)) {
        if (p.headless) cam.y = g + p.h;
        else if (cam.y < g + 0.5) cam.y = g + 0.5;
      }
    }
    this.camera.updateMatrixWorld();
    if (this.mode === 'walk' || this.mode === 'fly') this.world.playerFeet = this.mode === 'walk' && this.spawned ? this.player.position : null;
    else if (this.mode === 'photo' || this.mode === 'edit') this.world.playerFeet = null;
    this.world.update(this.camera, this.post, this.time);
    this.post.render(this.scene, this.camera, dt, this.time);
    this.input.endFrame();
    // Dynamic resolution holds the frame rate (not while composing a photo).
    if (this.dynRes && this.mode !== 'photo' && this.world.ready && this.dynRes.update(dt * 1000, dt)) {
      this.renderer.setPixelRatio(this.basePixelRatio * QUALITY[this.quality].scale * this.dynRes.scale);
      this.resize();
    }

    if (this.frameCount % 6 === 0) {
      const c = this.world.carvings.lookedAt(this.camera);
      if (c) {
        const award = [c.placed && `${c.placed} place`, c.awards].filter(Boolean).join(' · ');
        this.hud.setTooltip(`#${c.n} ${c.name || 'Chainsaw carving'}`, [
          [c.carver, c.country].filter(Boolean).join(', ') + (c.year ? ` (${c.year})` : ''),
          ...(award ? [award] : []),
          ...(c.location ? [c.location.replace(/\*$/, '')] : []),
        ]);
      } else this.hud.setTooltip(null);
    }
    if (this.frameCount % 15 === 0) {
      const s = this.world.forest.stats;
      const ms = this.modes.status(this.mode);
      this.hud.setStatus(`${Math.round(this.fps)} fps · ${this.world.season} · ${this.world.weather.kind} · ${String(Math.floor(this.world.sky.hour)).padStart(2, '0')}:${String(Math.floor((this.world.sky.hour % 1) * 60)).padStart(2, '0')} · trees ${s.lod0 + s.lod1}${ms ? ` · ${ms}` : ''}`);
    }
    const placed = Number.isFinite(this.world.groundHeight(cam.x, cam.z));
    const walkDone = !this.autoWalk || this.walked >= this.autoWalk;
    if (p.mode && this.world.ready && placed && this.mode !== p.mode && this.frameCount > 2 && !this.startModeDone) {
      this.startModeDone = true;
      this.setMode(p.mode as Mode);
    }
    if (this.world.ready && placed && walkDone) this.readyFrames++;
    else this.readyFrames = 0;
    if (this.readyFrames > 8 && window.__cw) window.__cw.ready = true;
  }
}
