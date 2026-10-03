import * as THREE from 'three';
import { CASCADES, CascadedSunShadow } from '../../engine/CascadedShadows';
import type { CullView } from '../InstanceCull';
import type { TerrainIndex } from './TerrainIndex';
import type { Resident, TerrainStore } from './TerrainStore';
import { TERRAIN_GRID, terrainVertexPars } from './terrainShaders';

const MIN_LEVEL = -2; // virtual render levels below data level 0 (1 m vertices at -2)
const MAX_INSTANCES = 2048;
/** Per shadow cascade: detail factor on the terrain LOD ranges (far cascades draw coarser terrain). */
const SHADOW_LOD = [1, 1, 0.6, 0.4];

function buildGrid(): THREE.InstancedBufferGeometry {
  const G = TERRAIN_GRID;
  const pos: number[] = [];
  const idx: number[] = [];
  const v = (x: number, z: number, skirt: number) => {
    pos.push(x, skirt, z);
    return pos.length / 3 - 1;
  };
  const grid: number[][] = [];
  for (let z = 0; z <= G; z++) {
    grid.push([]);
    for (let x = 0; x <= G; x++) grid[z].push(v(x, z, 0));
  }
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const a = grid[z][x];
      const b = grid[z][x + 1];
      const c = grid[z + 1][x];
      const d = grid[z + 1][x + 1];
      // Alternate diagonals so the morph to the half-resolution grid stays symmetric.
      if ((x + z) % 2 === 0) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  }
  // Skirts: a downward flap along each edge.
  const edge = (pts: number[]) => {
    const skirt = pts.map((p) => v(pos[p * 3], pos[p * 3 + 2], 1));
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const c = skirt[k];
      const d = skirt[k + 1];
      idx.push(a, b, c, b, d, c, a, c, b, b, c, d);
    }
  };
  edge(grid[0]);
  edge(grid[G]);
  edge(grid.map((r) => r[0]));
  edge(grid.map((r) => r[G]));
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

/** Patch a built-in material so it renders CDLOD terrain from the height atlas. */
export function patchTerrainVertex(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: Record<string, THREE.IUniform>): void {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${terrainVertexPars}`)
    .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
    .replace('#include <begin_vertex>', 'vec3 transformed = terrainPosition();');
  shader.vertexShader = shader.vertexShader.replace(/attribute vec3 aGrid;\n/, '');
  // Grid coordinates live in the position attribute: (x, skirtFlag, z).
  shader.vertexShader = shader.vertexShader.replace('vec2 g = aGrid.xy;', 'vec2 g = position.xz;')
    .replace('if (aGrid.z > 0.5)', 'if (position.y > 0.5)').replace('vSkirt = aGrid.z;', 'vSkirt = position.y;');
}

export interface TerrainStats {
  instances: number;
  resident: number;
}

/** Instance attributes of one selection: patch (x0, z0, size, level) and its two data nodes. */
interface InstanceSet {
  node: THREE.InstancedBufferAttribute;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
}

/** GPU copies of each selection's instance data, used in turn (see Selection.sets). */
const SETS = 3;

/**
 * One selection of terrain patches (the camera's, or a shadow cascade's) and its instance buffers.
 *
 * The patches are re-selected every frame but rarely change; uploading them anyway rewrote buffers the
 * GPU was still drawing from the previous frame, which on ANGLE/Direct3D 11 serialises CPU and GPU
 * (measured: ~15 ms for a single patch). So a selection is written into scratch arrays, compared with
 * what was last uploaded, and only a real change is uploaded, into the next of three buffer sets, so
 * a buffer the GPU may still be reading is never touched.
 */
interface Selection {
  geo: THREE.InstancedBufferGeometry;
  /** Scratch arrays the selection is written into. */
  node: Float32Array;
  a: Float32Array;
  b: Float32Array;
  sets: InstanceSet[];
  current: number;
  /** Instances in the uploaded set (and the content it holds, as uploaded). */
  uploaded: number;
  frustum: THREE.Frustum;
  count: number;
  max: number;
  /** Ask the store for missing data (the camera's view does; the shadow selection uses what is resident). */
  request: boolean;
  /** Strict caster test for shadow selections: patches whose shadow cannot reach the view are skipped. */
  view: CullView | null;
  /** Detail factor on the LOD ranges (1 = the camera's; far shadow cascades use coarser terrain). */
  lodK: number;
}

function makeSelection(grid: THREE.InstancedBufferGeometry, max: number, request: boolean): Selection {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = grid.index;
  geo.setAttribute('position', grid.getAttribute('position'));
  const attr = () => {
    const x = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    x.setUsage(THREE.DynamicDrawUsage);
    return x;
  };
  const sets: InstanceSet[] = [];
  for (let k = 0; k < SETS; k++) sets.push({ node: attr(), a: attr(), b: attr() });
  const sel: Selection = {
    geo, node: new Float32Array(max * 4), a: new Float32Array(max * 4), b: new Float32Array(max * 4), sets, current: 0, uploaded: -1,
    frustum: new THREE.Frustum(), count: 0, max, request, view: null, lodK: 1,
  };
  geo.setAttribute('iNode', sets[0].node);
  geo.setAttribute('iA', sets[0].a);
  geo.setAttribute('iB', sets[0].b);
  geo.instanceCount = 0;
  return sel;
}

/** First `n` values of two arrays are equal. */
function same(x: Float32Array, y: Float32Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * CDLOD terrain: selects quadtree nodes each frame and draws all of them in a single
 * instanced draw call, sampling heights from the streamed texture array. Each sun shadow cascade gets
 * its own selection (the patches inside that cascade's light volume whose shadow can reach the view,
 * at the same detail as the camera's view, so shadows line up), re-selected only on the frames the
 * cascade is redrawn and drawn by a proxy mesh that only the shadow pass sees, in its own cascade.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  /** Per cascade: draws that cascade's shadow selection; visible only during the shadow pass (see World). */
  readonly shadowMeshes: THREE.Mesh[] = [];
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly main: Selection;
  private readonly shadows: Selection[] = [];
  private readonly sphere = new THREE.Sphere();
  private readonly ranges = new Float32Array(16);
  private readonly box = new THREE.Box3();
  private readonly projView = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  /**
   * LOD range per node size. The shading normal comes from the normal atlas per pixel, not from the
   * vertices, so the grid only shapes depth and silhouettes: at 2 (for a 1080-pixel-high render) the
   * geometric error stays around a pixel, while at street level the old 3 drew the 1 m grid out to
   * 192 m as sub-pixel slivers that cost fragment work for nothing (40 % fewer triangles; most of the
   * terrain's MSAA overhead). It follows the render height (see setRenderHeight).
   */
  lodScale = 2.0;

  /**
   * Keep the geometric error near one pixel of the render target: the ranges scale with its height,
   * so a frame rendered smaller by dynamic resolution also draws a coarser grid (fewer, larger
   * triangles), and a taller one a finer grid.
   */
  setRenderHeight(h: number): void {
    const s = Math.round(Math.min(3, Math.max(1.2, (2 * h) / 1080)) * 20) / 20;
    if (s === this.lodScale) return;
    this.lodScale = s;
    this.updateRanges();
  }
  /** True once every node the current view wants at its ideal level is resident. */
  complete = false;

  constructor(
    readonly index: TerrainIndex,
    readonly store: TerrainStore,
    material: THREE.Material,
    depthMaterial: THREE.Material,
  ) {
    const grid = buildGrid();
    this.main = makeSelection(grid, MAX_INSTANCES, true);
    this.uniforms = {
      uHeights: { value: store.atlas },
      uNormals: { value: store.normalAtlas },
      uCamPos: { value: this.camPos },
      uLodRange: { value: this.ranges },
    };
    this.mesh = new THREE.Mesh(this.main.geo, material);
    // Drawn after the other opaque objects (roads 1-2, everything else 0; the sky goes last of all):
    // its ground shading is the most expensive in the scene, and whatever trees, grass, buildings and
    // roads already cover is then rejected by the depth test instead of shaded (5-8 % of the frame at
    // street level). Roads are draped above the ground, so the depth test, not the order, keeps them on top.
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    for (let c = 0; c < CASCADES; c++) {
      const sel = makeSelection(grid, 512, false);
      // Far cascades only ever shade distant ground, where the camera's terrain is coarse too.
      sel.lodK = SHADOW_LOD[c];
      const sm = new THREE.Mesh(sel.geo, material);
      sm.frustumCulled = false;
      sm.customDepthMaterial = depthMaterial;
      sm.castShadow = true;
      sm.visible = false;
      sm.name = `terrain:shadow${c}`;
      // Shown only while its own cascade's tile is drawn (showCascade).
      this.shadows.push(sel);
      this.shadowMeshes.push(sm);
      this.mesh.add(sm);
    }
    this.updateRanges();
  }

  updateRanges(): void {
    for (let r = MIN_LEVEL; r <= this.index.rootLevel; r++) {
      this.ranges[r - MIN_LEVEL] = this.lodScale * this.index.size(r);
    }
    this.ranges[this.index.rootLevel - MIN_LEVEL] = 1e9;
  }

  get stats(): TerrainStats {
    return { instances: this.main.count, resident: this.store.residentCount };
  }

  /**
   * `csm`: the sun's cascades (selections are rebuilt for the ones due this frame); `view` enables the
   * strict caster test (patches whose shadow cannot reach the camera's view are left out).
   */
  update(camera: THREE.Camera, csm: CascadedSunShadow | null = null, view: CullView | null = null): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.main.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.main.count = 0;
    this.complete = true;
    const root = this.index.get(this.index.rootLevel, 0, 0);
    if (!root) return;
    this.store.request(root, -1);
    if (!this.store.get(root.level, 0, 0)) {
      this.complete = false;
      this.main.geo.instanceCount = 0;
      for (const sel of this.shadows) {
        sel.count = 0;
        sel.geo.instanceCount = 0;
      }
      this.store.update();
      return;
    }
    this.select(this.main, this.index.rootLevel, 0, 0);
    this.commit(this.main);
    if (csm) {
      for (const c of csm.due) {
        const sel = this.shadows[c];
        sel.frustum.copy(csm.frustums[c]);
        sel.view = view;
        sel.count = 0;
        this.select(sel, this.index.rootLevel, 0, 0);
        this.commit(sel);
      }
    }
    this.store.update();
    if (this.store.busy) this.complete = false;
  }

  /** Around the shadow pass: the cascade proxies start hidden; each is shown for its own tile (showCascade). */
  beginShadowPass(): void {
    for (const m of this.shadowMeshes) m.visible = false;
  }

  /** As the shadow pass starts drawing cascade `c`: only that cascade's selection is drawn. */
  showCascade(c: number): void {
    for (let k = 0; k < this.shadowMeshes.length; k++) {
      this.shadowMeshes[k].visible = k === c && this.shadows[k].count > 0;
      this.shadows[k].geo.instanceCount = this.shadows[k].count;
    }
  }

  endShadowPass(): void {
    for (const m of this.shadowMeshes) m.visible = false;
  }

  /** Upload a selection only if it changed, into the next buffer set (see Selection). */
  private commit(sel: Selection): void {
    sel.geo.instanceCount = sel.count;
    const n = sel.count * 4;
    const cur = sel.sets[sel.current];
    if (sel.count === sel.uploaded && same(sel.node, cur.node.array as Float32Array, n)
      && same(sel.a, cur.a.array as Float32Array, n) && same(sel.b, cur.b.array as Float32Array, n)) return;
    sel.current = (sel.current + 1) % SETS;
    const next = sel.sets[sel.current];
    for (const [src, attr] of [[sel.node, next.node], [sel.a, next.a], [sel.b, next.b]] as const) {
      (attr.array as Float32Array).set(src.subarray(0, n));
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, Math.max(n, 4));
      attr.needsUpdate = true;
    }
    sel.geo.setAttribute('iNode', next.node);
    sel.geo.setAttribute('iA', next.a);
    sel.geo.setAttribute('iB', next.b);
    sel.uploaded = sel.count;
  }

  private bMin = 0;
  private bMax = 0;

  /** Bounds (hmin, hmax) for a render node from the finest data node covering it, into bMin/bMax. */
  private bounds(r: number, x0: number, z0: number): void {
    const idx = this.index;
    this.bMin = 0;
    this.bMax = 3000;
    for (let dl = idx.rootLevel; dl >= Math.max(r, 0); dl--) {
      const s = idx.size(dl);
      const n = idx.get(dl, Math.floor((x0 + idx.half) / s + 1e-6), Math.floor((z0 + idx.half) / s + 1e-6));
      if (!n) break;
      this.bMin = n.hmin;
      this.bMax = n.hmax;
    }
  }

  private dataFor(r: number, x0: number, z0: number, minLevel: number, request: boolean, prio: number): Resident | undefined {
    const idx = this.index;
    for (let dl = Math.max(minLevel, 0); dl <= idx.rootLevel; dl++) {
      const s = idx.size(dl);
      const i = Math.floor((x0 + idx.half) / s + 1e-6);
      const j = Math.floor((z0 + idx.half) / s + 1e-6);
      const res = this.store.get(dl, i, j);
      if (res) {
        this.store.touch(res);
        return res;
      }
      const info = idx.get(dl, i, j);
      if (info && request) {
        this.store.request(info, prio + (dl - r) * 0.001);
        this.complete = false;
      }
    }
    return undefined;
  }

  private hasDataBelow(r: number, x0: number, z0: number): boolean {
    // Can node r be refined? Children at level r-1 need data at level max(r-1, 0).
    const idx = this.index;
    const dl = Math.max(r - 1, 0);
    const s = idx.size(dl);
    if (r - 1 >= 0) {
      const S = idx.size(r);
      for (let a = 0; a < 2; a++)
        for (let b = 0; b < 2; b++) {
          if (idx.has(dl, Math.floor((x0 + a * S * 0.5 + idx.half) / s + 1e-6), Math.floor((z0 + b * S * 0.5 + idx.half) / s + 1e-6))) return true;
        }
      return false;
    }
    return idx.has(0, Math.floor((x0 + idx.half) / s + 1e-6), Math.floor((z0 + idx.half) / s + 1e-6));
  }

  private select(sel: Selection, r: number, i: number, j: number): void {
    const idx = this.index;
    const S = idx.size(r);
    const x0 = -idx.half + i * S;
    const z0 = -idx.half + j * S;
    this.bounds(r, x0, z0);
    this.box.min.set(x0, this.bMin - 2, z0);
    this.box.max.set(x0 + S, this.bMax + 2, z0 + S);
    if (!sel.frustum.intersectsBox(this.box)) return;
    if (sel.view) {
      // Strict caster culling: a patch neither in view nor able to shade the view casts nothing useful.
      const sp = this.box.getBoundingSphere(this.sphere);
      if (!sel.view.inView(sp.center.x, sp.center.y, sp.center.z, sp.radius)
        && !sel.view.shadowReaches(sp.center.x, sp.center.y, sp.center.z, sp.radius, sp.radius)) return;
    }
    // Detail by distance to the camera in all selections, so the shadow casters match the terrain seen.
    const dist = this.box.distanceToPoint(this.camPos);
    const split = r > MIN_LEVEL && dist < this.ranges[r - 1 - MIN_LEVEL] * sel.lodK && this.hasDataBelow(r, x0, z0);
    if (split) {
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) this.select(sel, r - 1, i * 2 + a, j * 2 + b);
      return;
    }
    if (sel.count >= sel.max) return;
    const prio = dist / S;
    const A = this.dataFor(r, x0, z0, r, sel.request, prio);
    const B = this.dataFor(r, x0, z0, r + 1, false, prio) ?? A;
    if (!A || !B) return;
    const k = sel.count++;
    const node = sel.node;
    node[k * 4] = x0;
    node[k * 4 + 1] = z0;
    node[k * 4 + 2] = S;
    node[k * 4 + 3] = r;
    this.writeData(sel.a, k, A);
    this.writeData(sel.b, k, B);
  }

  private writeData(arr: Float32Array, k: number, d: Resident): void {
    const { level, i, j } = d.info;
    const ox = this.index.originX(level, i), oz = this.index.originX(level, j);
    arr[k * 4] = d.slot;
    arr[k * 4 + 1] = ox;
    arr[k * 4 + 2] = oz;
    arr[k * 4 + 3] = this.index.nodeRes / this.index.size(level);
  }
}
