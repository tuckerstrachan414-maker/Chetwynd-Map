import * as THREE from 'three';
import { StreamScan } from '../StreamScan';
import { worldLit } from '../../engine/WorldLight';
import { gunzip } from '../codec';
import { buildTrack, tieGeometry } from './RailBuilder';

/** Road surface type -> ground texture array layer (see assets-src/build_terrain_textures.mjs). */
const LAYER: Record<number, number> = { 0: 6, 1: 5, 2: 4, 3: 7, 12: 12 };

export const roadUniforms = {
  uWet: { value: 0 },
  uSnow: { value: 0 },
};

const roadVert = /* glsl */ `
attribute vec2 attr;
varying vec2 vAttr;
varying vec3 vRWPos;
`;

const roadFragPars = /* glsl */ `
uniform highp sampler2DArray uGroundA;
uniform highp sampler2DArray uGroundN;
uniform float uLayer;
uniform float uTileS;
uniform float uSurface;
uniform float uWet;
uniform float uSnow;
varying vec2 vAttr;
varying vec3 vRWPos;
float rh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rh(i), rh(i + vec2(1, 0)), u.x), mix(rh(i + vec2(0, 1)), rh(i + vec2(1, 1)), u.x), u.y); }
float rfbm(vec2 p) { return rn(p) * 0.5 + rn(p * 2.03) * 0.25 + rn(p * 4.1) * 0.125 + rn(p * 8.3) * 0.0625; }
// Distance to cell edges of a jittered grid: crack network.
float cracks(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = vec2(rh(i + g), rh(i + g + 17.3));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
`;

const roadFragMain = /* glsl */ `
  vec2 wuv = vRWPos.xz / uTileS;
  vec4 ga = texture(uGroundA, vec3(wuv, uLayer));
  vec4 gn = texture(uGroundN, vec3(wuv, uLayer));
  vec3 col = ga.rgb;
  float rough = gn.b;
  vec2 nxy = gn.xy * 2.0 - 1.0;
  float lat = vAttr.x;
  if (uSurface < 0.5) {
    // Asphalt ageing: large-scale tone, cracks, tar snakes, patches, wheel paths, edge crumble.
    float age = rfbm(vRWPos.xz * 0.02);
    col *= 0.78 + 0.35 * age;
    // Cracks and tar snakes are centimetres wide: past ~70 m they are under a pixel and would only
    // shimmer, so they fade out there and their noise (a Voronoi and three fbm) is not evaluated.
    float crackK = 1.0 - smoothstep(45.0, 70.0, length(vRWPos - cameraPosition));
    if (crackK > 0.0) {
      float cr = cracks(vRWPos.xz * 0.35 + rfbm(vRWPos.xz * 0.2) * 1.5);
      float crackLine = 1.0 - smoothstep(0.0, 0.035, cr);
      float crackMask = smoothstep(0.55, 0.75, rfbm(vRWPos.xz * 0.05 + 3.0));
      col *= 1.0 - 0.55 * crackLine * crackMask * crackK;
      // Tar sealant (shiny black) along some cracks.
      float tar = (1.0 - smoothstep(0.0, 0.09, cr)) * smoothstep(0.62, 0.8, rfbm(vRWPos.xz * 0.04 + 9.0)) * crackK;
      col = mix(col, vec3(0.015), tar * 0.9);
      rough = mix(rough, 0.35, tar);
    }
    // Rectangular patches.
    vec2 pc = floor(vRWPos.xz / 7.0);
    if (rh(pc) > 0.93) {
      vec2 f = fract(vRWPos.xz / 7.0);
      float inPatch = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
      col = mix(col, col * 0.7 + vec3(0.01), inPatch);
    }
    // Wheel paths: polished, slightly lighter bands.
    float wp = exp(-pow((lat - 0.3) / 0.08, 2.0)) + exp(-pow((lat - 0.72) / 0.08, 2.0));
    col *= 1.0 + 0.08 * wp;
    rough = mix(rough, rough * 0.8, wp);
    // Oil drips along the lane centre.
    col *= 1.0 - 0.12 * exp(-pow((lat - 0.51) / 0.05, 2.0)) * rn(vRWPos.xz * 0.9);
    // Crumbling edge to gravel shoulder.
    float edge = smoothstep(0.86, 1.0, lat + (rfbm(vRWPos.xz * 1.3) - 0.5) * 0.12);
    vec4 gv = texture(uGroundA, vec3(vRWPos.xz / 1.5, 5.0));
    col = mix(col, gv.rgb * 0.9, edge);
    rough = mix(rough, 0.9, edge);
  } else if (uSurface < 1.5) {
    // Gravel: slightly greener crown between the tyre tracks.
    col *= 0.85 + 0.25 * rfbm(vRWPos.xz * 0.08);
    float mid = exp(-pow(lat / 0.12, 2.0));
    col = mix(col, col * vec3(0.85, 0.95, 0.75), mid * 0.4);
  } else if (uSurface < 2.5) {
    // Dirt track: grass growing along the centre.
    float mid = exp(-pow(lat / 0.18, 2.0));
    vec4 grass = texture(uGroundA, vec3(vRWPos.xz / 2.5, 1.0));
    col = mix(col, grass.rgb, mid * 0.75 * smoothstep(0.35, 0.65, rfbm(vRWPos.xz * 0.3)));
  }
  // Wetness darkens and smooths.
  col *= mix(1.0, 0.55, uWet);
  rough = mix(rough, 0.08, uWet * 0.9);
  // Snow cover; plowed arterial asphalt keeps only edge snow.
  float snowK = uSnow * (uSurface < 0.5 ? smoothstep(0.55, 0.95, lat) * 0.9 + 0.2 : 0.9);
  col = mix(col, vec3(0.85, 0.87, 0.9), snowK);
  diffuseColor.rgb = col;
`;

interface RoadChunk {
  group: THREE.Group;
}

/** Triangle mesh flagged as a physics collider (bridge decks, parapets, piers). */
export interface ColliderMesh {
  pos: Float32Array;
  idx: Uint32Array;
}

const STRUCT = 20;
const TIMBER = 22;
const TIES = 23;
const STEEL = 24;
const RAILHEAD = 25;
const RAIL = 30;
const BALLAST = 12;

const structFrag = /* glsl */ `
  // Weathered cast concrete / timber: world-space noise, vertical rain staining, board joints.
  vec3 an = abs(vRNormal);
  vec2 q = an.y > 0.6 ? vRWPos.xz : (an.x > an.z ? vRWPos.zy : vRWPos.xy);
  float n1 = rfbm(q * 1.7);
  float n2 = rfbm(q * 9.0);
  if (uKind < 0.5) {
    diffuseColor.rgb *= 0.78 + 0.3 * n1 + 0.1 * n2;
    // Streaks running down vertical faces.
    float streak = rn(vec2(q.x * 3.0, 0.0)) * smoothstep(0.3, 0.9, rn(vec2(q.x * 0.7, q.y * 0.15)));
    diffuseColor.rgb *= 1.0 - 0.25 * streak * (1.0 - an.y);
    // Formwork panel lines.
    float pan = step(0.97, fract(q.y / 1.2)) + step(0.985, fract(q.x / 2.4));
    diffuseColor.rgb *= 1.0 - 0.12 * clamp(pan, 0.0, 1.0);
  } else {
    // Boards across the deck: joints along the length, grain and weathering.
    float board = fract(vAttr.y / 0.16);
    float gap = smoothstep(0.0, 0.06, board) * smoothstep(1.0, 0.94, board);
    float boardId = floor(vAttr.y / 0.16);
    float tone = rh(vec2(boardId, 3.1));
    float grain = rn(vec2(q.x * 0.6, q.y * 25.0)) * 0.5 + rn(q * 4.0) * 0.5;
    diffuseColor.rgb *= (0.7 + 0.35 * tone) * (0.85 + 0.25 * grain);
    diffuseColor.rgb *= mix(0.35, 1.0, an.y > 0.6 ? gap : 1.0);
  }
  float snowUp = uSnow * smoothstep(0.55, 0.85, vRNormal.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), snowUp);
`;

/** Streams per-chunk road surface and marking meshes. */
export class RoadManager {
  private scan: StreamScan | null = null;
  readonly root = new THREE.Group();
  private readonly chunks = new Map<string, RoadChunk>();
  private readonly loading = new Set<string>();
  private readonly missing = new Set<string>();
  private readonly surf = new Map<number, THREE.MeshStandardMaterial>();
  private readonly paint = new Map<number, THREE.MeshStandardMaterial>();
  private readonly struct = new Map<number, THREE.MeshStandardMaterial>();
  private readonly tieGeo = tieGeometry();
  radius = 900;
  /** Called with bridge collider meshes when a chunk loads, and with the key when it unloads. */
  onColliders?: (key: string, meshes: ColliderMesh[]) => void;
  onUnload?: (key: string) => void;

  constructor(
    private readonly baseUrl: string,
    private readonly groundA: THREE.Texture,
    private readonly groundN: THREE.Texture,
    private readonly tiles: number[],
    private readonly half: number,
    private readonly size: number,
    private readonly available: Set<string>,
  ) {
    this.root.name = 'roads';
    for (const s of [0, 1, 2, 3, 12]) this.surf.set(s, this.surfaceMaterial(s));
    this.paint.set(10, this.paintMaterial(new THREE.Color(0.8, 0.8, 0.76)));
    this.paint.set(11, this.paintMaterial(new THREE.Color(0.75, 0.52, 0.07)));
    this.struct.set(STRUCT, this.structureMaterial(0, new THREE.Color(0.5, 0.49, 0.46), 0.92));
    this.struct.set(TIMBER, this.structureMaterial(1, new THREE.Color(0.34, 0.26, 0.19), 0.85));
    this.struct.set(TIES, this.structureMaterial(1, new THREE.Color(0.2, 0.155, 0.12), 0.92));
    this.struct.set(STEEL, this.steelMaterial(false));
    this.struct.set(RAILHEAD, this.steelMaterial(true));
  }

  /** Rail steel: rusty web and flange; the running surface is polished bright by wheels. */
  private steelMaterial(head: boolean): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: head ? new THREE.Color(0.6, 0.6, 0.62) : new THREE.Color(0.3, 0.2, 0.14),
      metalness: head ? 1.0 : 0.55,
      roughness: head ? 0.22 : 0.7,
    });
    if (!head) {
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vRWPos;')
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\nvarying vec3 vRWPos;\n${roadFragPars.replace(/uniform[^;]*;\n/g, '').replace(/varying[^;]*;\n/g, '')}`)
          .replace('#include <map_fragment>', `
            float rust = rfbm(vRWPos.xz * 3.0 + vRWPos.y * 5.0);
            diffuseColor.rgb *= 0.7 + 0.6 * rust;
          `);
      };
      m.customProgramCacheKey = () => 'cw-steel';
    }
    return worldLit(m);
  }

  private structureMaterial(kind: number, color: THREE.Color, roughness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, roadUniforms, { uKind: { value: kind } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${roadVert}\nvarying vec3 vRNormal;`)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vAttr = attr;
          vec4 rw = vec4(transformed, 1.0);
          vec3 rn = objectNormal;
          #ifdef USE_INSTANCING
            rw = instanceMatrix * rw;
            rn = mat3(instanceMatrix) * rn;
          #endif
          vRWPos = (modelMatrix * rw).xyz;
          vRNormal = normalize(mat3(modelMatrix) * rn);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${roadFragPars}\nuniform float uKind;\nvarying vec3 vRNormal;`)
        .replace('#include <map_fragment>', structFrag);
    };
    m.customProgramCacheKey = () => `cw-struct-${kind}`;
    return worldLit(m);
  }

  private surfaceMaterial(s: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
    const layer = LAYER[s];
    const uniforms = {
      uGroundA: { value: this.groundA },
      uGroundN: { value: this.groundN },
      uLayer: { value: layer },
      uTileS: { value: this.tiles[layer] },
      uSurface: { value: s },
      ...roadUniforms,
    };
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${roadVert}`)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvAttr = attr;\nvRWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${roadFragPars}`)
        .replace('#include <map_fragment>', roadFragMain)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rough;')
        .replace('#include <normal_fragment_maps>', `
          {
            vec3 nw = normalize(vec3(nxy.x, 1.0, -nxy.y));
            normal = normalize((viewMatrix * vec4(normalize(mix(vec3(0.0, 1.0, 0.0), nw, 0.7)), 0.0)).xyz);
          }
        `);
    };
    m.customProgramCacheKey = () => `cw-road-${s}`;
    m.userData.wlNoWet = true; // the road shader darkens and glosses itself
    return worldLit(m);
  }

  private paintMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, roadUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${roadVert}`)
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvAttr = attr;\nvRWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec2 vAttr;
          varying vec3 vRWPos;
          uniform float uSnow;
          uniform float uWet;
          float ph(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float pn(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(ph(i), ph(i + vec2(1, 0)), u.x), mix(ph(i + vec2(0, 1)), ph(i + vec2(1, 1)), u.x), u.y); }
        `)
        .replace('#include <map_fragment>', `
          // Worn paint: gaps where tyres cross, fading with age.
          float wear = pn(vRWPos.xz * 3.0) * 0.6 + pn(vRWPos.xz * 11.0) * 0.4;
          if (wear < 0.28 || uSnow > 0.5) discard;
          diffuseColor.rgb *= 0.8 + 0.25 * wear;
          diffuseColor.rgb *= mix(1.0, 0.6, uWet);
        `);
    };
    m.customProgramCacheKey = () => `cw-paint-${color.getHexString()}`;
    m.userData.wlNoWet = true;
    return worldLit(m);
  }

  get busy(): boolean {
    return this.loading.size > 0;
  }

  private async load(key: string): Promise<void> {
    const res = await fetch(new URL(`${this.baseUrl}/${key}.bin`, location.href).href);
    if (!res.ok) throw new Error(String(res.status));
    const raw = await gunzip(await res.arrayBuffer());
    if (raw.length < 8 || String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== 'CWR1') return;
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const dv = new DataView(buf);
    const n = dv.getUint32(4, true);
    let o = 8;
    const group = new THREE.Group();
    const colliders: ColliderMesh[] = [];
    for (let g = 0; g < n; g++) {
      const type = dv.getUint8(o);
      const flags = dv.getUint8(o + 1);
      const nv = dv.getUint32(o + 4, true);
      if (type === RAIL) {
        // Track stations: build ballast, ties and rails here instead of shipping the geometry.
        const ni = dv.getUint32(o + 8, true);
        o += 12;
        const pos = new Float32Array(buf, o, nv * 3);
        o += nv * 12;
        const attr = new Float32Array(buf, o, nv * 2);
        o += nv * 8;
        const fl = new Uint32Array(buf, o, ni);
        o += ni * 4;
        const tr = buildTrack({ pos, attr, flags: fl });
        if (tr.ballast) {
          const bm = new THREE.Mesh(tr.ballast, this.surf.get(BALLAST)!);
          bm.receiveShadow = true;
          bm.renderOrder = 1;
          group.add(bm);
        }
        for (const [geo, type2] of [[tr.steel, STEEL], [tr.head, RAILHEAD]] as const) {
          const rm = new THREE.Mesh(geo, this.struct.get(type2)!);
          rm.castShadow = true;
          rm.receiveShadow = true;
          group.add(rm);
        }
        if (tr.ties.length) {
          const tm = new THREE.InstancedMesh(this.tieGeo, this.struct.get(TIES)!, tr.ties.length);
          tr.ties.forEach((mm, i) => tm.setMatrixAt(i, mm));
          tm.computeBoundingSphere();
          tm.castShadow = true;
          tm.receiveShadow = true;
          group.add(tm);
        }
        if (flags & 1) colliders.push(tr.collider);
        continue;
      }
      const ni = dv.getUint32(o + 8, true);
      o += 12;
      const pos = new Float32Array(buf, o, nv * 3);
      o += nv * 12;
      const attr = new Float32Array(buf, o, nv * 2);
      o += nv * 8;
      const idx = new Uint32Array(buf, o, ni);
      o += ni * 4;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('attr', new THREE.BufferAttribute(attr, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const mat = type >= STRUCT ? this.struct.get(type)! : type >= 10 ? this.paint.get(type)! : this.surf.get(type)!;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      if (flags & 1) {
        mesh.castShadow = true;
        colliders.push({ pos, idx });
      }
      mesh.renderOrder = type >= 10 ? 2 : 1;
      group.add(mesh);
    }
    group.name = `roads_${key}`;
    this.root.add(group);
    this.chunks.set(key, { group });
    if (colliders.length) this.onColliders?.(key, colliders);
  }

  update(cam: THREE.Vector3): boolean {
    this.scan ??= new StreamScan(this.size, this.half);
    const scan = this.scan;
    if (!scan.due(cam)) return scan.complete;
    let pending = 0;
    for (const key of this.available) {
      if (this.chunks.has(key) || this.missing.has(key)) continue;
      if (scan.distance(key, cam) > this.radius) continue;
      pending++;
      if (this.loading.has(key) || this.loading.size >= 6) continue;
      this.loading.add(key);
      this.load(key)
        .catch(() => this.missing.add(key))
        .finally(() => {
          this.loading.delete(key);
          scan.dirty = true;
        });
    }
    for (const [key, c] of this.chunks) {
      if (scan.distance(key, cam) > this.radius + 300) {
        this.root.remove(c.group);
        c.group.traverse((o) => {
          const g = (o as THREE.Mesh).geometry;
          if (g && g !== this.tieGeo) g.dispose();
          if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        });
        this.chunks.delete(key);
        this.onUnload?.(key);
      }
    }
    scan.complete = pending === 0 && this.loading.size === 0;
    return scan.complete;
  }
}
