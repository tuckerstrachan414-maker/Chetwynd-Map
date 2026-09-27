import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Procedural street-furniture models. Each model is a list of parts, one per material, with the
 * origin at ground level and local +z as the "front" (sign face, lamp arm, bench seat).
 */
export type MatKey = 'galv' | 'wood' | 'darkMetal' | 'red' | 'yellow' | 'green' | 'white' | 'black' | 'lens' | 'lensAmber'
  | 'lensRed' | 'lensGreen' | 'stopFace' | 'nameBlade' | 'benchWood' | 'plastic' | 'ceramic' | 'rope' | 'concrete';

export interface Part {
  mat: MatKey;
  geo: THREE.BufferGeometry;
}

type G = THREE.BufferGeometry;

function tf(g: G, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): G {
  g.rotateX(rx);
  g.rotateY(ry);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

function cyl(r0: number, r1: number, h: number, seg = 8): G {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, false);
  g.translate(0, h / 2, 0);
  return g;
}

function boxg(w: number, h: number, d: number): G {
  return new THREE.BoxGeometry(w, h, d);
}

/** A tube between two points. */
function beam(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 6): G {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  const g = new THREE.CylinderGeometry(r, r, L, seg, 1, true);
  g.translate(0, L / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

function strip(g: G): G {
  // Keep only position/normal/uv so parts can be merged together.
  const out = new THREE.BufferGeometry();
  const src = g.index ? g.toNonIndexed() : g;
  out.setAttribute('position', src.getAttribute('position'));
  out.setAttribute('normal', src.getAttribute('normal'));
  const uv = src.getAttribute('uv');
  out.setAttribute('uv', uv ?? new THREE.Float32BufferAttribute(new Float32Array(src.getAttribute('position').count * 2), 2));
  return out;
}

function parts(list: [MatKey, G][]): Part[] {
  const by = new Map<MatKey, G[]>();
  for (const [m, g] of list) {
    const arr = by.get(m) ?? [];
    arr.push(strip(g));
    by.set(m, arr);
  }
  return [...by.entries()].map(([mat, gs]) => ({ mat, geo: mergeGeometries(gs, false)! }));
}

/** Cobra-head street light: 0 = wooden pole with a short arm (residential), 1 = tall galvanized arterial pole. */
export function lampModel(variant: number): Part[] {
  const L: [MatKey, G][] = [];
  const h = variant ? 10 : 8.5;
  const armLen = variant ? 3.2 : 1.8;
  L.push([variant ? 'galv' : 'wood', cyl(variant ? 0.11 : 0.15, variant ? 0.07 : 0.12, h, 10)]);
  if (variant) L.push(['concrete', cyl(0.3, 0.28, 0.35, 12)]);
  // Arm curving out over the road.
  const a0 = new THREE.Vector3(0, h - 0.6, 0);
  const a1 = new THREE.Vector3(0, h - 0.05, armLen * 0.45);
  const a2 = new THREE.Vector3(0, h + 0.1, armLen);
  L.push(['galv', beam(a0, a1, 0.045)]);
  L.push(['galv', beam(a1, a2, 0.04)]);
  // Luminaire: tapered head with a flat lens underneath.
  const head = new THREE.CapsuleGeometry(0.16, 0.5, 4, 8);
  head.rotateX(Math.PI / 2);
  head.scale(1.15, 0.55, 1);
  L.push(['galv', tf(head, 0, h + 0.05, armLen + 0.3)]);
  L.push(['lens', tf(boxg(0.26, 0.02, 0.5), 0, h - 0.04, armLen + 0.32)]);
  return parts(L);
}

/** Wooden distribution pole with a crossarm, three insulators and (sometimes) a transformer can. */
export function poleModel(variant: number): Part[] {
  const L: [MatKey, G][] = [];
  const h = 11.5;
  L.push(['wood', cyl(0.16, 0.12, h, 10)]);
  L.push(['wood', tf(boxg(2.4, 0.1, 0.1), 0, h - 0.5, 0)]);
  for (const x of [-1.05, 0, 1.05]) L.push(['ceramic', tf(cyl(0.05, 0.04, 0.22, 6), x, h - 0.45 + (x === 0 ? 0.35 : 0), 0)]);
  // Braces from crossarm to pole.
  L.push(['galv', beam(new THREE.Vector3(-0.6, h - 0.5, 0), new THREE.Vector3(0, h - 1.1, 0), 0.015, 4)]);
  L.push(['galv', beam(new THREE.Vector3(0.6, h - 0.5, 0), new THREE.Vector3(0, h - 1.1, 0), 0.015, 4)]);
  // Secondary/neutral rack.
  L.push(['galv', tf(boxg(0.06, 0.4, 0.06), 0, h - 2.2, 0.17)]);
  if (variant % 5 === 0) {
    L.push(['galv', tf(cyl(0.28, 0.28, 0.9, 12), 0, h - 3.4, 0.4)]);
    L.push(['galv', tf(cyl(0.29, 0.26, 0.06, 12), 0, h - 2.5, 0.4)]);
  }
  return parts(L);
}

/** Steel lattice transmission tower (single circuit, three phases and a shield wire). */
export function towerModel(): Part[] {
  const L: [MatKey, G][] = [];
  const H = 26;
  const baseW = 3.2;
  const topW = 1.0;
  const legs: THREE.Vector3[][] = [];
  const levels = 9;
  for (let k = 0; k <= levels; k++) {
    const t = k / levels;
    const y = t * H * 0.78;
    const w = baseW + (topW - baseW) * Math.min(1, t * 1.05);
    legs.push([new THREE.Vector3(-w, y, -w), new THREE.Vector3(w, y, -w), new THREE.Vector3(w, y, w), new THREE.Vector3(-w, y, w)]);
  }
  for (let k = 0; k < levels; k++) {
    for (let c = 0; c < 4; c++) {
      L.push(['galv', beam(legs[k][c], legs[k + 1][c], 0.06, 4)]);
      const n = (c + 1) % 4;
      L.push(['galv', beam(legs[k][c], legs[k + 1][n], 0.025, 3)]);
      L.push(['galv', beam(legs[k][n], legs[k + 1][c], 0.025, 3)]);
      L.push(['galv', beam(legs[k + 1][c], legs[k + 1][n], 0.03, 3)]);
    }
  }
  // Peak and crossarms.
  const top = legs[levels];
  const peak = new THREE.Vector3(0, H, 0);
  for (const p of top) L.push(['galv', beam(p, peak, 0.04, 4)]);
  const armY = H * 0.78;
  L.push(['galv', tf(boxg(11, 0.35, 0.35), 0, armY + 0.2, 0)]);
  L.push(['galv', beam(new THREE.Vector3(-5.5, armY + 0.2, 0), new THREE.Vector3(-1, armY + 2.4, 0), 0.04, 4)]);
  L.push(['galv', beam(new THREE.Vector3(5.5, armY + 0.2, 0), new THREE.Vector3(1, armY + 2.4, 0), 0.04, 4)]);
  for (const x of [-5.0, 0, 5.0]) L.push(['ceramic', tf(cyl(0.12, 0.1, 1.6, 8), x, armY - 1.5, 0)]);
  return parts(L);
}

/** Fire hydrant: red barrel, bonnet, two hose nozzles and a pumper port. */
export function hydrantModel(): Part[] {
  const L: [MatKey, G][] = [];
  L.push(['red', cyl(0.13, 0.12, 0.62, 12)]);
  L.push(['red', tf(cyl(0.16, 0.16, 0.06, 12), 0, 0.02, 0)]);
  const dome = new THREE.SphereGeometry(0.13, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  L.push(['yellow', tf(dome, 0, 0.62, 0)]);
  L.push(['yellow', tf(cyl(0.035, 0.03, 0.1, 5), 0, 0.72, 0)]);
  for (const s of [-1, 1]) L.push(['red', tf(cyl(0.045, 0.045, 0.12, 8), s * 0.12, 0.45, 0, 0, 0, s * Math.PI / 2)]);
  L.push(['yellow', tf(cyl(0.07, 0.07, 0.1, 10), 0, 0.42, 0.12, Math.PI / 2, 0, 0)]);
  return parts(L);
}

function octagon(r: number, depth: number): G {
  const s = new THREE.Shape();
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    if (k === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  // UVs across the face for the sign texture.
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / (2 * r) + 0.5, pos.getY(i) / (2 * r) + 0.5);
  return g;
}

export function stopModel(): Part[] {
  const L: [MatKey, G][] = [];
  L.push(['galv', cyl(0.03, 0.03, 2.5, 6)]);
  L.push(['stopFace', tf(octagon(0.38, 0.01), 0, 2.2, 0.035)]);
  L.push(['galv', tf(octagon(0.38, 0.01), 0, 2.2, 0.02)]);
  return parts(L);
}

/** Street-name post: two blades; blade UVs are remapped per instance to a name atlas row. */
export function streetNameModel(): { post: Part[]; bladeA: G; bladeB: G } {
  const post = parts([['galv', cyl(0.035, 0.035, 3.1, 6)], ['galv', tf(cyl(0.04, 0.04, 0.08, 6), 0, 3.08, 0)]]);
  const blade = () => strip(new THREE.BoxGeometry(0.9, 0.16, 0.012));
  const a = tf(blade(), 0, 2.95, 0.02);
  const b = tf(blade(), 0, 2.75, 0.02, 0, Math.PI / 2, 0);
  return { post, bladeA: a, bladeB: b };
}

/** Traffic signal: steel pole, mast arm over the lanes, two signal heads. */
export function signalModel(): Part[] {
  const L: [MatKey, G][] = [];
  L.push(['galv', cyl(0.16, 0.12, 6.8, 12)]);
  L.push(['concrete', cyl(0.35, 0.33, 0.3, 12)]);
  L.push(['galv', beam(new THREE.Vector3(0, 6.2, 0), new THREE.Vector3(0, 6.5, 7.5), 0.08, 8)]);
  for (const z of [3.8, 6.8]) {
    L.push(['black', tf(boxg(0.36, 1.05, 0.28), 0, 5.75, z)]);
    L.push(['lensRed', tf(new THREE.CircleGeometry(0.1, 12), 0, 6.1, z - 0.145, Math.PI, 0, 0)]);
    L.push(['lensAmber', tf(new THREE.CircleGeometry(0.1, 12), 0, 5.77, z - 0.145, Math.PI, 0, 0)]);
    L.push(['lensGreen', tf(new THREE.CircleGeometry(0.1, 12), 0, 5.44, z - 0.145, Math.PI, 0, 0)]);
    L.push(['black', tf(boxg(0.5, 1.2, 0.02), 0, 5.75, z + 0.15)]);
  }
  // Pedestrian push-button box.
  L.push(['black', tf(boxg(0.1, 0.16, 0.08), 0, 1.1, -0.18)]);
  return parts(L);
}

export function benchModel(): Part[] {
  const L: [MatKey, G][] = [];
  for (let k = 0; k < 3; k++) L.push(['benchWood', tf(boxg(1.8, 0.035, 0.12), 0, 0.45, 0.06 - k * 0.14)]);
  for (let k = 0; k < 2; k++) L.push(['benchWood', tf(boxg(1.8, 0.12, 0.03), 0, 0.62 + k * 0.16, -0.27 - k * 0.02, -0.12, 0, 0)]);
  for (const x of [-0.75, 0.75]) {
    L.push(['darkMetal', tf(boxg(0.05, 0.45, 0.05), x, 0.22, 0.12)]);
    L.push(['darkMetal', tf(boxg(0.05, 0.8, 0.05), x, 0.4, -0.25, -0.12, 0, 0)]);
    L.push(['darkMetal', tf(boxg(0.05, 0.04, 0.5), x, 0.44, -0.06)]);
    L.push(['darkMetal', tf(boxg(0.05, 0.04, 0.4), x, 0.68, -0.02)]);
  }
  return parts(L);
}

export function binModel(): Part[] {
  const L: [MatKey, G][] = [];
  L.push(['green', cyl(0.28, 0.3, 0.95, 14)]);
  L.push(['darkMetal', tf(cyl(0.32, 0.32, 0.05, 14), 0, 0.95, 0)]);
  const dome = new THREE.SphereGeometry(0.3, 14, 5, 0, Math.PI * 2, 0, Math.PI / 3);
  L.push(['darkMetal', tf(dome, 0, 0.85, 0)]);
  return parts(L);
}

/** Playground: platform tower with a slide and a two-seat swing set. */
export function playgroundModel(): Part[] {
  const L: [MatKey, G][] = [];
  for (const [x, z] of [[-0.8, -0.8], [0.8, -0.8], [0.8, 0.8], [-0.8, 0.8]]) L.push(['yellow', tf(cyl(0.06, 0.06, 2.6, 8), x, 0, z)]);
  L.push(['plastic', tf(boxg(1.8, 0.08, 1.8), 0, 1.3, 0)]);
  const roof = new THREE.ConeGeometry(1.35, 0.8, 4, 1);
  L.push(['red', tf(roof, 0, 3.0, 0, 0, Math.PI / 4, 0)]);
  // Slide down to the front.
  const slide = new THREE.BoxGeometry(0.6, 0.04, 2.8);
  L.push(['plastic', tf(slide, 0, 0.7, 2.1, -0.49, 0, 0)]);
  for (const s of [-1, 1]) L.push(['plastic', tf(boxg(0.04, 0.22, 2.8), s * 0.31, 0.8, 2.1, -0.49, 0, 0)]);
  // Ladder at the back.
  for (const s of [-1, 1]) L.push(['yellow', beam(new THREE.Vector3(s * 0.3, 0, -1.8), new THREE.Vector3(s * 0.3, 1.3, -0.9), 0.03, 6)]);
  for (let k = 1; k < 5; k++) L.push(['yellow', tf(boxg(0.6, 0.04, 0.04), 0, (k / 5) * 1.3, -1.8 + (k / 5) * 0.9)]);
  // Swing set to the side.
  const sx = 4.0;
  for (const z of [-1.2, 1.2]) {
    L.push(['green', beam(new THREE.Vector3(sx - 1.6, 0, z), new THREE.Vector3(sx, 2.4, z), 0.05, 6)]);
    L.push(['green', beam(new THREE.Vector3(sx + 1.6, 0, z), new THREE.Vector3(sx, 2.4, z), 0.05, 6)]);
  }
  L.push(['green', beam(new THREE.Vector3(sx, 2.4, -1.3), new THREE.Vector3(sx, 2.4, 1.3), 0.05, 8)]);
  for (const z of [-0.5, 0.5]) {
    for (const dx of [-0.2, 0.2]) L.push(['rope', beam(new THREE.Vector3(sx + dx, 2.4, z), new THREE.Vector3(sx + dx, 0.5, z), 0.01, 4)]);
    L.push(['black', tf(boxg(0.5, 0.03, 0.18), sx, 0.5, z)]);
  }
  return parts(L);
}

/** Where the conductors attach on a distribution pole (local space) and on a lattice tower. */
export const POLE_ATTACH: [number, number, number][] = [[-1.05, 11.25, 0], [0, 11.6, 0], [1.05, 11.25, 0], [0, 9.3, 0.17]];
export const TOWER_ATTACH: [number, number, number][] = [[-5, 18.8, 0], [0, 18.8, 0], [5, 18.8, 0], [0, 26, 0]];
