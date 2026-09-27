import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Bench } from '../src/app/Bench';

const canvas = { width: 1920, height: 1080 } as HTMLCanvasElement;

function run(frameMs: (i: number) => number, seconds = 70): Bench {
  const b = new Bench('Test GPU', 'high', seconds);
  const cam = new THREE.PerspectiveCamera();
  for (let i = 0; i < 100000 && !b.done; i++) b.update(frameMs(i) / 1000, cam, () => 600, canvas);
  return b;
}

describe('benchmark', () => {
  it('flies the whole route and reports steady 60 fps', () => {
    const b = run(() => 1000 / 60);
    expect(b.done).toBe(true);
    expect(b.result!.avgFps).toBeCloseTo(60, 0);
    expect(b.result!.low1).toBeCloseTo(60, 0);
    expect(b.result!.frames).toBeGreaterThan(60 * 69);
    expect(b.result!.resolution).toBe('1920x1080');
  });

  it('reports hitches in the 1 % and 0.1 % lows', () => {
    // Every 100th frame takes 50 ms.
    const b = run((i) => (i % 100 === 0 ? 50 : 1000 / 60));
    expect(b.result!.avgFps).toBeGreaterThan(55);
    expect(b.result!.low1).toBeLessThan(25);
    expect(b.result!.low01).toBeLessThanOrEqual(b.result!.low1);
  });

  it('keeps the camera on the route above the ground', () => {
    const b = new Bench('g', 'low', 7);
    const cam = new THREE.PerspectiveCamera();
    for (let i = 0; i < 300; i++) b.update(1 / 60, cam, () => 600, canvas);
    expect(cam.position.y).toBeGreaterThan(600);
    expect(Number.isFinite(cam.position.x) && Number.isFinite(cam.position.z)).toBe(true);
  });
});
