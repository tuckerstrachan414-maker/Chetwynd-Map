import * as THREE from 'three';
import { gunzip } from '../codec';
import { ARCHETYPES, SPECIES, archetypeOf, type Archetype } from './species';
import { IMP_VIEWS, type ModelEntry, TreeLibrary, VARIANTS } from './TreeLibrary';
import { vegUniforms } from './TreeMaterials';

interface VegIndex {
  size: number;
  half: number;
  chunks: [number, number, number, number][];
}

/** Per-tree record in world space: x, y, z, h, r, species, seed, rotY. */
const STRIDE = 8;

interface VegChunk {
  trees: Float32Array;
  shrubs: Float32Array;
  imp: THREE.Mesh | null;
}

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
vec3 toCam = cameraPosition - base;
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
float ignImp(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

interface NearSet {
  e: ModelEntry;
  lod: 0 | 1;
  bark: THREE.InstancedMesh;
  leaves: THREE.InstancedMesh;
}

/** Impostor billboards + near instanced trees, streamed from per-chunk LiDAR vegetation. */
export class Forest {
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, VegChunk>();
  private readonly loading = new Set<string>();
  private readonly available = new Map<string, [number, number]>();
  private readonly impMaterial: THREE.MeshStandardMaterial;
  private readonly impUniforms: Record<string, THREE.IUniform>;
  private readonly quad: THREE.BufferGeometry;
  private readonly near: NearSet[] = [];
  private readonly shrubMesh: { bark: THREE.InstancedMesh; leaves: THREE.InstancedMesh };
  private lastNear = new THREE.Vector3(1e9, 0, 0);
  loadRadius = 1900;
  nearRadius = 150;
  lod0Radius = 40;
  shrubRadius = 90;
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
          if (alb.a < 0.5 || vFade < ignImp(gl_FragCoord.xy)) discard;
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
    this.impMaterial = m;
    // Near instanced meshes per model entry and LOD.
    for (const e of lib.entries) {
      for (const lod of [0, 1] as const) {
        const cap = lod === 0 ? 400 : 3000;
        const bark = new THREE.InstancedMesh(lod === 0 ? e.geo.bark0 : e.geo.bark1, e.bark, cap);
        const leaves = new THREE.InstancedMesh(lod === 0 ? e.geo.leaves0 : e.geo.leaves1, e.foliage, cap);
        for (const im of [bark, leaves]) {
          im.count = 0;
          im.frustumCulled = false;
          im.castShadow = true;
          im.receiveShadow = true;
          im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          im.setColorAt(0, new THREE.Color(1, 1, 1));
          this.root.add(im);
        }
        leaves.customDepthMaterial = e.foliageDepth;
        this.near.push({ e, lod, bark, leaves });
      }
    }
    const sh = lib.entry('round', 2);
    const sb = new THREE.InstancedMesh(sh.geo.bark1, sh.bark, 20000);
    const sl = new THREE.InstancedMesh(sh.geo.leaves1, sh.foliage, 20000);
    for (const im of [sb, sl]) {
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.root.add(im);
    }
    sl.customDepthMaterial = sh.foliageDepth;
    this.shrubMesh = { bark: sb, leaves: sl };
    this.setSeason(0);
  }

  get stats(): Record<string, number> {
    let n0 = 0, n1 = 0, imp = 0;
    for (const n of this.near) {
      if (n.lod === 0) n0 += n.leaves.count;
      else n1 += n.leaves.count;
    }
    for (const c of this.chunks.values()) imp += c.trees.length / STRIDE;
    return { chunks: this.chunks.size, lod0: n0, lod1: n1, trees: imp, shrubs: this.shrubMesh.leaves.count };
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
    const repr: Record<Archetype, number> = { spruce: 3, bspruce: 4, pine: 5, aspen: 0, poplar: 1, round: 7, shrub: 7 };
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
    const repr: Record<Archetype, number> = { spruce: 3, bspruce: 4, pine: 5, aspen: 0, poplar: 1, round: 7, shrub: 7 };
    const g = c.imp!.geometry as THREE.InstancedBufferGeometry;
    const iC = g.getAttribute('iC') as THREE.InstancedBufferAttribute;
    const n = c.trees.length / STRIDE;
    for (let k = 0; k < n; k++) {
      const sp = c.trees[k * STRIDE + 5];
      const a = archetypeOf(sp);
      const col = this.leafColor.get(sp)!;
      const ref = this.leafColor.get(repr[a])!;
      iC.setXYZ(k, col.r / Math.max(ref.r, 1e-3), col.g / Math.max(ref.g, 1e-3), col.b / Math.max(ref.b, 1e-3));
    }
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
    const trees = parse(16, nT);
    const shrubs = parse(16 + nT * 10, nS);
    const chunk: VegChunk = { trees, shrubs, imp: null };
    if (nT > 0) {
      const g = new THREE.InstancedBufferGeometry();
      g.index = this.quad.index;
      g.setAttribute('position', this.quad.getAttribute('position'));
      g.setAttribute('normal', this.quad.getAttribute('normal'));
      const iA = new Float32Array(nT * 4);
      const iB = new Float32Array(nT * 4);
      for (let k = 0; k < nT; k++) {
        const t = k * STRIDE;
        const sp = trees[t + 5];
        const e = this.lib.entry(archetypeOf(sp), trees[t + 6] % VARIANTS);
        iA.set([trees[t], trees[t + 1], trees[t + 2], trees[t + 3]], k * 4);
        iB.set([e.frameW * (trees[t + 4] / e.model.R), e.frameH * (trees[t + 3] / e.model.H), e.layer, trees[t + 7]], k * 4);
      }
      g.setAttribute('iA', new THREE.InstancedBufferAttribute(iA, 4));
      g.setAttribute('iB', new THREE.InstancedBufferAttribute(iB, 4));
      g.setAttribute('iC', new THREE.InstancedBufferAttribute(new Float32Array(nT * 3).fill(1), 3));
      g.instanceCount = nT;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + 128, ymin + 20, z0 + 128), 260);
      const mesh = new THREE.Mesh(g, this.impMaterial);
      mesh.name = `imp_${key}`;
      mesh.receiveShadow = true;
      chunk.imp = mesh;
      this.fillTint(chunk);
      this.root.add(mesh);
    }
    this.chunks.set(key, chunk);
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
      } else if (d > this.loadRadius + 400 && this.chunks.has(key)) {
        const c = this.chunks.get(key)!;
        if (c.imp) {
          this.root.remove(c.imp);
          c.imp.geometry.dispose();
        }
        this.chunks.delete(key);
      }
    }
    if (cam.distanceToSquared(this.lastNear) > 16) this.updateNear(cam);
    return pending === 0 && this.loading.size === 0;
  }

  private updateNear(cam: THREE.Vector3): void {
    this.lastNear.copy(cam);
    for (const n of this.near) {
      n.bark.count = 0;
      n.leaves.count = 0;
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const byEntry = new Map<ModelEntry, { 0: NearSet; 1: NearSet }>();
    for (const n of this.near) {
      const rec = byEntry.get(n.e) ?? ({} as { 0: NearSet; 1: NearSet });
      rec[n.lod] = n;
      byEntry.set(n.e, rec);
    }
    const R2 = this.nearRadius * this.nearRadius;
    const s = this.index.size;
    let shrubN = 0;
    const sh = this.shrubMesh;
    const shEntry = this.lib.entry('round', 2);
    const shrubCol = new THREE.Color(0.1, 0.2, 0.06);
    for (const [key, c] of this.chunks) {
      const [i, j] = this.available.get(key)!;
      const cx = -this.index.half + (i + 0.5) * s;
      const cz = -this.index.half + (j + 0.5) * s;
      if (Math.hypot(cx - cam.x, cz - cam.z) > this.nearRadius + 190) continue;
      const t = c.trees;
      for (let k = 0; k < t.length; k += STRIDE) {
        const dx = t[k] - cam.x;
        const dz = t[k + 2] - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const sp = t[k + 5];
        const e = this.lib.entry(archetypeOf(sp), t[k + 6] % VARIANTS);
        const lod = d2 < this.lod0Radius * this.lod0Radius ? 0 : 1;
        const n = byEntry.get(e)![lod];
        if (n.leaves.count >= n.leaves.instanceMatrix.count) continue;
        pos.set(t[k], t[k + 1] - 0.05, t[k + 2]);
        q.setFromAxisAngle(up, t[k + 7]);
        const sxz = t[k + 4] / e.model.R;
        scl.set(sxz, t[k + 3] / e.model.H, sxz);
        m.compose(pos, q, scl);
        const idx = n.leaves.count++;
        n.bark.count++;
        n.leaves.setMatrixAt(idx, m);
        n.bark.setMatrixAt(idx, m);
        const lc = this.leafColor.get(sp)!;
        n.leaves.setColorAt(idx, lc);
        n.bark.setColorAt(idx, this.barkColor.get(sp)!);
      }
      const sr2 = this.shrubRadius * this.shrubRadius;
      const u = c.shrubs;
      for (let k = 0; k < u.length && shrubN < sh.leaves.instanceMatrix.count; k += STRIDE) {
        const dx = u[k] - cam.x;
        const dz = u[k + 2] - cam.z;
        if (dx * dx + dz * dz > sr2) continue;
        pos.set(u[k], u[k + 1] - 0.1, u[k + 2]);
        q.setFromAxisAngle(up, u[k + 7]);
        const h = Math.max(u[k + 3], 0.6);
        scl.set((h * 0.7) / shEntry.model.R * 1.6, h / shEntry.model.H, (h * 0.7) / shEntry.model.R * 1.6);
        m.compose(pos, q, scl);
        sh.leaves.setMatrixAt(shrubN, m);
        sh.bark.setMatrixAt(shrubN, m);
        const v = 0.8 + 0.4 * ((u[k + 6] * 37) % 1);
        sh.leaves.setColorAt(shrubN, shrubCol.clone().multiplyScalar(v));
        sh.bark.setColorAt(shrubN, new THREE.Color(0.4, 0.35, 0.3));
        shrubN++;
      }
    }
    sh.leaves.count = sh.bark.count = shrubN;
    for (const im of [sh.leaves, sh.bark]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    for (const n of this.near) {
      for (const im of [n.bark, n.leaves]) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
    void ARCHETYPES;
  }
}
