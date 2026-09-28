/** Small 2D polygon helpers (x, z plane) used by the building generator. */
export type P2 = [number, number];

export function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/** Ensure positive signed area (outward edge normal = (dz, -dx)). */
export function orientCCW(poly: P2[]): P2[] {
  return signedArea(poly) < 0 ? poly.slice().reverse() : poly;
}

export function dedupe(poly: P2[], eps = 0.05): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  if (out.length > 2) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= eps) out.pop();
  }
  return out;
}

/** Offset a CCW polygon outward by d using mitred joins (clamped). */
export function offsetPolygon(poly: P2[], d: number): P2[] {
  const n = poly.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = poly[(i + n - 1) % n];
    const p1 = poly[i];
    const p2 = poly[(i + 1) % n];
    const e0x = p1[0] - p0[0], e0z = p1[1] - p0[1];
    const e1x = p2[0] - p1[0], e1z = p2[1] - p1[1];
    const l0 = Math.hypot(e0x, e0z) || 1;
    const l1 = Math.hypot(e1x, e1z) || 1;
    const n0x = e0z / l0, n0z = -e0x / l0;
    const n1x = e1z / l1, n1z = -e1x / l1;
    let mx = n0x + n1x, mz = n0z + n1z;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const cos = mx * n1x + mz * n1z;
    const k = Math.min(d / Math.max(cos, 0.35), d * 2.5);
    out.push([p1[0] + mx * k, p1[1] + mz * k]);
  }
  return out;
}

/** Clip polygon to the half-plane a*x + b*z + c >= 0 (Sutherland-Hodgman). */
export function clipHalfPlane(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const dp = a * p[0] + b * p[1] + c;
    const dq = a * q[0] + b * q[1] + c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

export function centroid(poly: P2[]): P2 {
  let cx = 0, cz = 0, a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % n];
    const f = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * f;
    cz += (z1 + z2) * f;
    a += f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [cx / (3 * a), cz / (3 * a)];
}

/** Minimum-area oriented bounding box via rotating edges. */
export function orientedBox(poly: P2[]): { c: P2; ax: P2; ay: P2; L: number; W: number } {
  let best = { area: Infinity, c: [0, 0] as P2, ax: [1, 0] as P2, ay: [0, 1] as P2, L: 0, W: 0 };
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (l < 1e-6) continue;
    const ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l;
    const vx = -uz, vz = ux;
    let minu = Infinity, maxu = -Infinity, minv = Infinity, maxv = -Infinity;
    for (const r of poly) {
      const u = r[0] * ux + r[1] * uz;
      const v = r[0] * vx + r[1] * vz;
      minu = Math.min(minu, u); maxu = Math.max(maxu, u);
      minv = Math.min(minv, v); maxv = Math.max(maxv, v);
    }
    const area = (maxu - minu) * (maxv - minv);
    if (area < best.area) {
      const cu = (minu + maxu) / 2, cv = (minv + maxv) / 2;
      let L = maxu - minu, W = maxv - minv;
      let ax: P2 = [ux, uz], ay: P2 = [vx, vz];
      if (W > L) {
        [L, W] = [W, L];
        [ax, ay] = [ay, [-ax[0], -ax[1]]];
      }
      best = { area, c: [cu * ux + cv * vx, cu * uz + cv * vz], ax, ay, L, W };
    }
  }
  return { c: best.c, ax: best.ax, ay: best.ay, L: best.L, W: best.W };
}
