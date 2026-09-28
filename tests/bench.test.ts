import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Bench, benchText } from '../src/app/Bench';

const canvas = { width: 1920, height: 1080 } as HTMLCanvasElement;

function run(frameMs: (i: number) => number, seconds = 70): Bench {
  const b = new Bench('Test GPU', 'high', seconds);
  const cam = new THREE.PerspectiveCamera();
  for (let i = 0; i < 100000 && !b.done; i++) {
    const ms = frameMs(i);
    b.update(Math.min(ms / 1000, 0.1), ms, cam, () => 600, canvas);
  }
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
    for (let i = 0; i < 300; i++) b.update(1 / 60, 1000 / 60, cam, () => 600, canvas);
    expect(cam.position.y).toBeGreaterThan(600);
    expect(Number.isFinite(cam.position.x) && Number.isFinite(cam.position.z)).toBe(true);
  });

  it('counts long frames in full, not capped at the 100 ms simulation step', () => {
    const b = run((i) => (i === 3000 ? 400 : 1000 / 60));
    expect(b.result!.worstMs).toBe(400);
    expect(b.result!.low01).toBeLessThan(10);
  });

  it('reports FPS per stretch of the route and a one-line breakdown', () => {
    const b = run((i) => (i < 1500 ? 1000 / 30 : 1000 / 60));
    const legs = b.result!.legs;
    expect(Object.keys(legs)).toEqual(['downtown', 'greenbelt', 'river', 'valley']);
    expect(legs.downtown).toBeCloseTo(30, 0);
    expect(legs.valley).toBeCloseTo(60, 0);
    const text = benchText({
      ...b.result!,
      profile: {
        frames: 10, frameMs: 20, cpu: { frame: 8, render: 4, trees: 2 }, gpu: { opaque: 9, shadow: 5 },
        draws: { 'main:forest': 300, 'shadow:forest': 200 }, trisBy: { 'main:forest': 2e6 }, tris: 2.5e6, programs: 80,
        hitches: [{ t: 3.2, ms: 180, what: '2 shaders compiled, render 150' }],
      },
    });
    expect(text).toContain('legs: downtown 30');
    expect(text).toContain('CPU 8.0 ms/frame (render 4.0, trees 2.0)');
    expect(text).toContain('GPU 14.0 ms/frame (opaque 9.0, shadow 5.0)');
    expect(text).toContain('draws 500 (main:forest 300, shadow:forest 200)');
    expect(text).toContain('180 ms at 3.2s (2 shaders compiled, render 150)');
  });
});
