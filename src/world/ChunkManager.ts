import * as THREE from 'three';
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

interface Loaded {
  group: THREE.Group;
  raw: Record<string, unknown>;
}

export interface ChunkMaterials {
  facade: THREE.Material;
  roof: THREE.Material;
  trim: THREE.Material;
}

function geometry(s: PackedStream): THREE.BufferGeometry | null {
  if (s.pos.length === 0) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(s.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(s.nrm, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(s.uv, 2));
  g.setAttribute('a0', new THREE.BufferAttribute(s.a0, 4));
  g.setAttribute('a1', new THREE.BufferAttribute(s.a1, 4));
  g.setAttribute('a2', new THREE.BufferAttribute(s.a2, 4));
  g.setAttribute('a3', new THREE.BufferAttribute(s.a3, 4));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * Streams 256 m feature chunks (buildings, and later vegetation/props) around the camera,
 * building their geometry in workers.
 */
export class ChunkManager {
  readonly root = new THREE.Group();
  private readonly available = new Map<string, [number, number]>();
  private readonly loaded = new Map<string, Loaded>();
  private readonly loading = new Set<string>();
  private readonly pool: WorkerPool<{ url: string }, ChunkRes>;
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
  }

  get busy(): boolean {
    return this.loading.size > 0;
  }

  get stats(): { loaded: number; loading: number } {
    return { loaded: this.loaded.size, loading: this.loading.size };
  }

  private center(i: number, j: number): [number, number] {
    const s = this.index.size;
    return [-this.index.half + (i + 0.5) * s, -this.index.half + (j + 0.5) * s];
  }

  /** Returns true when every chunk inside the load radius is loaded. */
  update(cam: THREE.Vector3): boolean {
    const want: [string, number][] = [];
    for (const [key, [i, j]] of this.available) {
      const [cx, cz] = this.center(i, j);
      const d = Math.hypot(cx - cam.x, cz - cam.z);
      if (d < this.loadRadius) {
        if (!this.loaded.has(key) && !this.loading.has(key)) want.push([key, d]);
      } else if (d > this.unloadRadius && this.loaded.has(key)) {
        const l = this.loaded.get(key)!;
        this.root.remove(l.group);
        l.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
        this.loaded.delete(key);
        this.onChunkUnloaded?.(key);
      }
    }
    want.sort((a, b) => a[1] - b[1]);
    for (const [key] of want) {
      if (this.loading.size >= this.maxConcurrent) break;
      this.loading.add(key);
      const url = new URL(`${this.baseUrl}/${key}.bin`, location.href).href;
      this.pool
        .run({ url })
        .then((res) => this.onLoaded(key, res))
        .catch((e) => console.warn('chunk failed', key, e))
        .finally(() => this.loading.delete(key));
    }
    return want.length === 0 && this.loading.size === 0;
  }

  private onLoaded(key: string, res: ChunkRes): void {
    const group = new THREE.Group();
    group.name = `chunk_${key}`;
    const add = (s: PackedStream, mat: THREE.Material, name: string) => {
      const g = geometry(s);
      if (!g) return;
      const m = new THREE.Mesh(g, mat);
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    };
    add(res.data.walls, this.mats.facade, 'walls');
    add(res.data.roofs, this.mats.roof, 'roofs');
    add(res.data.trims, this.mats.trim, 'trims');
    this.root.add(group);
    this.loaded.set(key, { group, raw: res.raw });
    this.onChunkLoaded?.(key, res.raw, group);
  }
}
