/// <reference lib="webworker" />
import { decodeHeight, gunzip } from '../codec';

interface Req {
  id: number;
  url: string;
  matUrl?: string;
  /** Metres between height samples. */
  spacing: number;
}

/**
 * Surface normals of a height tile, two bytes per sample (x and z; y is implied, the terrain faces up):
 * central differences over one sample, as the terrain shader used to take per pixel from four filtered
 * reads of the float heights. Filtering 8-bit normals is cheap; filtering 32-bit floats is not.
 */
function tileNormals(h: Float32Array, n: number, spacing: number): Uint8Array {
  const out = new Uint8Array(n * n * 2);
  const at = (x: number, z: number) => h[Math.min(n - 1, Math.max(0, z)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const nx = at(x - 1, z) - at(x + 1, z);
      const ny = 2 * spacing;
      const nz = at(x, z - 1) - at(x, z + 1);
      const inv = 1 / Math.hypot(nx, ny, nz);
      const k = (z * n + x) * 2;
      out[k] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      out[k + 1] = Math.round((nz * inv * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, url, matUrl, spacing } = e.data;
  try {
    const [res, mres] = await Promise.all([fetch(url), matUrl ? fetch(matUrl) : Promise.resolve(null)]);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const tile = await decodeHeight(await res.arrayBuffer());
    let mats: Uint8Array | null = null;
    if (mres && mres.ok) mats = await gunzip(await mres.arrayBuffer());
    const normals = tileNormals(tile.heights, tile.n, spacing);
    const transfer: Transferable[] = [tile.heights.buffer, normals.buffer];
    if (mats) transfer.push(mats.buffer);
    (self as unknown as Worker).postMessage({ id, ok: true, tile, mats, normals }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
