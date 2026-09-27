import { describe, expect, it } from 'vitest';
import { generateTree } from '../src/world/vegetation/TreeGen';

describe('tree generator', () => {
  for (const arch of ['spruce', 'bspruce', 'pine', 'aspen', 'poplar', 'round'] as const) {
    it(`${arch}: produces bounded LOD0/LOD1 meshes`, () => {
      const t = generateTree(arch, 3, [[0, 0, 1, 1]]);
      const tris0 = (t.lod0.bark.idx.length + t.lod0.leaves.idx.length) / 3;
      const tris1 = (t.lod1.bark.idx.length + t.lod1.leaves.idx.length) / 3;
      expect(tris0).toBeGreaterThan(200);
      expect(tris0).toBeLessThan(30000);
      expect(tris1).toBeLessThan(tris0);
      let maxY = 0;
      for (let k = 1; k < t.lod0.leaves.pos.length; k += 3) maxY = Math.max(maxY, t.lod0.leaves.pos[k]);
      expect(maxY).toBeGreaterThan(t.H * 0.8);
      expect(maxY).toBeLessThan(t.H * 1.25);
      console.log(arch, 'lod0 tris', tris0, 'lod1 tris', tris1);
    });
  }
});
