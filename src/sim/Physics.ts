import RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingRec } from '../world/buildings/BuildingGen';
import type { TerrainStore } from '../world/terrain/TerrainStore';

/** Scratch values handed to Rapier setters (no object per call). */
const _v = { x: 0, y: 0, z: 0 };
const _q = { x: 0, y: 0, z: 0, w: 1 };

/** Numeric key of a level-0 terrain node (i, j < 4096). */
const nodeKey = (i: number, j: number) => i * 4096 + j;

/**
 * Rapier world with streamed colliders: 1 m terrain heightfields for level-0 nodes near the
 * player, wall boxes for nearby buildings, and trunk cylinders for nearby trees.
 *
 * The world advances only in fixed steps (`step(h)`, driven by a FixedStep clock), never by frame
 * time. Streamed colliders come from pools: trunk cylinders and wall boxes are moved, resized and
 * re-enabled rather than created and destroyed as the player travels, so streaming leaves no garbage
 * on either side of the WASM boundary.
 */
export class Physics {
  world!: RAPIER.World;
  R = RAPIER;
  private readonly terrain = new Map<number, RAPIER.Collider>();
  private readonly terrainWant = new Set<number>();
  private terrainScratch = new Float32Array(0);
  private readonly buildings = new Map<string, RAPIER.Collider[]>();
  private readonly meshes = new Map<string, RAPIER.Collider[]>();
  /** Every trunk cylinder ever made; the first `trunkUsed` are live, the rest disabled. */
  private readonly trunkPool: RAPIER.Collider[] = [];
  private trunkUsed = 0;
  private lastTrunkPos = { x: 1e9, z: 1e9 };
  /** Disabled wall boxes ready for reuse (buildings, fences). */
  private readonly wallPool: RAPIER.Collider[] = [];
  private walls: RAPIER.Collider[] = [];

  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }

  /** Keep heightfields for level-0 terrain nodes within `radius` of (x, z). */
  updateTerrain(store: TerrainStore, x: number, z: number, radius = 200): void {
    const idx = store.index;
    const s = idx.size(0);
    const want = this.terrainWant;
    want.clear();
    const i0 = Math.floor((x - radius + idx.half) / s), i1 = Math.floor((x + radius + idx.half) / s);
    const j0 = Math.floor((z - radius + idx.half) / s), j1 = Math.floor((z + radius + idx.half) / s);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = nodeKey(i, j);
        const r = store.get(0, i, j);
        if (!r) continue;
        want.add(key);
        if (this.terrain.has(key)) continue;
        const n = store.n;
        const cells = n - 1;
        // Rapier copies the heights in, so one scratch buffer serves every node.
        if (this.terrainScratch.length !== n * n) this.terrainScratch = new Float32Array(n * n);
        const hf = this.terrainScratch;
        let minH = Infinity;
        for (let k = 0; k < n * n; k++) minH = Math.min(minH, r.heights[k]);
        for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) hf[ix * n + iz] = r.heights[iz * n + ix] - minH;
        const [ox, oz] = idx.origin(0, i, j);
        const desc = RAPIER.ColliderDesc.heightfield(cells, cells, hf, { x: s, y: 1, z: s })
          .setTranslation(ox + s / 2, minH, oz + s / 2)
          .setFriction(0.9);
        this.terrain.set(key, this.world.createCollider(desc));
      }
    }
    for (const [key, c] of this.terrain) {
      if (!want.has(key)) {
        this.world.removeCollider(c, false);
        this.terrain.delete(key);
      }
    }
  }

  /** A wall box from the pool (enabled), sized and placed. `ang`: heading atan2(dz, dx). */
  private wall(hx: number, hy: number, hz: number, x: number, y: number, z: number, ang: number): RAPIER.Collider {
    let c = this.wallPool.pop();
    _v.x = hx; _v.y = hy; _v.z = hz;
    if (!c) c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz));
    else {
      c.setHalfExtents(_v);
      c.setEnabled(true);
    }
    _v.x = x; _v.y = y; _v.z = z;
    c.setTranslation(_v);
    _q.x = 0; _q.y = Math.sin(-ang / 2); _q.z = 0; _q.w = Math.cos(-ang / 2);
    c.setRotation(_q);
    return c;
  }

  private releaseWall(c: RAPIER.Collider): void {
    c.setEnabled(false);
    this.wallPool.push(c);
  }

  addBuildings(key: string, buildings: BuildingRec[]): void {
    if (this.buildings.has(key)) return;
    const cols: RAPIER.Collider[] = [];
    for (const b of buildings) {
      const top = b.base + Math.max(b.eave, 2) + 0.5;
      const bottom = Math.min(b.baseMin, b.base) - 1;
      const hy = (top - bottom) / 2;
      const n = b.poly.length;
      for (let k = 0; k < n; k++) {
        const p = b.poly[k];
        const q = b.poly[(k + 1) % n];
        const dx = q[0] - p[0], dz = q[1] - p[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.2) continue;
        cols.push(this.wall(len / 2 + 0.1, hy, 0.15, (p[0] + q[0]) / 2, bottom + hy, (p[1] + q[1]) / 2, Math.atan2(dz, dx)));
      }
    }
    this.buildings.set(key, cols);
  }

  removeBuildings(key: string): void {
    const cols = this.buildings.get(key);
    if (!cols) return;
    for (const c of cols) this.releaseWall(c);
    this.buildings.delete(key);
  }

  /** Static triangle-mesh colliders (bridges) for a streamed chunk. */
  addMeshes(key: string, meshes: { pos: Float32Array; idx: Uint32Array }[]): void {
    if (this.meshes.has(key)) return;
    const cols = meshes.map((m) =>
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(m.pos, m.idx).setFriction(0.9)),
    );
    this.meshes.set(key, cols);
  }

  removeMeshes(key: string): void {
    const cols = this.meshes.get(key);
    if (!cols) return;
    for (const c of cols) this.world.removeCollider(c, false);
    this.meshes.delete(key);
  }

  /** Replace the thin static walls (fences): centre, half length, half height, heading atan2(dz, dx). */
  setWalls(walls: { x: number; y: number; z: number; hl: number; hh: number; ang: number }[]): void {
    for (const c of this.walls) this.releaseWall(c);
    this.walls = walls.map((b) => this.wall(b.hl, b.hh, 0.06, b.x, b.y, b.z, b.ang));
  }

  /** Trunk cylinders for the trees near (x, z) (trees: [x, y, z, h, ...] stride 8), from the pool. */
  updateTrunks(trees: Float32Array[], x: number, z: number, radius = 45): void {
    if (Math.hypot(x - this.lastTrunkPos.x, z - this.lastTrunkPos.z) < 8) return;
    this.lastTrunkPos.x = x;
    this.lastTrunkPos.z = z;
    const before = this.trunkUsed;
    let used = 0;
    const r2 = radius * radius;
    for (const arr of trees) {
      for (let k = 0; k < arr.length; k += 8) {
        const dx = arr[k] - x, dz = arr[k + 2] - z;
        if (dx * dx + dz * dz > r2) continue;
        const h = arr[k + 3];
        const r = Math.max(0.08, h * 0.011);
        let c = this.trunkPool[used];
        if (!c) {
          c = this.world.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, r));
          this.trunkPool.push(c);
        } else {
          c.setHalfHeight(h / 2);
          c.setRadius(r);
          if (used >= before) c.setEnabled(true);
        }
        _v.x = arr[k]; _v.y = arr[k + 1] + h / 2; _v.z = arr[k + 2];
        c.setTranslation(_v);
        used++;
      }
    }
    for (let i = used; i < before; i++) this.trunkPool[i].setEnabled(false);
    this.trunkUsed = used;
  }

  /** Advance the world by one fixed step (optionally collecting contact events). */
  step(h = 1 / 60, events?: RAPIER.EventQueue): void {
    this.world.timestep = h;
    this.world.step(events);
  }
}
