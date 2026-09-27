/**
 * Decoders for pipeline binary formats (see pipeline/codec.py).
 */

export interface HeightTile {
  level: number;
  i: number;
  j: number;
  n: number;
  hmin: number;
  step: number;
  /** Row-major heights in metres, n*n samples. Row 0 is the north edge (min z). */
  heights: Float32Array;
}

export async function gunzip(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode an already-gunzipped CWH1 payload. */
export function decodeHeightRaw(raw: Uint8Array): HeightTile {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== 'CWH1') throw new Error(`bad height magic ${magic}`);
  const level = dv.getUint8(4);
  const planes = dv.getUint8(5);
  const i = dv.getUint16(6, true);
  const j = dv.getUint16(8, true);
  const n = dv.getUint16(10, true);
  const hmin = dv.getFloat32(12, true);
  const step = dv.getFloat32(16, true);
  const count = n * n;
  const body = raw.subarray(20);
  const heights = new Float32Array(count);
  // Rebuild zigzag residuals from byte planes and invert the planar predictor with a 2D prefix sum.
  const q = new Int32Array(count);
  for (let k = 0; k < count; k++) {
    let zz = body[k];
    if (planes > 1) zz |= body[count + k] << 8;
    if (planes > 2) zz |= body[2 * count + k] << 16;
    q[k] = (zz >>> 1) ^ -(zz & 1);
  }
  for (let y = 0; y < n; y++) {
    const row = y * n;
    for (let x = 1; x < n; x++) q[row + x] += q[row + x - 1];
    if (y > 0) {
      const prev = row - n;
      for (let x = 0; x < n; x++) q[row + x] += q[prev + x];
    }
  }
  for (let k = 0; k < count; k++) heights[k] = hmin + q[k] * step;
  return { level, i, j, n, hmin, step, heights };
}

export async function decodeHeight(data: ArrayBuffer): Promise<HeightTile> {
  return decodeHeightRaw(await gunzip(data));
}
