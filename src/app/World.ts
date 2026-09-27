import * as THREE from 'three';
import type { Post } from '../engine/Post';
import type { FrameProfiler } from '../engine/FrameProfiler';
import { CulledInstances, CullView } from '../world/InstanceCull';
import { Atmosphere } from '../engine/sky/Atmosphere';
import { SkyEnvironment } from '../engine/sky/SkyEnvironment';
import { loadKtx2Array } from '../engine/textures/TextureArrays';
import { LightField, worldLightUniforms } from '../engine/WorldLight';
import { ChunkManager } from '../world/ChunkManager';
import { buildingUniforms, createFacadeMaterial, createRoofMaterial, createTrimMaterial } from '../world/buildings/BuildingMaterials';
import { Carvings } from '../world/props/Carvings';
import { Fences } from '../world/props/Fences';
import { PropManager, propUniforms } from '../world/props/PropManager';
import { RoadManager, roadUniforms } from '../world/roads/RoadManager';
import { SkyState, SUN_E } from '../world/SkyState';
import { Overrides } from '../world/Overrides';
import { Terrain } from '../world/terrain/Terrain';
import { Weather } from '../world/Weather';
import { TerrainIndex, type TerrainIndexJson } from '../world/terrain/TerrainIndex';
import { createTerrainMaterials, type ImageryInfo } from '../world/terrain/TerrainMaterial';
import { TerrainStore } from '../world/terrain/TerrainStore';
import { FallingLeaves } from '../world/vegetation/FallingLeaves';
import { Forest } from '../world/vegetation/Forest';
import { Grass } from '../world/vegetation/Grass';
import { TreeLibrary } from '../world/vegetation/TreeLibrary';
import { vegUniforms } from '../world/vegetation/TreeMaterials';
import { createRestoreMaterial } from '../world/water/WaterMaterial';
import { WATER_LAYER, WaterManager } from '../world/water/WaterManager';

export const WORLD = './world';

async function loadTexture(url: string, srgb = true): Promise<THREE.Texture> {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

const srgbToLin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/**
 * Albedo calibration of the photoscanned ground layers (by material ID) towards measured boreal
 * values: litter and moss floors are dark (~0.1), the stock scans are bright and orange.
 */
const GROUND_GAIN: Record<number, [number, number, number]> = {
  1: [0.9, 0.9, 0.9], // meadow
  2: [0.5, 0.53, 0.52], // deciduous forest floor
  3: [0.48, 0.53, 0.6], // conifer floor
  4: [0.62, 0.7, 0.85], // dirt: the scan is reddish; local silty clay is grey-brown
  9: [0.88, 0.88, 0.9], // cutbank
  11: [0.6, 0.63, 0.56], // moss
  13: [0.85, 0.85, 0.88], // stubble
  15: [0.85, 0.88, 0.95], // sand
};

export const SEASONS = ['summer', 'autumn', 'winter', 'spring'] as const;
export type Season = (typeof SEASONS)[number];

/** All world content and environment state: terrain, buildings, roads, forest, sky and sun. */
export class World {
  readonly sky = new SkyState();
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  readonly weather = new Weather();
  readonly overrides = new Overrides();
  readonly leaves = new FallingLeaves();
  lightField!: LightField;
  private lastTime = -1;
  store!: TerrainStore;
  terrain!: Terrain;
  chunks!: ChunkManager;
  roads!: RoadManager;
  props!: PropManager;
  carvings!: Carvings;
  fences!: Fences;
  forest!: Forest;
  grass!: Grass;
  /** Player feet position for grass interaction (null when not walking). */
  playerFeet: THREE.Vector3 | null = null;
  water!: WaterManager;
  private waterRestore!: THREE.Mesh;
  atmosphere!: Atmosphere;
  skyEnv!: SkyEnvironment;
  private complete = { terrain: false, chunks: false, forest: false, roads: false, water: false };
  /** The camera's view for per-instance culling (trees, props). */
  readonly cullView = new CullView();
  /** Frame profiler (sections per subsystem). */
  prof: FrameProfiler | null = null;
  season: Season = 'summer';
  private terrainUniforms: Record<string, THREE.IUniform> = {};

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
  ) {}

  async init(opts: { chunkRadius?: number; onProgress?: (label: string, frac: number) => void }): Promise<void> {
    // Report a step, then give the browser a frame to paint the loading bar before heavy work.
    const progress = async (label: string, frac: number) => {
      opts.onProgress?.(label, frac);
      await new Promise((r) => setTimeout(r, 16));
    };
    await progress('Loading terrain', 0.03);
    const [indexJson, imgJson] = await Promise.all([
      fetch(`${WORLD}/terrain/index.json`).then((r) => r.json() as Promise<TerrainIndexJson>),
      fetch(`${WORLD}/imagery/index.json`).then((r) => r.json() as Promise<Record<string, ImageryInfo>>),
    ]);
    const [near, root] = await Promise.all([loadTexture(`${WORLD}/imagery/near.jpg`), loadTexture(`${WORLD}/imagery/root.jpg`)]);
    const index = new TerrainIndex(indexJson);
    this.store = new TerrainStore(index, `${WORLD}/terrain`, 256, `${WORLD}/material`);
    const groundIndex = (await fetch('./assets/terrain/index.json').then((r) => r.json())) as {
      layers: { id: number; tile: number; mean: number[] }[];
    };
    const ids = groundIndex.layers.map((l) => String(l.id).padStart(2, '0'));
    await progress('Loading ground textures', 0.12);
    const [gA, gN] = await Promise.all([
      loadKtx2Array(this.renderer, ids.map((id) => `./assets/terrain/albedo_${id}.ktx2`), true),
      loadKtx2Array(this.renderer, ids.map((id) => `./assets/terrain/normal_${id}.ktx2`), false),
    ]);
    const layers = {
      albedo: gA,
      normal: gN,
      tiles: groundIndex.layers.map((l) => l.tile),
      means: groundIndex.layers.map((l) => new THREE.Vector3(srgbToLin(l.mean[0]), srgbToLin(l.mean[1]), srgbToLin(l.mean[2]))),
      gains: groundIndex.layers.map((l) => new THREE.Vector3(...(GROUND_GAIN[l.id] ?? [1, 1, 1]))),
    };
    const mats = createTerrainMaterials(this.terrainUniforms, near, root, imgJson.near, imgJson.root, layers, this.store.matAtlas);
    this.terrain = new Terrain(index, this.store, mats.material, mats.depth);
    Object.assign(this.terrainUniforms, this.terrain.uniforms);
    this.scene.add(this.terrain.mesh);

    await progress('Loading buildings and roads', 0.3);
    const chunkIndex = await fetch(`${WORLD}/chunks/index.json`).then((r) => r.json());
    this.chunks = new ChunkManager(chunkIndex, `${WORLD}/chunks`, {
      facade: createFacadeMaterial(),
      roof: createRoofMaterial(),
      trim: createTrimMaterial(),
    });
    if (opts.chunkRadius) {
      this.chunks.loadRadius = opts.chunkRadius;
      this.chunks.unloadRadius = opts.chunkRadius + 400;
    }
    this.scene.add(this.chunks.root);

    const roadIndex = (await fetch(`${WORLD}/roads/index.json`).then((r) => r.json())) as { size: number; half: number; chunks: string[] };
    this.roads = new RoadManager(`${WORLD}/roads`, gA, gN, layers.tiles, roadIndex.half, roadIndex.size, new Set(roadIndex.chunks));
    this.scene.add(this.roads.root);

    await progress('Placing street furniture, fences and carvings', 0.38);
    await this.overrides.load(`${WORLD}/overrides.json`);
    this.props = new PropManager(`${WORLD}/props`);
    await this.props.init();
    this.props.applyOverrides(this.overrides);
    this.scene.add(this.props.root);
    // Street lights pool light onto everything around them at night.
    this.lightField = new LightField();
    this.lightField.setLights(this.props.lampLights());
    this.scene.add(this.weather.root);
    this.fences = new Fences(`${WORLD}/props/fences.json`);
    await this.fences.init();
    this.fences.applyOverrides(this.overrides);
    this.scene.add(this.fences.root);
    this.carvings = new Carvings(`${WORLD}/props/carvings.json`);
    await this.carvings.init();
    this.scene.add(this.carvings.root);

    await progress('Growing the trees', 0.48);
    const trees = new TreeLibrary(this.renderer);
    await trees.init();
    await progress('Planting the forest', 0.72);
    const vegIndex = await fetch(`${WORLD}/veg/index.json`).then((r) => r.json());
    this.forest = new Forest(trees, vegIndex, `${WORLD}/veg`);
    this.forest.applyOverrides(this.overrides);
    this.scene.add(this.forest.root);
    this.scene.add(this.leaves.mesh);
    // Editor changes apply live.
    this.overrides.onChange(() => {
      this.props.applyOverrides(this.overrides);
      this.forest.applyOverrides(this.overrides);
      this.fences.applyOverrides(this.overrides);
      this.lightField.setLights(this.props.lampLights());
    });
    this.grass = new Grass(this.store);
    this.scene.add(this.grass.root);

    this.atmosphere = new Atmosphere();
    this.skyEnv = new SkyEnvironment(this.renderer, this.atmosphere);

    await progress('Filling the rivers', 0.8);
    this.water = new WaterManager(`${WORLD}/water`);
    await this.water.init();
    this.water.uniforms.uHaze = this.atmosphere.haze;
    this.water.uniforms.uDebug.value = Number(new URLSearchParams(location.search).get('wdebug') ?? 0);
    this.water.uniforms.tSkySun.value = this.atmosphere.skyViewSun.texture;
    this.water.uniforms.tSkyMoon.value = this.atmosphere.skyViewMoon.texture;
    this.water.uniforms.uTransmittance.value = this.atmosphere.transmittance.texture;
    this.scene.add(this.water.root);
    // Restores the resolved opaque colour before water is drawn (see Post.render).
    this.waterRestore = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), createRestoreMaterial());
    this.waterRestore.frustumCulled = false;
    this.waterRestore.renderOrder = -1000;
    this.waterRestore.layers.set(WATER_LAYER);
    this.scene.add(this.waterRestore);

    // The shadow pass draws the near trees whose shadows reach the view, the camera only those in it.
    const sm = this.renderer.shadowMap as unknown as { render: (...a: unknown[]) => void };
    const shadowRender = sm.render.bind(this.renderer.shadowMap);
    sm.render = (...a: unknown[]) => {
      CulledInstances.beginShadowPass();
      this.terrain.shadowMesh.visible = true;
      try {
        shadowRender(...a);
      } finally {
        CulledInstances.endShadowPass();
        this.terrain.shadowMesh.visible = false;
      }
    };
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = -160;
    sc.right = 160;
    sc.top = 160;
    sc.bottom = -160;
    sc.near = 1;
    sc.far = 4000;
    sc.updateProjectionMatrix();
    const reversed = this.renderer.state.buffers.depth.getReversed();
    this.sun.shadow.bias = reversed ? 0.0003 : -0.0003;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
  }

  get ready(): boolean {
    const c = this.complete;
    return c.terrain && c.chunks && c.forest && c.roads && c.water;
  }

  groundHeight(x: number, z: number): number {
    return this.store.heightAt(x, z);
  }

  setSeason(s: Season): void {
    this.season = s;
    const k = SEASONS.indexOf(s);
    this.forest.setSeason(k);
    this.water.setSeason(k);
    this.grass.setSeason(k);
    this.props.setSeason(k);
    const snow = s === 'winter' ? 1 : 0;
    vegUniforms.uSnow.value = snow;
    buildingUniforms.uSnow.value = snow;
    roadUniforms.uSnow.value = snow;
    this.terrainUniforms.uSnow.value = snow;
  }

  /** Per-frame environment and streaming update. `focus` is where content streams around. */
  update(camera: THREE.PerspectiveCamera, post: Post, time: number): void {
    const dt = this.lastTime < 0 ? 0 : THREE.MathUtils.clamp(time - this.lastTime, 0, 0.25);
    this.lastTime = time;
    // Weather first: it sets the haze the sky is computed with.
    const pr = this.prof;
    pr?.begin('sky');
    pr?.gpu('sky');
    const wx = this.weather.update(dt, time, camera.position, this.sky.lightDir, this.sky.lightColor, this.season === 'winter');
    this.atmosphere.haze.value = wx.haze;
    roadUniforms.uWet.value = wx.wet;
    worldLightUniforms.uWLWet.value = wx.wet;
    this.water.uniforms.uRain.value = wx.rain;
    // Faint sodium/LED sky glow of the town on the cloud base at night.
    worldLightUniforms.uCloudGlow.value.set(1.0, 0.64, 0.38).multiplyScalar(0.00035 * this.sky.night * wx.cover);
    const altKm = Math.max(camera.position.y / 1000, 0.01);
    this.sky.update(altKm, this.atmosphere.haze.value);
    this.atmosphere.update(this.renderer, camera, this.sky.sunDir, this.sky.moonDir, this.sky.lightDir);
    const cu = post.composite.uniforms;
    (cu.uSunDir.value as THREE.Vector3).copy(this.sky.sunDir);
    (cu.uMoonDir.value as THREE.Vector3).copy(this.sky.moonDir);
    cu.uSunE.value = SUN_E;
    cu.uMoonE.value = this.sky.moonE;
    cu.uApE.value = this.sky.lightDir.equals(this.sky.sunDir) ? SUN_E : this.sky.moonE;
    cu.uStars.value = this.sky.night * 0.02;
    if (this.skyEnv.update(this.sky.sunDir, this.sky.moonDir, SUN_E, this.sky.moonE, altKm)) {
      this.scene.environment = this.skyEnv.texture;
    }
    // Sun/moon light with a shadow frustum snapped to texels around the camera.
    const cam = camera.position;
    this.sun.color.copy(this.sky.lightColor);
    this.sun.intensity = 1;
    const texel = (this.sun.shadow.camera.right * 2) / this.sun.shadow.mapSize.x;
    this.sun.target.position.set(Math.round(cam.x / texel) * texel, cam.y, Math.round(cam.z / texel) * texel);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sky.lightDir, 2000);
    this.sun.target.updateMatrixWorld();

    pr?.gpuStop();
    pr?.end('sky');
    pr?.begin('terrain');
    // This frame's sun shadow volume (the renderer recomputes the same matrices for the shadow pass).
    this.sun.updateMatrixWorld();
    this.sun.shadow.updateMatrices(this.sun);
    this.terrain.update(camera, this.sun.shadow.getFrustum());
    this.complete.terrain = this.terrain.complete;
    pr?.end('terrain');
    pr?.begin('buildings');
    this.complete.chunks = this.chunks.update(cam);
    pr?.end('buildings');
    pr?.begin('trees');
    this.complete.forest = this.forest.update(cam);
    this.cullView.update(camera, this.sky.lightDir);
    this.forest.cull(this.cullView);
    pr?.end('trees');
    pr?.begin('grass');
    this.grass.update(camera, this.playerFeet);
    pr?.end('grass');
    pr?.begin('props');
    this.props.update(cam);
    this.props.cull(this.cullView);
    pr?.end('props');
    propUniforms.uNight.value = this.sky.night;
    propUniforms.uTime.value = time;
    // Photocells switch the street lights on at dusk, together with the lens glow.
    pr?.begin('lights');
    pr?.gpu('lights');
    this.lightField.update(this.renderer, cam, THREE.MathUtils.smoothstep(this.sky.night, 0.25, 0.6));
    pr?.gpuStop();
    pr?.end('lights');
    post.final.uniforms.uNight.value = this.sky.night;
    // Autumn leaves drifting down from nearby aspens, poplars and birches.
    const season = SEASONS.indexOf(this.season);
    const lu = this.leaves.uniforms;
    (lu.uSun.value as THREE.Color).copy(this.sky.lightColor).multiplyScalar(Math.max(this.sky.lightDir.y, 0));
    (lu.uSunDir.value as THREE.Vector3).copy(this.sky.lightDir);
    (lu.uAmb.value as THREE.Color).copy(this.sky.lightColor).multiplyScalar(0.05 + 0.1 * Math.max(this.sky.lightDir.y, 0));
    (lu.uWind.value as THREE.Vector2).copy(this.weather.wind);
    pr?.begin('leaves');
    this.leaves.update(cam, time, season === 1 || season === 0, () => this.forest.deciduousNear(cam.x, cam.z, 45, season));
    pr?.end('leaves');
    pr?.begin('roads');
    this.complete.roads = this.roads.update(cam);
    pr?.end('roads');
    pr?.begin('water');
    this.complete.water = this.water.update(cam);
    this.updateWater(camera, post, time);
    pr?.end('water');
    vegUniforms.uTime.value = time;
    buildingUniforms.uTime.value = time;
    buildingUniforms.uNight.value = this.sky.night;
    buildingUniforms.uInterior.value = 0.08 + 0.35 * THREE.MathUtils.clamp(this.sky.sunDir.y * 3, 0, 1);
  }

  private updateWater(camera: THREE.PerspectiveCamera, post: Post, time: number): void {
    const u = this.water.uniforms;
    // Underwater view: the composite fogs everything through the water column.
    const ws = this.water.sample(camera.position.x, camera.position.z);
    const under = ws !== null && !ws.frozen && camera.position.y < ws.level - 0.02;
    const cu = post.composite.uniforms;
    cu.uUnder.value = under ? 1 : 0;
    if (under) {
      const lc = this.sky.lightColor;
      const e = (Math.max(this.sky.lightDir.y, 0) + 0.35) / Math.PI;
      (cu.uUnderDeep.value as THREE.Vector3).set(0.024 * lc.r * e, 0.034 * lc.g * e, 0.021 * lc.b * e);
      const turbid = 1 + 1.6 * (u.uTurbid.value as number);
      (cu.uUnderSigma.value as THREE.Vector3).set(0.62 * turbid, 0.3 * turbid, 0.38 * turbid);
    }
    post.secondPass = this.water.inView(camera);
    (this.waterRestore.material as THREE.ShaderMaterial).uniforms.tSrc.value = post.refrColor.texture;
    u.tRefr.value = post.refrColor.texture;
    u.tDepthC.value = post.refrDepth.texture;
    (u.uProj.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (u.uResolution.value as THREE.Vector2).set(post.pixelWidth, post.pixelHeight);
    u.uReversed.value = post.reversed ? 1 : 0;
    u.uTime.value = time;
    u.uViewAltKm.value = Math.max(camera.position.y / 1000, 0.01);
    (u.uSunDir.value as THREE.Vector3).copy(this.sky.sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(this.sky.moonDir);
    u.uSunE.value = SUN_E;
    u.uMoonE.value = this.sky.moonE;
    (u.uLightDir.value as THREE.Vector3).copy(this.sky.lightDir);
    (u.uLightColor.value as THREE.Color).copy(this.sky.lightColor);
    const sm = this.sun.shadow.map;
    if (sm?.depthTexture) {
      u.uShadowMap.value = sm.depthTexture;
      u.uShadowOn.value = 1;
    }
    u.uShadowMatrix.value = this.sun.shadow.matrix;
  }

  /** Vehicle low beams from a chassis (+X forward); pass null to switch them off. */
  setHeadlights(root: THREE.Object3D | null, night: number): void {
    const u = worldLightUniforms;
    if (!root) {
      u.uHeadK.value = 0;
      return;
    }
    root.updateMatrixWorld();
    const e = root.matrixWorld.elements;
    const f = new THREE.Vector3(e[0], e[1], e[2]).normalize();
    const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
    const right = new THREE.Vector3(e[8], e[9], e[10]).normalize();
    u.uHeadPos.value.copy(new THREE.Vector3(2.95, 0.12, 0).applyMatrix4(root.matrixWorld));
    u.uHeadMat.value.set(f.x, f.y, f.z, up.x, up.y, up.z, right.x, right.y, right.z);
    u.uHeadK.value = THREE.MathUtils.smoothstep(night, 0.15, 0.55) + (this.weather.kind === 'fog' || this.weather.kind === 'rain' || this.weather.kind === 'snow' ? 0.35 : 0);
  }

  stats(): Record<string, unknown> {
    return { terrain: this.terrain.stats, chunks: this.chunks.stats, forest: this.forest.stats, water: this.water.stats };
  }
}
