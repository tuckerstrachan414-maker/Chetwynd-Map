import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';

describe('rapier heightfield layout', () => {
  it('maps heights[i + j * (nrows+1)] as expected', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const n = 4; // 4x4 cells -> 5x5 samples
    const size = 8;
    const h = new Float32Array((n + 1) * (n + 1));
    // Sample (ix along x, iz along z): height = ix * 1 + iz * 10 (row-major in our data: data[iz*(n+1)+ix]).
    for (let iz = 0; iz <= n; iz++) for (let ix = 0; ix <= n; ix++) h[ix * (n + 1) + iz] = ix + iz * 10;
    const desc = RAPIER.ColliderDesc.heightfield(n, n, h, { x: size, y: 1, z: size });
    world.createCollider(desc);
    world.step();
    const probe = (x: number, z: number) => {
      const ray = new RAPIER.Ray({ x, y: 100, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 200, true);
      return hit ? 100 - hit.timeOfImpact : NaN;
    };
    // Heightfield spans [-size/2, size/2] in x and z.
    const at = (ix: number, iz: number) => probe(-size / 2 + (ix * size) / n + 1e-3, -size / 2 + (iz * size) / n + 1e-3);
    const vals = [at(0, 0), at(4, 0), at(0, 4), at(2, 3)];
    console.log('probe', vals);
    expect(vals[0]).toBeCloseTo(0, 1);
    // Column-major: element (row = iz, col = ix) lives at ix * (nrows + 1) + iz.
    expect(vals[3]).toBeCloseTo(32, 1);
  });
});
