import type { Archetype } from './species';

/**
 * Procedural tree generator. Produces bark (tube) and foliage (alpha cards) meshes at a
 * reference size (height `H`, crown radius `R`); instances are scaled to their LiDAR size.
 *
 * Per-vertex wind data `wind` = (branch sway weight, branch phase, leaf flutter weight, leaf phase).
 * Foliage `nrm` blends the card normal with a crown-volume normal for soft, volumetric shading,
 * and `ao` darkens the crown interior.
 */
export interface MeshPart {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  wind: Float32Array;
  ao: Float32Array;
  idx: Uint32Array;
}

export interface TreeModel {
  arch: Archetype;
  H: number;
  R: number;
  lod0: { bark: MeshPart; leaves: MeshPart };
  lod1: { bark: MeshPart; leaves: MeshPart };
}

type V3 = [number, number, number];

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  wind: number[] = [];
  ao: number[] = [];
  idx: number[] = [];
  vert(p: V3, n: V3, u: number, v: number, w: [number, number, number, number], ao: number): number {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    this.wind.push(w[0], w[1], w[2], w[3]);
    this.ao.push(ao);
    return this.pos.length / 3 - 1;
  }
  build(): MeshPart {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Float32Array(this.nrm),
      uv: new Float32Array(this.uv),
      wind: new Float32Array(this.wind),
      ao: new Float32Array(this.ao),
      idx: new Uint32Array(this.idx),
    };
  }
}

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Tube along a polyline with per-point radius. */
function tube(b: Builder, pts: V3[], radii: number[], sides: number, windW: (k: number) => number, phase: number, vScale: number): void {
  const start = b.pos.length / 3;
  let vAcc = 0;
  for (let k = 0; k < pts.length; k++) {
    const t = norm(k < pts.length - 1 ? sub(pts[k + 1], pts[k]) : sub(pts[k], pts[k - 1]));
    const ref: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const nx = norm(cross(t, ref));
    const ny = cross(nx, t);
    if (k > 0) vAcc += len(sub(pts[k], pts[k - 1]));
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const n = add(mul(nx, Math.cos(a)), mul(ny, Math.sin(a)));
      b.vert(add(pts[k], mul(n, radii[k])), n, s / sides, vAcc * vScale, [windW(k), phase, 0, 0], 1);
    }
  }
  const row = sides + 1;
  for (let k = 0; k < pts.length - 1; k++) {
    for (let s = 0; s < sides; s++) {
      const a = start + k * row + s;
      const c = a + row;
      b.idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
  }
}

/**
 * Foliage card: quad with base at `p`, extending `size` along `dir`, width axis `side`.
 * UV rect (u0, v0, du, dv) in the atlas; the spray's base is at the bottom centre (v = v0 + dv).
 */
function card(b: Builder, p: V3, dir: V3, side: V3, size: number, width: number, rect: number[], center: V3, crownR: number,
  windW: number, phase: number, flutter: number, aoBase: number, volumeBlend: number): void {
  const nCard = norm(cross(side, dir));
  const hw = width * 0.5;
  const corners: [V3, number, number][] = [
    [add(p, mul(side, -hw)), rect[0], rect[1] + rect[3]],
    [add(p, mul(side, hw)), rect[0] + rect[2], rect[1] + rect[3]],
    [add(add(p, mul(side, hw)), mul(dir, size)), rect[0] + rect[2], rect[1]],
    [add(add(p, mul(side, -hw)), mul(dir, size)), rect[0], rect[1]],
  ];
  const ids: number[] = [];
  for (let k = 0; k < 4; k++) {
    const q = corners[k][0];
    const radial = sub(q, center);
    const rl = len(radial);
    let vn = norm([radial[0], radial[1] * 0.6 + 0.35 * rl, radial[2]]);
    if (dot(vn, nCard) < 0) vn = vn; // card normal flips handled in shader (double sided)
    const n = norm(add(mul(nCard, 1 - volumeBlend), mul(vn, volumeBlend)));
    const depth = Math.min(1, rl / Math.max(crownR, 0.1));
    const ao = aoBase * (0.45 + 0.55 * Math.pow(depth, 0.8));
    const tipW = k >= 2 ? 1 : 0.35;
    ids.push(b.vert(q, n, corners[k][1], corners[k][2], [windW, phase, flutter * tipW, phase * 3.7 + k], ao));
  }
  b.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
}

// ---------------------------------------------------------------------------------------------

interface Params {
  H: number;
  R: number;
  crownBase: number;
  cells: number[][];
}

function conifer(arch: Archetype, seed: number, p: Params, lod: 0 | 1): { bark: Builder; leaves: Builder } {
  const r = rng(seed * 31 + lod);
  const bark = new Builder();
  const leaves = new Builder();
  const { H, R } = p;
  const narrow = arch === 'bspruce';
  const pine = arch === 'pine';
  const cb = p.crownBase * H;
  // Trunk with slight lean/curve.
  const lean: V3 = [(r() - 0.5) * 0.04 * H, 0, (r() - 0.5) * 0.04 * H];
  const trunkPts: V3[] = [];
  const trunkR: number[] = [];
  const segs = lod === 0 ? 10 : 4;
  const r0 = H * (pine ? 0.013 : 0.011);
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const y = t * H;
    trunkPts.push([lean[0] * t * t, y, lean[2] * t * t]);
    trunkR.push(Math.max(0.02, r0 * (1 - 0.92 * t) * (k === 0 ? 1.35 : 1)));
  }
  tube(bark, trunkPts, trunkR, lod === 0 ? 7 : 5, (k) => (k / segs) ** 2 * 0.15, 0, 0.5);
  const axisAt = (y: number): V3 => {
    const t = y / H;
    return [lean[0] * t * t, y, lean[2] * t * t];
  };
  const shape = (t: number) => {
    if (pine) return Math.pow(Math.max(0, 1 - t), 0.55) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.4 + 0.2)));
    if (narrow) return Math.pow(Math.max(0, 1 - t), 1.25) * (t > 0.82 ? 1.8 : 1);
    return Math.pow(Math.max(0, 1 - t), 0.9) * (1 + 0.15 * Math.sin(t * 9 + seed));
  };
  const cell = () => p.cells[Math.floor(r() * p.cells.length) % p.cells.length];
  const spacing = pine ? 0.75 : narrow ? 0.3 : 0.42;
  const center: V3 = axisAt((cb + H) / 2);
  let az0 = r() * Math.PI * 2;
  let wi = 0;
  for (let y = cb; y < H - 0.25; y += spacing * (0.75 + 0.5 * r())) {
    const t = (y - cb) / (H - cb);
    const Lmax = R * shape(t) * (0.8 + 0.4 * r());
    const nb = pine ? 3 + Math.floor(r() * 3) : 4 + Math.floor(r() * 3);
    az0 += 2.39996;
    wi++;
    const localCenter = axisAt(y);
    if (lod === 1) {
      // One set of radial fins per whorl group.
      if (wi % 2 !== 0 && t < 0.97) continue;
      const fins = 3;
      for (let f = 0; f < fins; f++) {
        const az = az0 + (f / fins) * Math.PI;
        const dirH: V3 = [Math.cos(az), 0, Math.sin(az)];
        const L = Math.max(Lmax, 0.4);
        const droop = pine ? -0.05 : -0.25 - 0.3 * (1 - t);
        for (const sgn of [1, -1]) {
          const d = norm([dirH[0] * sgn, droop, dirH[2] * sgn]);
          const side: V3 = norm(cross(d, [0, 1, 0]));
          const upSide = norm(cross(side, d));
          card(leaves, localCenter, d, upSide, L * 1.15, L * 0.8 + spacing * 2, cell(), center, R, 0.6 * t + 0.2, r() * 6.28, 0.3, 1, 0.6);
        }
      }
      continue;
    }
    for (let k = 0; k < nb; k++) {
      const az = az0 + (k / nb) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const dirH: V3 = [Math.cos(az), 0, Math.sin(az)];
      const L = Math.max(Lmax * (0.85 + 0.3 * r()), 0.25);
      // Branch curve: out and down (spruce droop), tips turn up.
      const droop = pine ? 0.05 - 0.15 * (1 - t) : -0.2 - 0.45 * (1 - t);
      const pts: V3[] = [];
      const n = 4;
      for (let s = 0; s <= n; s++) {
        const u = s / n;
        const dy = pine ? droop * u * L + 0.15 * u * u * L : droop * u * L + 0.35 * u * u * u * L;
        pts.push(add(localCenter, [dirH[0] * u * L, dy, dirH[2] * u * L]));
      }
      const phase = r() * 6.28;
      const bw = (s: number) => 0.3 + 0.7 * (s / n);
      if (L > 0.7) tube(bark, pts, pts.map((_, s) => Math.max(0.008, 0.035 * L * (1 - s / (n + 0.5)))), 3, bw, phase, 1.0);
      // Needle sprays along the branch.
      const step = pine ? 0.45 : 0.28;
      for (let u = pine ? 0.45 : 0.15; u <= 1.001; u += step / L) {
        const seg = Math.min(n - 1, Math.floor(u * n));
        const f = u * n - seg;
        const pb = add(mul(pts[seg], 1 - f), mul(pts[seg + 1], f));
        const along = norm(sub(pts[seg + 1], pts[seg]));
        const size = (pine ? 0.55 : 0.42) + (pine ? 0.25 : 0.2) * r();
        for (let c = 0; c < (pine ? 3 : 2); c++) {
          // Rotate the spray around the branch axis; flatten into the branch plane for spruce.
          const roll = (pine ? (c / 3) * Math.PI * 2 : (c === 0 ? -0.5 : 0.5)) + (r() - 0.5) * 0.9;
          const flat = norm(cross(along, [0, 1, 0]));
          const upv = norm(cross(flat, along));
          const side = norm(add(mul(flat, Math.cos(roll)), mul(upv, Math.sin(roll))));
          const outDir = norm(add(along, mul(norm(cross(side, along)), (r() - 0.5) * 0.6)));
          const dir = pine ? norm(add(outDir, [0, 0.9, 0])) : outDir;
          card(leaves, pb, dir, side, size, size * 0.85, cell(), center, R, bw(u * n), phase, pine ? 0.25 : 0.35, 1, 0.7);
        }
      }
    }
  }
  // Leader / top tuft.
  if (lod === 0) {
    const top = axisAt(H - 0.3);
    for (let c = 0; c < 3; c++) {
      const az = (c / 3) * Math.PI;
      const side: V3 = [Math.cos(az), 0, Math.sin(az)];
      card(leaves, sub(top, [0, 0.3, 0]), [0, 1, 0], side, pine ? 1.0 : 0.8, 0.5, cell(), center, R, 1, 0, 0.3, 1, 0.5);
    }
  }
  return { bark, leaves };
}

function deciduous(arch: Archetype, seed: number, p: Params, lod: 0 | 1): { bark: Builder; leaves: Builder } {
  const r = rng(seed * 17 + lod * 7);
  const bark = new Builder();
  const leaves = new Builder();
  const { H, R } = p;
  const cb = p.crownBase * H;
  const round = arch === 'round';
  const poplar = arch === 'poplar';
  const lean: V3 = [(r() - 0.5) * 0.06 * H, 0, (r() - 0.5) * 0.06 * H];
  const segs = lod === 0 ? 10 : 4;
  const trunkTop = round ? cb + (H - cb) * 0.35 : H * 0.92;
  const trunkPts: V3[] = [];
  const trunkR: number[] = [];
  const r0 = H * (poplar ? 0.02 : round ? 0.018 : 0.012);
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const y = t * trunkTop;
    const wob = Math.sin(t * 5 + seed) * 0.08 * t;
    trunkPts.push([lean[0] * t * t + wob, y, lean[2] * t * t - wob * 0.5]);
    trunkR.push(Math.max(0.02, r0 * (1 - 0.8 * t) * (k === 0 ? 1.3 : 1)));
  }
  tube(bark, trunkPts, trunkR, lod === 0 ? 8 : 5, (k) => (k / segs) ** 2 * 0.12, 0, 0.35);
  const axisAt = (y: number): V3 => {
    const t = Math.min(y / trunkTop, 1);
    return [lean[0] * t * t, y, lean[2] * t * t];
  };
  const center: V3 = axisAt(cb + (H - cb) * 0.55);
  const crownH = H - cb;
  // Ellipsoidal crown envelope; aspen is narrow and irregular.
  const envelope = (y: number) => {
    const t = (y - cb) / crownH;
    const e = Math.sqrt(Math.max(0, 1 - Math.pow(2 * t - (round ? 1.0 : 0.9), 2)));
    return R * (round ? e : e * (0.75 + 0.25 * t));
  };
  const nBranches = lod === 0 ? (round ? 16 : poplar ? 22 : 18) : round ? 7 : 9;
  const cellRect = p.cells[0];
  const clusterSize = poplar ? 1.1 : round ? 0.85 : 0.75;
  let az = r() * 6.28;
  for (let k = 0; k < nBranches; k++) {
    const t = (k + r() * 0.8) / nBranches;
    const y = cb + t * crownH * (round ? 0.85 : 0.92);
    az += 2.39996 + (r() - 0.5) * 0.6;
    const base = axisAt(Math.min(y, trunkTop));
    const env = envelope(y) * (0.7 + 0.5 * r());
    const upAng = (round ? 0.9 : poplar ? 0.75 : 0.55) + (r() - 0.5) * 0.4; // radians from vertical
    const dirv = norm([Math.cos(az) * Math.sin(upAng), Math.cos(upAng), Math.sin(az) * Math.sin(upAng)]);
    const L = Math.max(env / Math.max(Math.sin(upAng), 0.3), 0.8);
    const pts: V3[] = [base];
    let cur = base;
    let d = dirv;
    const n = 3;
    for (let s = 1; s <= n; s++) {
      d = norm(add(d, [(r() - 0.5) * 0.5, (r() - 0.6) * 0.3, (r() - 0.5) * 0.5]));
      cur = add(cur, mul(d, L / n));
      pts.push(cur);
    }
    const phase = r() * 6.28;
    const rootR = Math.max(0.03, r0 * 0.5 * (1 - t * 0.6));
    const bw = (s: number) => 0.25 + 0.75 * (s / n);
    if (lod === 0 || k % 2 === 0) tube(bark, pts, pts.map((_, s) => Math.max(0.01, rootR * (1 - s / (n + 0.6)))), lod === 0 ? 4 : 3, bw, phase, 0.6);
    // Sub-branches with leaf clusters.
    const subs = lod === 0 ? (round ? 5 : 4) : 2;
    for (let s = 0; s < subs; s++) {
      const u = 0.35 + 0.65 * ((s + r() * 0.8) / subs);
      const seg = Math.min(n - 1, Math.floor(u * n));
      const f = u * n - seg;
      const pb = add(mul(pts[seg], 1 - f), mul(pts[seg + 1], f));
      const along = norm(sub(pts[seg + 1], pts[seg]));
      const sideAz = az + (s % 2 ? 1 : -1) * (0.8 + r() * 0.6);
      const sd = norm(add(mul(along, 0.5), [Math.cos(sideAz) * 0.6, 0.25 + r() * 0.3, Math.sin(sideAz) * 0.6]));
      const sl = L * (0.3 + 0.25 * r());
      const tip = add(pb, mul(sd, sl));
      if (lod === 0) tube(bark, [pb, tip], [Math.max(0.008, rootR * 0.4), 0.006], 3, () => bw(u * n) + 0.2, phase, 0.6);
      // Leaf clusters: crossed cards around the twig tip.
      const clusters = lod === 0 ? 3 : 1;
      for (let c = 0; c < clusters; c++) {
        const q = add(pb, mul(sd, sl * (0.45 + 0.55 * (c + 1) / clusters)));
        const sz = clusterSize * (lod === 0 ? 1 : 2.4) * (0.8 + 0.4 * r());
        const outward = norm(add(sub(q, center), [0, 0.6, 0]));
        for (let x = 0; x < 2; x++) {
          const roll = x * Math.PI * 0.5 + r() * 1.2;
          const ref: V3 = Math.abs(outward[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
          const a1 = norm(cross(outward, ref));
          const a2 = cross(a1, outward);
          const side = norm(add(mul(a1, Math.cos(roll)), mul(a2, Math.sin(roll))));
          const dir = norm(add(outward, mul(sd, 0.5)));
          const start = sub(q, mul(dir, sz * 0.45));
          card(leaves, start, dir, side, sz, sz * 0.9, cellRect, center, R, bw(u * n) + 0.25, phase, lod === 0 ? 1 : 0.6, 1, 0.8);
        }
      }
    }
  }
  return { bark, leaves };
}

const REF: Record<Archetype, { H: number; R: number; cb: number }> = {
  spruce: { H: 20, R: 3.2, cb: 0.12 },
  bspruce: { H: 12, R: 1.3, cb: 0.1 },
  pine: { H: 20, R: 2.4, cb: 0.55 },
  aspen: { H: 18, R: 3.0, cb: 0.55 },
  poplar: { H: 24, R: 5.0, cb: 0.45 },
  round: { H: 8, R: 3.0, cb: 0.3 },
  shrub: { H: 2, R: 1.2, cb: 0 },
};

export function generateTree(arch: Archetype, seed: number, cells: number[][]): TreeModel {
  const ref = REF[arch];
  const p: Params = { H: ref.H, R: ref.R, crownBase: ref.cb, cells };
  const gen = arch === 'spruce' || arch === 'bspruce' || arch === 'pine' ? conifer : deciduous;
  const a = gen(arch, seed, p, 0);
  const b = gen(arch, seed, p, 1);
  return {
    arch,
    H: ref.H,
    R: ref.R,
    lod0: { bark: a.bark.build(), leaves: a.leaves.build() },
    lod1: { bark: b.bark.build(), leaves: b.leaves.build() },
  };
}
