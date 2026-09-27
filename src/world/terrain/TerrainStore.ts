import * as THREE from 'three';
import { WorkerPool } from '../../util/WorkerPool';
import type { HeightTile } from '../codec';
import { nodeKey, type NodeInfo, type TerrainIndex } from './TerrainIndex';

interface LoadRes {
  id: number;
  ok: boolean;
  tile: HeightTile;
  mats: Uint8Array | null;
}

export interface Resident {
  info: NodeInfo;
  slot: number;
  heights: Float32Array;
  lastUsed: number;
}

/**
 * Streams terrain height nodes into a GPU texture array (one layer per node) and keeps
 * CPU copies for height queries. Slots are recycled least-recently-used.
 */
export class TerrainStore {
  readonly atlas: THREE.DataArrayTexture;
  /** Ground material IDs per vertex (level-0 nodes only), same slot as the height layer. */
  readonly matAtlas: THREE.DataArrayTexture;
  readonly n: number;
  private readonly slots: (Resident | null)[];
  private readonly resident = new Map<string, Resident>();
  private readonly wanted = new Map<string, { info: NodeInfo; priority: number }>();
  private readonly loading = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly pool: WorkerPool<{ url: string; matUrl?: string }, LoadRes>;
  private frame = 0;
  private pendingUploads = 0;
  /** Bumped whenever a node becomes resident (consumers re-sample heights/materials). */
  version = 0;
  maxConcurrent = 6;

  constructor(
    readonly index: TerrainIndex,
    private readonly baseUrl: string,
    readonly slotCount: number,
    private readonly materialUrl?: string,
  ) {
    this.n = index.nodeRes + 1;
    const data = new Float32Array(this.n * this.n * slotCount);
    this.atlas = new THREE.DataArrayTexture(data, this.n, this.n, slotCount);
    this.atlas.format = THREE.RedFormat;
    this.atlas.type = THREE.FloatType;
    this.atlas.internalFormat = 'R32F';
    this.atlas.minFilter = THREE.LinearFilter;
    this.atlas.magFilter = THREE.LinearFilter;
    this.atlas.generateMipmaps = false;
    this.atlas.needsUpdate = true;
    this.matAtlas = new THREE.DataArrayTexture(new Uint8Array(this.n * this.n * slotCount), this.n, this.n, slotCount);
    this.matAtlas.format = THREE.RedIntegerFormat;
    this.matAtlas.type = THREE.UnsignedByteType;
    this.matAtlas.internalFormat = 'R8UI';
    this.matAtlas.minFilter = THREE.NearestFilter;
    this.matAtlas.magFilter = THREE.NearestFilter;
    this.matAtlas.generateMipmaps = false;
    this.matAtlas.needsUpdate = true;
    this.slots = new Array(slotCount).fill(null);
    const workers = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.pool = new WorkerPool(
      () => new Worker(new URL('../workers/terrain.worker.ts', import.meta.url), { type: 'module' }),
      workers,
    );
  }

  get(level: number, i: number, j: number): Resident | undefined {
    return this.resident.get(nodeKey(level, i, j));
  }

  get busy(): boolean {
    return this.loading.size > 0 || this.wanted.size > 0 || this.pendingUploads > 0;
  }

  get residentCount(): number {
    return this.resident.size;
  }

  /** Mark a resident node as used this frame (protects it from eviction). */
  touch(r: Resident): void {
    r.lastUsed = this.frame;
  }

  /** Request a node; lower priority value loads first. */
  request(info: NodeInfo, priority: number): void {
    const key = nodeKey(info.level, info.i, info.j);
    if (this.resident.has(key) || this.loading.has(key) || this.failed.has(key)) return;
    const w = this.wanted.get(key);
    if (!w || priority < w.priority) this.wanted.set(key, { info, priority });
  }

  /** Call once per frame after requests: starts loads in priority order. */
  update(): void {
    this.frame++;
    if (this.wanted.size === 0) return;
    const queue = [...this.wanted.entries()].sort((a, b) => a[1].priority - b[1].priority);
    this.wanted.clear();
    for (const [key, { info }] of queue) {
      if (this.loading.size >= this.maxConcurrent) break;
      this.loading.add(key);
      const url = new URL(`${this.baseUrl}/${info.level}/${info.i}_${info.j}.bin`, location.href).href;
      const matUrl = info.level === 0 && this.materialUrl ? new URL(`${this.materialUrl}/0/${info.i}_${info.j}.bin`, location.href).href : undefined;
      this.pool
        .run({ url, matUrl })
        .then((res) => this.onLoaded(key, info, res.tile, res.mats))
        .catch((err) => {
          console.warn('terrain load failed', key, err);
          this.failed.add(key);
        })
        .finally(() => this.loading.delete(key));
    }
  }

  private onLoaded(key: string, info: NodeInfo, tile: HeightTile, mats: Uint8Array | null): void {
    const slot = this.allocSlot();
    if (slot < 0) return;
    const r: Resident = { info, slot, heights: tile.heights, lastUsed: this.frame };
    this.version++;
    const layerSize = this.n * this.n;
    (this.atlas.image.data as Float32Array).set(tile.heights, slot * layerSize);
    this.atlas.addLayerUpdate(slot);
    this.atlas.needsUpdate = true;
    if (mats && mats.length === layerSize) {
      (this.matAtlas.image.data as Uint8Array).set(mats, slot * layerSize);
      this.matAtlas.addLayerUpdate(slot);
      this.matAtlas.needsUpdate = true;
    }
    this.slots[slot] = r;
    this.resident.set(key, r);
  }

  private allocSlot(): number {
    let best = -1;
    let bestAge = -1;
    for (let s = 0; s < this.slots.length; s++) {
      const r = this.slots[s];
      if (!r) return s;
      // Never evict the root or nodes used in the last two frames.
      if (r.info.level === this.index.rootLevel) continue;
      const age = this.frame - r.lastUsed;
      if (age > 2 && age > bestAge) {
        best = s;
        bestAge = age;
      }
    }
    if (best >= 0) {
      const old = this.slots[best]!;
      this.resident.delete(nodeKey(old.info.level, old.info.i, old.info.j));
      this.slots[best] = null;
    }
    return best;
  }

  /** Bilinear height from the finest resident node covering (x, z); NaN if none. */
  heightAt(x: number, z: number): number {
    const idx = this.index;
    let found: Resident | undefined;
    for (let level = 0; level <= idx.rootLevel; level++) {
      const s = idx.size(level);
      const r = this.get(level, Math.floor((x + idx.half) / s), Math.floor((z + idx.half) / s));
      if (r) {
        found = r;
        break;
      }
    }
    if (!found) return NaN;
    const { level, i, j } = found.info;
    const s = idx.size(level);
    const [x0, z0] = idx.origin(level, i, j);
    const res = idx.nodeRes;
    const tx = Math.min(Math.max(((x - x0) / s) * res, 0), res - 1e-6);
    const tz = Math.min(Math.max(((z - z0) / s) * res, 0), res - 1e-6);
    const ix = Math.floor(tx);
    const iz = Math.floor(tz);
    const fx = tx - ix;
    const fz = tz - iz;
    const n = this.n;
    const h = found.heights;
    const a = h[iz * n + ix];
    const b = h[iz * n + ix + 1];
    const c = h[(iz + 1) * n + ix];
    const d = h[(iz + 1) * n + ix + 1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  /** Ground material ID (see pipeline/ground.py) at (x, z) from resident level-0 nodes; -1 if unknown. */
  materialAt(x: number, z: number): number {
    const idx = this.index;
    const s = idx.size(0);
    const r = this.get(0, Math.floor((x + idx.half) / s), Math.floor((z + idx.half) / s));
    if (!r) return -1;
    const [x0, z0] = idx.origin(0, r.info.i, r.info.j);
    const res = idx.nodeRes;
    const ix = Math.min(Math.max(Math.round(((x - x0) / s) * res), 0), res);
    const iz = Math.min(Math.max(Math.round(((z - z0) / s) * res), 0), res);
    const data = this.matAtlas.image.data as Uint8Array;
    return data[r.slot * this.n * this.n + iz * this.n + ix];
  }

  /** Finest resident level covering (x,z), for diagnostics. */
  levelAt(x: number, z: number): number {
    const idx = this.index;
    for (let level = 0; level <= idx.rootLevel; level++) {
      const s = idx.size(level);
      if (this.get(level, Math.floor((x + idx.half) / s), Math.floor((z + idx.half) / s))) return level;
    }
    return -1;
  }

  markUploadPending(delta: number): void {
    this.pendingUploads += delta;
  }
}
