import earcut from 'earcut';
import { clipHalfPlane, centroid, dedupe, offsetPolygon, orientCCW, orientedBox, signedArea, type P2 } from './geom2d';

/** Building record as stored in world chunks (engine coordinates). */
export interface BuildingRec {
  id: string;
  cls: string;
  seed: number;
  poly: P2[];
  holes?: P2[][];
  base: number;
  baseMin: number;
  eave: number;
  top: number;
  roof: { type: string; pitch?: number; ridgeAz?: number | null; ridge?: number; dirAz?: number; complex?: boolean };
  ri: number;
  name?: string;
  front?: number;
}

export interface Skeleton {
  vertices: [number, number, number][];
  polygons: number[][];
}
export type SkeletonFn = (rings: number[][][]) => Skeleton | null;

/** Growable interleaved attribute streams for one material group. */
export class Stream {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  a0: number[] = [];
  a1: number[] = [];
  a2: number[] = [];
  a3: number[] = [];
  cur0: number[] = [0, 0, 0, 0];
  cur1: number[] = [0, 0, 0, 0];
  cur2: number[] = [0, 0, 0, 0];
  cur3: number[] = [0, 0, 0, 0];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.a0.push(...this.cur0);
    this.a1.push(...this.cur1);
    this.a2.push(...this.cur2);
    this.a3.push(...this.cur3);
  }

  /** Triangle with a flat normal computed from its winding (counter-clockwise = front). */
  tri(a: number[], b: number[], c: number[], uva: number[], uvb: number[], uvc: number[]): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.vert(a[0], a[1], a[2], nx, ny, nz, uva[0], uva[1]);
    this.vert(b[0], b[1], b[2], nx, ny, nz, uvb[0], uvb[1]);
    this.vert(c[0], c[1], c[2], nx, ny, nz, uvc[0], uvc[1]);
  }

  quad(a: number[], b: number[], c: number[], d: number[], uva: number[], uvb: number[], uvc: number[], uvd: number[]): void {
    this.tri(a, b, c, uva, uvb, uvc);
    this.tri(a, c, d, uva, uvc, uvd);
  }

  get count(): number {
    return this.pos.length / 3;
  }
}

export interface BuildingStreams {
  walls: Stream;
  roofs: Stream;
  trims: Stream;
}

// ---------------------------------------------------------------------------------------------
// Deterministic style selection

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const srgb = (hex: number): [number, number, number] => {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
};

// Northern BC small-town palette: vinyl siding tones, stained wood, painted stucco.
const SIDING = [0xd8cfb8, 0xc9b99a, 0xb8b4aa, 0xe8e6de, 0x9fa9ad, 0x8e9a88, 0xe3d7a8, 0xa88e6c, 0x6f7f8f, 0x5b5f63,
  0x8c4a3a, 0xefe6cf, 0xc7c2b3, 0x7d6b58, 0xb9c4c9, 0x98a37f];
const STUCCO = [0xd9d2c3, 0xc8bca6, 0xe6e1d6, 0xb3a996, 0x9c9588];
const BRICK = [0x8a4b3a, 0x7a4636, 0x9c6a52, 0x6d3f33];
const METAL_WALL = [0xc9ccce, 0xe5e6e3, 0x8f9a8c, 0x5d6b73, 0x9aa3a8, 0x7b3f35, 0x3f5e4d, 0xd8cdb4];
const SHINGLE = [0x3a3a3c, 0x2b2b2d, 0x5a4a3c, 0x6b6b6b, 0x4b3a2e, 0x3d4a3c, 0x5c2f2a, 0x55585c];
const METAL_ROOF = [0xb9bdbf, 0xe0e2df, 0x2f5a3e, 0x6a2a2a, 0x3b3f44, 0x3a5877, 0x8f7f63, 0x9aa0a4];
const MEMBRANE = [0x6d6f70, 0x9b9d9c, 0xcfd0cd, 0x3c3d3e];
const TRIM = [0xf2f0ea, 0xece8dc, 0x3b3b3b, 0x5a4636, 0xd9d4c7];

export const WALL_SIDING = 0;
export const WALL_STUCCO = 1;
export const WALL_BRICK = 2;
export const WALL_METAL = 3;
export const WALL_BOARD = 4;
export const WALL_BLOCK = 5;
export const ROOF_SHINGLE = 0;
export const ROOF_METAL = 1;
export const ROOF_MEMBRANE = 2;
export const WIN_HOUSE = 0;
export const WIN_SHOP = 1;
export const WIN_INDUSTRIAL = 2;
export const WIN_CIVIC = 3;
export const WIN_NONE = 4;
export const WIN_APT = 5;

interface Style {
  wallType: number;
  wall: [number, number, number];
  trim: [number, number, number];
  roofType: number;
  roof: [number, number, number];
  win: number;
  floorH: number;
  overhang: number;
  parapet: number;
  chimney: boolean;
}

function pick<T>(r: () => number, a: T[]): T {
  return a[Math.floor(r() * a.length) % a.length];
}

function styleFor(b: BuildingRec): Style {
  const r = rng(b.seed);
  const cls = b.cls;
  let wallType: number;
  let wall: number | [number, number, number];
  let win = WIN_HOUSE;
  let floorH = 2.75;
  let overhang = 0.45;
  let parapet = 0;
  if (cls === 'industrial') {
    wallType = r() < 0.8 ? WALL_METAL : WALL_BLOCK;
    wall = wallType === WALL_METAL ? pick(r, METAL_WALL) : pick(r, STUCCO);
    win = WIN_INDUSTRIAL;
    floorH = 4.5;
    overhang = 0.25;
  } else if (cls === 'commercial') {
    const k = r();
    wallType = k < 0.35 ? WALL_STUCCO : k < 0.55 ? WALL_BRICK : k < 0.8 ? WALL_METAL : WALL_SIDING;
    wall = wallType === WALL_STUCCO ? pick(r, STUCCO) : wallType === WALL_BRICK ? pick(r, BRICK) : wallType === WALL_METAL ? pick(r, METAL_WALL) : pick(r, SIDING);
    win = WIN_SHOP;
    floorH = 3.8;
    overhang = 0.3;
  } else if (cls === 'civic' || cls === 'church') {
    wallType = r() < 0.5 ? WALL_BRICK : WALL_STUCCO;
    wall = wallType === WALL_BRICK ? pick(r, BRICK) : pick(r, STUCCO);
    win = WIN_CIVIC;
    floorH = 3.8;
  } else if (cls === 'apartments') {
    wallType = r() < 0.6 ? WALL_SIDING : WALL_STUCCO;
    wall = wallType === WALL_SIDING ? pick(r, SIDING) : pick(r, STUCCO);
    win = WIN_APT;
    floorH = 2.9;
  } else if (cls === 'garage' || cls === 'shed' || cls === 'carport') {
    const k = r();
    wallType = k < 0.55 ? WALL_SIDING : k < 0.8 ? WALL_BOARD : WALL_METAL;
    wall = wallType === WALL_METAL ? pick(r, METAL_WALL) : wallType === WALL_BOARD ? srgbHex(pick(r, [0x7a5c42, 0x8b6f4e, 0x6a5040, 0x9c8a70])) : pick(r, SIDING);
    win = WIN_NONE;
    floorH = 2.6;
    overhang = 0.3;
  } else if (cls === 'mobile') {
    wallType = WALL_SIDING;
    wall = pick(r, [0xe8e6de, 0xd8cfb8, 0xc9c6bd, 0xb9c4c9, 0xe3d7a8, 0x9fa9ad]);
    floorH = 2.4;
    overhang = 0.2;
  } else {
    wallType = r() < 0.82 ? WALL_SIDING : r() < 0.5 ? WALL_STUCCO : WALL_BOARD;
    wall = wallType === WALL_STUCCO ? pick(r, STUCCO) : wallType === WALL_BOARD ? srgbHex(pick(r, [0x7a5c42, 0x8b6f4e, 0x5e4a3a])) : pick(r, SIDING);
  }
  const flat = b.roof.type === 'flat';
  let roofType = ROOF_SHINGLE;
  let roofHex = pick(r, SHINGLE);
  if (flat) {
    roofType = ROOF_MEMBRANE;
    roofHex = pick(r, MEMBRANE);
    if (cls === 'commercial' || cls === 'civic' || cls === 'apartments' || (cls === 'industrial' && r() < 0.5)) parapet = 0.5 + r() * 0.7;
  } else if (cls === 'industrial' || b.ri > 1.15 || (cls !== 'house' && r() < 0.3) || (cls === 'house' && r() < 0.12)) {
    roofType = ROOF_METAL;
    roofHex = b.ri > 1.2 ? pick(r, [0xb9bdbf, 0xe0e2df, 0x9aa0a4]) : pick(r, METAL_ROOF);
  } else if (b.ri < 0.55) {
    roofHex = pick(r, [0x2b2b2d, 0x3a3a3c, 0x3d4a3c]);
  }
  return {
    wallType,
    wall: typeof wall === 'number' ? srgb(wall) : wall,
    trim: srgb(pick(r, TRIM)),
    roofType,
    roof: srgb(roofHex),
    win,
    floorH,
    overhang,
    parapet,
    chimney: (cls === 'house' && !flat && r() < 0.45) || cls === 'church',
  };
}

function srgbHex(hex: number): [number, number, number] {
  return srgb(hex);
}

// ---------------------------------------------------------------------------------------------
// Roof height functions

interface RoofModel {
  /** Roof surface height at (x, z) without overhang considerations. */
  h: (x: number, z: number) => number;
  /** Polygons (in xz) that partition the expanded roof outline into planar faces. */
  faces: P2[][];
  /** Break lines (a, b, c) where the wall top has kinks: a*x + b*z + c = 0. */
  kinks: [number, number, number][];
  ridgeY: number;
  /** Wall top height function (defaults to h clamped to >= eave). */
  wallTop?: (x: number, z: number) => number;
  /** Skeleton-based faces with explicit heights. */
  faces3?: { pts: [number, number, number][] }[];
}

function azToDir(az: number): P2 {
  const a = (az * Math.PI) / 180;
  return [Math.sin(a), -Math.cos(a)];
}

function roofModel(b: BuildingRec, poly: P2[], outer: P2[], eaveY: number, skeleton: SkeletonFn | null, overhang: number): RoofModel {
  const type = b.roof.type;
  const pitch = Math.min(Math.max(b.roof.pitch ?? 22, 5), 55);
  const s = Math.tan((pitch * Math.PI) / 180);
  const obb = orientedBox(poly);
  const fill = Math.abs(signedArea(poly)) / Math.max(obb.L * obb.W, 1e-6);
  const flatModel = (y: number): RoofModel => ({ h: () => y, faces: [outer], kinks: [], ridgeY: y });
  if (type === 'flat' || type === 'skillion' && b.cls === 'industrial' && pitch < 4) return flatModel(eaveY);
  if (type === 'skillion') {
    const d = azToDir(b.roof.dirAz ?? 0);
    const c = centroid(poly);
    let minProj = Infinity;
    for (const p of poly) minProj = Math.min(minProj, (p[0] - c[0]) * d[0] + (p[1] - c[1]) * d[1]);
    const h = (x: number, z: number) => eaveY + s * ((x - c[0]) * d[0] + (z - c[1]) * d[1] - minProj);
    let maxY = eaveY;
    for (const p of poly) maxY = Math.max(maxY, h(p[0], p[1]));
    return { h, faces: [outer], kinks: [], ridgeY: maxY };
  }
  const complex = b.roof.complex || fill < 0.82 || poly.length > 8;
  if (complex && skeleton) {
    // Straight-skeleton hipped roof on the expanded outline.
    const ring = outer.map((p) => [p[0], p[1]]);
    ring.push([outer[0][0], outer[0][1]]);
    const sk = skeleton([ring]);
    if (sk) {
      const faces3 = sk.polygons.map((f) => ({
        pts: f.map((vi) => {
          const v = sk.vertices[vi];
          return [v[0], eaveY + (v[2] - overhang) * s, v[1]] as [number, number, number];
        }),
      }));
      let ridgeY = eaveY;
      for (const f of faces3) for (const p of f.pts) ridgeY = Math.max(ridgeY, p[1]);
      return { h: () => eaveY, faces: [], kinks: [], ridgeY, faces3, wallTop: () => eaveY };
    }
  }
  // Rectangle-like: analytic gable or hip around the oriented box.
  let ax = obb.ax;
  if (b.roof.ridgeAz !== null && b.roof.ridgeAz !== undefined && type === 'gabled') {
    const d = azToDir(b.roof.ridgeAz);
    // Snap to the closer OBB axis to keep the ridge parallel to walls.
    const dotL = Math.abs(d[0] * obb.ax[0] + d[1] * obb.ax[1]);
    ax = dotL >= 0.7 ? obb.ax : obb.ay;
  }
  const ay: P2 = [-ax[1], ax[0]];
  const c = obb.c;
  let halfW = 0, halfL = 0;
  for (const p of poly) {
    halfW = Math.max(halfW, Math.abs((p[0] - c[0]) * ay[0] + (p[1] - c[1]) * ay[1]));
    halfL = Math.max(halfL, Math.abs((p[0] - c[0]) * ax[0] + (p[1] - c[1]) * ax[1]));
  }
  const ridgeY = eaveY + s * halfW;
  if (type === 'hipped') {
    const hl = Math.max(halfL - halfW, 0);
    const h = (x: number, z: number) => {
      const u = (x - c[0]) * ax[0] + (z - c[1]) * ax[1];
      const v = (x - c[0]) * ay[0] + (z - c[1]) * ay[1];
      return ridgeY - s * Math.max(Math.abs(v), Math.abs(u) - hl);
    };
    // Partition into 4 planes: long sides (|v| dominant) and hip ends.
    const faces: P2[][] = [];
    const cu = c[0] * ax[0] + c[1] * ax[1];
    const cv = c[0] * ay[0] + c[1] * ay[1];
    // Region definitions via half-planes in (u, v): side +v: v >= |u| - hl ; etc.
    const regions: [number, number, number][][] = [
      [[-ax[0] + ay[0], -ax[1] + ay[1], cu - cv + hl], [ax[0] + ay[0], ax[1] + ay[1], -cu - cv + hl]], // v >= u-hl and v >= -u-hl
      [[-ax[0] - ay[0], -ax[1] - ay[1], cu + cv + hl], [ax[0] - ay[0], ax[1] - ay[1], -cu + cv + hl]], // -v >= ...
      [[ax[0] - ay[0], ax[1] - ay[1], -cu + cv - hl], [ax[0] + ay[0], ax[1] + ay[1], -cu - cv - hl]], // u - hl >= |v|
      [[-ax[0] - ay[0], -ax[1] - ay[1], cu + cv - hl], [-ax[0] + ay[0], -ax[1] + ay[1], cu - cv - hl]], // -u - hl >= |v|
    ];
    for (const reg of regions) {
      let f = outer;
      for (const [a, bb, cc] of reg) f = clipHalfPlane(f, a, bb, cc);
      if (f.length >= 3) faces.push(f);
    }
    return { h, faces, kinks: [], ridgeY, wallTop: () => eaveY };
  }
  // Gable: two planes split on the ridge line.
  const h = (x: number, z: number) => ridgeY - s * Math.abs((x - c[0]) * ay[0] + (z - c[1]) * ay[1]);
  const kc = -(c[0] * ay[0] + c[1] * ay[1]);
  const f1 = clipHalfPlane(outer, ay[0], ay[1], kc);
  const f2 = clipHalfPlane(outer, -ay[0], -ay[1], -kc);
  return { h, faces: [f1, f2].filter((f) => f.length >= 3), kinks: [[ay[0], ay[1], kc]], ridgeY };
}

// ---------------------------------------------------------------------------------------------

function setWallAttrs(S: Stream, st: Style, b: BuildingRec, wallLen: number, isFront: number, eaveRel: number): void {
  S.cur0 = [st.wall[0], st.wall[1], st.wall[2], st.wallType];
  S.cur1 = [st.trim[0], st.trim[1], st.trim[2], st.win];
  S.cur2 = [(b.seed % 997) / 997, st.floorH, isFront, wallLen];
  S.cur3 = [eaveRel, b.cls === 'garage' ? 1 : 0, 0, 0];
}

/** Generate all geometry for one building into the shared streams. */
export function buildBuilding(b: BuildingRec, out: BuildingStreams, skeleton: SkeletonFn | null): void {
  let poly = dedupe(b.poly.map((p) => [p[0], p[1]] as P2));
  if (poly.length < 3) return;
  poly = orientCCW(poly);
  const st = styleFor(b);
  const eaveY = b.base + Math.max(b.eave, 2.0);
  const groundY = Math.min(b.baseMin, b.base) - 0.6;
  const overhang = b.roof.type === 'flat' ? 0 : st.overhang;
  const outer = overhang > 0 ? offsetPolygon(poly, overhang) : poly;
  const model = roofModel(b, poly, outer, eaveY, skeleton, overhang);
  const parapetY = b.roof.type === 'flat' && st.parapet > 0 ? eaveY + st.parapet : eaveY;
  const wallTop = model.wallTop ?? ((x: number, z: number) => Math.max(model.h(x, z), eaveY));
  const topAt = (x: number, z: number) => (b.roof.type === 'flat' ? parapetY : wallTop(x, z));

  // Front wall: pipeline-provided or the longest edge.
  let front = b.front ?? -1;
  if (front < 0) {
    let best = -1;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > best) { best = l; front = i; }
    }
  }

  // ---- walls
  const W = out.walls;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < 0.05) continue;
    // Break points where the roof profile kinks along this wall.
    const ts = [0, 1];
    for (const [a, bb, c] of model.kinks) {
      const dp = a * p[0] + bb * p[1] + c;
      const dq = a * q[0] + bb * q[1] + c;
      if ((dp > 0) !== (dq > 0) && Math.abs(dp - dq) > 1e-6) ts.push(dp / (dp - dq));
    }
    ts.sort((x, y) => x - y);
    setWallAttrs(W, st, b, len, i === front ? 1 : 0, eaveY - b.base);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-4) continue;
      const x0 = p[0] + (q[0] - p[0]) * t0, z0 = p[1] + (q[1] - p[1]) * t0;
      const x1 = p[0] + (q[0] - p[0]) * t1, z1 = p[1] + (q[1] - p[1]) * t1;
      const y0 = topAt(x0, z0), y1 = topAt(x1, z1);
      const u0 = t0 * len, u1 = t1 * len;
      // Quad: bottom-left, bottom-right, top-right, top-left (outward facing).
      W.quad([x0, groundY, z0], [x0, y0, z0], [x1, y1, z1], [x1, groundY, z1],
        [u0, groundY - b.base], [u0, y0 - b.base], [u1, y1 - b.base], [u1, groundY - b.base]);
    }
    // Inner parapet face.
    if (parapetY > eaveY + 0.01) {
      W.quad([x0f(p), eaveY, z0f(p)], [x0f(q), eaveY, z0f(q)], [x0f(q), parapetY, z0f(q)], [x0f(p), parapetY, z0f(p)],
        [0, eaveY - b.base], [len, eaveY - b.base], [len, parapetY - b.base], [0, parapetY - b.base]);
    }
  }

  // ---- roof surfaces
  const R = out.roofs;
  R.cur0 = [st.roof[0], st.roof[1], st.roof[2], st.roofType];
  R.cur1 = [(b.seed % 991) / 991, 0, 0, 0];
  const roofTri = (a: number[], bb: number[], c: number[]) => {
    // UV: metres along the fall line and across it for shingle courses.
    const ux = bb[0] - a[0], uy = bb[1] - a[1], uz = bb[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    if (ny < 0) { [bb, c] = [c, bb]; nx = -nx; ny = -ny; nz = -nz; }
    // Fall-line direction projected on the plane.
    let dx = nx, dz = nz;
    const dl = Math.hypot(dx, dz);
    if (dl < 1e-4) { dx = 1; dz = 0; } else { dx /= dl; dz /= dl; }
    const tx = -dz, tz = dx;
    const slopeScale = 1 / Math.max(ny, 0.2);
    const uvOf = (p: number[]) => [p[0] * tx + p[2] * tz, (p[0] * dx + p[2] * dz) * slopeScale];
    R.vert(a[0], a[1], a[2], nx, ny, nz, ...(uvOf(a) as [number, number]));
    R.vert(bb[0], bb[1], bb[2], nx, ny, nz, ...(uvOf(bb) as [number, number]));
    R.vert(c[0], c[1], c[2], nx, ny, nz, ...(uvOf(c) as [number, number]));
  };
  const roofOutline: P2[] = b.roof.type === 'flat' && st.parapet > 0 ? offsetPolygon(poly, -0.25) : outer;
  if (model.faces3) {
    for (const f of model.faces3) {
      const flat2 = f.pts.flatMap((p) => [p[0], p[2]]);
      const idx = earcut(flat2);
      for (let k = 0; k < idx.length; k += 3) roofTri(f.pts[idx[k]], f.pts[idx[k + 1]], f.pts[idx[k + 2]]);
    }
  } else {
    const faces = b.roof.type === 'flat' ? [roofOutline] : model.faces;
    for (const f of faces) {
      const flat2 = f.flatMap((p) => [p[0], p[1]]);
      const idx = earcut(flat2);
      const pts = f.map((p) => [p[0], (b.roof.type === 'flat' ? eaveY + 0.02 : model.h(p[0], p[1])), p[1]]);
      for (let k = 0; k < idx.length; k += 3) roofTri(pts[idx[k]], pts[idx[k + 1]], pts[idx[k + 2]]);
    }
  }

  // ---- trims: fascia, soffit, gutters, downspouts, parapet cap, chimney
  const T = out.trims;
  const trimCol = st.trim;
  T.cur0 = [trimCol[0], trimCol[1], trimCol[2], 0];
  const hAt = model.faces3 ? () => eaveY - overhang * Math.tan(((b.roof.pitch ?? 22) * Math.PI) / 180) : (x: number, z: number) => (b.roof.type === 'flat' ? eaveY : model.h(x, z));
  if (overhang > 0) {
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p = outer[i], q = outer[(i + 1) % n];
      const pi = poly[i], qi = poly[(i + 1) % n];
      const yp = hAt(p[0], p[1]), yq = hAt(q[0], q[1]);
      const fd = 0.22;
      // Fascia board.
      T.quad([p[0], yp - fd, p[1]], [q[0], yq - fd, q[1]], [q[0], yq + 0.02, q[1]], [p[0], yp + 0.02, p[1]], [0, 0], [1, 0], [1, 1], [0, 1]);
      // Soffit (underside of the overhang), facing down.
      T.quad([pi[0], yp - fd, pi[1]], [qi[0], yq - fd, qi[1]], [q[0], yq - fd, q[1]], [p[0], yp - fd, p[1]], [0, 0], [1, 0], [1, 1], [0, 1]);
      // Gutter along level eaves.
      if (Math.abs(yp - yq) < 0.05 && Math.abs(yp - (eaveY - overhang * Math.tan(((b.roof.pitch ?? 22) * Math.PI) / 180))) < 0.6 && b.cls !== 'shed') {
        const ex = q[0] - p[0], ez = q[1] - p[1];
        const el = Math.hypot(ex, ez) || 1;
        const nx = ez / el, nz = -ex / el;
        const gy = yp - 0.05, gh = 0.13, gw = 0.13;
        const o = (pt: P2, d: number): number[] => [pt[0] + nx * d, gy, pt[1] + nz * d];
        const a0 = o(p, 0.0), b0 = o(q, 0.0), a1 = o(p, gw), b1 = o(q, gw);
        T.cur0 = [0.78, 0.78, 0.76, 1];
        T.quad([a1[0], gy - gh, a1[2]], [b1[0], gy - gh, b1[2]], [b1[0], gy, b1[2]], [a1[0], gy, a1[2]], [0, 0], [1, 0], [1, 1], [0, 1]);
        T.quad([a0[0], gy - gh, a0[2]], [a1[0], gy - gh, a1[2]], [b1[0], gy - gh, b1[2]], [b0[0], gy - gh, b0[2]], [0, 0], [1, 0], [1, 1], [0, 1]);
        // Downspout at the start corner of this gutter run.
        const dsx = pi[0] + nx * 0.08 + (ex / el) * 0.15, dsz = pi[1] + nz * 0.08 + (ez / el) * 0.15;
        box(T, dsx, groundY + 0.5, dsz, 0.07, gy - gh - (groundY + 0.5), 0.07, [0.78, 0.78, 0.76]);
        T.cur0 = [trimCol[0], trimCol[1], trimCol[2], 0];
      }
    }
  }
  if (b.roof.type === 'flat' && st.parapet > 0) {
    T.cur0 = [0.62, 0.61, 0.58, 0];
    const inner = offsetPolygon(poly, -0.25);
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const ip = inner[i], iq = inner[(i + 1) % poly.length];
      T.quad([p[0], parapetY, p[1]], [ip[0], parapetY, ip[1]], [iq[0], parapetY, iq[1]], [q[0], parapetY, q[1]], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }
  if (st.chimney && model.ridgeY > eaveY + 0.8) {
    const c = centroid(poly);
    const r = rng(b.seed ^ 0x9e3779b9);
    const obb = orientedBox(poly);
    const off = (r() - 0.5) * obb.L * 0.5;
    const cx = c[0] + obb.ax[0] * off, cz = c[1] + obb.ax[1] * off;
    const baseY = Math.min(model.faces3 ? eaveY : model.h(cx, cz), model.ridgeY) - 0.3;
    box(T, cx, baseY, cz, 0.6, model.ridgeY + 0.9 - baseY, 0.9, [0.36, 0.2, 0.15]);
  }
  if (b.cls === 'commercial' && b.roof.type === 'flat') {
    // Rooftop HVAC units.
    const r = rng(b.seed ^ 0x51ed27);
    const c = centroid(poly);
    const units = 1 + Math.floor(r() * 3);
    for (let k = 0; k < units; k++) {
      const obb = orientedBox(poly);
      const u = (r() - 0.5) * obb.L * 0.5, v = (r() - 0.5) * obb.W * 0.5;
      const x = c[0] + obb.ax[0] * u + obb.ay[0] * v, z = c[1] + obb.ax[1] * u + obb.ay[1] * v;
      box(T, x, eaveY, z, 1.4 + r(), 1.1, 1.2 + r(), [0.7, 0.71, 0.7]);
    }
  }
  if (b.holes) {
    // Courtyard walls for multipolygon holes (rare): inward facing.
    for (const hole of b.holes) {
      let hp = dedupe(hole.map((p) => [p[0], p[1]] as P2));
      if (hp.length < 3) continue;
      hp = orientCCW(hp).slice().reverse();
      for (let i = 0; i < hp.length; i++) {
        const p = hp[i], q = hp[(i + 1) % hp.length];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        setWallAttrs(W, st, b, len, 0, eaveY - b.base);
        W.quad([p[0], groundY, p[1]], [p[0], eaveY, p[1]], [q[0], eaveY, q[1]], [q[0], groundY, q[1]],
          [0, groundY - b.base], [0, eaveY - b.base], [len, eaveY - b.base], [len, groundY - b.base]);
      }
    }
  }

  function x0f(p: P2) { return p[0]; }
  function z0f(p: P2) { return p[1]; }
}

/** Axis-aligned box (x/z centred, y from y0) into a trim stream with a colour. */
export function box(T: Stream, x: number, y0: number, z: number, sx: number, sy: number, sz: number, col: number[]): void {
  const prev = T.cur0;
  T.cur0 = [col[0], col[1], col[2], 0];
  const x0 = x - sx / 2, x1 = x + sx / 2, z0 = z - sz / 2, z1 = z + sz / 2, y1 = y0 + sy;
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
  T.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], uv[0], uv[1], uv[2], uv[3]);
  T.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], uv[0], uv[1], uv[2], uv[3]);
  T.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], uv[0], uv[1], uv[2], uv[3]);
  T.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], uv[0], uv[1], uv[2], uv[3]);
  T.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], uv[0], uv[1], uv[2], uv[3]);
  T.cur0 = prev;
}
