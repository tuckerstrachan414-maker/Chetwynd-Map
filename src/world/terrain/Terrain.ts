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

/**
 * CDLOD terrain: selects quadtree nodes each frame and draws all of them in a single
 * instanced draw call, sampling heights from the streamed texture array.
 */
export class Terrain {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly iNode: THREE.InstancedBufferAttribute;
  private readonly iA: THREE.InstancedBufferAttribute;
  private readonly iB: THREE.InstancedBufferAttribute;
  private readonly ranges = new Float32Array(16);
  private readonly frustum = new THREE.Frustum();
  private readonly box = new THREE.Box3();
  private readonly projView = new THREE.Matrix4();
  private count = 0;
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
    this.geo = buildGrid();
    this.iNode = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
    this.iB = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 4), 4);
    for (const a of [this.iNode, this.iA, this.iB]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iNode', this.iNode);
    this.geo.setAttribute('iA', this.iA);
    this.geo.setAttribute('iB', this.iB);
    this.geo.instanceCount = 0;
    this.uniforms = {
      uHeights: { value: store.atlas },
      uCamPos: { value: this.camPos },
      uLodRange: { value: this.ranges },
    };
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.customDepthMaterial = depthMaterial;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
    this.mesh.name = 'terrain';
    this.updateRanges();
  }

  updateRanges(): void {
    for (let r = MIN_LEVEL; r <= this.index.rootLevel; r++) {
      this.ranges[r - MIN_LEVEL] = this.lodScale * this.index.size(r);
    }
    this.ranges[this.index.rootLevel - MIN_LEVEL] = 1e9;
  }

  get stats(): TerrainStats {
    return { instances: this.count, resident: this.store.residentCount };
  }

  update(camera: THREE.Camera): void {
    this.camPos.setFromMatrixPosition(camera.matrixWorld);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, (camera as THREE.PerspectiveCamera).reversedDepth);
    this.count = 0;
    this.complete = true;
    const root = this.index.get(this.index.rootLevel, 0, 0);
    if (!root) return;
    this.store.request(root, -1);
    if (!this.store.get(root.level, 0, 0)) {
      this.complete = false;
      this.geo.instanceCount = 0;
      this.store.update();
      return;
    }
    this.select(this.index.rootLevel, 0, 0);
    this.geo.instanceCount = this.count;
    this.iNode.needsUpdate = true;
    this.iA.needsUpdate = true;
    this.iB.needsUpdate = true;
    this.iNode.addUpdateRange(0, this.count * 4);
    this.iA.addUpdateRange(0, this.count * 4);
    this.iB.addUpdateRange(0, this.count * 4);
    this.store.update();
    if (this.store.busy) this.complete = false;
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

  private select(r: number, i: number, j: number): void {
    const idx = this.index;
    const S = idx.size(r);
    const x0 = -idx.half + i * S;
    const z0 = -idx.half + j * S;
    const [hmin, hmax] = this.bounds(r, x0, z0);
    this.box.min.set(x0, hmin - 2, z0);
    this.box.max.set(x0 + S, hmax + 2, z0 + S);
    if (!this.frustum.intersectsBox(this.box)) return;
    const dist = this.box.distanceToPoint(this.camPos);
    const split = r > MIN_LEVEL && dist < this.ranges[r - 1 - MIN_LEVEL] && this.hasDataBelow(r, x0, z0);
    if (split) {
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) this.select(r - 1, i * 2 + a, j * 2 + b);
      return;
    }
    if (this.count >= MAX_INSTANCES) return;
    const prio = dist / S;
    const A = this.dataFor(r, x0, z0, r, true, prio);
    const B = this.dataFor(r, x0, z0, r + 1, false, prio) ?? A;
    if (!A || !B) return;
    const k = this.count++;
    this.iNode.array[k * 4] = x0;
    this.iNode.array[k * 4 + 1] = z0;
    this.iNode.array[k * 4 + 2] = S;
    this.iNode.array[k * 4 + 3] = r;
    this.writeData(this.iA.array as Float32Array, k, A);
    this.writeData(this.iB.array as Float32Array, k, B);
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
