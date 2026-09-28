import * as THREE from 'three';
import { StreamScan } from '../StreamScan';
import { gunzip } from '../codec';
import { createWaterMaterial, createWaterUniforms } from './WaterMaterial';
import { createWaterTexture } from './waterTexture';

/** Render layer for water: drawn in a second pass after the opaque scene has been copied. */
export const WATER_LAYER = 1;

interface WaterIndex {
  size: number;
  half: number;
  chunks: string[];
  far: string;
}

interface Chunk {
  group: THREE.Group;
  seasonal: THREE.Mesh[];
}

/** Water under a point: surface height, current speed (m/s), kind, and whether it is frozen over. */
export interface WaterSample {
  level: number;
  speed: number;
  kind: number;
  frozen: boolean;
}

const _ray = new THREE.Raycaster();
const _down = new THREE.Vector3(0, -1, 0);
const _o = new THREE.Vector3();

/**
 * Streams the per-chunk water meshes (rivers, ponds, creeks) around the camera and keeps one coarse
 * mesh of the whole valley for distant views.
 */
export class WaterManager {
  private scan: StreamScan | null = null;
  readonly root = new THREE.Group();
  readonly uniforms = createWaterUniforms();
  private readonly material: THREE.ShaderMaterial;
  private readonly farMaterial: THREE.ShaderMaterial;
  private readonly chunks = new Map<string, Chunk>();
  private readonly loading = new Set<string>();
  private readonly missing = new Set<string>();
  private available = new Set<string>();
  private size = 256;
  private half = 65536;
  radius = 2900;
  private spring = false;
  private winter = false;
  stats = { chunks: 0, verts: 0 };

  constructor(private readonly baseUrl: string) {
    this.uniforms.tWater.value = createWaterTexture();
    this.uniforms.uSwitch.value = this.radius - 420;
    this.material = createWaterMaterial(this.uniforms, false);
    this.farMaterial = createWaterMaterial(this.uniforms, true);
    this.root.name = 'water';
  }

  async init(): Promise<void> {
    const idx = (await fetch(`${this.baseUrl}/index.json`).then((r) => r.json())) as WaterIndex;
    this.size = idx.size;
    this.half = idx.half;
    this.available = new Set(idx.chunks);
    const far = await this.fetchMeshes(idx.far, this.farMaterial);
    if (far) {
      far.group.name = 'water_far';
      for (const m of far.group.children) m.renderOrder = 0;
      this.root.add(far.group);
    }
  }

  get visible(): boolean {
    return this.root.children.length > 0;
  }

  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();

  /** Any water surface inside the camera's view: otherwise the frame skips the water pass and its copies. */
  inView(camera: THREE.PerspectiveCamera): boolean {
    if (!this.visible) return false;
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    let hit = false;
    this.root.traverseVisible((o) => {
      if (!hit && (o as THREE.Mesh).isMesh && this.frustum.intersectsObject(o)) hit = true;
    });
    return hit;
  }

  setSeason(season: number): void {
    // 0 summer, 1 autumn, 2 winter, 3 spring. Seasonal creeks run with snowmelt in spring.
    this.spring = season === 3;
    this.winter = season === 2;
    for (const c of this.chunks.values()) for (const m of c.seasonal) m.visible = this.spring;
    this.uniforms.uIce.value = season === 2 ? 1 : 0;
    this.uniforms.uTurbid.value = season === 3 ? 1 : 0;
  }

  private async fetchMeshes(file: string, mat: THREE.Material): Promise<Chunk | null> {
    const res = await fetch(new URL(`${this.baseUrl}/${file}`, location.href).href);
    if (!res.ok) throw new Error(String(res.status));
    const raw = await gunzip(await res.arrayBuffer());
    if (raw.length < 8 || String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== 'CWW1') return null;
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const dv = new DataView(buf);
    const n = dv.getUint32(4, true);
    let o = 8;
    const group = new THREE.Group();
    const seasonal: THREE.Mesh[] = [];
    for (let g = 0; g < n; g++) {
      const flags = dv.getUint8(o);
      const nv = dv.getUint32(o + 4, true);
      const ni = dv.getUint32(o + 8, true);
      o += 12;
      const pos = new Float32Array(buf, o, nv * 3);
      o += nv * 12;
      const flow = new Int16Array(buf, o, nv * 2);
      o += nv * 4;
      const tint = new Uint8Array(buf, o, nv * 4);
      o += nv * 4;
      const meta = new Uint8Array(buf, o, nv * 4);
      o += nv * 4;
      const idx = new Uint32Array(buf, o, ni);
      o += ni * 4;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('flow', new THREE.BufferAttribute(flow, 2));
      geo.setAttribute('tint', new THREE.BufferAttribute(tint, 4, true));
      geo.setAttribute('meta', new THREE.BufferAttribute(meta, 4));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.layers.set(WATER_LAYER);
      mesh.renderOrder = 1;
      if (flags & 1) {
        mesh.visible = this.spring;
        seasonal.push(mesh);
      }
      this.stats.verts += nv;
      group.add(mesh);
    }
    return { group, seasonal };
  }

  private async load(key: string): Promise<void> {
    const c = await this.fetchMeshes(`${key}.bin`, this.material);
    if (!c) return;
    c.group.name = `water_${key}`;
    this.root.add(c.group);
    this.chunks.set(key, c);
  }

  /** Water surface under (x, z) from the loaded chunk meshes, or null on dry land. */
  sample(x: number, z: number): WaterSample | null {
    const i = Math.floor((x + this.half) / this.size);
    const j = Math.floor((z + this.half) / this.size);
    const c = this.chunks.get(`${i}_${j}`);
    if (!c) return null;
    _o.set(x, 5000, z);
    _ray.set(_o, _down);
    _ray.layers.set(WATER_LAYER);
    const hits = _ray.intersectObjects(c.group.children.filter((m) => m.visible), false);
    if (!hits.length || !hits[0].face) return null;
    const h = hits[0];
    const mesh = h.object as THREE.Mesh;
    const flow = mesh.geometry.getAttribute('flow');
    const meta = mesh.geometry.getAttribute('meta');
    const f = h.face!;
    const b = h.barycoord ?? new THREE.Vector3(1 / 3, 1 / 3, 1 / 3);
    const fx = (flow.getX(f.a) * b.x + flow.getX(f.b) * b.y + flow.getX(f.c) * b.z) * 0.001;
    const fz = (flow.getY(f.a) * b.x + flow.getY(f.b) * b.y + flow.getY(f.c) * b.z) * 0.001;
    const speed = Math.hypot(fx, fz);
    const kind = meta.getX(f.a);
    // Mirrors the shader: still water freezes; the river keeps open water in its fast current.
    const frozen = this.winter && (kind !== 0 || speed < 0.75);
    return { level: h.point.y, speed, kind, frozen };
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
        c.group.traverse((m) => {
          const mesh = m as THREE.Mesh;
          if (mesh.isMesh) {
            this.stats.verts -= mesh.geometry.getAttribute('position').count;
            mesh.geometry.dispose();
          }
        });
        this.chunks.delete(key);
      }
    }
    this.stats.chunks = this.chunks.size;
    scan.complete = pending === 0 && this.loading.size === 0;
    return scan.complete;
  }
}
