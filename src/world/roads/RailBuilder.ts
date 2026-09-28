import * as THREE from 'three';

/**
 * Builds railway track geometry at load time from the compact station records in the road chunks
 * (see pipeline/roads.py, group type 30): a ballast bed with shoulders, creosoted timber ties every
 * 0.6 m along the line, and two flat-bottom rails whose running surface is a separate polished strip.
 * At level crossings the ballast and ties are omitted and the rail heads sit flush with the road.
 */

export const GAUGE = 1.435;
const TIE_SPACING = 0.6;

export interface TrackStations {
  pos: Float32Array; // x, rail top, z per station
  attr: Float32Array; // ballast bed height, distance along line
  flags: Uint32Array; // 1 crossing, 2 bridge
}

export interface TrackMeshes {
  ballast: THREE.BufferGeometry | null;
  steel: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  ties: THREE.Matrix4[];
  /** Rails (steel + head) as collider soup. */
  collider: { pos: Float32Array; idx: Uint32Array };
}

class Soup {
  pos: number[] = [];
  attr: number[] = [];
  idx: number[] = [];
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('attr', new THREE.Float32BufferAttribute(this.attr, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Sweep a cross-section (lateral, vertical) along stations. Profiles are traversed clockwise in the
 * (right, up) plane so faces point outwards.
 */
function sweep(out: Soup, P: Float32Array, R: Float32Array, Y: Float32Array, start: number, end: number,
  profile: [number, number][], along: Float32Array): void {
  const n = end - start;
  if (n < 2) return;
  for (let s = 0; s < profile.length - 1; s++) {
    const [l0, v0] = profile[s];
    const [l1, v1] = profile[s + 1];
    const base = out.pos.length / 3;
    for (let k = start; k < end; k++) {
      out.pos.push(P[k * 2] + R[k * 2] * l0, Y[k] + v0, P[k * 2 + 1] + R[k * 2 + 1] * l0);
      out.attr.push(s / (profile.length - 1), along[k]);
    }
    for (let k = start; k < end; k++) {
      out.pos.push(P[k * 2] + R[k * 2] * l1, Y[k] + v1, P[k * 2 + 1] + R[k * 2 + 1] * l1);
      out.attr.push((s + 1) / (profile.length - 1), along[k]);
    }
    for (let k = 0; k < n - 1; k++) {
      const a = base + k;
      const b = base + n + k;
      out.idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
}

const RAIL_LEFT: [number, number][] = [[-0.07, 0.0], [-0.07, 0.012], [-0.009, 0.03], [-0.009, 0.13], [-0.036, 0.14], [-0.036, 0.172]];
const RAIL_RIGHT: [number, number][] = [[0.036, 0.172], [0.036, 0.14], [0.009, 0.13], [0.009, 0.03], [0.07, 0.012], [0.07, 0.0]];

export function buildTrack(t: TrackStations): TrackMeshes {
  const n = t.pos.length / 3;
  const P = new Float32Array(n * 2);
  const R = new Float32Array(n * 2);
  const top = new Float32Array(n);
  const bed = new Float32Array(n);
  const along = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    P[k * 2] = t.pos[k * 3];
    P[k * 2 + 1] = t.pos[k * 3 + 2];
    top[k] = t.pos[k * 3 + 1];
    bed[k] = t.attr[k * 2];
    along[k] = t.attr[k * 2 + 1];
  }
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1);
    const b = Math.min(n - 1, k + 1);
    let tx = P[b * 2] - P[a * 2];
    let tz = P[b * 2 + 1] - P[a * 2 + 1];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // Right-hand side of the direction of travel, in engine space (y up).
    R[k * 2] = -tz;
    R[k * 2 + 1] = tx;
  }
  // Ballast along runs outside crossings and bridges.
  const ballast = new Soup();
  let runStart = -1;
  const bedY = new Float32Array(n);
  for (let k = 0; k < n; k++) bedY[k] = bed[k] + 0.03;
  for (let k = 0; k <= n; k++) {
    const free = k < n && (t.flags[k] & 3) === 0;
    if (free && runStart < 0) runStart = k;
    if (!free && runStart >= 0) {
      sweep(ballast, P, R, bedY, runStart, k, [[-2.5, -0.3], [-1.75, 0.0], [1.75, 0.0], [2.5, -0.3]], along);
      runStart = -1;
    }
  }
  // Ties: at fixed spacing along the line, jittered a little, not inside road crossings.
  const ties: THREE.Matrix4[] = [];
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < n - 1; k++) {
    const s0 = along[k];
    const s1 = along[k + 1];
    if (s1 <= s0) continue;
    let st = Math.ceil(s0 / TIE_SPACING) * TIE_SPACING;
    for (; st < s1; st += TIE_SPACING) {
      const f = (st - s0) / (s1 - s0);
      if (t.flags[f < 0.5 ? k : k + 1] & 1) continue;
      const x = P[k * 2] + (P[(k + 1) * 2] - P[k * 2]) * f;
      const z = P[k * 2 + 1] + (P[(k + 1) * 2 + 1] - P[k * 2 + 1]) * f;
      const yb = bed[k] + (bed[k + 1] - bed[k]) * f;
      const jit = ((Math.sin(st * 12.9898) * 43758.5453) % 1) * 0.04;
      // Rotate the tie (long axis local x) onto the lateral direction R.
      const ang = Math.atan2(-R[k * 2 + 1], R[k * 2]) + jit * 0.3;
      q.setFromAxisAngle(up, ang);
      m.compose(new THREE.Vector3(x, yb - 0.02, z), q, new THREE.Vector3(1, 1, 1));
      ties.push(m.clone());
    }
  }
  // Rails.
  const steel = new Soup();
  const head = new Soup();
  const railBase = new Float32Array(n);
  for (let k = 0; k < n; k++) railBase[k] = top[k] - 0.172;
  for (const side of [-1, 1]) {
    const off = side * (GAUGE / 2 + 0.036);
    const shift = (p: [number, number][]) => p.map(([l, v]) => [l + off, v] as [number, number]);
    sweep(steel, P, R, railBase, 0, n, shift(RAIL_LEFT), along);
    sweep(steel, P, R, railBase, 0, n, shift(RAIL_RIGHT), along);
    sweep(head, P, R, railBase, 0, n, shift([[-0.036, 0.172], [0.036, 0.172]]), along);
  }
  const collider = {
    pos: new Float32Array([...steel.pos, ...head.pos]),
    idx: new Uint32Array([...steel.idx, ...head.idx.map((i) => i + steel.pos.length / 3)]),
  };
  return {
    ballast: ballast.idx.length ? ballast.geometry() : null,
    steel: steel.geometry(),
    head: head.geometry(),
    ties,
    collider,
  };
}

/** A creosoted tie: 2.6 m long (across the track), 0.23 m wide, 0.16 m deep; origin at its base. */
export function tieGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(2.6, 0.16, 0.23);
  g.translate(0, 0.08, 0);
  const n = g.getAttribute('position').count;
  const attr = new Float32Array(n * 2);
  const uv = g.getAttribute('uv');
  for (let i = 0; i < n; i++) {
    attr[i * 2] = uv.getX(i);
    attr[i * 2 + 1] = uv.getY(i) * 2.6;
  }
  g.setAttribute('attr', new THREE.BufferAttribute(attr, 2));
  return g;
}
