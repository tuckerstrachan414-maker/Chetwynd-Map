import RAPIER from '@dimforge/rapier3d-compat';
import type { BuildingRec } from '../world/buildings/BuildingGen';
import type { TerrainStore } from '../world/terrain/TerrainStore';

/**
 * Rapier world with streamed colliders: 1 m terrain heightfields for level-0 nodes near the
 * player, wall boxes for nearby buildings, and trunk cylinders for nearby trees.
 */
export class Physics {
  world!: RAPIER.World;
  R = RAPIER;
  private readonly terrain = new Map<string, RAPIER.Collider>();
  private readonly buildings = new Map<string, RAPIER.Collider[]>();
  private readonly meshes = new Map<string, RAPIER.Collider[]>();
  private trunks: RAPIER.Collider[] = [];
  private lastTrunkPos = { x: 1e9, z: 1e9 };

  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
  }

  /** Keep heightfields for level-0 terrain nodes within `radius` of (x, z). */
  updateTerrain(store: TerrainStore, x: number, z: number, radius = 200): void {
    const idx = store.index;
    const s = idx.size(0);
    const want = new Set<string>();
    const i0 = Math.floor((x - radius + idx.half) / s), i1 = Math.floor((x + radius + idx.half) / s);
    const j0 = Math.floor((z - radius + idx.half) / s), j1 = Math.floor((z + radius + idx.half) / s);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const key = `${i}_${j}`;
        const r = store.get(0, i, j);
        if (!r) continue;
        want.add(key);
        if (this.terrain.has(key)) continue;
        const n = store.n;
        const cells = n - 1;
        const hf = new Float32Array(n * n);
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
        const ang = Math.atan2(dz, dx);
        const desc = RAPIER.ColliderDesc.cuboid(len / 2 + 0.1, hy, 0.15)
          .setTranslation((p[0] + q[0]) / 2, bottom + hy, (p[1] + q[1]) / 2)
          .setRotation({ x: 0, y: Math.sin(-ang / 2), z: 0, w: Math.cos(-ang / 2) });
        cols.push(this.world.createCollider(desc));
      }
    }
    this.buildings.set(key, cols);
  }

  removeBuildings(key: string): void {
    const cols = this.buildings.get(key);
    if (!cols) return;
    for (const c of cols) this.world.removeCollider(c, false);
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

  /** Thin static walls (fences): centre, half length, half height, heading atan2(dz, dx). */
  addWalls(walls: { x: number; y: number; z: number; hl: number; hh: number; ang: number }[]): void {
    for (const b of walls) {
      const desc = RAPIER.ColliderDesc.cuboid(b.hl, b.hh, 0.06)
        .setTranslation(b.x, b.y, b.z)
        .setRotation({ x: 0, y: Math.sin(-b.ang / 2), z: 0, w: Math.cos(-b.ang / 2) });
      this.world.createCollider(desc);
    }
  }

  /** Replace trunk colliders with trees near (x, z). trees: [x, y, z, h, ...] stride 8. */
  updateTrunks(trees: Float32Array[], x: number, z: number, radius = 45): void {
    if (Math.hypot(x - this.lastTrunkPos.x, z - this.lastTrunkPos.z) < 8) return;
    this.lastTrunkPos = { x, z };
    for (const c of this.trunks) this.world.removeCollider(c, false);
    this.trunks = [];
    for (const arr of trees) {
      for (let k = 0; k < arr.length; k += 8) {
        const dx = arr[k] - x, dz = arr[k + 2] - z;
        if (dx * dx + dz * dz > radius * radius) continue;
        const h = arr[k + 3];
        const r = Math.max(0.08, h * 0.011);
        const desc = RAPIER.ColliderDesc.cylinder(h / 2, r).setTranslation(arr[k], arr[k + 1] + h / 2, arr[k + 2]);
        this.trunks.push(this.world.createCollider(desc));
      }
    }
  }

  step(): void {
    this.world.step();
  }
}
