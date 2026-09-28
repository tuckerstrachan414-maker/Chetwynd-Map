import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { detectQuality, DynamicResolution, QUALITY, QUALITY_LEVELS } from '../src/engine/Quality';

/** A renderer stand-in whose GL context reports the given GPU name. */
function fakeRenderer(gpu: string): THREE.WebGLRenderer {
  const gl = {
    RENDERER: 0x1f01,
    getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }),
    getParameter: () => gpu,
  };
  return { getContext: () => gl } as unknown as THREE.WebGLRenderer;
}

describe('quality detection', () => {
  const cases: [string, string][] = [
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ultra'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0)', 'high'],
    ['Apple M1', 'high'],
    ['Apple M2 Max', 'ultra'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)', 'medium'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)', 'low'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'low'],
  ];
  for (const [gpu, want] of cases) {
    it(`${want} for ${gpu.slice(0, 48)}`, () => {
      expect(detectQuality(fakeRenderer(gpu))).toBe(want);
    });
  }

  it('orders the presets from cheapest to richest', () => {
    const q = QUALITY_LEVELS.map((l) => QUALITY[l]);
    for (let i = 1; i < q.length; i++) {
      expect(q[i].grass).toBeGreaterThanOrEqual(q[i - 1].grass);
      expect(q[i].treeNear).toBeGreaterThanOrEqual(q[i - 1].treeNear);
      expect(q[i].chunks).toBeGreaterThanOrEqual(q[i - 1].chunks);
    }
  });
});

describe('dynamic resolution', () => {
  it('lowers the scale when frames run long and recovers when they are fast', () => {
    const d = new DynamicResolution(16.7);
    let changed = 0;
    for (let i = 0; i < 400; i++) if (d.update(30, 1 / 30)) changed++;
    expect(d.scale).toBeLessThan(1);
    expect(d.scale).toBeGreaterThanOrEqual(0.55);
    expect(changed).toBeGreaterThan(0);
    for (let i = 0; i < 3000; i++) d.update(8, 1 / 120);
    expect(d.scale).toBe(1);
  });

  it('is off when no target is set', () => {
    const d = new DynamicResolution(0);
    for (let i = 0; i < 200; i++) expect(d.update(50, 0.05)).toBe(false);
    expect(d.scale).toBe(1);
  });
});
