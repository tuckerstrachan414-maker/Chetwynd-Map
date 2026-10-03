import * as THREE from 'three';
import { CASCADES } from '../engine/CascadedShadows';

/** Versions are unique across views, so a culler never mistakes one view for another. */
let viewVersions = 0;

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
  /** The eye: instances are ordered by distance from it, nearest first. */
  readonly eye = new THREE.Vector3();
  /** Per shadow cascade: casters farther than this from the eye cannot reach its slice (m). */
  readonly reach = new Float32Array(CASCADES).fill(1e9);
  /** How far shadows reach from the eye (m): longer shadows cannot matter. */
  shadowRange = 160;
  /** Per shadow cascade: its light frustum's planes (24 floats each), current for the cascades in `dueMask`. */
  readonly cascadePlanes = new Float32Array(CASCADES * 24);
  /** Bit c set: cascade c is redrawn this frame (its caster set must be current). */
  dueMask = 0;
  private readonly frustum = new THREE.Frustum();
  private readonly proj = new THREE.Matrix4();
  private readonly lastProj = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly lastLight = new THREE.Vector3();

  /**
   * The cascades the shadow pass redraws this frame and their light frustums. A cascade whose frustum
   * moved changes `version` too, so per-cascade caster sets are rebuilt even when the camera is still.
   */
  setCascades(frustums: readonly THREE.Frustum[], due: readonly number[]): void {
    let mask = 0;
    let moved = false;
    const cp = this.cascadePlanes;
    for (const c of due) {
      mask |= 1 << c;
      const planes = frustums[c].planes;
      for (let i = 0; i < 6; i++) {
        const p = planes[i];
        const o = c * 24 + i * 4;
        if (cp[o] !== p.normal.x || cp[o + 1] !== p.normal.y || cp[o + 2] !== p.normal.z || cp[o + 3] !== p.constant) {
          cp[o] = p.normal.x;
          cp[o + 1] = p.normal.y;
          cp[o + 2] = p.normal.z;
          cp[o + 3] = p.constant;
          moved = true;
        }
      }
    }
    this.dueMask = mask;
    if (moved) this.version = ++viewVersions;
  }

  /** Sphere (x, y, z, r) touches cascade c's light frustum. */
  inCascade(c: number, x: number, y: number, z: number, r: number): boolean {
    const pn = this.cascadePlanes;
    const o = c * 24;
    for (let p = o; p < o + 24; p += 4) if (pn[p] * x + pn[p + 1] * y + pn[p + 2] * z + pn[p + 3] < -r) return false;
    return true;
  }

  /** `projection`: the camera's projection without the TAA jitter (which would make every frame a new view). */
  update(camera: THREE.PerspectiveCamera, lightDir: THREE.Vector3, reach?: ArrayLike<number>, shadowRange?: number,
    projection: THREE.Matrix4 = camera.projectionMatrix): void {
    if (reach) for (let i = 0; i < CASCADES; i++) this.reach[i] = reach[i];
    if (shadowRange !== undefined) this.shadowRange = shadowRange;
    this.proj.multiplyMatrices(projection, camera.matrixWorldInverse);
    if (this.proj.equals(this.lastProj) && lightDir.equals(this.lastLight)) return;
    this.lastProj.copy(this.proj);
    this.lastLight.copy(lightDir);
    this.version = ++viewVersions;
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    this.frustum.setFromProjectionMatrix(this.proj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    const planes = this.frustum.planes;
    for (let i = 0; i < 6; i++) {
      const p = planes[i];
      this.planes[i * 4] = p.normal.x;
      this.planes[i * 4 + 1] = p.normal.y;
      this.planes[i * 4 + 2] = p.normal.z;
      this.planes[i * 4 + 3] = p.constant;
    }
    const ly = Math.max(lightDir.y, 0.1);
    this.sx = -lightDir.x / ly;
    this.sz = -lightDir.z / ly;
    // Shadows longer than the shadow maps reach cannot matter.
    this.maxDrop = this.shadowRange / Math.max(Math.hypot(this.sx, this.sz), 1e-3);
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

/**
 * Strict shadow-caster culling for static streamed meshes (merged building chunks, roads, fences,
 * carvings): before each shadow pass, every caster that is neither in view nor able to throw its
 * shadow into the view is switched off for that pass, so nothing behind the camera fills the cascades.
 * (Each cascade's frustum test then trims the rest per tile.)
 */
export class ShadowCasterCull {
  private readonly roots: THREE.Object3D[] = [];
  private readonly off: THREE.Object3D[] = [];
  /** Casters skipped in the last shadow pass. */
  skipped = 0;

  add(...roots: THREE.Object3D[]): void {
    this.roots.push(...roots);
  }

  begin(view: CullView): void {
    this.off.length = 0;
    for (const root of this.roots) this.visit(root, view);
    this.skipped = this.off.length;
  }

  end(): void {
    for (const o of this.off) o.castShadow = true;
    this.off.length = 0;
  }

  private visit(o: THREE.Object3D, view: CullView): void {
    if (!o.visible) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.castShadow) {
      const s = this.worldSphere(m);
      if (s && !view.inView(s.center.x, s.center.y, s.center.z, s.radius)
        && !view.shadowReaches(s.center.x, s.center.y, s.center.z, s.radius, s.radius)) {
        m.castShadow = false;
        this.off.push(m);
      }
    }
    const ch = o.children;
    for (let i = 0; i < ch.length; i++) this.visit(ch[i], view);
  }

  /** World bounding sphere of static content, computed once. */
  private worldSphere(m: THREE.Mesh): THREE.Sphere | null {
    let s = m.userData.shadowSphere as THREE.Sphere | undefined;
    if (s) return s;
    const im = m as THREE.InstancedMesh;
    if (im.isInstancedMesh && !im.boundingSphere) im.computeBoundingSphere();
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const local = im.isInstancedMesh ? im.boundingSphere : m.geometry.boundingSphere;
    if (!local) return null;
    m.updateWorldMatrix(true, false);
    s = local.clone().applyMatrix4(m.matrixWorld);
    m.userData.shadowSphere = s;
    return s;
  }
}

interface Channel {
  /** Per-instance values by instance index. */
  src: Float32Array;
  size: number;
  /** Installs a camera-pass buffer of this channel on the meshes that read it. */
  bindMain: (a: THREE.InstancedBufferAttribute) => void;
  /** Installs a shadow-pass buffer on one cascade's shadow copies (null: the depth shaders do not read it). */
  bindShadow: ((a: THREE.InstancedBufferAttribute, meshes: readonly THREE.InstancedMesh[]) => void) | null;
}

/** One copy of a pass's instance buffers: transforms and each channel's values. */
interface GpuSet {
  cap: number;
  matrix: THREE.InstancedBufferAttribute;
  channels: (THREE.InstancedBufferAttribute | null)[];
}

/**
 * Copies of the instance buffers a pass draws from, used in turn. Rewriting a buffer the GPU may still
 * be reading from a recent frame makes ANGLE/Direct3D 11 wait for the GPU (measured: turning the camera
 * dropped Ultra from 5.8 to 1.3 fps), so a changed selection is written into the next copy, which the
 * GPU finished with frames ago, and the meshes are pointed at it.
 */
const RING = 3;

const BND = 5;
/** Re-sort by distance once the eye has moved this far (m) since the last sort. */
const RESORT = 2;
let visIdx = new Int32Array(1024);
let shIdx = new Int32Array(1024);
let cIdx = new Int32Array(1024);
const registry = new Set<CulledInstances>();

/** A geometry sharing every vertex attribute and the index of `g` (the GPU buffers are shared too). */
function sharedGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.index = g.index;
  for (const [name, attr] of Object.entries(g.attributes)) {
    if (!(attr as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) out.setAttribute(name, attr);
  }
  out.boundingSphere = g.boundingSphere;
  out.boundingBox = g.boundingBox;
  return out;
}

const pow2 = (n: number) => {
  let c = 64;
  while (c < n) c *= 2;
  return c;
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * InstancedMeshes that draw the same instances (the parts of one model), culled per instance.
 *
 * The camera pass draws the instances in view, ordered nearest first so the depth test rejects
 * hidden fragments before they are shaded.
 *
 * Shadow casting moves to copies of the meshes, one set per sun cascade (`shadowMeshes`), each shown
 * only while its own cascade's tile is drawn (`showCascade`). A cascade's set holds just the casters
 * whose bounds touch that cascade's light frustum, among those in view or casting into it, so no tile
 * sends trees that fall outside it through the vertex shader (each cascade used to draw every caster
 * within its reach and drop the misses per vertex, which made the middle cascades the most expensive
 * part of the shadow pass). Only the cascades redrawn this frame are re-selected. With `shadowLod`, the
 * LOD hand-over is applied here as well: where two LODs of a tree overlap, each casts on its side of
 * the middle of the band, so every tree casts exactly once.
 *
 * Instances are appended to master arrays; each cull writes a selection only when it changed, into the
 * next buffer of a three-deep ring (see RING), uploading only the used range. Buffers grow with the
 * selection instead of being allocated at full capacity. Empty meshes are hidden so they cost no draw
 * call.
 */
export class CulledInstances {
  n = 0;
  /** Instances in view (camera pass). */
  main = 0;
  /** Shadow casters: in view or casting into it. */
  shadow = 0;
  /** Per cascade: casters in its set. */
  readonly cascade = new Int32Array(CASCADES);
  readonly mat: Float32Array;
  /** Per instance: bounding sphere centre x, y, z, radius, and the centre's height above the ground. */
  readonly bnd: Float32Array;
  /** Shadow-pass copies of the casting meshes (CASCADES sets); add them to the scene next to `meshes`. */
  readonly shadowMeshes: THREE.InstancedMesh[] = [];
  /**
   * Per instance (fade-in start, width, fade-out start, width; distances from the eye): the LOD
   * hand-over the depth shaders apply, mirrored when selecting the shadow sets.
   */
  shadowLod: Float32Array | null = null;
  private readonly cascadeMeshes: THREE.InstancedMesh[][] = [];
  private readonly channels: Channel[] = [];
  private readonly mainRing: GpuSet[] = [];
  private readonly cascadeRing: GpuSet[][] = [];
  private mainAt = 0;
  private readonly cascadeAt = new Int32Array(CASCADES);
  private readonly order: Int32Array;
  private readonly cascadeOrder: Int32Array[] = [];
  private readonly byDist: Int32Array;
  private readonly dist: Float32Array;
  private readonly sortedAt = new THREE.Vector3(1e9, 0, 1e9);
  private readonly byDistance = (a: number, b: number) => this.dist[a] - this.dist[b];
  private seen = -1;
  private dirty = true;

  constructor(readonly meshes: THREE.InstancedMesh[], readonly cap: number) {
    this.mat = new Float32Array(cap * 16);
    this.bnd = new Float32Array(cap * BND);
    this.order = new Int32Array(cap).fill(-1);
    this.byDist = new Int32Array(cap);
    this.dist = new Float32Array(cap);
    const casting: THREE.InstancedMesh[] = [];
    for (const m of meshes) {
      m.frustumCulled = false;
      m.count = 0;
      m.visible = false;
      if (!m.castShadow) continue;
      // The camera-pass mesh stops casting; per-cascade copies that only the shadow pass sees take over.
      m.castShadow = false;
      casting.push(m);
    }
    for (let c = 0; c < CASCADES && casting.length; c++) {
      const set: THREE.InstancedMesh[] = [];
      for (const m of casting) {
        // `userData.shadowMaterial`: a material that also compiles without the camera-pass instance
        // attributes (the copy only ever draws depth, through its depth material).
        const sg = sharedGeometry(m.geometry);
        // A model may cast with only a leading part of its triangles (a conifer's trunk without the
        // branches hidden in its sprays: `userData.shadowCount`).
        const sc = m.geometry.userData.shadowCount as number | undefined;
        if (sc !== undefined) sg.setDrawRange(0, sc);
        const s = new THREE.InstancedMesh(sg, (m.userData.shadowMaterial as THREE.Material) ?? m.material, 1);
        s.customDepthMaterial = m.customDepthMaterial;
        s.castShadow = true;
        s.receiveShadow = m.receiveShadow;
        s.frustumCulled = false;
        s.count = 0;
        s.visible = false;
        s.name = `${m.name}:shadow${c}`;
        s.userData.shadowOnly = true;
        set.push(s);
        this.shadowMeshes.push(s);
      }
      this.cascadeMeshes.push(set);
      this.cascadeRing.push([]);
      this.cascadeOrder.push(new Int32Array(cap).fill(-1));
    }
    // Small initial buffers (the meshes' own full-capacity ones are dropped).
    this.bindSet(this.nextSet(this.mainRing, 0, 0, false), -1);
    for (let c = 0; c < this.cascadeMeshes.length; c++) this.bindSet(this.nextSet(this.cascadeRing[c], 0, 0, true), c);
    registry.add(this);
  }

  /**
   * A further per-instance attribute that follows the instance order (colours, atlas rows, LOD fades).
   * `attr` is the attribute the meshes read now: a mesh's instanceColor or one of its geometry's
   * attributes. With `geometryName`, the shadow-pass copies read it too (under that name).
   */
  channel(attr: THREE.InstancedBufferAttribute, geometryName?: string): Float32Array {
    const size = attr.itemSize;
    const src = new Float32Array(this.cap * size);
    // Who reads this attribute: as instance colour, or as a named geometry attribute.
    const colorOf = this.meshes.filter((m) => m.instanceColor === attr);
    const geoOf: [THREE.BufferGeometry, string][] = [];
    for (const m of this.meshes) {
      for (const [name, a] of Object.entries(m.geometry.attributes)) if (a === attr) geoOf.push([m.geometry, name]);
    }
    const bindMain = (a: THREE.InstancedBufferAttribute) => {
      for (const m of colorOf) m.instanceColor = a;
      for (const [g, name] of geoOf) g.setAttribute(name, a);
    };
    const shadowName = geometryName && this.shadowMeshes.length ? geometryName : null;
    const bindShadow = shadowName
      ? (a: THREE.InstancedBufferAttribute, meshes: readonly THREE.InstancedMesh[]) => {
        for (const s of meshes) s.geometry.setAttribute(shadowName, a);
      }
      : null;
    this.channels.push({ src, size, bindMain, bindShadow });
    // Give the current buffer sets room for the new channel and install them.
    for (const set of this.mainRing) set.channels.push(null);
    for (const ring of this.cascadeRing) for (const set of ring) set.channels.push(null);
    this.bindSet(this.ensureChannels(this.mainRing[this.mainAt], false), -1);
    for (let c = 0; c < this.cascadeMeshes.length; c++) this.bindSet(this.ensureChannels(this.cascadeRing[c][this.cascadeAt[c]], true), c);
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
    const e = view.eye;
    const resort = this.dirty || Math.abs(e.x - this.sortedAt.x) + Math.abs(e.z - this.sortedAt.z) > RESORT;
    if (!resort && this.seen === view.version) return;
    const rewrite = this.dirty || resort;
    this.dirty = false;
    this.seen = view.version;
    if (visIdx.length < this.n) {
      visIdx = new Int32Array(this.cap);
      shIdx = new Int32Array(this.cap);
      cIdx = new Int32Array(this.cap);
    }
    const b = this.bnd;
    if (resort) {
      this.sortedAt.copy(e);
      for (let i = 0; i < this.n; i++) {
        const o = i * BND;
        const dx = b[o] - e.x, dy = b[o + 1] - e.y, dz = b[o + 2] - e.z;
        this.dist[i] = dx * dx + dy * dy + dz * dz;
        this.byDist[i] = i;
      }
      this.byDist.subarray(0, this.n).sort(this.byDistance);
    }
    // Walk nearest first: the in-view list and the caster list come out sorted.
    let v = 0;
    let sh = 0;
    const castsShadow = this.shadowMeshes.length > 0;
    for (let k = 0; k < this.n; k++) {
      const i = this.byDist[k];
      const o = i * BND;
      if (view.inView(b[o], b[o + 1], b[o + 2], b[o + 3])) {
        visIdx[v++] = i;
        shIdx[sh++] = i;
      } else if (castsShadow && view.shadowReaches(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4])) shIdx[sh++] = i;
    }
    const mainSame = !rewrite && v === this.main && this.sameAs(this.order, visIdx, v);
    this.main = v;
    this.shadow = sh;
    this.setCount(v);
    if (!mainSame) this.write(visIdx, v, this.order, -1);
    if (!castsShadow) return;
    // Each cascade redrawn this frame: the casters touching its light frustum, on their side of an LOD
    // hand-over (the depth shaders' rule, with the same eye distance).
    const lod = this.shadowLod;
    const mat = this.mat;
    for (let c = 0; c < CASCADES; c++) {
      if (!(view.dueMask & (1 << c))) continue;
      let n = 0;
      for (let k = 0; k < sh; k++) {
        const i = shIdx[k];
        const o = i * BND;
        if (!view.inCascade(c, b[o], b[o + 1], b[o + 2], b[o + 3])) continue;
        if (lod) {
          const l = i * 4;
          const dx = mat[i * 16 + 12] - e.x, dz = mat[i * 16 + 14] - e.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (clamp01((d - lod[l]) / lod[l + 1]) < 0.5 || clamp01((d - lod[l + 2]) / lod[l + 3]) >= 0.5) continue;
        }
        cIdx[n++] = i;
      }
      const same = !rewrite && n === this.cascade[c] && this.sameAs(this.cascadeOrder[c], cIdx, n);
      this.cascade[c] = n;
      if (!same) this.write(cIdx, n, this.cascadeOrder[c], c);
    }
  }

  private sameAs(prev: Int32Array, next: Int32Array, n: number): boolean {
    for (let a = 0; a < n; a++) if (prev[a] !== next[a]) return false;
    return true;
  }

  /** Buffer set `k` of a ring with room for `n` instances (made or regrown as needed). */
  private nextSet(ring: GpuSet[], k: number, n: number, shadow: boolean): GpuSet {
    let set = ring[k];
    if (!set || set.cap < n) {
      const cap = Math.min(this.cap, pow2(n));
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      set = ring[k] = { cap, matrix, channels: this.channels.map(() => null) };
    }
    return this.ensureChannels(set, shadow);
  }

  /** Make the channel buffers a set needs (shadow sets only hold the ones the depth shaders read). */
  private ensureChannels(set: GpuSet, shadow: boolean): GpuSet {
    for (let c = 0; c < this.channels.length; c++) {
      const ch = this.channels[c];
      if (set.channels[c] || (shadow && !ch.bindShadow)) continue;
      const a = new THREE.InstancedBufferAttribute(new Float32Array(set.cap * ch.size), ch.size);
      a.setUsage(THREE.DynamicDrawUsage);
      set.channels[c] = a;
    }
    return set;
  }

  /** Point the camera-pass meshes (cascade -1) or a cascade's shadow copies at a buffer set. */
  private bindSet(set: GpuSet, cascade: number): void {
    const meshes = cascade < 0 ? this.meshes : this.cascadeMeshes[cascade];
    for (const m of meshes) m.instanceMatrix = set.matrix;
    for (let c = 0; c < this.channels.length; c++) {
      const a = set.channels[c];
      if (!a) continue;
      const ch = this.channels[c];
      if (cascade >= 0) ch.bindShadow?.(a, meshes);
      else ch.bindMain(a);
    }
  }

  /** Copy the selected instances (and their channel values) into the next buffer set of a ring. */
  private write(sel: Int32Array, n: number, order: Int32Array, cascade: number): void {
    const shadow = cascade >= 0;
    const ring = shadow ? this.cascadeRing[cascade] : this.mainRing;
    const k = ((shadow ? this.cascadeAt[cascade] : this.mainAt) + 1) % RING;
    if (shadow) this.cascadeAt[cascade] = k;
    else this.mainAt = k;
    const set = this.nextSet(ring, k, n, shadow);
    const dm = set.matrix.array as Float32Array;
    const chs = this.channels;
    for (let j = 0; j < n; j++) {
      const i = sel[j];
      order[j] = i;
      const s = i * 16, d = j * 16;
      for (let c = 0; c < 16; c++) dm[d + c] = this.mat[s + c];
      for (let c = 0; c < chs.length; c++) {
        const target = set.channels[c];
        if (!target) continue;
        const size = chs[c].size;
        const arr = target.array as Float32Array;
        const src = chs[c].src;
        for (let q = 0; q < size; q++) arr[j * size + q] = src[i * size + q];
      }
    }
    if (n > 0) {
      this.flag(set.matrix, n * 16);
      for (let c = 0; c < chs.length; c++) {
        const target = set.channels[c];
        if (target) this.flag(target, n * chs[c].size);
      }
    }
    this.bindSet(set, cascade);
  }

  private flag(attr: THREE.InstancedBufferAttribute, count: number): void {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
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

  /** Around the sun's shadow pass: every cascade's copies start hidden (see showCascade). */
  static beginShadowPass(): void {
    for (const ci of registry) {
      for (let c = 0; c < ci.cascadeMeshes.length; c++) {
        for (const s of ci.cascadeMeshes[c]) {
          s.count = ci.cascade[c];
          s.visible = CulledInstances.forceVisible;
        }
      }
    }
  }

  /** As the shadow pass starts drawing cascade `c`: show only that cascade's copies (non-empty ones). */
  static showCascade(c: number): void {
    const force = CulledInstances.forceVisible;
    for (const ci of registry) {
      for (let k = 0; k < ci.cascadeMeshes.length; k++) {
        const on = k === c && (ci.cascade[k] > 0 || force);
        for (const s of ci.cascadeMeshes[k]) s.visible = on;
      }
    }
  }

  static endShadowPass(): void {
    for (const ci of registry) for (const s of ci.shadowMeshes) s.visible = false;
  }
}
