import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import { Drone } from '../src/sim/Drone';
import { Physics, SINK_DEPTH } from '../src/sim/Physics';
import { Player } from '../src/sim/Player';
import { TerrainIndex, type TerrainIndexJson } from '../src/world/terrain/TerrainIndex';
import { type Resident, type TerrainStore } from '../src/world/terrain/TerrainStore';

// A tiny pyramid: 4 m level-0 tiles, 8 m and 16 m coarser levels, nodes of 4 samples across.
// Level 0 is only present for the north-east quarter, so the other tiles can only be ground from level 1.
const INDEX: TerrainIndexJson = {
  nodeRes: 4,
  nodeBase: 4,
  rootLevel: 2,
  half: 8,
  levels: {
    '0': [[2, 2, 0, 0], [2, 3, 0, 0], [3, 2, 0, 0], [3, 3, 0, 0]],
    '1': [[0, 0, 0, 0], [0, 1, 0, 0], [1, 0, 0, 0], [1, 1, 0, 0]],
    '2': [[0, 0, 0, 0]],
  },
};
const index = new TerrainIndex(INDEX);

// A sloped plane: any swap of x and z in the physics layout would put the ground in the wrong place.
const plane = (x: number, z: number) => 1 + 0.3 * x + 0.7 * z;
// Fine data differs from the coarse data by a constant, so a test can tell which one the ground came from.
const fine = (x: number, z: number) => plane(x, z) + 0.25;

function node(level: number, i: number, j: number, f: (x: number, z: number) => number): Resident {
  const n = INDEX.nodeRes + 1;
  const sp = index.size(level) / INDEX.nodeRes;
  const ox = index.originX(level, i), oz = index.originX(level, j);
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights[iz * n + ix] = f(ox + ix * sp, oz + iz * sp);
  return { info: { level, i, j, hmin: 0, hmax: 0 }, slot: 0, heights, lastUsed: 0 };
}

/** A stand-in for TerrainStore that serves the given resident nodes (the physics only reads these). */
function storeOf(nodes: Map<string, Resident>): TerrainStore {
  return {
    index,
    n: INDEX.nodeRes + 1,
    get: (level: number, i: number, j: number) => nodes.get(`${level}/${i}/${j}`),
  } as unknown as TerrainStore;
}
const put = (nodes: Map<string, Resident>, r: Resident) => nodes.set(`${r.info.level}/${r.info.i}/${r.info.j}`, r);

/** Height of the physics ground at (x, z), from a straight-down ray (NaN if there is none). */
function groundY(p: Physics, x: number, z: number): number {
  p.step(1 / 60);
  const hit = p.world.castRay(new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 }), 200, true);
  return hit ? 100 - hit.timeOfImpact : NaN;
}

describe('physics ground follows the finest terrain data', () => {
  it('uses coarser data for tiles with no level-0 node (beyond the 1 m survey)', async () => {
    const p = new Physics();
    await p.init();
    const nodes = new Map<string, Resident>();
    put(nodes, node(1, 0, 0, plane));
    put(nodes, node(1, 1, 0, plane));
    put(nodes, node(1, 0, 1, plane));
    put(nodes, node(1, 1, 1, plane));
    const store = storeOf(nodes);
    p.updateTerrain(store, -6, -6, 6);
    for (const [x, z] of [[-6.3, -5.7], [-4.5, -4.5], [-7.4, -2.6]]) {
      expect(groundY(p, x, z)).toBeCloseTo(plane(x, z), 2);
    }
  });

  it('has no ground where no terrain data exists', async () => {
    const p = new Physics();
    await p.init();
    const nodes = new Map<string, Resident>();
    put(nodes, node(1, 0, 0, plane));
    p.updateTerrain(storeOf(nodes), 5, 5, 6);
    expect(groundY(p, 5, 5)).toBeNaN();
  });

  it('rebuilds a tile from its 1 m data once that streams in', async () => {
    const p = new Physics();
    await p.init();
    const nodes = new Map<string, Resident>();
    put(nodes, node(1, 1, 1, plane));
    const store = storeOf(nodes);
    p.updateTerrain(store, 2, 2, 3);
    expect(groundY(p, 2.5, 2.5)).toBeCloseTo(plane(2.5, 2.5), 2);
    put(nodes, node(0, 2, 2, fine));
    p.updateTerrain(store, 2, 2, 3);
    expect(groundY(p, 2.5, 2.5)).toBeCloseTo(fine(2.5, 2.5), 2);
  });
});

describe('sunk bodies are lifted back onto the ground', () => {
  it('a drone that drove into the ground is a crash and is set back on the surface', async () => {
    const p = new Physics();
    await p.init();
    const nodes = new Map<string, Resident>();
    put(nodes, node(0, 2, 2, plane));
    put(nodes, node(0, 2, 3, plane));
    put(nodes, node(0, 3, 2, plane));
    put(nodes, node(0, 3, 3, plane));
    const store = storeOf(nodes);
    p.updateTerrain(store, 2, 2, 6);
    const g = plane(2, 2);
    const d = new Drone(p);
    d.spawn(2, g, 2, 0);
    d.body.setTranslation({ x: 2, y: g - 2, z: 2 }, true);
    d.recover(() => g);
    expect(d.crashed).toBe(true);
    expect(d.crashReason).toBe('CRASH');
    expect(d.position.y).toBeGreaterThan(g);
    expect(d.position.y).toBeLessThan(g + 0.2);
  });

  it('a drone above the ground is left alone', async () => {
    const p = new Physics();
    await p.init();
    const d = new Drone(p);
    const g = 3;
    d.spawn(2, g + 5, 2, 0);
    d.recover(() => g);
    expect(d.crashed).toBe(false);
    expect(d.position.y).toBeGreaterThan(g + 4);
  });

  it('a walker spawned below the ground stands back on it', async () => {
    const p = new Physics();
    await p.init();
    const nodes = new Map<string, Resident>();
    put(nodes, node(0, 2, 2, plane));
    put(nodes, node(0, 2, 3, plane));
    put(nodes, node(0, 3, 2, plane));
    put(nodes, node(0, 3, 3, plane));
    p.updateTerrain(storeOf(nodes), 2, 2, 6);
    const g = plane(2, 2);
    const walker = new Player(p);
    walker.ground = (x, z) => plane(x, z);
    walker.spawn(2, g - 3, 2);
    walker.step(1 / 60);
    expect(walker.position.y).toBeGreaterThan(g - SINK_DEPTH);
    expect(walker.position.y).toBeLessThan(g + 0.5);
  });
});
