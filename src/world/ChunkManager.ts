import * as THREE from 'three';
import { BucketPool } from '../util/Pool';
import { WorkerPool } from '../util/WorkerPool';
import type { PackedStream } from './workers/chunk.worker';

interface ChunkIndex {
  size: number;
  half: number;
  chunks: [number, number, Record<string, number>][];
}

interface ChunkRes {
  id: number;
  ok: boolean;
  data: { walls: PackedStream; roofs: PackedStream; trims: PackedStream };
  raw: Record<string, unknown>;
}

/** A pooled building mesh: geometry buffers with room for `cap` vertices, drawn up to `drawRange`. */
interface Part {
  mesh: THREE.Mesh;
  cap: number;
}

interface Loaded {
  group: THREE.Group;
  raw: Record<string, unknown>;
  parts: Part[];
}

export interface ChunkMaterials {
  facade: THREE.Material;
  roof: THREE.Material;
  trim: THREE.Material;
}

/** Vertex attributes of a building stream: name, item size, PackedStream field. */
const ATTRS: [string, number, keyof PackedStream][] = [
  ['position', 3, 'pos'], ['normal', 3, 'nrm'], ['aUv', 2, 'uv'], ['a0', 4, 'a0'], ['a1', 4, 'a1'], ['a2', 4, 'a2'], ['a3', 4, 'a3'],
];

/** Frames a released mesh rests before reuse, so the GPU has finished drawing from its buffers. */
const QUARANTINE = 4;
/** Vertices a frame may start uploading (newly loaded chunks enter the scene within this budget). */
const UPLOAD_BUDGET = 120000;

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

/**
 * Streams 256 m feature chunks (buildings) around the camera, building their geometry in workers.
 *
 * Streaming is built for fast travel without hitches or garbage:
 * - meshes come from pools by vertex capacity (powers of two): a chunk's walls, roofs and trims are
 *   copied into the buffers of meshes released by chunks that streamed out, which are updated in
 *   place instead of new GPU buffers being created; released meshes rest a few frames first, so a
 *   buffer the GPU may still be drawing from is never overwritten;
 * - finished chunks wait in a queue and enter the scene within a per-frame vertex budget, so a burst
 *   of arrivals is uploaded over several frames instead of stalling one.
 */
export class ChunkManager {
  readonly root = new THREE.Group();
  private readonly available = new Map<string, [number, number]>();
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Set<string>();
  private readonly arrived: [string, ChunkRes][] = [];
  private readonly pool: WorkerPool<{ url: string }, ChunkRes>;
  private readonly parts: Map<THREE.Material, BucketPool<Part>> = new Map();
  /** Released meshes waiting out their quarantine: [frame released, material, part]. */
  private readonly resting: [number, THREE.Material, Part][] = [];
  private frame = 0;
  loadRadius = 1600;
  unloadRadius = 2000;
  maxConcurrent = 4;
  onChunkLoaded?: (key: string, raw: Record<string, unknown>, group: THREE.Group) => void;
  onChunkUnloaded?: (key: string) => void;

  constructor(
    private readonly index: ChunkIndex,
    private readonly baseUrl: string,
    private readonly mats: ChunkMaterials,
  ) {
    for (const [i, j] of index.chunks) this.available.set(`${i}_${j}`, [i, j]);
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
    this.pool = new WorkerPool(() => new Worker(new URL('./workers/chunk.worker.ts', import.meta.url), { type: 'module' }), n);
    this.root.name = 'chunks';
    for (const m of [mats.facade, mats.roof, mats.trim]) this.parts.set(m, new BucketPool((cap) => this.makePart(m, cap), 1024));
  }

  get busy(): boolean {
    return this.loading.size > 0 || this.arrived.length > 0;
  }

  get stats(): { loaded: number; loading: number; meshes: number } {
    let meshes = 0;
    for (const p of this.parts.values()) meshes += p.created;
    return { loaded: this.loaded.size, loading: this.loading.size + this.arrived.length, meshes };
  }

  private center(i: number, j: number): [number, number] {
    const s = this.index.size;
    return [-this.index.half + (i + 0.5) * s, -this.index.half + (j + 0.5) * s];
  }

  /** Returns true when every chunk inside the load radius is loaded. */
  update(cam: THREE.Vector3): boolean {
    this.frame++;
    const want: [string, number][] = [];
    for (const [key, [i, j]] of this.available) {
      const [cx, cz] = this.center(i, j);
      const d = Math.hypot(cx - cam.x, cz - cam.z);
      if (d < this.loadRadius) {
        if (!this.loaded.has(key) && !this.loading.has(key)) want.push([key, d]);
      } else if (d > this.unloadRadius && this.loaded.has(key)) {
        this.unload(key);
      }
    }
    want.sort((a, b) => a[1] - b[1]);
    for (const [key] of want) {
      if (this.loading.size >= this.maxConcurrent) break;
      this.loading.add(key);
      const url = new URL(`${this.baseUrl}/${key}.bin`, location.href).href;
      this.pool
        .run({ url })
        .then((res) => this.arrived.push([key, res]))
        .catch((e) => {
          console.warn('chunk failed', key, e);
          this.loading.delete(key);
        });
    }
    // Arrivals enter the scene within the frame's upload budget (at least one per frame).
    let budget = UPLOAD_BUDGET;
    while (this.arrived.length && budget > 0) {
      const [key, res] = this.arrived.shift()!;
      this.loading.delete(key);
      budget -= this.install(key, res, cam);
    }
    return want.length === 0 && this.loading.size === 0 && this.arrived.length === 0;
  }

  private unload(key: string): void {
    const l = this.loaded.get(key)!;
    this.root.remove(l.group);
    for (const p of l.parts) {
      l.group.remove(p.mesh);
      this.resting.push([this.frame, p.mesh.material as THREE.Material, p]);
    }
    this.loaded.delete(key);
    this.onChunkUnloaded?.(key);
  }

  /** A mesh with room for `cap` vertices of a building stream. */
  private makePart(mat: THREE.Material, cap: number): Part {
    const g = new THREE.BufferGeometry();
    for (const [name, size] of ATTRS) {
      const a = new THREE.BufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
    }
    g.boundingSphere = new THREE.Sphere();
    g.boundingBox = new THREE.Box3();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { mesh, cap };
  }

  /** A pooled mesh for `n` vertices (taking back meshes whose quarantine is over first). */
  private acquire(mat: THREE.Material, n: number): Part {
    for (let k = this.resting.length - 1; k >= 0; k--) {
      const [at, m, p] = this.resting[k];
      if (this.frame - at < QUARANTINE) continue;
      this.parts.get(m)!.release(p, p.cap);
      this.resting.splice(k, 1);
    }
    return this.parts.get(mat)!.acquire(n);
  }

  /** Fill pooled meshes with a chunk's streams and add it to the scene; returns the vertices uploaded. */
  private install(key: string, res: ChunkRes, cam: THREE.Vector3): number {
    if (this.loaded.has(key)) return 0;
    // The camera may have left while the chunk was in flight.
    const [i, j] = this.available.get(key)!;
    const [cx, cz] = this.center(i, j);
    if (Math.hypot(cx - cam.x, cz - cam.z) > this.unloadRadius) return 0;
    const group = new THREE.Group();
    group.name = `chunk_${key}`;
    const parts: Part[] = [];
    let uploaded = 0;
    const add = (s: PackedStream, mat: THREE.Material, name: string) => {
      const n = s.pos.length / 3;
      if (n === 0) return;
      const part = this.acquire(mat, n);
      const g = part.mesh.geometry;
      for (const [attr, size, field] of ATTRS) {
        const a = g.getAttribute(attr) as THREE.BufferAttribute;
        (a.array as Float32Array).set(s[field]);
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * size);
        a.needsUpdate = true;
      }
      g.setDrawRange(0, n);
      // Bounds of the vertices in use (the buffers are larger).
      _box.makeEmpty();
      const p = s.pos;
      for (let k = 0; k < p.length; k += 3) _box.expandByPoint(_v.set(p[k], p[k + 1], p[k + 2]));
      g.boundingBox!.copy(_box);
      _box.getBoundingSphere(g.boundingSphere!);
      part.mesh.name = name;
      part.mesh.userData.shadowSphere = undefined;
      group.add(part.mesh);
      parts.push(part);
      uploaded += n;
    };
    add(res.data.walls, this.mats.facade, 'walls');
    add(res.data.roofs, this.mats.roof, 'roofs');
    add(res.data.trims, this.mats.trim, 'trims');
    this.root.add(group);
    this.loaded.set(key, { group, raw: res.raw, parts });
    this.onChunkLoaded?.(key, res.raw, group);
    return Math.max(uploaded, 1);
  }
}
