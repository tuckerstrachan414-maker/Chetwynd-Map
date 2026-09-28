import * as THREE from 'three';

/**
 * The camera's view frustum and the sun direction, flattened for fast per-instance tests.
 * `version` changes whenever either moved, so unchanged views cost nothing.
 */
export class CullView {
  readonly planes = new Float32Array(24);
  /** Horizontal shadow sweep per metre of drop along the light, and the longest drop considered. */
  sx = 0;
  sz = 0;
  maxDrop = 160;
  version = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly lastProj = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly lastLight = new THREE.Vector3();

  update(camera: THREE.PerspectiveCamera, lightDir: THREE.Vector3): void {
    this.proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this.proj.equals(this.lastProj) && lightDir.equals(this.lastLight)) return;
    this.lastProj.copy(this.proj);
    this.lastLight.copy(lightDir);
    this.version++;
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    this.frustum.planes.forEach((p, i) => {
      this.planes[i * 4] = p.normal.x;
      this.planes[i * 4 + 1] = p.normal.y;
      this.planes[i * 4 + 2] = p.normal.z;
      this.planes[i * 4 + 3] = p.constant;
    });
    const ly = Math.max(lightDir.y, 0.1);
    this.sx = -lightDir.x / ly;
    this.sz = -lightDir.z / ly;
    // Shadows longer than the shadow map's reach (160 m) cannot matter.
    this.maxDrop = 160 / Math.max(Math.hypot(this.sx, this.sz), 1e-3);
  }

  /** Sphere (x, y, z, r) touches the view. */
  inView(x: number, y: number, z: number, r: number): boolean {
    const pn = this.planes;
    for (let p = 0; p < 24; p += 4) if (pn[p] * x + pn[p + 1] * y + pn[p + 2] * z + pn[p + 3] < -r) return false;
    return true;
  }

  /** The shadow of a sphere whose centre is `drop` m above the ground can fall into the view. */
  shadowReaches(x: number, y: number, z: number, r: number, drop: number): boolean {
    const k = Math.min(drop, this.maxDrop);
    const tx = x + this.sx * k, ty = y - k, tz = z + this.sz * k;
    const pn = this.planes;
    for (let p = 0; p < 24; p += 4) {
      const da = pn[p] * x + pn[p + 1] * y + pn[p + 2] * z + pn[p + 3];
      const db = pn[p] * tx + pn[p + 1] * ty + pn[p + 2] * tz + pn[p + 3];
      if (da < -r && db < -r) return false;
    }
    return true;
  }
}

interface Channel {
  attr: THREE.InstancedBufferAttribute;
  src: Float32Array;
  size: number;
}

const BND = 5;
let visIdx = new Int32Array(1024);
let shIdx = new Int32Array(1024);
const registry = new Set<CulledInstances>();

/**
 * InstancedMeshes that draw the same instances (the parts of one model), culled per instance:
 * the camera draws the instances in view; the sun's shadow map also draws those whose shadow can
 * reach the view. Instances are appended to master arrays; each cull writes the selection (in view
 * first, then shadow casters) to the meshes, uploading only the used range and only on change.
 * Empty meshes are hidden so they cost no draw call.
 */
export class CulledInstances {
  n = 0;
  main = 0;
  shadow = 0;
  readonly mat: Float32Array;
  /** Per instance: bounding sphere centre x, y, z, radius, and the centre's height above the ground. */
  readonly bnd: Float32Array;
  private readonly channels: Channel[] = [];
  private readonly order: Int32Array;
  private seen = -1;
  private dirty = true;

  constructor(readonly meshes: THREE.InstancedMesh[], readonly cap: number) {
    this.mat = new Float32Array(cap * 16);
    this.bnd = new Float32Array(cap * BND);
    this.order = new Int32Array(cap).fill(-1);
    const shared = meshes[0].instanceMatrix;
    shared.setUsage(THREE.DynamicDrawUsage);
    for (const m of meshes) {
      m.instanceMatrix = shared;
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
    }
    registry.add(this);
  }

  /** A further per-instance attribute that follows the instance order (colours, atlas rows, ...). */
  channel(attr: THREE.InstancedBufferAttribute): Float32Array {
    attr.setUsage(THREE.DynamicDrawUsage);
    const src = new Float32Array(this.cap * attr.itemSize);
    this.channels.push({ attr, src, size: attr.itemSize });
    return src;
  }

  clear(): void {
    this.n = 0;
    this.dirty = true;
  }

  /** Append an instance; returns its index for channel values, or -1 when full. */
  add(m: THREE.Matrix4, x: number, y: number, z: number, r: number, drop: number): number {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    m.toArray(this.mat, i * 16);
    const o = i * BND;
    this.bnd[o] = x;
    this.bnd[o + 1] = y;
    this.bnd[o + 2] = z;
    this.bnd[o + 3] = r;
    this.bnd[o + 4] = drop;
    this.dirty = true;
    return i;
  }

  cull(view: CullView): void {
    if (!this.dirty && this.seen === view.version) return;
    const rewrite = this.dirty;
    this.dirty = false;
    this.seen = view.version;
    if (visIdx.length < this.n) {
      visIdx = new Int32Array(this.cap);
      shIdx = new Int32Array(this.cap);
    }
    const b = this.bnd;
    let v = 0;
    let sh = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * BND;
      if (view.inView(b[o], b[o + 1], b[o + 2], b[o + 3])) visIdx[v++] = i;
      else if (view.shadowReaches(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4])) shIdx[sh++] = i;
    }
    const total = v + sh;
    // The same selection in the same order: nothing to upload.
    let same = !rewrite && total === this.shadow && v === this.main;
    for (let a = 0; same && a < v; a++) same = this.order[a] === visIdx[a];
    for (let a = 0; same && a < sh; a++) same = this.order[v + a] === shIdx[a];
    this.main = v;
    this.shadow = total;
    this.setCount(v);
    if (same) return;
    const dm = this.meshes[0].instanceMatrix.array as Float32Array;
    for (let j = 0; j < total; j++) {
      const i = j < v ? visIdx[j] : shIdx[j - v];
      this.order[j] = i;
      const s = i * 16, d = j * 16;
      for (let c = 0; c < 16; c++) dm[d + c] = this.mat[s + c];
      for (const ch of this.channels) {
        const arr = ch.attr.array as Float32Array;
        for (let c = 0; c < ch.size; c++) arr[j * ch.size + c] = ch.src[i * ch.size + c];
      }
    }
    if (total === 0) return;
    const attrs: [THREE.InstancedBufferAttribute, number][] = [[this.meshes[0].instanceMatrix, 16], ...this.channels.map((c) => [c.attr, c.size] as [THREE.InstancedBufferAttribute, number])];
    for (const [attr, size] of attrs) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, total * size);
      attr.needsUpdate = true;
    }
  }

  private setCount(c: number): void {
    for (const m of this.meshes) {
      m.count = c;
      m.visible = c > 0 || CulledInstances.forceVisible;
    }
  }

  /** Keep empty meshes visible (the shader warm-up draws everything once). */
  static forceVisible = false;

  dispose(): void {
    registry.delete(this);
  }

  /** Around the sun's shadow pass: draw the shadow casters too, then only what is in view again. */
  static beginShadowPass(): void {
    // Parts that cast no shadow are skipped by the shadow pass itself.
    for (const ci of registry) ci.setCount(ci.shadow);
  }

  static endShadowPass(): void {
    for (const ci of registry) ci.setCount(ci.main);
  }
}
