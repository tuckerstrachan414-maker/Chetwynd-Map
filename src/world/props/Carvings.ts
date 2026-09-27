import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Chetwynd's chainsaw carvings (District tour map; see pipeline/carvings.py), rendered as
 * procedural carved-wood stand-ins: the figure type comes from the carving's name, the pose and
 * proportions from a per-carving seed, and the surface is faceted like chainsaw cuts with grain,
 * stain and a few painted accents. Each stands on a sawn stump plinth.
 */

export interface Carving {
  n: number;
  x: number;
  y: number;
  z: number;
  name: string;
  carver: string;
  country: string;
  year: string;
  placed: string;
  awards: string;
  location: string;
}

type Kind = 'bear' | 'bird' | 'owl' | 'moose' | 'wolf' | 'cat' | 'fish' | 'horse' | 'human' | 'bench' | 'sign' | 'dragon' | 'beaver'
  | 'totem';

const KEYWORDS: [RegExp, Kind][] = [
  [/bench|throne|chair|seat/i, 'bench'],
  [/sign|pillar|welcome|centre|rama/i, 'sign'],
  [/owl/i, 'owl'],
  [/eagle|raven|hawk|bird|sparrow|chick|wings|nest|phoenix|pegasus|swan|goose|duck/i, 'bird'],
  [/bear|grizzl|cub/i, 'bear'],
  [/moose|elk|deer|caribou|stag/i, 'moose'],
  [/wolf|wolves|dog|coyote|fox/i, 'wolf'],
  [/cougar|cat|lynx|lion|tiger|panther/i, 'cat'],
  [/fish|salmon|trout|undersea|sea|mermaid|whale|dolphin|shark|riptide/i, 'fish'],
  [/horse|rodeo|bull|ride|pony|unicorn|buffalo|bison/i, 'horse'],
  [/dragon|serpent|snake/i, 'dragon'],
  [/beaver/i, 'beaver'],
  [/totem|spirit|mask|face|pole/i, 'totem'],
  [/man|woman|girl|boy|lady|mother|king|queen|warrior|goalie|prospector|hunter|huntress|robot|buddha|gong|miner|logger|firefighter|mountie|angel|knight|pirate|wizard|viking|samurai|guardian|protector|she |he |victory|player|fiddle|dance/i, 'human'],
];

function kindOf(name: string, n: number): Kind {
  for (const [re, k] of KEYWORDS) if (re.test(name)) return k;
  const fallback: Kind[] = ['bear', 'bird', 'human', 'totem', 'owl', 'wolf'];
  return fallback[n % fallback.length];
}

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 7;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

type G = THREE.BufferGeometry;

/** A part with a colour (vertex-colour tint over the wood). */
interface P {
  g: G;
  c: THREE.Color;
}

const WOOD = new THREE.Color(0.32, 0.17, 0.07);
const DARK = new THREE.Color(0.08, 0.06, 0.05);
const WHITE = new THREE.Color(0.7, 0.66, 0.56);
const BEAK = new THREE.Color(0.8, 0.6, 0.12);

function ell(rx: number, ry: number, rz: number, x: number, y: number, z: number, rot?: THREE.Euler, seg = 9): G {
  const g = new THREE.SphereGeometry(1, seg, Math.max(5, Math.round(seg * 0.7)));
  g.scale(rx, ry, rz);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(x, y, z);
  return g;
}

function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, seg = 7): G {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 2);
  g.translate(0, L / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function figure(kind: Kind, r: () => number, name: string): P[] {
  const P: P[] = [];
  const w = (g: G, c = WOOD) => P.push({ g, c });
  const s = 0.9 + r() * 0.35;
  switch (kind) {
    case 'bear': {
      const standing = r() < 0.55;
      if (standing) {
        w(ell(0.48, 0.75, 0.42, 0, 1.05, 0));
        w(ell(0.36, 0.34, 0.34, 0, 1.95, 0.05));
        w(ell(0.14, 0.12, 0.2, 0, 1.9, 0.36));
        w(ell(0.05, 0.04, 0.04, 0, 1.93, 0.55), DARK);
        for (const sx of [-1, 1]) {
          w(ell(0.1, 0.1, 0.06, sx * 0.25, 2.22, 0.02));
          w(limb(v(sx * 0.38, 1.5, 0.05), v(sx * 0.55, 1.0 + r() * 0.6, 0.35), 0.15, 0.12));
          w(limb(v(sx * 0.22, 0.4, 0), v(sx * 0.25, 0.0, 0.1), 0.18, 0.16));
          w(ell(0.04, 0.04, 0.03, sx * 0.12, 2.02, 0.32), DARK);
        }
      } else {
        w(ell(0.55, 0.55, 0.5, 0, 0.6, 0));
        w(ell(0.35, 0.38, 0.35, 0, 1.25, 0.15));
        w(ell(0.32, 0.3, 0.3, 0, 1.75, 0.25));
        w(ell(0.13, 0.11, 0.18, 0, 1.7, 0.55));
        w(ell(0.05, 0.04, 0.04, 0, 1.73, 0.72), DARK);
        for (const sx of [-1, 1]) {
          w(ell(0.09, 0.09, 0.06, sx * 0.22, 2.0, 0.2));
          w(limb(v(sx * 0.3, 1.2, 0.3), v(sx * 0.3, 0.15, 0.5), 0.12, 0.12));
          w(ell(0.18, 0.12, 0.3, sx * 0.35, 0.15, 0.4));
        }
      }
      break;
    }
    case 'bird':
    case 'owl': {
      const owl = kind === 'owl';
      w(limb(v(0, 0, 0), v(0, owl ? 0.9 : 1.2, 0), 0.22, 0.18));
      const by = owl ? 1.45 : 1.8;
      w(ell(owl ? 0.34 : 0.3, owl ? 0.5 : 0.55, 0.3, 0, by, 0));
      w(ell(owl ? 0.3 : 0.2, owl ? 0.27 : 0.22, owl ? 0.26 : 0.24, 0, by + (owl ? 0.58 : 0.6), owl ? 0.02 : 0.1), owl ? WOOD : WHITE);
      w(new THREE.ConeGeometry(0.06, owl ? 0.1 : 0.22, 5).rotateX(Math.PI / 2).translate(0, by + 0.56, owl ? 0.28 : 0.38), BEAK);
      if (owl) {
        for (const sx of [-1, 1]) {
          w(ell(0.07, 0.07, 0.03, sx * 0.12, by + 0.65, 0.24), BEAK);
          w(ell(0.035, 0.035, 0.02, sx * 0.12, by + 0.65, 0.27), DARK);
          w(new THREE.ConeGeometry(0.06, 0.16, 4).translate(sx * 0.18, by + 0.9, 0));
        }
      }
      const span = owl ? 0.5 : 1.1 + r() * 0.6;
      const lift = owl ? -0.3 : 0.25 + r() * 0.5;
      for (const sx of [-1, 1]) {
        w(ell(span / 2, 0.08, 0.32, sx * (0.25 + span / 2), by + lift * 0.5, -0.05, new THREE.Euler(0, 0, sx * lift)));
        w(ell(span / 2.5, 0.05, 0.26, sx * (0.25 + span * 0.95), by + lift * 1.1, -0.1, new THREE.Euler(0, 0, sx * lift * 1.3)));
      }
      w(ell(0.18, 0.06, 0.35, 0, by - 0.5, -0.3, new THREE.Euler(0.6, 0, 0)));
      break;
    }
    case 'moose':
    case 'horse':
    case 'wolf':
    case 'cat':
    case 'beaver': {
      const size = kind === 'moose' ? 1.25 : kind === 'horse' ? 1.15 : kind === 'beaver' ? 0.45 : 0.6;
      const legH = kind === 'beaver' ? 0.1 : size * (kind === 'moose' ? 1.05 : 0.8);
      const body = size * 0.5;
      w(ell(body * 0.75, body * 0.6, body * 1.4, 0, legH + body * 0.5, 0));
      for (const [lx, lz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
        w(limb(v(lx * body * 0.45, legH + body * 0.3, lz * body * 0.9), v(lx * body * 0.4, 0, lz * body * 0.95), body * 0.18, body * 0.12));
      }
      const neckTop = v(0, legH + body * (kind === 'horse' ? 1.9 : 1.4), body * 1.6);
      w(limb(v(0, legH + body * 0.7, body * 1.1), neckTop, body * 0.35, body * 0.25));
      w(ell(body * 0.28, body * 0.3, body * (kind === 'moose' || kind === 'horse' ? 0.62 : 0.45), neckTop.x, neckTop.y, neckTop.z + body * 0.35,
        new THREE.Euler(kind === 'horse' ? 0.5 : 0.2, 0, 0)));
      for (const sx of [-1, 1]) {
        w(ell(0.035, 0.035, 0.02, sx * body * 0.2, neckTop.y + body * 0.08, neckTop.z + body * 0.5), DARK);
        if (kind === 'moose') {
          w(ell(body * 0.75, body * 0.08, body * 0.4, sx * body * 0.85, neckTop.y + body * 0.45, neckTop.z, new THREE.Euler(0, 0, sx * 0.4)));
        } else if (kind !== 'beaver') {
          w(new THREE.ConeGeometry(body * 0.1, body * 0.25, 4).translate(sx * body * 0.15, neckTop.y + body * 0.35, neckTop.z + body * 0.1));
        }
      }
      if (kind === 'beaver') w(ell(body * 0.45, body * 0.08, body * 0.7, 0, 0.08, -body * 1.8), DARK);
      else if (kind !== 'moose') w(limb(v(0, legH + body * 0.7, -body * 1.3), v(0, legH + body * (kind === 'cat' ? 1.4 : 0.2), -body * 2.2), body * 0.12, body * 0.05));
      break;
    }
    case 'fish': {
      w(limb(v(0, 0, 0), v(0, 0.8, 0), 0.2, 0.16));
      const arch = new THREE.Euler(0.5 + r() * 0.4, 0, 0);
      w(ell(0.28, 0.35, 0.95, 0, 1.3, 0, arch, 11));
      w(new THREE.ConeGeometry(0.35, 0.5, 4).scale(0.25, 1, 1).rotateX(-0.9).translate(0, 1.95, -0.75));
      w(new THREE.ConeGeometry(0.2, 0.4, 3).scale(0.2, 1, 1).translate(0, 1.72, 0.05));
      for (const sx of [-1, 1]) w(ell(0.05, 0.05, 0.03, sx * 0.22, 0.95, 0.72), DARK);
      break;
    }
    case 'human': {
      const h = 1.9 * s;
      for (const sx of [-1, 1]) {
        w(limb(v(sx * 0.14, h * 0.48, 0), v(sx * 0.16, 0.02, 0.03), 0.12, 0.09));
        w(ell(0.1, 0.06, 0.16, sx * 0.16, 0.05, 0.08), DARK);
        const up = r() < 0.3;
        w(limb(v(sx * 0.3, h * 0.78, 0), up ? v(sx * 0.45, h * 1.05, 0.1) : v(sx * 0.36, h * 0.46, 0.12), 0.08, 0.06));
      }
      w(ell(0.3, h * 0.2, 0.2, 0, h * 0.66, 0));
      w(ell(0.26, 0.14, 0.18, 0, h * 0.46, 0));
      w(ell(0.14, 0.17, 0.15, 0, h * 0.92, 0.02));
      if (r() < 0.6) {
        w(limb(v(0, h * 1.0, 0.02), v(0, h * 1.08, 0.02), 0.2, 0.15), DARK);
        w(limb(v(0, h * 1.08, 0.02), v(0, h * 1.18, 0.02), 0.12, 0.09), DARK);
      }
      for (const sx of [-1, 1]) w(ell(0.025, 0.02, 0.015, sx * 0.05, h * 0.94, 0.16), DARK);
      break;
    }
    case 'bench': {
      w(ell(1.1, 0.14, 0.3, 0, 0.5, 0, undefined, 12));
      w(ell(1.1, 0.35, 0.12, 0, 0.9, -0.25, undefined, 12));
      for (const sx of [-1, 1]) {
        w(limb(v(sx * 0.85, 0, 0), v(sx * 0.85, 0.48, 0), 0.16, 0.16));
        // Carved animal heads on the arms.
        w(ell(0.16, 0.16, 0.2, sx * 1.1, 0.8, 0.1));
        w(ell(0.07, 0.06, 0.1, sx * 1.1, 0.78, 0.3));
      }
      break;
    }
    case 'sign': {
      for (const sx of [-1, 1]) w(limb(v(sx * 1.1, 0, 0), v(sx * 1.1, 2.2, 0), 0.16, 0.14));
      w(new THREE.BoxGeometry(2.4, 0.9, 0.14).translate(0, 1.55, 0));
      w(ell(0.22, 0.22, 0.2, -1.1, 2.3, 0.05));
      w(ell(0.22, 0.22, 0.2, 1.1, 2.3, 0.05));
      void name;
      break;
    }
    case 'dragon': {
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        pts.push(v(Math.sin(t * 5.5) * 0.6, 0.3 + t * 1.8, Math.cos(t * 5.5) * 0.6));
      }
      for (let k = 0; k < 8; k++) w(limb(pts[k], pts[k + 1], 0.24 - k * 0.018, 0.22 - k * 0.018));
      const hd = pts[8];
      w(ell(0.2, 0.18, 0.4, hd.x, hd.y + 0.1, hd.z + 0.2));
      for (const sx of [-1, 1]) w(new THREE.ConeGeometry(0.06, 0.3, 4).translate(hd.x + sx * 0.1, hd.y + 0.35, hd.z));
      for (const sx of [-1, 1]) w(ell(0.7, 0.05, 0.35, sx * 0.8, 1.6, 0, new THREE.Euler(0, 0, sx * 0.5)));
      break;
    }
    default: {
      // Totem column with stacked faces.
      w(limb(v(0, 0, 0), v(0, 2.9, 0), 0.32, 0.26, 10));
      for (let k = 0; k < 3; k++) {
        const y = 0.6 + k * 0.85;
        for (const sx of [-1, 1]) w(ell(0.06, 0.05, 0.03, sx * 0.1, y + 0.1, 0.3), k % 2 ? WHITE : DARK);
        w(new THREE.ConeGeometry(0.07, 0.18, 4).rotateX(Math.PI / 2).translate(0, y - 0.05, 0.36));
        w(ell(0.2, 0.04, 0.05, 0, y - 0.22, 0.3), DARK);
      }
      for (const sx of [-1, 1]) w(ell(0.5, 0.06, 0.2, sx * 0.55, 2.7, 0, new THREE.Euler(0, 0, sx * 0.25)));
    }
  }
  return P;
}

/** Chainsaw facets: jitter vertices a little, drop the index so each triangle shades flat. */
function carve(g: G, r: () => number, amp: number): G {
  const ng = (g.index ? g.toNonIndexed() : g) as G;
  const pos = ng.getAttribute('position');
  // Quantised jitter keyed on the original position keeps shared corners together (no cracks).
  const cache = new Map<string, THREE.Vector3>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let o = cache.get(k);
    if (!o) {
      o = new THREE.Vector3((r() - 0.5) * amp, (r() - 0.5) * amp, (r() - 0.5) * amp);
      cache.set(k, o);
    }
    pos.setXYZ(i, pos.getX(i) + o.x, pos.getY(i) + o.y, pos.getZ(i) + o.z);
  }
  ng.deleteAttribute('uv');
  ng.deleteAttribute('normal');
  ng.computeVertexNormals();
  return ng;
}

function build(c: Carving): G {
  const r = rng(c.n * 97 + 13);
  const kind = kindOf(c.name, c.n);
  const parts = figure(kind, r, c.name);
  // Stain: cedar, pine, weathered grey, or painted accents per carving.
  // Linear-space stains: oiled cedar, fir, weathered grey, dark walnut.
  const stain = [new THREE.Color(0.32, 0.15, 0.06), new THREE.Color(0.42, 0.24, 0.1), new THREE.Color(0.24, 0.2, 0.17),
    new THREE.Color(0.2, 0.1, 0.05)][c.n % 4];
  const geos: G[] = [];
  // Sawn stump plinth.
  const stump = new THREE.CylinderGeometry(0.55, 0.62, 0.35, 12).translate(0, 0.175, 0);
  parts.unshift({ g: stump, c: new THREE.Color(0.22, 0.14, 0.08) });
  for (const p of parts) {
    const g = carve(p.g, r, 0.025);
    if (p !== parts[0]) g.translate(0, 0.35, 0);
    const col = p.c === WOOD ? stain : p.c;
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const vv = 0.9 + 0.2 * r();
      colors[i * 3] = col.r * vv;
      colors[i * 3 + 1] = col.g * vv;
      colors[i * 3 + 2] = col.b * vv;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(g);
  }
  const g = mergeGeometries(geos, false)!;
  const scale = kind === 'bench' || kind === 'sign' ? 1 : 0.95 + r() * 0.35;
  g.scale(scale, scale, scale);
  g.rotateY(r() * Math.PI * 2);
  g.translate(c.x, c.y, c.z);
  return g;
}

export class Carvings {
  readonly root = new THREE.Group();
  list: Carving[] = [];
  private readonly material: THREE.MeshStandardMaterial;

  constructor(private readonly url: string) {
    this.root.name = 'carvings';
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvCWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vCWPos;
          float cwh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
          float cwn(vec3 p) {
            vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(cwh(i), cwh(i + vec3(1,0,0)), f.x), mix(cwh(i + vec3(0,1,0)), cwh(i + vec3(1,1,0)), f.x), f.y),
                       mix(mix(cwh(i + vec3(0,0,1)), cwh(i + vec3(1,0,1)), f.x), mix(cwh(i + vec3(0,1,1)), cwh(i + vec3(1,1,1)), f.x), f.y), f.z);
          }`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Vertical grain and fine chainsaw scoring.
          float grain = cwn(vec3(vCWPos.x * 22.0, vCWPos.y * 1.5, vCWPos.z * 22.0));
          float score = abs(fract(dot(vCWPos, vec3(5.1, 7.3, 4.2))) - 0.5);
          diffuseColor.rgb *= 0.82 + 0.28 * grain;
          diffuseColor.rgb *= 0.92 + 0.08 * smoothstep(0.1, 0.4, score);`);
    };
    m.customProgramCacheKey = () => 'cw-carving';
    this.material = worldLit(m);
  }

  async init(): Promise<void> {
    const res = await fetch(this.url);
    if (!res.ok) return;
    const data = (await res.json()) as { carvings: Carving[] };
    this.list = data.carvings.filter((c) => Number.isFinite(c.y));
    // Merge per 250 m cell to keep draw calls low.
    const cells = new Map<string, G[]>();
    for (const c of this.list) {
      const k = `${Math.floor(c.x / 250)}_${Math.floor(c.z / 250)}`;
      const arr = cells.get(k) ?? [];
      arr.push(build(c));
      cells.set(k, arr);
    }
    for (const gs of cells.values()) {
      const g = mergeGeometries(gs, false)!;
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
  }

  /** The carving the camera is looking at (within 12 m, near the view centre), if any. */
  lookedAt(cam: THREE.Camera): Carving | null {
    const p = cam.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    let best: Carving | null = null;
    let bestScore = 0.93;
    for (const c of this.list) {
      const d = new THREE.Vector3(c.x - p.x, c.y + 1.2 - p.y, c.z - p.z);
      const L = d.length();
      if (L > 12) continue;
      const dot = d.divideScalar(L).dot(f);
      if (dot > bestScore) {
        bestScore = dot;
        best = c;
      }
    }
    return best;
  }
}
