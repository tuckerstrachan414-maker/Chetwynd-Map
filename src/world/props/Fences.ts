import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldLit } from '../../engine/WorldLight';
import type { Pickable } from '../../ui/Editor';
import { refOf, type Overrides } from '../Overrides';

/** fences.json (pipeline/fences.py): polylines [x, y(ground), z], height, type, source. */
interface FenceRec {
  p: [number, number, number][];
  h: number;
  t: 'privacy' | 'chainlink' | 'rail';
  src: string;
  /** Editor identity: "fence@x_z" of the first point, or "#id" for a user-drawn fence. */
  ref?: string;
}

/** A straight fence panel for collisions: centre, half length, half height, heading. */
export interface FenceBox {
  x: number;
  y: number;
  z: number;
  hl: number;
  hh: number;
  ang: number;
}

const CELL = 250;
/** Fences draw merged per 500 m cell (a handful of draw calls); colliders stay per 250 m cell. */
const RENDER_CELL = 500;

// Board fence: vertical cedar boards with gaps, grain and weathering, in fence-local metres (uv).
const boardFrag = /* glsl */ `
  float fh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float fn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(fh(i), fh(i + vec2(1, 0)), u.x), mix(fh(i + vec2(0, 1)), fh(i + vec2(1, 1)), u.x), u.y); }
`;

/** Wooden, chain-link and rail fences, merged per 500 m cell. */
export class Fences {
  readonly root = new THREE.Group();
  readonly boxes = new Map<string, FenceBox[]>();
  private readonly mats: Record<string, THREE.Material>;

  constructor(private readonly url: string) {
    this.root.name = 'fences';
    const board = new THREE.MeshStandardMaterial({ color: 0x8a6a4c, roughness: 0.9, side: THREE.DoubleSide });
    board.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${boardFrag}`)
        .replace('#include <map_fragment>', `
          {
            // vMapUv-free: the uv attribute carries (distance along the fence, height) in metres.
            vec2 q = vFenceUv;
            float board = floor(q.x / 0.14);
            float bx = fract(q.x / 0.14);
            float gap = smoothstep(0.0, 0.04, bx) * smoothstep(1.0, 0.96, bx);
            float tone = 0.8 + 0.35 * fh(vec2(board, 3.0));
            float grain = 0.85 + 0.15 * fn(vec2(q.x * 60.0, q.y * 3.0 + board * 7.0));
            float weather = mix(1.0, 0.7, smoothstep(0.3, 0.0, q.y)) * (0.85 + 0.15 * fn(q * 1.5));
            diffuseColor.rgb *= tone * grain * weather * mix(0.25, 1.0, gap);
          }`);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFenceUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFenceUv = uv;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFenceUv;');
    };
    board.customProgramCacheKey = () => 'cw-fence-board';
    const chain = new THREE.MeshStandardMaterial({ color: 0xb4b8bc, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide });
    chain.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFenceUv;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFenceUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vFenceUv;')
        .replace('#include <alphatest_fragment>', `
          {
            // Chain-link: 50 mm diamonds of ~3.5 mm wire. Where the wires shrink below a pixel the
            // panel becomes a hashed ~30 % veil, as a real fence reads from a distance.
            vec2 q = vFenceUv / 0.05;
            vec2 d = vec2(q.x + q.y, q.x - q.y) * 0.7071;
            vec2 f = abs(fract(d) - 0.5);
            vec2 w = fwidth(d);
            float t = 0.05;
            float a = max(smoothstep(0.5 - t - w.x, 0.5 - t + w.x, f.x), smoothstep(0.5 - t - w.y, 0.5 - t + w.y, f.y));
            a = mix(a, 0.3, clamp(max(w.x, w.y) * 3.0 - 0.4, 0.0, 1.0));
            float hash = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            if (a < hash) discard;
            diffuseColor.a = 1.0;
          }`);
    };
    chain.customProgramCacheKey = () => 'cw-fence-chain';
    this.mats = {
      board: worldLit(board),
      chain: worldLit(chain),
      post: worldLit(new THREE.MeshStandardMaterial({ color: 0x6e5540, roughness: 0.92 })),
      steel: worldLit(new THREE.MeshStandardMaterial({ color: 0xa9adb1, roughness: 0.4, metalness: 0.85 })),
      rail: worldLit(new THREE.MeshStandardMaterial({ color: 0x7a6049, roughness: 0.9 })),
    };
  }

  private data: FenceRec[] = [];
  private recs: FenceRec[] = [];
  private overrides: Overrides | null = null;
  /** Called after every rebuild (the app refreshes the fence colliders). */
  onRebuild: () => void = () => {};

  async init(): Promise<void> {
    const res = await fetch(this.url);
    if (!res.ok) return;
    this.data = ((await res.json()) as { fences: FenceRec[] }).fences;
    this.build();
  }

  /** Apply the editor's fence deletions and user-drawn fences. */
  applyOverrides(ov: Overrides): void {
    this.overrides = ov;
    this.build();
  }

  /** Fence segments near (x, z) for the editor; LiDAR- and OSM-derived fences count as mapped. */
  pickables(x: number, z: number, radius: number): Pickable[] {
    const out: Pickable[] = [];
    const r2 = radius * radius;
    for (const f of this.recs) {
      for (let k = 0; k + 1 < f.p.length; k++) {
        const a = f.p[k], b = f.p[k + 1];
        const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
        if ((mx - x) ** 2 + (mz - z) ** 2 > r2) continue;
        const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
        out.push({ kind: 'fence', ref: f.ref!, x: mx, y: (a[1] + b[1]) / 2, z: mz, rot: 0, h: f.h, r: Math.max(0.6, len / 2), src: f.src === 'user' ? 'user' : 'mapped' });
      }
    }
    return out;
  }

  private build(): void {
    for (const m of [...this.root.children]) {
      this.root.remove(m);
      (m as THREE.Mesh).geometry.dispose();
    }
    this.boxes.clear();
    const removed = new Set<string>();
    const recs: FenceRec[] = [];
    if (this.overrides) {
      const { removed: r, added } = this.overrides.forKind('fence');
      for (const x of r) removed.add(x);
      for (const a of added) {
        if (a.pts && a.pts.length >= 2) recs.push({ p: a.pts, h: a.h ?? 1.6, t: a.ft ?? 'privacy', src: 'user', ref: `#${a.id}` });
      }
    }
    for (const f of this.data) {
      const ref = refOf('fence', f.p[0][0], f.p[0][2]);
      if (!removed.has(ref)) recs.push({ ...f, ref });
    }
    this.recs = recs;
    const byCell = new Map<string, Record<string, THREE.BufferGeometry[]>>();
    const bucket = (x: number, z: number) => {
      const rkey = `${Math.floor(x / RENDER_CELL)}_${Math.floor(z / RENDER_CELL)}`;
      let b = byCell.get(rkey);
      if (!b) byCell.set(rkey, (b = { board: [], chain: [], post: [], steel: [], rail: [] }));
      const key = `${Math.floor(x / CELL)}_${Math.floor(z / CELL)}`;
      let bx = this.boxes.get(key);
      if (!bx) this.boxes.set(key, (bx = []));
      return { geo: b, boxes: bx };
    };
    for (const f of recs) {
      let along = 0;
      for (let k = 0; k + 1 < f.p.length; k++) {
        const a = new THREE.Vector3(...f.p[k]);
        const b = new THREE.Vector3(...f.p[k + 1]);
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 0.2) continue;
        const { geo, boxes } = bucket((a.x + b.x) / 2, (a.z + b.z) / 2);
        this.segment(f, a, b, along, geo);
        boxes.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + f.h / 2, z: (a.z + b.z) / 2, hl: len / 2, hh: f.h / 2 + 0.2, ang: Math.atan2(b.z - a.z, b.x - a.x) });
        along += len;
      }
      // End post.
      const e = f.p[f.p.length - 1];
      const { geo } = bucket(e[0], e[2]);
      this.post(f, new THREE.Vector3(...e), geo);
    }
    for (const parts of byCell.values()) {
      for (const [mat, geos] of Object.entries(parts)) {
        if (!geos.length) continue;
        const m = new THREE.Mesh(mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g))), this.mats[mat]);
        m.castShadow = mat !== 'chain';
        m.receiveShadow = true;
        this.root.add(m);
      }
    }
    this.onRebuild();
  }

  private post(f: FenceRec, p: THREE.Vector3, geo: Record<string, THREE.BufferGeometry[]>): void {
    const h = f.h + (f.t === 'privacy' ? 0.05 : 0.02);
    const g = f.t === 'chainlink' ? new THREE.CylinderGeometry(0.03, 0.03, h, 8) : new THREE.BoxGeometry(f.t === 'rail' ? 0.1 : 0.09, h, f.t === 'rail' ? 0.1 : 0.09);
    g.translate(p.x, p.y + h / 2 - 0.02, p.z);
    geo[f.t === 'chainlink' ? 'steel' : 'post'].push(g);
  }

  /** One straight run between polyline vertices: posts at the fence type's spacing plus panels/rails. */
  private segment(f: FenceRec, a: THREE.Vector3, b: THREE.Vector3, along: number, geo: Record<string, THREE.BufferGeometry[]>): void {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const spacing = f.t === 'privacy' ? 2.4 : f.t === 'chainlink' ? 3.0 : 2.5;
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i < n; i++) this.post(f, new THREE.Vector3().lerpVectors(a, b, i / n), geo);
    const dir = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
    const ang = Math.atan2(-dir.z, dir.x);
    const quad = (y0: number, y1: number, mat: string) => {
      // Vertical strip following the ground between a and b; uv = (metres along, metres up).
      const g = new THREE.BufferGeometry();
      const P = [a.x, a.y + y0, a.z, b.x, b.y + y0, b.z, b.x, b.y + y1, b.z, a.x, a.y + y1, a.z];
      const U = [along, y0, along + len, y0, along + len, y1, along, y1];
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      geo[mat].push(g);
    };
    const bar = (y: number, w: number, hgt: number, mat: string, round: boolean) => {
      const g = round ? new THREE.CylinderGeometry(w, w, len, 6).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(len, hgt, w);
      g.rotateY(ang);
      g.translate((a.x + b.x) / 2, (a.y + b.y) / 2 + y, (a.z + b.z) / 2);
      // Follow the slope between the two ends.
      const slope = (b.y - a.y) / len;
      const pos = g.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const t = (pos.getX(i) - (a.x + b.x) / 2) * dir.x + (pos.getZ(i) - (a.z + b.z) / 2) * dir.z;
        pos.setY(i, pos.getY(i) + t * slope);
      }
      g.computeVertexNormals();
      geo[mat].push(g);
    };
    if (f.t === 'privacy') {
      quad(0.04, f.h, 'board');
      bar(0.35, 0.04, 0.09, 'rail', false);
      bar(f.h - 0.3, 0.04, 0.09, 'rail', false);
    } else if (f.t === 'chainlink') {
      quad(0.03, f.h - 0.03, 'chain');
      bar(f.h - 0.02, 0.021, 0, 'steel', true);
    } else {
      bar(f.h * 0.45, 0.05, 0.12, 'rail', false);
      bar(f.h * 0.9, 0.05, 0.12, 'rail', false);
    }
  }
}
