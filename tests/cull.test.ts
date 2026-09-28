import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CulledInstances, CullView } from '../src/world/InstanceCull';
import { StreamScan } from '../src/world/StreamScan';
import { Grass } from '../src/world/vegetation/Grass';
import type { TerrainStore } from '../src/world/terrain/TerrainStore';

/** A camera at the origin, 1.7 m up, looking north (-z). */
function camera(yawDeg = 0): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(75, 16 / 9, 0.1, 200000);
  c.position.set(0, 1.7, 0);
  c.rotation.set(0, THREE.MathUtils.degToRad(-yawDeg), 0, 'YXZ');
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

const noon = new THREE.Vector3(0, 1, 0);

function meshes(n: number, cap: number): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  for (let i = 0; i < n; i++) {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), cap);
    m.castShadow = true;
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    out.push(m);
  }
  return out;
}

describe('per-instance culling', () => {
  it('keeps spheres in front of the camera and rejects those behind it', () => {
    const v = new CullView();
    v.update(camera(), noon);
    expect(v.inView(0, 2, -30, 1)).toBe(true);
    expect(v.inView(0, 2, 30, 1)).toBe(false);
    // Just outside the left edge, but a big enough radius reaches in.
    expect(v.inView(-80, 2, -30, 1)).toBe(false);
    expect(v.inView(-80, 2, -30, 60)).toBe(true);
  });

  it('keeps shadow casters behind the camera when a low sun throws their shadow forward', () => {
    const v = new CullView();
    // Sun low in the south (+z), behind the camera: shadows fall north, into the view.
    v.update(camera(), new THREE.Vector3(0, 0.25, 1).normalize());
    expect(v.inView(0, 8, 10, 4)).toBe(false);
    expect(v.shadowReaches(0, 8, 10, 4, 8)).toBe(true);
    // Sun in the north (in front): the same tree's shadow falls away from the view.
    v.update(camera(), new THREE.Vector3(0, 0.25, -1).normalize());
    expect(v.shadowReaches(0, 8, 10, 4, 8)).toBe(false);
    // The view's version changes only when the view or the light moved.
    const ver = v.version;
    v.update(camera(), new THREE.Vector3(0, 0.25, -1).normalize());
    expect(v.version).toBe(ver);
  });

  it('draws in-view instances first, adds shadow casters for the shadow pass, and hides empty meshes', () => {
    const ms = meshes(2, 16);
    const ci = new CulledInstances(ms, 16);
    const col = ci.channel(ms[0].instanceColor!);
    const v = new CullView();
    v.update(camera(), new THREE.Vector3(0, 0.25, 1).normalize());
    const m = new THREE.Matrix4();
    const add = (x: number, z: number, tag: number) => {
      const i = ci.add(m.makeTranslation(x, 0, z), x, 8, z, 4, 8);
      col[i * 3] = tag;
    };
    add(0, 10, 1); // behind, shadow reaches the view
    add(0, -30, 2); // in view
    add(0, 200, 3); // far behind: neither
    add(5, -60, 4); // in view
    ci.cull(v);
    expect(ci.main).toBe(2);
    expect(ci.shadow).toBe(3);
    expect(ms[0].instanceMatrix).toBe(ms[1].instanceMatrix);
    const arr = ms[0].instanceMatrix.array as Float32Array;
    // Order: the two in view (z = -30, -60), then the caster (z = 10).
    expect([arr[14], arr[16 + 14], arr[32 + 14]]).toEqual([-30, -60, 10]);
    const colours = ms[0].instanceColor!.array as Float32Array;
    expect([colours[0], colours[3], colours[6]]).toEqual([2, 4, 1]);
    expect(ms.every((x) => x.count === 2 && x.visible)).toBe(true);
    CulledInstances.beginShadowPass();
    expect(ms[0].count).toBe(3);
    CulledInstances.endShadowPass();
    expect(ms[0].count).toBe(2);
    // Unchanged view: nothing is rewritten or uploaded.
    const version = ms[0].instanceMatrix.version;
    ci.cull(v);
    expect(ms[0].instanceMatrix.version).toBe(version);
    // Turned around: nothing in view, so the meshes are hidden (no draw call).
    const back = new CullView();
    back.update(camera(180), noon);
    ci.clear();
    add(0, -30, 5);
    ci.cull(back);
    expect(ci.main).toBe(0);
    expect(ms.every((x) => !x.visible)).toBe(true);
    ci.dispose();
  });
});

describe('streaming scan gate', () => {
  it('parses chunk centres once and rescans only after moving or a change', () => {
    const s = new StreamScan(256, 1024);
    expect(s.centre('4_5')).toEqual([-1024 + 4.5 * 256, -1024 + 5.5 * 256]);
    const cam = new THREE.Vector3(0, 0, 0);
    expect(s.due(cam)).toBe(true);
    expect(s.due(cam)).toBe(false);
    cam.x += 5;
    expect(s.due(cam)).toBe(false);
    cam.x += 5;
    expect(s.due(cam)).toBe(true);
    s.dirty = true;
    expect(s.due(cam)).toBe(true);
  });
});

describe('grass density', () => {
  it('draws fewer clumps per cell at lower quality while keeping the expected density', () => {
    const store = { heightAt: () => 600, materialAt: () => 0, version: 0 } as unknown as TerrainStore;
    const g = new Grass(store);
    const rings = (g as unknown as { rings: { perCell: number; perCellNow: number; uniforms: Record<string, THREE.IUniform> }[] }).rings;
    for (const k of [0.35, 0.6, 1, 1.35]) {
      g.setDensity(k);
      for (const r of rings) {
        expect(r.perCellNow).toBe(Math.max(1, Math.ceil(r.perCell * k - 1e-6)));
        expect(r.uniforms.uDensity.value).toBeLessThanOrEqual(1);
        // Clumps kept per cell on full-density ground = base clumps x quality factor.
        expect(r.perCellNow * r.uniforms.uDensity.value).toBeCloseTo(r.perCell * k, 6);
      }
    }
  });
});
