import * as THREE from 'three';
import type { TerrainIndex } from './TerrainIndex';
import type { Resident, TerrainStore } from './TerrainStore';
import { TERRAIN_GRID, terrainVertexPars } from './terrainShaders';

const MIN_LEVEL = -2; // virtual render levels below data level 0 (1 m vertices at -2)
const MAX_INSTANCES = 2048;

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

/** One selection of terrain patches (the camera's, or the sun shadow map's) and its instance buffers. */
interface Selection {
  geo: THREE.InstancedBufferGeometry;
  node: THREE.InstancedBufferAttribute;
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  frustum: THREE.Frustum;
  count: number;
  max: number;
  /** Ask the store for missing data (the camera's view does; the shadow selection uses what is resident). */
  request: boolean;
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
  const sel: Selection = { geo, node: attr(), a: attr(), b: attr(), frustum: new THREE.Frustum(), count: 0, max, request };
  geo.setAttribute('iNode', sel.node);
  geo.setAttribute('iA', sel.a);
  geo.setAttribute('iB', sel.b);
  geo.instanceCount = 0;
  return sel;
}

/**
 * CDLOD terrain: selects quadtree nodes each frame and draws all of them in a single
 * instanced draw call, sampling heights from the streamed texture array. The sun's shadow map gets
 * its own selection (the patches inside the shadow volume, at the same detail as the camera's view,
 * so shadows line up) drawn by a proxy mesh that only the shadow pass sees.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  /** Draws the shadow selection; visible only during the shadow pass (see World). */
  readonly shadowMesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly main: Selection;
  private readonly shadow: Selection;
  private readonly ranges = new Float32Array(16);
  private readonly box = new THREE.Box3();
  private readonly projView = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  lodScale = 3.0;
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
    this.shadow = makeSelection(grid, 512, false);
    this.uniforms = {
      uHeights: { value: store.atlas },
      uCamPos: { value: this.camPos },
      uLodRange: { value: this.ranges },
    };
    this.mesh = new THREE.Mesh(this.main.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'terrain';
    this.shadowMesh = new THREE.Mesh(this.shadow.geo, material);
    this.shadowMesh.frustumCulled = false;
    this.shadowMesh.customDepthMaterial = depthMaterial;
    this.shadowMesh.castShadow = true;
    this.shadowMesh.visible = false;
    this.mesh.add(this.shadowMesh);
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

  /** `shadowFrustum`: the sun shadow camera's frustum for this frame (null: no shadow selection). */
  update(camera: THREE.Camera, shadowFrustum: THREE.Frustum | null = null): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.main.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.main.count = 0;
    this.shadow.count = 0;
    this.complete = true;
    const root = this.index.get(this.index.rootLevel, 0, 0);
    if (!root) return;
    this.store.request(root, -1);
    if (!this.store.get(root.level, 0, 0)) {
      this.complete = false;
      this.main.geo.instanceCount = 0;
      this.shadow.geo.instanceCount = 0;
      this.store.update();
      return;
    }
    this.select(this.main, this.index.rootLevel, 0, 0);
    this.commit(this.main);
    if (shadowFrustum) {
      this.shadow.frustum.copy(shadowFrustum);
      this.select(this.shadow, this.index.rootLevel, 0, 0);
    }
    this.commit(this.shadow);
    this.store.update();
    if (this.store.busy) this.complete = false;
  }

  private commit(sel: Selection): void {
    sel.geo.instanceCount = sel.count;
    if (sel.count === 0) return;
    for (const a of [sel.node, sel.a, sel.b]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, sel.count * 4);
      a.needsUpdate = true;
    }
  }

  /** Bounds (hmin, hmax) for a render node from the finest data node covering it. */
  private bounds(r: number, x0: number, z0: number): [number, number] {
    const idx = this.index;
    let best: [number, number] = [0, 3000];
    for (let dl = idx.rootLevel; dl >= Math.max(r, 0); dl--) {
      const s = idx.size(dl);
      const n = idx.get(dl, Math.floor((x0 + idx.half) / s + 1e-6), Math.floor((z0 + idx.half) / s + 1e-6));
      if (!n) break;
      best = [n.hmin, n.hmax];
    }
    return best;
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
    const [hmin, hmax] = this.bounds(r, x0, z0);
    this.box.min.set(x0, hmin - 2, z0);
    this.box.max.set(x0 + S, hmax + 2, z0 + S);
    if (!sel.frustum.intersectsBox(this.box)) return;
    // Detail by distance to the camera in both selections, so the shadow casters match the terrain seen.
    const dist = this.box.distanceToPoint(this.camPos);
    const split = r > MIN_LEVEL && dist < this.ranges[r - 1 - MIN_LEVEL] && this.hasDataBelow(r, x0, z0);
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
    const node = sel.node.array as Float32Array;
    node[k * 4] = x0;
    node[k * 4 + 1] = z0;
    node[k * 4 + 2] = S;
    node[k * 4 + 3] = r;
    this.writeData(sel.a.array as Float32Array, k, A);
    this.writeData(sel.b.array as Float32Array, k, B);
  }

  private writeData(arr: Float32Array, k: number, d: Resident): void {
    const { level, i, j } = d.info;
    const [ox, oz] = this.index.origin(level, i, j);
    arr[k * 4] = d.slot;
    arr[k * 4 + 1] = ox;
    arr[k * 4 + 2] = oz;
    arr[k * 4 + 3] = this.index.nodeRes / this.index.size(level);
  }
}
