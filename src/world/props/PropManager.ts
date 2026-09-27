import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';
import type { Pickable } from '../../ui/Editor';
import { refOf, type EditKind, type Overrides } from '../Overrides';
import {
  benchModel, binModel, hydrantModel, lampModel, playgroundModel, poleModel, POLE_ATTACH, signalModel, stopModel,
  streetNameModel, TOWER_ATTACH, towerModel, type MatKey, type Part,
} from './PropModels';

/** props.json record: [x, y, z, rotY, src, extra?] (see pipeline/props.py). */
type Rec = [number, number, number, number, string, unknown?];

interface PropsJson {
  lamp: Rec[];
  pole: Rec[];
  tower: Rec[];
  hydrant: Rec[];
  stop: Rec[];
  streetname: Rec[];
  signal: Rec[];
  bench: Rec[];
  bin: Rec[];
  playground: Rec[];
  wires: number[][];
  hv: number[][];
}

export const propUniforms = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uSnow: { value: 0 },
};

interface Kind {
  recs: Rec[];
  meshes: THREE.InstancedMesh[];
  radius: number;
  onFill?: (mesh: THREE.InstancedMesh, recIdx: number[]) => void;
}

function stopTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#b8141c';
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = ((k + 0.5) / 8) * Math.PI * 2;
    const x = 128 + Math.cos(a) * 118;
    const y = 128 + Math.sin(a) * 118;
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 74px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // CanvasTexture uploads with flipY, so canvas-up is texture-up: draw the word upright.
  g.fillText('STOP', 128, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** One row per street name: white reflective lettering on a green blade. */
function nameAtlas(names: string[]): { tex: THREE.CanvasTexture; rows: number } {
  const rows = Math.max(1, names.length);
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64 * THREE.MathUtils.ceilPowerOfTwo(rows);
  const g = c.getContext('2d')!;
  names.forEach((n, i) => {
    const y = i * 64;
    g.fillStyle = '#0f6b3a';
    g.fillRect(0, y, 512, 64);
    g.strokeStyle = '#e8f0ea';
    g.lineWidth = 4;
    g.strokeRect(4, y + 4, 504, 56);
    g.fillStyle = '#f4f7f4';
    let size = 36;
    g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    const label = n.replace(/\bStreet\b/, 'St').replace(/\bAvenue\b/, 'Ave').replace(/\bRoad\b/, 'Rd').replace(/\bPlace\b/, 'Pl')
      .replace(/\bCrescent\b/, 'Cr').replace(/\bNortheast\b/, 'NE').replace(/\bNorthwest\b/, 'NW').replace(/\bSoutheast\b/, 'SE')
      .replace(/\bSouthwest\b/, 'SW');
    while (g.measureText(label).width > 480 && size > 18) {
      size -= 2;
      g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 256, y + 34);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = true;
  t.anisotropy = 4;
  return { tex: t, rows: c.height / 64 };
}

/**
 * Street furniture and utilities from props.json: instanced per model part, re-filled with the
 * props near the camera, plus sagging conductors between poles and towers.
 */
export class PropManager {
  readonly root = new THREE.Group();
  private readonly kinds = new Map<string, Kind>();
  private readonly mats = new Map<MatKey, THREE.Material>();
  private lastPos = new THREE.Vector3(1e9, 0, 1e9);
  private data!: PropsJson;
  private overrides: Overrides | null = null;
  private readonly userIds = new WeakMap<Rec, string>();
  /** Editor overrides of original records by ref: the moved record, or null when deleted. */
  private moved = new Map<string, Rec | null>();
  private wires!: THREE.Mesh;
  stats = { drawn: 0 };

  constructor(private readonly baseUrl: string) {
    this.root.name = 'props';
  }

  private material(k: MatKey): THREE.Material {
    const hit = this.mats.get(k);
    if (hit) return hit;
    const std = (color: number, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
    let m: THREE.Material;
    switch (k) {
      case 'galv': m = std(0x9a9ea2, 0.45, 0.85); break;
      case 'wood': m = std(0x5d4a38, 0.95); break;
      case 'darkMetal': m = std(0x2b2d2f, 0.55, 0.6); break;
      case 'red': m = std(0xa0151b, 0.5); break;
      case 'yellow': m = std(0xd9a414, 0.5); break;
      case 'green': m = std(0x1f4d2f, 0.6); break;
      case 'white': m = std(0xe0e0dc, 0.5); break;
      case 'black': m = std(0x151617, 0.6); break;
      case 'plastic': m = std(0x2d6fb2, 0.4); break;
      case 'ceramic': m = std(0x6f5a4a, 0.25); break;
      case 'rope': m = std(0x2a2a2a, 0.9); break;
      case 'concrete': m = std(0x8b8883, 0.95); break;
      case 'benchWood': m = std(0x7a5634, 0.8); break;
      case 'stopFace': {
        const s = new THREE.MeshStandardMaterial({ map: stopTexture(), roughness: 0.35 });
        m = s;
        break;
      }
      case 'nameBlade': m = new THREE.MeshStandardMaterial({ roughness: 0.35 }); break;
      case 'lens':
      case 'lensAmber':
      case 'lensRed':
      case 'lensGreen': {
        const col = k === 'lens' ? new THREE.Color(1.0, 0.78, 0.5) : k === 'lensAmber' ? new THREE.Color(1, 0.55, 0.05)
          : k === 'lensRed' ? new THREE.Color(1, 0.08, 0.05) : new THREE.Color(0.1, 1, 0.45);
        const mm = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.2, emissive: col, emissiveIntensity: 0 });
        const signal = k !== 'lens';
        const phase = k === 'lensRed' ? 0 : k === 'lensGreen' ? 1 : 2;
        mm.onBeforeCompile = (shader) => {
          Object.assign(shader.uniforms, propUniforms);
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uTime;')
            .replace('#include <emissivemap_fragment>', signal ? `
              // Signal cycle: green 20 s, amber 4 s, red 24 s.
              float cyc = mod(uTime, 48.0);
              float on = ${phase === 0 ? 'step(24.0, cyc)' : phase === 1 ? '1.0 - step(20.0, cyc)' : 'step(20.0, cyc) * (1.0 - step(24.0, cyc))'};
              totalEmissiveRadiance *= on * 40.0;
            ` : `
              // Street lights come on at dusk (photocells) and glow warm high-pressure sodium / LED.
              totalEmissiveRadiance *= smoothstep(0.25, 0.6, uNight) * 60.0;
            `);
        };
        mm.emissiveIntensity = 1;
        mm.customProgramCacheKey = () => `cw-lens-${k}`;
        m = mm;
        break;
      }
      default: m = std(0x888888, 0.6);
    }
    worldLit(m);
    this.mats.set(k, m);
    return m;
  }

  async init(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/props.json`);
    if (!res.ok) return;
    this.data = (await res.json()) as PropsJson;
    this.setupStreetNames(this.data.streetname ?? []);
    this.build();
  }

  /** Use the editor's overrides: rebuilds the editable kinds and the wires. */
  applyOverrides(ov: Overrides): void {
    this.overrides = ov;
    if (this.data) this.build();
  }

  /** Records of a kind after the editor's deletes, moves and additions. */
  private recsOf(kind: EditKind, recs: Rec[]): Rec[] {
    if (!this.overrides) return recs;
    const { removed, added } = this.overrides.forKind(kind);
    const out: Rec[] = [];
    for (const r of recs) {
      const ref = refOf(kind, r[0], r[2]);
      if (removed.has(ref)) this.moved.set(ref, null);
      else out.push(r);
    }
    for (const a of added) {
      if (a.x === undefined || a.z === undefined) continue;
      const rec: Rec = [a.x, a.y ?? 0, a.z, a.rot ?? 0, 'user', a.variant];
      this.userIds.set(rec, a.id ?? '');
      if (a.ref) this.moved.set(a.ref, rec);
      out.push(rec);
    }
    return out;
  }

  private build(): void {
    // Drop the previous build (street-name posts are not editable and stay).
    for (const [key, kind] of this.kinds) {
      if (key.startsWith('streetname')) continue;
      for (const m of kind.meshes) {
        this.root.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
      this.kinds.delete(key);
    }
    if (this.wires) {
      this.root.remove(this.wires);
      this.wires.geometry.dispose();
    }
    this.moved.clear();
    const d = this.data;
    const add = (name: EditKind, recs: Rec[], models: (v: number) => Part[], variants: number[], radius: number) => {
      const all = this.recsOf(name, recs);
      for (const v of variants) {
        const sel = all.filter((r) => (variants.length > 1 ? Number(r[5] ?? 0) === v : true));
        this.kinds.set(`${name}:${v}`, { recs: sel, meshes: this.instanced(models(v), sel.length + 64), radius });
      }
    };
    add('lamp', d.lamp ?? [], lampModel, [0, 1], 700);
    // Poles: about one in five carries a transformer can (chosen by position, stable under edits).
    const poles = this.recsOf('pole', d.pole ?? []);
    const can = (r: Rec) => Math.abs(Math.floor(r[0] * 7.31 + r[2] * 3.17)) % 5 === 0;
    this.kinds.set('pole:0', { recs: poles.filter((r) => !can(r)), meshes: this.instanced(poleModel(1), poles.length + 64), radius: 900 });
    this.kinds.set('pole:1', { recs: poles.filter(can), meshes: this.instanced(poleModel(0), poles.length + 64), radius: 900 });
    add('tower', d.tower ?? [], towerModel, [0], 4000);
    add('hydrant', d.hydrant ?? [], hydrantModel, [0], 250);
    add('stop', d.stop ?? [], stopModel, [0], 300);
    add('signal', d.signal ?? [], signalModel, [0], 800);
    add('bench', d.bench ?? [], benchModel, [0], 250);
    add('bin', d.bin ?? [], binModel, [0], 200);
    add('playground', d.playground ?? [], playgroundModel, [0], 500);
    this.buildWires();
    this.lastPos.set(1e9, 0, 1e9);
  }

  /** Editable street furniture near (x, z) for the editor. */
  pickables(x: number, z: number, radius: number): Pickable[] {
    const size: Partial<Record<EditKind, [number, number]>> = {
      lamp: [9, 0.7], pole: [11, 0.7], hydrant: [0.9, 0.6], stop: [2.6, 0.6], bench: [1, 1.1], bin: [1, 0.6],
    };
    const out: Pickable[] = [];
    const r2 = radius * radius;
    for (const [key, kind] of this.kinds) {
      const name = key.split(':')[0] as EditKind;
      const sz = size[name];
      if (!sz) continue;
      for (const r of kind.recs) {
        const dx = r[0] - x, dz = r[2] - z;
        if (dx * dx + dz * dz > r2) continue;
        const id = this.userIds.get(r);
        out.push({
          kind: name, ref: id ? `#${id}` : refOf(name, r[0], r[2]), x: r[0], y: r[1], z: r[2], rot: r[3], h: sz[0], r: sz[1],
          src: r[4] === 'user' ? 'user' : r[4] === 'osm' ? 'mapped' : 'inferred',
          variant: name === 'lamp' ? Number(r[5] ?? 0) : undefined,
        });
      }
    }
    return out;
  }

  /**
   * Street-light heads for the night light field: [x, z, headHeight, intensity, r, g, b, headElevation].
   * The head sits at the end of the arm (see lampModel), rotated with the record's heading.
   */
  lampLights(): number[][] {
    const lamps = [...(this.kinds.get('lamp:0')?.recs ?? []), ...(this.kinds.get('lamp:1')?.recs ?? [])];
    return lamps.map((r) => {
      const arterial = Number(r[5] ?? 0) === 1;
      const h = arterial ? 10 : 8.5;
      const reach = (arterial ? 3.2 : 1.8) + 0.3;
      // Irradiance straight below the head ~0.2: about twenty times (boosted) full moonlight, the
      // ratio a lit street has to moonlit ground.
      const I = 0.2 * h * h * (arterial ? 1.25 : 1);
      const col = arterial ? [1, 0.72, 0.45] : [1, 0.8, 0.6];
      return [r[0] + Math.sin(r[3]) * reach, r[2] + Math.cos(r[3]) * reach, h, I, ...col, r[1] + h + 0.05];
    });
  }

  private instanced(parts: Part[], cap: number): THREE.InstancedMesh[] {
    return parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geo, this.material(p.mat), Math.max(1, cap));
      m.count = 0;
      m.castShadow = !p.mat.startsWith('lens');
      m.receiveShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.root.add(m);
      return m;
    });
  }

  private setupStreetNames(recs: Rec[]): void {
    const names: string[] = [];
    const idx = new Map<string, number>();
    for (const r of recs) {
      for (const n of (r[5] as string[]) ?? []) {
        if (!idx.has(n)) {
          idx.set(n, names.length);
          names.push(n);
        }
      }
    }
    const { tex, rows } = nameAtlas(names);
    const model = streetNameModel();
    const kind: Kind = { recs, meshes: this.instanced(model.post, recs.length), radius: 250 };
    for (const [key, geo] of [['a', model.bladeA], ['b', model.bladeB]] as const) {
      const row = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, recs.length)), 1);
      row.setUsage(THREE.DynamicDrawUsage);
      const g = geo.clone();
      g.setAttribute('aRow', row);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 });
      mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aRow;')
          .replace('#include <uv_vertex>', `#include <uv_vertex>
            // Each blade shows its own row of the name atlas (same text on both faces).
            vMapUv = vec2(uv.x, 1.0 - (aRow + 1.0 - uv.y) / ${rows.toFixed(1)});`);
      };
      mat.customProgramCacheKey = () => 'cw-streetname';
      worldLit(mat);
      const m = new THREE.InstancedMesh(g, mat, Math.max(1, recs.length));
      m.count = 0;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      this.root.add(m);
      kind.meshes.push(m);
      const which = key === 'a' ? 0 : 1;
      const prev = kind.onFill;
      kind.onFill = (mesh, recIdx) => {
        prev?.(mesh, recIdx);
        if (mesh !== m) return;
        const attr = (mesh.geometry as THREE.BufferGeometry).getAttribute('aRow') as THREE.InstancedBufferAttribute;
        recIdx.forEach((ri, i) => {
          const nm = (recs[ri][5] as string[])[which] ?? (recs[ri][5] as string[])[0];
          attr.setX(i, idx.get(nm) ?? 0);
        });
        attr.needsUpdate = true;
      };
    }
    this.kinds.set('streetname:0', kind);
  }

  /** Conductors hang in catenaries between consecutive poles/towers of each mapped or inferred line. */
  private buildWires(): void {
    const pos: number[] = [];
    const idx: number[] = [];
    const tmp = new THREE.Vector3();
    const addSpan = (a: THREE.Vector3, b: THREE.Vector3, sag: number, r: number) => {
      const segs = 14;
      const sides = 3;
      const base = pos.length / 3;
      const dir = new THREE.Vector3().subVectors(b, a);
      const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        p.y -= sag * 4 * t * (1 - t);
        for (let k = 0; k < sides; k++) {
          const ang = (k / sides) * Math.PI * 2;
          tmp.copy(side).multiplyScalar(Math.cos(ang) * r);
          tmp.y += Math.sin(ang) * r;
          pos.push(p.x + tmp.x, p.y + tmp.y, p.z + tmp.z);
        }
      }
      for (let s = 0; s < segs; s++) {
        for (let k = 0; k < sides; k++) {
          const a0 = base + s * sides + k;
          const a1 = base + s * sides + ((k + 1) % sides);
          idx.push(a0, a0 + sides, a1, a1, a0 + sides, a1 + sides);
        }
      }
    };
    const attach = (rec: Rec, local: [number, number, number]) => {
      const c = Math.cos(rec[3]);
      const s = Math.sin(rec[3]);
      // Crossarms run across the line (local x); rotate by the pole yaw.
      return new THREE.Vector3(rec[0] + local[0] * c + local[2] * s, rec[1] + local[1], rec[2] - local[0] * s + local[2] * c);
    };
    const lines = (chains: number[][], recs: Rec[], pts: [number, number, number][], sagPerM: number, r: number) => {
      for (const ch of chains) {
        for (let k = 0; k + 1 < ch.length; k++) {
          const A = recs[ch[k]];
          const B = recs[ch[k + 1]];
          if (!A || !B) continue;
          const span = Math.hypot(A[0] - B[0], A[2] - B[2]);
          if (span < 2 || span > 450) continue;
          for (const p of pts) addSpan(attach(A, p), attach(B, p), span * sagPerM, r);
        }
      }
    };
    const resolve = (kind: EditKind, recs: Rec[]) => recs.map((r) => {
      const m = this.moved.get(refOf(kind, r[0], r[2]));
      return m === undefined ? r : m;
    }) as Rec[];
    lines(this.data.wires ?? [], resolve('pole', this.data.pole ?? []), POLE_ATTACH, 0.018, 0.012);
    lines(this.data.hv ?? [], this.data.tower ?? [], TOWER_ATTACH, 0.02, 0.02);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = worldLit(new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5, metalness: 0.6 }));
    this.wires = new THREE.Mesh(g, mat);
    this.wires.castShadow = false;
    this.wires.receiveShadow = false;
    this.root.add(this.wires);
  }

  setSeason(season: number): void {
    propUniforms.uSnow.value = season === 2 ? 1 : 0;
  }

  update(cam: THREE.Vector3): void {
    if (!this.data) return;
    if (cam.distanceToSquared(this.lastPos) < 20 * 20) return;
    this.lastPos.copy(cam);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    let drawn = 0;
    for (const kind of this.kinds.values()) {
      const r2 = kind.radius * kind.radius;
      const near: number[] = [];
      kind.recs.forEach((r, i) => {
        const dx = r[0] - cam.x;
        const dz = r[2] - cam.z;
        if (dx * dx + dz * dz < r2) near.push(i);
      });
      for (const mesh of kind.meshes) {
        const n = Math.min(near.length, mesh.instanceMatrix.count);
        for (let i = 0; i < n; i++) {
          const r = kind.recs[near[i]];
          q.setFromAxisAngle(up, r[3]);
          m.compose(p.set(r[0], r[1] - 0.05, r[2]), q, one);
          mesh.setMatrixAt(i, m);
        }
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        kind.onFill?.(mesh, near.slice(0, n));
      }
      drawn += near.length;
    }
    this.stats.drawn = drawn;
  }
}
