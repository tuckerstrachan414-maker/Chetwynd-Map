import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';
import { BucketPool } from '../../util/Pool';
import { gunzip } from '../codec';
import { SPECIES, archetypeOf, type Archetype } from './species';
import { IMP_VIEWS, type ModelEntry, TreeLibrary, VARIANTS } from './TreeLibrary';
import { ditherGlsl, vegUniforms } from './TreeMaterials';
import type { Pickable } from '../../ui/Editor';
import { refOf, type Overrides } from '../Overrides';
import { CulledInstances, type CullView } from '../InstanceCull';

interface VegIndex {
  size: number;
  half: number;
  chunks: [number, number, number, number][];
}

/** Per-tree record in world space: x, y, z, h, r, species, seed, rotY. */
const STRIDE = 8;

/** One pooled impostor batch: a chunk's billboards. */
interface ImpSlot {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  iA: THREE.InstancedBufferAttribute;
  iB: THREE.InstancedBufferAttribute;
  iC: THREE.InstancedBufferAttribute;
  cap: number;
}

interface VegChunk {
  trees: Float32Array;
  shrubs: Float32Array;
  /** As loaded, before the editor's overrides. */
  rawTrees: Float32Array;
  rawShrubs: Float32Array;
  /** Override ids of user-added (or moved) trees/shrubs by record index; '' for originals. */
  treeIds: string[];
  shrubIds: string[];
  imp: ImpSlot | null;
  x0: number;
  z0: number;
  ymin: number;
  /** Chunk centre (x, z), for distance tests without re-deriving it from the key. */
  cx: number;
  cz: number;
}

const hashSeed = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 256;
};

/** Impostor billboards: per-instance base (relative to the batch origin), size/layer/rotation, tint. */
const impVert = /* glsl */ `
attribute vec4 iA;
attribute vec4 iB;
attribute vec3 iC;
uniform float uNear;
uniform float uFar;
varying vec3 vImpUvA;
varying vec3 vImpUvB;
varying float vBlend;
varying vec3 vTint;
varying float vFade;
varying float vRot;
`;

const impBegin = /* glsl */ `
vec3 base = iA.xyz;
vec3 toCam = cameraPosition - (base + vec3(modelMatrix[3]));
float dist = length(toCam.xz);
vec2 hd = normalize(toCam.xz + vec2(1e-5, 0.0));
vec3 right = vec3(hd.y, 0.0, -hd.x);
vec3 transformed = base + right * position.x * iB.x + vec3(0.0, position.y * iB.y - 0.02 * iA.w, 0.0);
float az = atan(hd.x, hd.y) - iB.w;
float k = fract(az / 6.2831853) * ${IMP_VIEWS}.0;
float k0 = floor(k);
float k1 = mod(k0 + 1.0, ${IMP_VIEWS}.0);
vec2 luv = vec2(position.x + 0.5, position.y);
vImpUvA = vec3((k0 + luv.x) / ${IMP_VIEWS}.0, luv.y, iB.z);
vImpUvB = vec3((k1 + luv.x) / ${IMP_VIEWS}.0, luv.y, iB.z);
vBlend = k - k0;
vTint = iC;
vRot = iB.w;
// Fades in across the near trees' hand-over band (they fade out on the complementary dither).
vFade = clamp((dist - uNear) / 18.0, 0.0, 1.0) * (1.0 - clamp((dist - uFar) / 250.0, 0.0, 1.0));
if (vFade <= 0.0) transformed = vec3(0.0, -100000.0, 0.0);
`;

const impFragPars = /* glsl */ `
uniform highp sampler2DArray uImpA;
uniform highp sampler2DArray uImpN;
varying vec3 vImpUvA;
varying vec3 vImpUvB;
varying float vBlend;
varying vec3 vTint;
varying float vFade;
varying float vRot;
${ditherGlsl}
`;

interface NearSet {
  e: ModelEntry;
  /** 0 full detail, 2 middle distance (thinned), 1 low-poly. */
  lod: 0 | 1 | 2;
  bark: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
  /** The near instances of this model, culled per instance each frame. */
  ci: CulledInstances;
  colL: Float32Array;
  colB: Float32Array;
  /** Per instance LOD hand-over: (fade-in start, width, fade-out start, width), see TreeMaterials. */
  lodP: Float32Array;
}

/** "Never fades in/out" in the per-instance LOD parameters. */
const NO_FADE_IN = -1e6;
const NO_FADE_OUT = 1e6;
/** Width of the full-geometry (or middle) -> low-poly hand-over (m), trees and shrubs. */
const LOD0_BAND = 6;
/** Trees: full geometry out to this fraction of the LOD0 radius, then the middle LOD, over a band (m). */
const MID_AT = 0.55;
const MID_BAND = 4;
const SHRUB_LOD0_BAND = 4;
/** The impostors fade in from (near radius - 10 m) over this distance (see impBegin). */
const IMP_BAND = 18;
/** Shrubs (no impostors) dissolve over this distance at the edge of their radius. */
const SHRUB_FAR_BAND = 12;

/**
 * The forest as an InstancedMesh hierarchy, streamed from per-chunk LiDAR vegetation:
 *
 * - near: full-geometry models (LOD0) close to the eye, a middle LOD (half the leaf cards, each
 *   larger, so the crown keeps its coverage) to the LOD0 radius, low-poly models (LOD1) to mid
 *   distance, culled per instance and ordered nearest first;
 * - far: one camera-facing impostor per tree (8 baked views with normals), batched per chunk.
 *
 * Every hand-over (LOD0 -> LOD1 -> impostor, and shrubs dissolving at their radius) is a short
 * dithered cross-fade, so density never changes and nothing pops. Near instances are drawn nearest
 * first and impostor batches are positioned at their chunk so the renderer sorts them near to far:
 * the depth test then rejects most hidden leaves and billboards before they are shaded.
 * Impostor batches come from a pool: chunks streaming in reuse the buffers of chunks streaming out.
 */
export class Forest {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, VegChunk>();
  private readonly loading = new Set<string>();
  private readonly available = new Map<string, [number, number]>();
  private readonly impMaterial: THREE.MeshStandardMaterial;
  private readonly impUniforms: Record<string, THREE.IUniform>;
  private readonly quad: THREE.BufferGeometry;
  private readonly impPool: BucketPool<ImpSlot>;
  private readonly near: NearSet[] = [];
  /** Near sets by model entry and LOD, for the per-instance loop. */
  private readonly byEntry = new Map<ModelEntry, [NearSet, NearSet, NearSet]>();
  private shrubCount = 0;
  private lastNear = new THREE.Vector3(1e9, 0, 0);
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tmpC = new THREE.Color();
  private readonly nearOut: Float32Array[] = [];

  loadRadius = 1900;
  nearRadius = 150;
  lod0Radius = 40;
  shrubRadius = 110;
  shrubLod0Radius = 28;
  readonly leafColor = new Map<number, THREE.Color>();
  readonly barkColor = new Map<number, THREE.Color>();
  season = 0;

  constructor(
    private readonly lib: TreeLibrary,
    private readonly index: VegIndex,
    private readonly baseUrl: string,
  ) {
    for (const [i, j] of index.chunks) this.available.set(`${i}_${j}`, [i, j]);
    this.root.name = 'forest';
    this.quad = new THREE.BufferGeometry();
    this.quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    this.quad.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    this.quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.impUniforms = {
      uImpA: { value: null },
      uImpN: { value: null },
      uNear: { value: this.nearRadius - 10 },
      uFar: { value: this.loadRadius - 200 },
      uDitherOffset: vegUniforms.uDitherOffset,
    };
    const m = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.impUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${impVert}`)
        .replace('#include <begin_vertex>', impBegin);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${impFragPars}`)
        .replace('#include <map_fragment>', `
          vec4 ia = texture(uImpA, vImpUvA);
          vec4 ib = texture(uImpA, vImpUvB);
          vec4 alb = mix(ia, ib, vBlend);
          if (alb.a < 0.5 || vFade <= cwDither(gl_FragCoord.xy)) discard;
          diffuseColor.rgb = alb.rgb * alb.rgb * vTint;
        `)
        .replace('#include <normal_fragment_begin>', `
          float faceDirection = 1.0;
          vec3 nm = normalize(mix(texture(uImpN, vImpUvA).xyz, texture(uImpN, vImpUvB).xyz, vBlend) * 2.0 - 1.0);
          float cr = cos(vRot), sr = sin(vRot);
          vec3 nw = vec3(cr * nm.x + sr * nm.z, nm.y, -sr * nm.x + cr * nm.z);
          vec3 normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
        `);
    };
    m.customProgramCacheKey = () => 'cw-impostor';
    this.impMaterial = worldLit(m);
    this.impPool = new BucketPool<ImpSlot>((cap) => this.makeSlot(cap), 256);
    // Near instanced meshes per model entry and LOD: bark and leaves.
    const white = new THREE.Color(1, 1, 1);
    for (const e of lib.entries) {
      const pair: NearSet[] = [];
      for (const lod of [0, 1, 2] as const) {
        const cap = lod === 0 ? 700 : lod === 2 ? 1500 : 6000;
        const bark = new THREE.InstancedMesh(lod === 0 ? e.geo.bark0 : lod === 2 ? e.geo.barkM : e.geo.bark1, e.bark, cap);
        const leaves = new THREE.InstancedMesh(lod === 0 ? e.geo.leaves0 : lod === 2 ? e.geo.leavesM : e.geo.leaves1, e.foliage, cap);
        for (const im of [bark, leaves]) {
          im.castShadow = true;
          im.receiveShadow = true;
          im.setColorAt(0, white);
        }
        leaves.customDepthMaterial = e.foliageDepth;
        bark.customDepthMaterial = e.barkDepth;
        // The leaves' shadow copy has no instance colours (which the foliage shader reads): give it a
        // plain material; it only ever draws through its depth material.
        leaves.userData.shadowMaterial = this.leafShadowMaterial(e);
        // Bark and leaves share the instance transforms; each has its own colour.
        const ci = new CulledInstances([leaves, bark], cap);
        const lodAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
        leaves.geometry.setAttribute('iLod', lodAttr);
        bark.geometry.setAttribute('iLod', lodAttr);
        const set: NearSet = {
          e, lod, bark, leaves, ci,
          colL: ci.channel(leaves.instanceColor!), colB: ci.channel(bark.instanceColor!), lodP: ci.channel(lodAttr),
        };
        // The shadow casters are picked per cascade on the CPU with the same LOD hand-over rule.
        ci.shadowLod = set.lodP;
        for (const im of [bark, leaves, ...ci.shadowMeshes]) this.root.add(im);
        this.near.push(set);
        pair.push(set);
      }
      this.byEntry.set(e, [pair[0], pair[1], pair[2]]);
    }
    this.setSeason(0);
  }

  private readonly leafShadowMats = new Map<ModelEntry, THREE.Material>();

  /** Stand-in material for a leaves shadow copy: same map, alpha test and sides as the foliage. */
  private leafShadowMaterial(e: ModelEntry): THREE.Material {
    let m = this.leafShadowMats.get(e);
    if (!m) {
      const f = e.foliage as THREE.MeshStandardMaterial;
      m = new THREE.MeshBasicMaterial({ map: f.map, alphaTest: f.alphaTest, side: f.side });
      m.alphaToCoverage = f.alphaToCoverage;
      this.leafShadowMats.set(e, m);
    }
    return m;
  }

  /** A pooled impostor batch with room for `cap` trees. */
  private makeSlot(cap: number): ImpSlot {
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.quad.index;
    g.setAttribute('position', this.quad.getAttribute('position'));
    g.setAttribute('normal', this.quad.getAttribute('normal'));
    const attr = (size: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const iA = attr(4), iB = attr(4), iC = attr(3);
    g.setAttribute('iA', iA);
    g.setAttribute('iB', iB);
    g.setAttribute('iC', iC);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 260);
    const mesh = new THREE.Mesh(g, this.impMaterial);
    mesh.receiveShadow = true;
    return { mesh, geo: g, iA, iB, iC, cap };
  }

  get stats(): Record<string, number> {
    let n0 = 0, nm = 0, n1 = 0, imp = 0;
    for (const n of this.near) {
      if (n.lod === 0) n0 += n.ci.n;
      else if (n.lod === 2) nm += n.ci.n;
      else n1 += n.ci.n;
    }
    for (const c of this.chunks.values()) imp += c.trees.length / STRIDE;
    return { chunks: this.chunks.size, lod0: n0, lodM: nm, lod1: n1, trees: imp, shrubs: this.shrubCount, impBatches: this.impPool.created };
  }

  get busy(): boolean {
    return this.loading.size > 0;
  }

  /** Recompute per-species colours for a season (0 summer, 1 autumn, 2 winter, 3 spring) and re-bake impostors. */
  setSeason(season: number): void {
    this.season = season;
    vegUniforms.uSeason.value = season;
    for (const [id, sp] of Object.entries(SPECIES)) {
      const c = season === 1 ? sp.autumn : season === 3 ? sp.spring : sp.summer;
      this.leafColor.set(Number(id), new THREE.Color(c[0], c[1], c[2]));
      this.barkColor.set(Number(id), new THREE.Color(sp.barkTint[0], sp.barkTint[1], sp.barkTint[2]));
    }
    const repr: Record<Archetype, number> = { spruce: 3, bspruce: 4, pine: 5, aspen: 0, poplar: 1, round: 7, shrub: 20, willow: 6 };
    this.lib.bakeImpostors(
      (a) => this.leafColor.get(repr[a])!,
      (a) => this.barkColor.get(repr[a])!,
      season === 2,
    );
    this.impUniforms.uImpA.value = this.lib.impAlbedo.texture;
    this.impUniforms.uImpN.value = this.lib.impNormal.texture;
    // Refresh impostor tints (ratio of species colour to the archetype bake colour).
    for (const c of this.chunks.values()) if (c.imp) this.fillTint(c);
    this.lastNear.set(1e9, 0, 0);
  }

  private fillTint(c: VegChunk): void {
    const repr: Record<Archetype, number> = { spruce: 3, bspruce: 4, pine: 5, aspen: 0, poplar: 1, round: 7, shrub: 20, willow: 6 };
    const iC = c.imp!.iC;
    const n = c.trees.length / STRIDE;
    for (let k = 0; k < n; k++) {
      const sp = c.trees[k * STRIDE + 5];
      const a = archetypeOf(sp);
      const col = this.leafColor.get(sp)!;
      const ref = this.leafColor.get(repr[a])!;
      iC.setXYZ(k, col.r / Math.max(ref.r, 1e-3), col.g / Math.max(ref.g, 1e-3), col.b / Math.max(ref.b, 1e-3));
    }
    iC.clearUpdateRanges();
    iC.addUpdateRange(0, Math.max(1, n) * 3);
    iC.needsUpdate = true;
  }

  private async load(key: string, i: number, j: number): Promise<void> {
    const res = await fetch(new URL(`${this.baseUrl}/${key}.bin`, location.href).href);
    if (!res.ok) throw new Error(`${res.status}`);
    const raw = await gunzip(await res.arrayBuffer());
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const nT = dv.getUint32(4, true);
    const nS = dv.getUint32(8, true);
    const ymin = dv.getFloat32(12, true);
    const x0 = -this.index.half + i * this.index.size;
    const z0 = -this.index.half + j * this.index.size;
    const parse = (offset: number, n: number) => {
      const out = new Float32Array(n * STRIDE);
      for (let k = 0; k < n; k++) {
        const o = offset + k * 10;
        const seed = dv.getUint8(o + 9);
        out[k * STRIDE] = x0 + dv.getUint16(o, true) / 100;
        out[k * STRIDE + 1] = ymin + dv.getUint16(o + 4, true) / 100;
        out[k * STRIDE + 2] = z0 + dv.getUint16(o + 2, true) / 100;
        out[k * STRIDE + 3] = dv.getUint8(o + 6) / 4;
        out[k * STRIDE + 4] = dv.getUint8(o + 7) / 10;
        out[k * STRIDE + 5] = dv.getUint8(o + 8);
        out[k * STRIDE + 6] = seed;
        out[k * STRIDE + 7] = (seed / 255) * Math.PI * 2;
      }
      return out;
    };
    const rawTrees = parse(16, nT);
    const rawShrubs = parse(16 + nT * 10, nS);
    const s = this.index.size;
    const chunk: VegChunk = {
      trees: rawTrees, shrubs: rawShrubs, rawTrees, rawShrubs, treeIds: [], shrubIds: [], imp: null, x0, z0, ymin, cx: x0 + s / 2, cz: z0 + s / 2,
    };
    this.install(key, chunk);
    this.chunks.set(key, chunk);
  }

  /** Return a chunk's impostor batch to the pool. */
  private releaseImp(c: VegChunk): void {
    if (!c.imp) return;
    this.root.remove(c.imp.mesh);
    this.impPool.release(c.imp, c.imp.cap);
    c.imp = null;
  }

  /** Apply the editor's overrides to a chunk and (re)build its impostor instances. */
  private install(key: string, chunk: VegChunk): void {
    const { x0, z0, ymin } = chunk;
    const s = this.index.size;
    const apply = (raw: Float32Array, kind: 'tree' | 'shrub'): [Float32Array, string[]] => {
      if (!this.overrides) return [raw, []];
      const { removed, added } = this.overrides.forKind(kind);
      if (!removed.size && !added.length) return [raw, []];
      const out: number[] = [];
      const ids: string[] = [];
      for (let k = 0; k < raw.length; k += STRIDE) {
        if (removed.size && removed.has(refOf(kind, raw[k], raw[k + 2]))) continue;
        for (let q = 0; q < STRIDE; q++) out.push(raw[k + q]);
        ids.push('');
      }
      for (const a of added) {
        if (a.x === undefined || a.z === undefined || a.x < x0 || a.x >= x0 + s || a.z < z0 || a.z >= z0 + s) continue;
        const seed = hashSeed(a.id ?? `${a.x},${a.z}`);
        out.push(a.x, a.y ?? 0, a.z, a.h ?? 10, a.r ?? 2, a.sp ?? 0, seed, a.rot ?? (seed / 255) * Math.PI * 2);
        ids.push(a.id ?? '');
      }
      return [new Float32Array(out), ids];
    };
    [chunk.trees, chunk.treeIds] = apply(chunk.rawTrees, 'tree');
    [chunk.shrubs, chunk.shrubIds] = apply(chunk.rawShrubs, 'shrub');
    this.releaseImp(chunk);
    const trees = chunk.trees;
    const nT = trees.length / STRIDE;
    if (nT === 0) return;
    const slot = this.impPool.acquire(nT);
    // Billboard bases are stored relative to the batch origin (the chunk centre at its lowest
    // ground): smaller numbers, and the renderer can sort the batches near to far.
    const ox = chunk.cx, oz = chunk.cz;
    const iA = slot.iA.array as Float32Array;
    const iB = slot.iB.array as Float32Array;
    for (let k = 0; k < nT; k++) {
      const t = k * STRIDE;
      const sp = trees[t + 5];
      const e = this.lib.entry(archetypeOf(sp), trees[t + 6] % VARIANTS);
      const a = k * 4;
      iA[a] = trees[t] - ox;
      iA[a + 1] = trees[t + 1] - ymin;
      iA[a + 2] = trees[t + 2] - oz;
      iA[a + 3] = trees[t + 3];
      iB[a] = e.frameW * (trees[t + 4] / e.model.R);
      iB[a + 1] = e.frameH * (trees[t + 3] / e.model.H);
      iB[a + 2] = e.layer;
      iB[a + 3] = trees[t + 7];
    }
    for (const attr of [slot.iA, slot.iB]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, nT * 4);
      attr.needsUpdate = true;
    }
    slot.geo.instanceCount = nT;
    slot.mesh.position.set(ox, ymin, oz);
    slot.mesh.name = `imp_${key}`;
    chunk.imp = slot;
    this.fillTint(chunk);
    this.root.add(slot.mesh);
  }

  private overrides: Overrides | null = null;

  /** Use the editor's overrides; re-applies them to every loaded chunk (and to chunks loaded later). */
  applyOverrides(ov: Overrides): void {
    this.overrides = ov;
    for (const [key, c] of this.chunks) this.install(key, c);
    this.lastNear.set(1e9, 0, 0);
  }

  /** Trees and shrubs near (x, z) for the editor: LiDAR trees are mapped, LiDAR-density shrubs inferred. */
  pickables(x: number, z: number, radius: number): Pickable[] {
    const out: Pickable[] = [];
    const r2 = radius * radius;
    for (const c of this.chunks.values()) {
      if (Math.hypot(c.cx - x, c.cz - z) > radius + 190) continue;
      for (const [arr, ids, kind] of [[c.trees, c.treeIds, 'tree'], [c.shrubs, c.shrubIds, 'shrub']] as const) {
        for (let k = 0, n = 0; k < arr.length; k += STRIDE, n++) {
          const dx = arr[k] - x, dz = arr[k + 2] - z;
          if (dx * dx + dz * dz > r2) continue;
          const id = ids[n] ?? '';
          out.push({
            kind, ref: id ? `#${id}` : refOf(kind, arr[k], arr[k + 2]), x: arr[k], y: arr[k + 1], z: arr[k + 2], rot: arr[k + 7],
            h: arr[k + 3], r: Math.max(0.7, arr[k + 4] * 0.6), sp: arr[k + 5], src: id ? 'user' : kind === 'tree' ? 'mapped' : 'inferred',
          });
        }
      }
    }
    return out;
  }

  /**
   * The `max` deciduous trees nearest (x, z) within `radius`, for falling leaves, written into `out`
   * as [x, y, z, h, crownR, r, g, b, amount] per tree (stride 9), nearest first; returns the count.
   * No allocation: `out` and the distance list are reused.
   */
  deciduousNear(x: number, z: number, radius: number, season: number, out: Float32Array, max: number): number {
    const r2 = radius * radius;
    const best = this.nearDist;
    let n = 0;
    for (const arr of this.treesNear(x, z, radius)) {
      for (let k = 0; k < arr.length; k += STRIDE) {
        const dx = arr[k] - x, dz = arr[k + 2] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || (n === max && d2 >= best[n - 1])) continue;
        const def = SPECIES[arr[k + 5]];
        if (!def?.deciduous) continue;
        // Insert into the sorted top-`max` list.
        let i = n < max ? n++ : max - 1;
        while (i > 0 && best[i - 1] > d2) {
          best[i] = best[i - 1];
          out.copyWithin(i * 9, (i - 1) * 9, i * 9);
          i--;
        }
        best[i] = d2;
        const c = season === 1 ? def.autumn : def.summer;
        const o = i * 9;
        out[o] = arr[k];
        out[o + 1] = arr[k + 1];
        out[o + 2] = arr[k + 2];
        out[o + 3] = arr[k + 3];
        out[o + 4] = arr[k + 4];
        out[o + 5] = c[0] * 2.2;
        out[o + 6] = c[1] * 2.2;
        out[o + 7] = c[2] * 2.2;
        // Aspen and poplar shed most; a few leaves fall in late summer too.
        out[o + 8] = season === 1 ? 1 : 0.05;
      }
    }
    return n;
  }

  private readonly nearDist = new Float32Array(256);

  /** Quality preset: full-geometry, LOD0 and shrub radii (m). */
  setRadii(near: number, lod0: number, shrubs: number): void {
    this.nearRadius = near;
    this.lod0Radius = lod0;
    this.shrubRadius = shrubs;
    this.impUniforms.uNear.value = near - 10;
    this.lastNear.set(1e9, 0, 0);
  }

  /**
   * Tree arrays (stride 8) of chunks near (x, z), for trunk colliders. The returned array is reused
   * by the next call (no allocation per frame).
   */
  treesNear(x: number, z: number, radius: number): Float32Array[] {
    const out = this.nearOut;
    out.length = 0;
    for (const c of this.chunks.values()) if (Math.hypot(c.cx - x, c.cz - z) < radius + 190) out.push(c.trees);
    return out;
  }

  update(cam: THREE.Vector3): boolean {
    const s = this.index.size;
    let pending = 0;
    for (const [key, [i, j]] of this.available) {
      const cx = -this.index.half + (i + 0.5) * s;
      const cz = -this.index.half + (j + 0.5) * s;
      const d = Math.hypot(cx - cam.x, cz - cam.z);
      if (d < this.loadRadius) {
        if (!this.chunks.has(key) && !this.loading.has(key)) {
          if (this.loading.size < 6) {
            this.loading.add(key);
            this.load(key, i, j)
              .catch((e) => console.warn('veg chunk failed', key, e))
              .finally(() => {
                this.loading.delete(key);
                this.lastNear.set(1e9, 0, 0);
              });
          }
          pending++;
        }
      } else if (d > this.loadRadius + 400) {
        const c = this.chunks.get(key);
        if (c) {
          this.releaseImp(c);
          this.chunks.delete(key);
        }
      }
    }
    if (cam.distanceToSquared(this.lastNear) > 16) this.updateNear(cam);
    return pending === 0 && this.loading.size === 0;
  }

  /**
   * Rebuild the near instance lists around the eye: each tree goes to LOD0 or LOD1 by distance, and to
   * both inside a hand-over band, with the fade parameters the shaders dissolve it with.
   */
  private updateNear(cam: THREE.Vector3): void {
    this.lastNear.copy(cam);
    for (const n of this.near) n.ci.clear();
    const b0 = this.lod0Radius - LOD0_BAND / 2;
    const bm = this.lod0Radius * MID_AT - MID_BAND / 2;
    const impStart = this.nearRadius - 10;
    const far = impStart + IMP_BAND;
    const R2 = far * far;
    const sb0 = this.shrubLod0Radius - SHRUB_LOD0_BAND / 2;
    const sFar = this.shrubRadius;
    const sr2 = sFar * sFar;
    const reach = Math.max(far, sFar) + 190;
    let shrubN = 0;
    const { m4: m, q, pos, scl, up, tmpC } = this;
    for (const c of this.chunks.values()) {
      if (Math.hypot(c.cx - cam.x, c.cz - cam.z) > reach) continue;
      const t = c.trees;
      for (let k = 0; k < t.length; k += STRIDE) {
        const dx = t[k] - cam.x;
        const dz = t[k + 2] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const d = Math.sqrt(d2);
        const sp = t[k + 5];
        const e = this.lib.entry(archetypeOf(sp), t[k + 6] % VARIANTS);
        const sets = this.byEntry.get(e)!;
        pos.set(t[k], t[k + 1] - 0.05, t[k + 2]);
        q.setFromAxisAngle(up, t[k + 7]);
        const sxz = t[k + 4] / e.model.R;
        scl.set(sxz, t[k + 3] / e.model.H, sxz);
        m.compose(pos, q, scl);
        const leaf = this.leafColor.get(sp)!, bark = this.barkColor.get(sp)!;
        // Full detail -> middle LOD -> low-poly, each hand-over a dithered band.
        if (d < bm + MID_BAND) this.putNear(sets[0], m, leaf, bark, t[k], t[k + 1], t[k + 2], t[k + 3], t[k + 4], NO_FADE_IN, 1, bm, MID_BAND);
        if (d >= bm && d < b0 + LOD0_BAND) this.putNear(sets[2], m, leaf, bark, t[k], t[k + 1], t[k + 2], t[k + 3], t[k + 4], bm, MID_BAND, b0, LOD0_BAND);
        if (d >= b0) this.putNear(sets[1], m, leaf, bark, t[k], t[k + 1], t[k + 2], t[k + 3], t[k + 4], b0, LOD0_BAND, impStart, IMP_BAND);
      }
      // Shrubs: multi-stem bush / willow clump models, full detail close by, dissolving at their radius.
      const u = c.shrubs;
      for (let k = 0; k < u.length; k += STRIDE) {
        const dx = u[k] - cam.x;
        const dz = u[k + 2] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > sr2) continue;
        const d = Math.sqrt(d2);
        const sp = u[k + 5];
        const e = this.lib.entry(archetypeOf(sp), u[k + 6] % VARIANTS);
        const sets = this.byEntry.get(e)!;
        const h = Math.max(u[k + 3], 0.5);
        const rr = THREE.MathUtils.clamp(u[k + 4], h * 0.35, h * 1.1);
        pos.set(u[k], u[k + 1] - 0.08, u[k + 2]);
        q.setFromAxisAngle(up, u[k + 7]);
        scl.set(rr / e.model.R, h / e.model.H, rr / e.model.R);
        m.compose(pos, q, scl);
        const lc = this.leafColor.get(sp) ?? this.leafColor.get(20)!;
        tmpC.copy(lc).multiplyScalar(0.85 + 0.3 * ((u[k + 6] * 0.37) % 1));
        const bc = this.barkColor.get(sp) ?? this.barkColor.get(20)!;
        const near = d < sb0 + SHRUB_LOD0_BAND;
        if (near) this.putNear(sets[0], m, tmpC, bc, u[k], u[k + 1], u[k + 2], h, rr, NO_FADE_IN, 1, sb0, SHRUB_LOD0_BAND);
        if (d >= sb0) this.putNear(sets[1], m, tmpC, bc, u[k], u[k + 1], u[k + 2], h, rr, sb0, SHRUB_LOD0_BAND, sFar - SHRUB_FAR_BAND, SHRUB_FAR_BAND);
        shrubN++;
      }
    }
    this.shrubCount = shrubN;
  }

  /** Append one near instance (transform, colours, bounds, LOD fades) to a model's list. */
  private putNear(n: NearSet, m: THREE.Matrix4, leaf: THREE.Color, bark: THREE.Color, x: number, y: number, z: number, h: number, r: number,
    inStart: number, inWidth: number, outStart: number, outWidth: number): void {
    // A sphere around trunk and crown: centre at 55 % of the height.
    const hc = h * 0.55;
    const i = n.ci.add(m, x, y + hc, z, Math.max(r, hc) + 0.5, hc);
    if (i < 0) return;
    leaf.toArray(n.colL, i * 3);
    bark.toArray(n.colB, i * 3);
    const o = i * 4;
    n.lodP[o] = inStart;
    n.lodP[o + 1] = inWidth;
    n.lodP[o + 2] = outStart === NO_FADE_OUT ? NO_FADE_OUT : outStart;
    n.lodP[o + 3] = outWidth;
  }

  /**
   * Alpha to coverage on the leaves only helps with MSAA; without it (TAA) the leaves use a plain alpha
   * test and the jittered frames antialias their edges.
   */
  setAlphaToCoverage(on: boolean): void {
    const mats = new Set<THREE.Material>();
    for (const n of this.near) mats.add(n.leaves.material as THREE.Material);
    for (const m of this.leafShadowMats.values()) mats.add(m);
    for (const m of mats) {
      if (m.alphaToCoverage === on) continue;
      m.alphaToCoverage = on;
      m.needsUpdate = true;
    }
  }

  /** Per-instance culling of the near trees and shrubs (see CulledInstances). */
  cull(view: CullView): void {
    for (const ns of this.near) ns.ci.cull(view);
  }
}
