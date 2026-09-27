import * as THREE from 'three';
import type { Post } from '../engine/Post';
import { Atmosphere } from '../engine/sky/Atmosphere';
import { SkyEnvironment } from '../engine/sky/SkyEnvironment';
import { loadKtx2Array } from '../engine/textures/TextureArrays';
import { ChunkManager } from '../world/ChunkManager';
import { buildingUniforms, createFacadeMaterial, createRoofMaterial, createTrimMaterial } from '../world/buildings/BuildingMaterials';
import { RoadManager, roadUniforms } from '../world/roads/RoadManager';
import { SkyState, SUN_E } from '../world/SkyState';
import { Terrain } from '../world/terrain/Terrain';
import { TerrainIndex, type TerrainIndexJson } from '../world/terrain/TerrainIndex';
import { createTerrainMaterials, type ImageryInfo } from '../world/terrain/TerrainMaterial';
import { TerrainStore } from '../world/terrain/TerrainStore';
import { Forest } from '../world/vegetation/Forest';
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

export const SEASONS = ['summer', 'autumn', 'winter', 'spring'] as const;
export type Season = (typeof SEASONS)[number];

/** All world content and environment state: terrain, buildings, roads, forest, sky and sun. */
export class World {
  readonly sky = new SkyState();
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  store!: TerrainStore;
  terrain!: Terrain;
  chunks!: ChunkManager;
  roads!: RoadManager;
  forest!: Forest;
  water!: WaterManager;
  private waterRestore!: THREE.Mesh;
  atmosphere!: Atmosphere;
  skyEnv!: SkyEnvironment;
  private complete = { terrain: false, chunks: false, forest: false, roads: false, water: false };
  season: Season = 'summer';
  private terrainUniforms: Record<string, THREE.IUniform> = {};

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
  ) {}

  async init(opts: { chunkRadius?: number }): Promise<void> {
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
    const [gA, gN] = await Promise.all([
      loadKtx2Array(this.renderer, ids.map((id) => `./assets/terrain/albedo_${id}.ktx2`), true),
      loadKtx2Array(this.renderer, ids.map((id) => `./assets/terrain/normal_${id}.ktx2`), false),
    ]);
    const layers = {
      albedo: gA,
      normal: gN,
      tiles: groundIndex.layers.map((l) => l.tile),
      means: groundIndex.layers.map((l) => new THREE.Vector3(srgbToLin(l.mean[0]), srgbToLin(l.mean[1]), srgbToLin(l.mean[2]))),
    };
    const mats = createTerrainMaterials(this.terrainUniforms, near, root, imgJson.near, imgJson.root, layers, this.store.matAtlas);
    this.terrain = new Terrain(index, this.store, mats.material, mats.depth);
    Object.assign(this.terrainUniforms, this.terrain.uniforms);
    this.scene.add(this.terrain.mesh);

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

    const trees = new TreeLibrary(this.renderer);
    await trees.init();
    const vegIndex = await fetch(`${WORLD}/veg/index.json`).then((r) => r.json());
    this.forest = new Forest(trees, vegIndex, `${WORLD}/veg`);
    this.scene.add(this.forest.root);

    this.atmosphere = new Atmosphere();
    this.skyEnv = new SkyEnvironment(this.renderer, this.atmosphere);

    this.water = new WaterManager(`${WORLD}/water`);
    await this.water.init();
    this.water.uniforms.uHaze = this.atmosphere.haze;
    this.water.uniforms.uDebug.value = Number(new URLSearchParams(location.search).get('wdebug') ?? 0);
    this.water.uniforms.tSkySun.value = this.atmosphere.skyViewSun.texture;
    this.water.uniforms.tSkyMoon.value = this.atmosphere.skyViewMoon.texture;
    this.scene.add(this.water.root);
    // Restores the resolved opaque colour before water is drawn (see Post.render).
    this.waterRestore = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), createRestoreMaterial());
    this.waterRestore.frustumCulled = false;
    this.waterRestore.renderOrder = -1000;
    this.waterRestore.layers.set(WATER_LAYER);
    this.scene.add(this.waterRestore);

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
    const snow = s === 'winter' ? 1 : 0;
    vegUniforms.uSnow.value = snow;
    buildingUniforms.uSnow.value = snow;
    roadUniforms.uSnow.value = snow;
    this.terrainUniforms.uSnow.value = snow;
  }

  /** Per-frame environment and streaming update. `focus` is where content streams around. */
  update(camera: THREE.PerspectiveCamera, post: Post, time: number): void {
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

    this.terrain.update(camera);
    this.complete.terrain = this.terrain.complete;
    this.complete.chunks = this.chunks.update(cam);
    this.complete.forest = this.forest.update(cam);
    this.complete.roads = this.roads.update(cam);
    this.complete.water = this.water.update(cam);
    this.updateWater(camera, post, time);
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
    post.secondPass = this.water.visible;
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

  stats(): Record<string, unknown> {
    return { terrain: this.terrain.stats, chunks: this.chunks.stats, forest: this.forest.stats, water: this.water.stats };
  }
}
