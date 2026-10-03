import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CulledInstances, CullView } from '../src/world/InstanceCull';
import { StreamScan } from '../src/world/StreamScan';
import { Grass, grassUniforms } from '../src/world/vegetation/Grass';
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

/** An axis-aligned box as a frustum (stands in for a shadow cascade's orthographic light volume). */
function boxFrustum(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): THREE.Frustum {
  const P = (x: number, y: number, z: number, c: number) => new THREE.Plane(new THREE.Vector3(x, y, z), c);
  return new THREE.Frustum(P(1, 0, 0, -x0), P(-1, 0, 0, x1), P(0, 1, 0, -y0), P(0, -1, 0, y1), P(0, 0, 1, -z0), P(0, 0, -1, z1));
}
const everywhere = () => [0, 1, 2, 3].map(() => boxFrustum(-1e4, 1e4, -1e4, 1e4, -1e4, 1e4));

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

  it('draws in-view instances nearest first, gives casters to the shadow copies, and hides empty meshes', () => {
    const ms = meshes(2, 16);
    const ci = new CulledInstances(ms, 16);
    const col = ci.channel(ms[0].instanceColor!);
    // The camera-pass meshes stop casting; shadow-only copies (one set per cascade) take over.
    expect(ms.every((x) => !x.castShadow)).toBe(true);
    expect(ci.shadowMeshes.length).toBe(2 * 4);
    expect(ci.shadowMeshes.every((x) => x.castShadow && !x.visible)).toBe(true);
    const v = new CullView();
    v.update(camera(), new THREE.Vector3(0, 0.25, 1).normalize());
    v.setCascades(everywhere(), [0, 1, 2, 3]);
    const m = new THREE.Matrix4();
    const add = (x: number, z: number, tag: number) => {
      const i = ci.add(m.makeTranslation(x, 0, z), x, 8, z, 4, 8);
      col[i * 3] = tag;
    };
    add(0, 10, 1); // behind, shadow reaches the view
    add(5, -60, 4); // in view
    add(0, 200, 3); // far behind: neither
    add(0, -30, 2); // in view
    ci.cull(v);
    expect(ci.main).toBe(2);
    expect(ci.shadow).toBe(3);
    expect(ms[0].instanceMatrix).toBe(ms[1].instanceMatrix);
    // Camera pass: the two in view, nearest first (z = -30, then -60).
    const arr = ms[0].instanceMatrix.array as Float32Array;
    expect([arr[14], arr[16 + 14]]).toEqual([-30, -60]);
    const colours = ms[0].instanceColor!.array as Float32Array;
    expect([colours[0], colours[3]]).toEqual([2, 4]);
    // Shadow pass: each cascade's copies hold every caster inside it, nearest first (z = 10, -30, -60).
    expect(Array.from(ci.cascade)).toEqual([3, 3, 3, 3]);
    const sh = ci.shadowMeshes[0].instanceMatrix.array as Float32Array;
    expect([sh[14], sh[16 + 14], sh[32 + 14]]).toEqual([10, -30, -60]);
    expect(ms.every((x) => x.count === 2 && x.visible)).toBe(true);
    // Each cascade's copies are shown only while that cascade's tile is drawn.
    CulledInstances.beginShadowPass();
    expect(ci.shadowMeshes.every((x) => !x.visible && x.count === 3)).toBe(true);
    CulledInstances.showCascade(2);
    expect(ci.shadowMeshes.map((x) => x.visible)).toEqual([false, false, false, false, true, true, false, false]);
    CulledInstances.endShadowPass();
    expect(ci.shadowMeshes.every((x) => !x.visible)).toBe(true);
    // Unchanged view: nothing is rewritten or uploaded.
    const buffer = ms[0].instanceMatrix;
    const version = buffer.version;
    ci.cull(v);
    expect(ms[0].instanceMatrix).toBe(buffer);
    expect(ms[0].instanceMatrix.version).toBe(version);
    // A changed selection goes into another buffer of the ring (never the one the GPU last read).
    ci.clear();
    add(0, -30, 5);
    ci.cull(v);
    expect(ci.main).toBe(1);
    expect(ms[0].instanceMatrix).not.toBe(buffer);
    expect((ms[0].instanceColor!.array as Float32Array)[0]).toBe(5);
    // Turned around: nothing in view, so the meshes are hidden (no draw call).
    const back = new CullView();
    back.update(camera(180), noon);
    ci.cull(back);
    expect(ci.main).toBe(0);
    expect(ms.every((x) => !x.visible)).toBe(true);
    ci.dispose();
  });

  it('gives each shadow cascade only the casters inside its light volume, re-selecting only the cascades due', () => {
    const ms = meshes(1, 16);
    const ci = new CulledInstances(ms, 16);
    const v = new CullView();
    v.update(camera(), noon);
    const slices = [boxFrustum(-50, 50, -1e3, 1e3, -20, 20), boxFrustum(-50, 50, -1e3, 1e3, -60, -20),
      boxFrustum(-200, 200, -1e3, 1e3, -170, -60), boxFrustum(-600, 600, -1e3, 1e3, -600, -170)];
    v.setCascades(slices, [0, 1, 2, 3]);
    const m = new THREE.Matrix4();
    for (const z of [-10, -40, -100, -300]) ci.add(m.makeTranslation(0, 0, z), 0, 8, z, 4, 8);
    ci.cull(v);
    expect(Array.from(ci.cascade)).toEqual([1, 1, 1, 1]);
    // Cascade 3 is not redrawn next frame: its set (and buffer) stay as they were.
    const far = ci.shadowMeshes[3].instanceMatrix;
    slices[0] = boxFrustum(-50, 50, -1e3, 1e3, -50, 20);
    v.setCascades(slices, [0, 1, 2]);
    ci.cull(v);
    expect(Array.from(ci.cascade)).toEqual([2, 1, 1, 1]);
    expect(ci.shadowMeshes[3].instanceMatrix).toBe(far);
    ci.dispose();
  });

  it('casts each tree once across an LOD hand-over band', () => {
    const near = new CulledInstances(meshes(1, 16), 16);
    const far = new CulledInstances(meshes(1, 16), 16);
    near.shadowLod = new Float32Array(16 * 4);
    far.shadowLod = new Float32Array(16 * 4);
    const v = new CullView();
    v.update(camera(), noon);
    v.setCascades(everywhere(), [0, 1, 2, 3]);
    const m = new THREE.Matrix4();
    // Trees at 50, 56 and 61 m in a band from 54 to 60 m: LOD0 fades out there, LOD1 fades in.
    for (const z of [-50, -56, -61]) {
      const a = near.add(m.makeTranslation(0, 0, z), 0, 8, z, 4, 8);
      near.shadowLod.set([-1e6, 1, 54, 6], a * 4);
      const b = far.add(m.makeTranslation(0, 0, z), 0, 8, z, 4, 8);
      far.shadowLod.set([54, 6, 1e6, 18], b * 4);
    }
    near.cull(v);
    far.cull(v);
    // The band's middle is 57 m: 50 and 56 cast from LOD0, 61 from LOD1.
    expect(near.cascade[0]).toBe(2);
    expect(far.cascade[0]).toBe(1);
    near.dispose();
    far.dispose();
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

describe('grass footprint', () => {
  it('keeps cells on the ground in view and drops those behind or beside the camera', () => {
    const store = { heightAt: () => 0, materialAt: () => 0, version: 0 } as unknown as TerrainStore;
    const g = new Grass(store);
    g.update(camera(), null);
    const H = grassUniforms.uHull.value;
    const inside = (x: number, z: number) => H.every((p) => p.x * x + p.y * z + p.z >= -0.5);
    expect(inside(0, -20)).toBe(true);
    expect(inside(5, -35)).toBe(true);
    expect(inside(0, 25)).toBe(false);
    expect(inside(-40, 3)).toBe(false);
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
