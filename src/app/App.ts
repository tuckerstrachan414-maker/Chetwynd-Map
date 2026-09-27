import * as THREE from 'three';
import { Post } from '../engine/Post';
import { Atmosphere } from '../engine/sky/Atmosphere';
import { SkyEnvironment } from '../engine/sky/SkyEnvironment';
import { FlyController } from '../sim/FlyController';
import { SkyState, SUN_E } from '../world/SkyState';
import { Terrain } from '../world/terrain/Terrain';
import { TerrainIndex, type TerrainIndexJson } from '../world/terrain/TerrainIndex';
import { createTerrainMaterials, type ImageryInfo } from '../world/terrain/TerrainMaterial';
import { TerrainStore } from '../world/terrain/TerrainStore';
import { readParams, type Params } from './params';

const WORLD = './world';

declare global {
  interface Window {
    __cw?: { ready: boolean; stats: () => Record<string, unknown>; app: App };
  }
}

async function loadTexture(url: string, srgb = true): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Top-level application: owns renderer, scene, camera and the frame loop. */
export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly params: Params;
  readonly sky = new SkyState();
  private readonly timer = new THREE.Timer();
  private atmosphere!: Atmosphere;
  private post!: Post;
  private skyEnv!: SkyEnvironment;
  private terrain!: Terrain;
  private store!: TerrainStore;
  private controller!: FlyController;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private time = 0;
  private readyFrames = 0;
  private placed = false;
  private frameCount = 0;

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.params.headless ? 1 : 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.camera = new THREE.PerspectiveCamera(this.params.fov, 1, 0.1, 200000);
    window.addEventListener('resize', () => this.resize());
  }

  async start(): Promise<void> {
    const p = this.params;
    const [indexJson, imgJson] = await Promise.all([
      fetch(`${WORLD}/terrain/index.json`).then((r) => r.json() as Promise<TerrainIndexJson>),
      fetch(`${WORLD}/imagery/index.json`).then((r) => r.json() as Promise<Record<string, ImageryInfo>>),
    ]);
    const [near, root] = await Promise.all([loadTexture(`${WORLD}/imagery/near.jpg`), loadTexture(`${WORLD}/imagery/root.jpg`)]);
    const index = new TerrainIndex(indexJson);
    this.store = new TerrainStore(index, `${WORLD}/terrain`, 256);
    const uniforms: Record<string, THREE.IUniform> = {};
    const mats = createTerrainMaterials(uniforms, near, root, imgJson.near, imgJson.root);
    this.terrain = new Terrain(index, this.store, mats.material, mats.depth);
    Object.assign(uniforms, this.terrain.uniforms);
    this.scene.add(this.terrain.mesh);

    this.atmosphere = new Atmosphere();
    this.post = new Post(this.renderer, this.atmosphere, { msaa: p.headless ? 0 : 4, fxaa: p.headless });
    this.skyEnv = new SkyEnvironment(this.renderer, this.atmosphere);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -160;
    sc.right = 160;
    sc.top = 160;
    sc.bottom = -160;
    sc.near = 1;
    sc.far = 4000;
    const reversed = this.renderer.state.buffers.depth.getReversed();
    this.sun.shadow.bias = reversed ? 0.0003 : -0.0003;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.sky.year = p.date[0];
    this.sky.month = p.date[1];
    this.sky.day = p.date[2];
    this.sky.hour = p.hour;

    const [x, z] = p.at ?? [300, -600];
    this.camera.position.set(x, 1200, z);
    this.controller = new FlyController(this.camera, this.canvas);
    this.controller.yaw = THREE.MathUtils.degToRad(-p.yaw);
    this.controller.pitch = THREE.MathUtils.degToRad(p.pitch);
    this.controller.enabled = !p.headless;

    window.__cw = { ready: false, stats: () => this.stats(), app: this };
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  stats(): Record<string, unknown> {
    const info = this.renderer.info;
    return {
      frame: this.frameCount,
      calls: info.render.calls,
      tris: info.render.triangles,
      terrain: this.terrain.stats,
      cam: this.camera.position.toArray().map((v) => Math.round(v * 10) / 10),
      level: this.store.levelAt(this.camera.position.x, this.camera.position.z),
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

  private placeCamera(): void {
    const c = this.camera.position;
    const g = this.store.heightAt(c.x, c.z);
    if (!Number.isFinite(g)) return;
    if (!this.placed || this.params.headless) {
      c.y = g + this.params.h;
      this.placed = true;
    } else if (c.y < g + 0.5) {
      c.y = g + 0.5;
    }
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    this.frameCount++;
    this.controller.update(dt);
    this.placeCamera();
    this.camera.updateMatrixWorld();

    const altKm = Math.max(this.camera.position.y / 1000, 0.01);
    this.sky.update(altKm, this.atmosphere.haze.value);
    this.atmosphere.update(this.renderer, this.camera, this.sky.sunDir, this.sky.moonDir, this.sky.lightDir);
    const cu = this.post.composite.uniforms;
    (cu.uSunDir.value as THREE.Vector3).copy(this.sky.sunDir);
    (cu.uMoonDir.value as THREE.Vector3).copy(this.sky.moonDir);
    cu.uSunE.value = SUN_E;
    cu.uMoonE.value = this.sky.moonE;
    cu.uApE.value = this.sky.lightDir.equals(this.sky.sunDir) ? SUN_E : this.sky.moonE;
    cu.uStars.value = this.sky.night * 0.02;
    if (this.skyEnv.update(this.sky.sunDir, this.sky.moonDir, SUN_E, this.sky.moonE, altKm)) {
      this.scene.environment = this.skyEnv.texture;
    }

    // Sun/moon directional light with a shadow frustum snapped to texels around the camera.
    const cam = this.camera.position;
    this.sun.color.copy(this.sky.lightColor);
    this.sun.intensity = 1;
    const texel = (this.sun.shadow.camera.right * 2) / this.sun.shadow.mapSize.x;
    const tx = Math.round(cam.x / texel) * texel;
    const tz = Math.round(cam.z / texel) * texel;
    this.sun.target.position.set(tx, cam.y, tz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sky.lightDir, 2000);
    this.sun.target.updateMatrixWorld();

    this.terrain.update(this.camera);
    this.post.render(this.scene, this.camera, dt, this.time);

    if (this.terrain.complete && this.placed) this.readyFrames++;
    else this.readyFrames = 0;
    if (this.readyFrames > 8 && window.__cw) window.__cw.ready = true;
    this.ui.dataset.frame = String(this.frameCount);
  }
}
