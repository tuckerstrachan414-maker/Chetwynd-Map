import * as THREE from 'three';
import { Post } from '../engine/Post';
import { FlyController } from '../sim/FlyController';
import { Input } from '../sim/Input';
import { Physics } from '../sim/Physics';
import { Player } from '../sim/Player';
import { Hud } from '../ui/Hud';
import type { BuildingRec } from '../world/buildings/BuildingGen';
import { readParams, type Params } from './params';
import { SEASONS, World } from './World';

declare global {
  interface Window {
    __cw?: { ready: boolean; stats: () => Record<string, unknown>; app: App };
  }
}

export type Mode = 'walk' | 'fly';

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.params.headless ? 1 : 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera = new THREE.PerspectiveCamera(this.params.fov, 1, 0.1, 200000);
    window.addEventListener('resize', () => this.resize());
  }

  async start(): Promise<void> {
    const p = this.params;
    this.hud = new Hud(this.ui);
    this.hud.setStartVisible(!p.headless);
    if (p.headless) this.hud.setVisible(false);
    this.world = new World(this.renderer, this.scene);
    const chunkR = Number(new URLSearchParams(location.search).get('chunkR') ?? 0);
    await this.world.init({ chunkRadius: chunkR || undefined });
    this.post = new Post(this.renderer, this.world.atmosphere, { msaa: p.headless ? 0 : 4, fxaa: p.headless });
    this.physics = new Physics();
    await this.physics.init();
    this.player = new Player(this.physics);
    this.input = new Input(this.canvas);
    this.fly = new FlyController(this.camera, this.canvas);
    this.fly.enabled = false;
    this.hud.onStartClick(() => {
      this.hud.setStartVisible(false);
      this.input.requestLock();
    });
    this.canvas.addEventListener('click', () => this.input.requestLock());

    const w = this.world;
    w.sky.year = p.date[0];
    w.sky.month = p.date[1];
    w.sky.day = p.date[2];
    w.sky.hour = p.hour;
    if (p.season && (SEASONS as readonly string[]).includes(p.season)) w.setSeason(p.season as (typeof SEASONS)[number]);

    w.chunks.onChunkLoaded = (key, raw) => this.physics.addBuildings(key, (raw.buildings ?? []) as BuildingRec[]);
    w.chunks.onChunkUnloaded = (key) => this.physics.removeBuildings(key);

    const [x, z] = p.at ?? [560, -330];
    this.camera.position.set(x, 1200, z);
    this.player.yaw = THREE.MathUtils.degToRad(-p.yaw);
    this.player.pitch = THREE.MathUtils.degToRad(p.pitch);
    this.fly.yaw = this.player.yaw;
    this.fly.pitch = this.player.pitch;
    const q = new URLSearchParams(location.search);
    this.autoWalk = Number(q.get('autowalk') ?? 0);
    this.mode = p.headless && !this.autoWalk ? 'fly' : 'walk';
    this.hud.setMode(this.mode);

    window.__cw = { ready: false, stats: () => this.stats(), app: this };
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
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

  setMode(m: Mode): void {
    if (m === this.mode) return;
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
    }
    this.mode = m;
    this.hud.setMode(m);
  }

  private handleKeys(): void {
    const i = this.input;
    if (i.hit('KeyF')) this.setMode(this.mode === 'fly' ? 'walk' : 'fly');
    if (i.hit('KeyH')) this.hud.toggleHelp();
    if (i.hit('KeyT')) this.world.sky.hour = (this.world.sky.hour + (i.down('ShiftLeft') ? -1 : 1) + 24) % 24;
    if (i.hit('KeyY')) {
      const k = (SEASONS.indexOf(this.world.season) + 1) % SEASONS.length;
      this.world.setSeason(SEASONS[k]);
    }
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
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
    } else {
      this.fly.update(dt);
      const g = this.world.groundHeight(cam.x, cam.z);
      if (Number.isFinite(g)) {
        if (p.headless) cam.y = g + p.h;
        else if (cam.y < g + 0.5) cam.y = g + 0.5;
      }
    }
    this.camera.updateMatrixWorld();
    this.world.update(this.camera, this.post, this.time);
    this.post.render(this.scene, this.camera, dt, this.time);
    this.input.endFrame();

    if (this.frameCount % 15 === 0) {
      const s = this.world.forest.stats;
      this.hud.setStatus(`${Math.round(this.fps)} fps · ${this.world.season} · ${String(Math.floor(this.world.sky.hour)).padStart(2, '0')}:${String(Math.round((this.world.sky.hour % 1) * 60)).padStart(2, '0')} · trees ${s.lod0 + s.lod1}`);
    }
    const placed = Number.isFinite(this.world.groundHeight(cam.x, cam.z));
    const walkDone = !this.autoWalk || this.walked >= this.autoWalk;
    if (this.world.ready && placed && walkDone) this.readyFrames++;
    else this.readyFrames = 0;
    if (this.readyFrames > 8 && window.__cw) window.__cw.ready = true;
  }
}
