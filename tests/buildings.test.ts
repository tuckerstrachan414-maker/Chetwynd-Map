import { describe, expect, it } from 'vitest';
import { buildBuilding, Stream, type BuildingRec } from '../src/world/buildings/BuildingGen';

function streams() {
  return { walls: new Stream(), roofs: new Stream(), trims: new Stream() };
}

const house: BuildingRec = {
  id: 't1', cls: 'house', seed: 1234, poly: [[0, 0], [12, 0], [12, 8], [0, 8]],
  base: 600, baseMin: 599.5, eave: 3, top: 6, roof: { type: 'gabled', pitch: 30, ridgeAz: 90 }, ri: 1,
};

describe('building generator', () => {
  it('builds a gabled house whose ridge matches the pitch', () => {
    const s = streams();
    buildBuilding(house, s, null);
    expect(s.walls.count).toBeGreaterThan(0);
    expect(s.roofs.count).toBeGreaterThan(0);
    let maxY = -Infinity;
    for (let k = 1; k < s.roofs.pos.length; k += 3) maxY = Math.max(maxY, s.roofs.pos[k]);
    // Half width 4 m at 30 degrees -> 2.31 m above the eave.
    expect(maxY).toBeCloseTo(603 + 4 * Math.tan(Math.PI / 6), 1);
    for (let k = 1; k < s.roofs.nrm.length; k += 3) expect(s.roofs.nrm[k]).toBeGreaterThan(0);
  });

  it('wall normals point outward for either winding', () => {
    for (const poly of [house.poly, [...house.poly].reverse()]) {
      const s = streams();
      buildBuilding({ ...house, poly: poly as [number, number][] }, s, null);
      for (let k = 0; k < s.walls.pos.length; k += 9) {
        const cx = (s.walls.pos[k] + s.walls.pos[k + 3] + s.walls.pos[k + 6]) / 3 - 6;
        const cz = (s.walls.pos[k + 2] + s.walls.pos[k + 5] + s.walls.pos[k + 8]) / 3 - 4;
        const d = cx * s.walls.nrm[k] + cz * s.walls.nrm[k + 2];
        expect(d).toBeGreaterThan(-1e-6);
      }
    }
  });

  it('flat commercial roof gets a parapet above the eave', () => {
    const s = streams();
    buildBuilding({ ...house, cls: 'commercial', roof: { type: 'flat' }, seed: 7 }, s, null);
    let maxWall = -Infinity;
    for (let k = 1; k < s.walls.pos.length; k += 3) maxWall = Math.max(maxWall, s.walls.pos[k]);
    expect(maxWall).toBeGreaterThanOrEqual(603);
  });
});
