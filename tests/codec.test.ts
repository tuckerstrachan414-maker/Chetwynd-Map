import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeHeightRaw } from '../src/world/codec';

describe('height codec', () => {
  it('matches the python encoder', () => {
    const bin = readFileSync(new URL('./fixtures/height_33.bin', import.meta.url));
    const expected = JSON.parse(readFileSync(new URL('./fixtures/height_33.json', import.meta.url), 'utf8'));
    const tile = decodeHeightRaw(new Uint8Array(gunzipSync(bin)));
    expect(tile.n).toBe(expected.n);
    expect(tile.level).toBe(expected.level);
    expect([tile.i, tile.j]).toEqual([expected.i, expected.j]);
    for (const [k, v] of Object.entries(expected.samples as Record<string, number>)) {
      expect(tile.heights[Number(k)]).toBeCloseTo(v, 3);
    }
  });
});
