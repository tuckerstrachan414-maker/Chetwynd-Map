import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';
import type { TerrainStore } from '../terrain/TerrainStore';
import { vegUniforms } from './TreeMaterials';

/**
 * GPU-instanced grass around the camera.
 *
 * Clumps are anchored to world cells (hashing the cell coordinates), so nothing swims as the camera
 * moves; an inner ring of small cells carries fine blades and an outer ring coarser clumps. What
 * grows where comes from the LiDAR ground classes via a camera-following "field" texture
 * (toroidally addressed, refreshed a strip at a time): ground height, grass density, grass type
 * and a variation value per 0.5 m cell.
 */

// Ground material IDs (pipeline/ground.py).
const LAWN = 0, MEADOW = 1, FOREST = 2, CONIFER = 3, DIRT = 4, CUTBANK = 9, MUD = 10, MOSS = 11, STUBBLE = 13;

/** Grass type written to the field: 0 none, 1 lawn, 2 meadow, 3 woodland, 4 wet sedge, 5 stubble. */
function grassOf(mat: number): [number, number] {
  switch (mat) {
    case LAWN: return [1.0, 1];
    case MEADOW: return [0.95, 2];
    case FOREST: return [0.4, 3];
    case CONIFER: return [0.12, 3];
    case DIRT: return [0.18, 2];
    case CUTBANK: return [0.12, 2];
    case MUD: return [0.45, 4];
    case MOSS: return [0.6, 2];
    case STUBBLE: return [0.8, 5];
    default: return [0, 0];
  }
}

const FIELD_N = 256;
const FIELD_RES = 0.5;
const FIELD_SIZE = FIELD_N * FIELD_RES;

export const grassUniforms = {
  uFieldH: { value: null as THREE.Texture | null },
  uFieldI: { value: null as THREE.Texture | null },
  uFieldSize: { value: FIELD_SIZE },
  uPlayer: { value: new THREE.Vector3(0, -1e4, 0) },
  uGrassSeason: { value: 0 },
  /** Quality density scale (1 = full). */
  uDensity: { value: 1 },
};

const grassVert = /* glsl */ `
uniform sampler2D uFieldH;
uniform sampler2D uFieldI;
uniform float uFieldSize;
uniform vec3 uPlayer;
uniform float uGrassSeason;
uniform float uDensity;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform vec3 uCamSnap;
uniform float uCell;
uniform vec2 uGridOrg;
uniform float uGridW;
uniform float uPerCell;
uniform float uInner;
uniform float uOuter;
uniform float uBladeScale;
attribute vec3 blade; // (height fraction 0..1, blade index, side -1..1)
varying float vT;
varying vec3 vGrassCol;
varying float vGrassAo;

vec2 gHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
`;

const grassBegin = /* glsl */ `
  float id = float(gl_InstanceID);
  float cellId = floor(id / uPerCell);
  float sub = id - cellId * uPerCell;
  // Only the cells under the camera's view are instanced (uGridOrg/uGridW, set per frame).
  vec2 c = vec2(mod(cellId, uGridW), floor(cellId / uGridW)) + uGridOrg;
  vec2 cellW = (floor(uCamSnap.xz / uCell) + c) * uCell;
  vec2 h1 = gHash2(cellW * 1.37 + sub * 17.17);
  vec2 h2 = gHash2(cellW * 0.73 + sub * 5.31 + 11.0);
  vec2 wp = cellW + h1 * uCell;
  vec2 fuv = fract(wp / uFieldSize);
  vec4 fi = texture2D(uFieldI, fuv);
  float gH = texture2D(uFieldH, fuv).r;
  // Distance in 3D, so the grass thins out as the camera climbs above it.
  float d = length(vec3(wp.x, gH, wp.y) - cameraPosition);
  float density = fi.r;
  float gtype = floor(fi.g * 255.0 + 0.5);
  float var = fi.b;
  // Density thins with distance inside each ring; the outer ring skips the inner disk.
  float ring = smoothstep(uOuter, uOuter * 0.7, d) * (uInner > 0.0 ? smoothstep(uInner * 0.85, uInner, d) : 1.0);
  bool keep = density * ring * uDensity > h2.x && gtype > 0.5;
  // Height and look per grass type: lawn, meadow, woodland, wet sedge, stubble.
  float ht = gtype < 1.5 ? 0.09 : gtype < 2.5 ? 0.55 : gtype < 3.5 ? 0.4 : gtype < 4.5 ? 0.7 : 0.18;
  ht *= (0.6 + 0.8 * h2.y) * (0.75 + 0.5 * var);
  if (uGrassSeason > 2.5) ht *= 0.6; // spring: new growth is short
  float bw = (gtype < 1.5 ? 0.008 : 0.013) * uBladeScale;
  // Each clump fans its blades out around a random heading.
  float ang = h1.x * 6.2831 + blade.y * 2.39996;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-dir.y, dir.x);
  float t = blade.x;
  float lean = (0.15 + 0.35 * fract(h2.y * 7.0 + blade.y * 0.37)) * t * t;
  vec3 local = vec3(0.0);
  float spread = (gtype < 1.5 ? 0.05 : 0.12) * uBladeScale;
  local.xz = dir * (spread * fract(blade.y * 0.618 + h1.y) + lean * ht) + perp * blade.z * bw * (1.0 - t * 0.85);
  local.y = t * ht;
  // Wind: gusting sway, stronger at the tip; the player parts the grass around their feet.
  float gust = 0.6 + 0.4 * sin(uTime * 0.9 + wp.x * 0.11 + wp.y * 0.07) * sin(uTime * 0.37 + wp.y * 0.05);
  float sway = sin(uTime * 2.1 + wp.x * 0.9 + wp.y * 0.7 + blade.y) * 0.5 + 0.5;
  local.xz += uWindDir * (t * t) * ht * uWind * (0.35 + 0.5 * sway) * gust;
  vec2 away = wp - uPlayer.xz;
  float pd = length(away);
  float push = (1.0 - smoothstep(0.2, 0.9, pd)) * step(abs(uPlayer.y - gH), 2.0);
  local.xz += (pd > 1e-3 ? away / pd : vec2(0.0)) * push * t * t * ht * 0.8;
  local.y *= 1.0 - 0.5 * push * t;
  vec3 transformed = vec3(wp.x, gH, wp.y) + local;
  if (!keep || ht < 0.02) transformed = vec3(0.0, -1e5, 0.0);
  vT = t;
  vGrassAo = mix(0.45, 1.0, t);
  vec3 baseC = gtype < 1.5 ? vec3(0.09, 0.19, 0.04) : gtype < 2.5 ? vec3(0.13, 0.2, 0.05) : gtype < 3.5 ? vec3(0.1, 0.17, 0.05) : gtype < 4.5 ? vec3(0.11, 0.17, 0.07) : vec3(0.35, 0.28, 0.14);
  // Autumn cures meadow grass to straw; lawns stay greener.
  if (uGrassSeason > 0.5 && uGrassSeason < 1.5) baseC = mix(baseC, vec3(0.38, 0.3, 0.13), gtype < 1.5 ? 0.35 : 0.8);
  if (uGrassSeason > 2.5) baseC = mix(baseC, vec3(0.16, 0.26, 0.05), 0.5);
  vGrassCol = baseC * (0.75 + 0.5 * var) * (0.85 + 0.3 * h2.y);
`;

function clumpGeometry(blades: number, segs: number): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const bl: number[] = [];
  const idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const base = pos.length / 3;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      for (const side of [-1, 1]) {
        pos.push(0, t, 0);
        bl.push(t, b, side);
      }
    }
    for (let s = 0; s < segs; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('blade', new THREE.Float32BufferAttribute(bl, 3));
  g.setIndex(idx);
  return g;
}

interface Ring {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  uniforms: Record<string, THREE.IUniform>;
  cell: number;
  gridN: number;
  /** Clumps per cell at full density, and as drawn for the quality setting. */
  perCell: number;
  perCellNow: number;
  outer: number;
}

export class Grass {
  readonly root = new THREE.Group();
  private readonly fieldH = new Float32Array(FIELD_N * FIELD_N);
  private readonly fieldI = new Uint8Array(FIELD_N * FIELD_N * 4);
  private readonly texH: THREE.DataTexture;
  private readonly texI: THREE.DataTexture;
  /** World cell index currently stored in each field row / column (toroidal addressing). */
  private readonly rowOf = new Int32Array(FIELD_N).fill(-1e9);
  private readonly colOf = new Int32Array(FIELD_N).fill(-1e9);
  private storeVersion = -1;
  private refreshRow = 0;
  private readonly rings: Ring[] = [];
  enabled = true;

  constructor(private readonly store: TerrainStore) {
    this.texH = new THREE.DataTexture(this.fieldH, FIELD_N, FIELD_N, THREE.RedFormat, THREE.FloatType);
    this.texH.minFilter = this.texH.magFilter = THREE.NearestFilter;
    this.texH.wrapS = this.texH.wrapT = THREE.RepeatWrapping;
    this.texI = new THREE.DataTexture(this.fieldI, FIELD_N, FIELD_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texI.minFilter = this.texI.magFilter = THREE.NearestFilter;
    this.texI.wrapS = this.texI.wrapT = THREE.RepeatWrapping;
    grassUniforms.uFieldH.value = this.texH;
    grassUniforms.uFieldI.value = this.texI;
    // Inner ring: fine blades within ~12 m. Outer ring: coarser clumps out to ~42 m.
    this.rings.push(this.makeRing(0.35, 72, 4, 0, 12.5, 9, 3, 0.8));
    this.rings.push(this.makeRing(0.9, 94, 3, 11, 42, 6, 2, 1.3));
    this.root.name = 'grass';
  }

  private makeRing(cell: number, gridN: number, perCell: number, inner: number, outer: number, blades: number, segs: number, scale: number): Ring {
    const geo = clumpGeometry(blades, segs);
    geo.instanceCount = gridN * gridN * perCell;
    const uniforms: Record<string, THREE.IUniform> = {
      ...vegUniforms,
      ...grassUniforms,
      uDensity: { value: 1 },
      uCamSnap: { value: new THREE.Vector3() },
      uCell: { value: cell },
      uGridOrg: { value: new THREE.Vector2(-Math.floor(gridN / 2), -Math.floor(gridN / 2)) },
      uGridW: { value: gridN },
      uPerCell: { value: perCell },
      uInner: { value: inner },
      uOuter: { value: outer },
      uBladeScale: { value: scale },
    };
    const m = new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${grassVert}`)
        // Normals are derived from the blade layout, so the instance logic runs first.
        .replace('#include <beginnormal_vertex>', `${grassBegin}
          vec3 objectNormal = vec3(0.0, 1.0, 0.0);
        `)
        .replace('#include <begin_vertex>', '')
        .replace('#include <defaultnormal_vertex>', `
          // Soft, mostly-up normals: blades read as a lit carpet rather than flat strips.
          vec3 bn = normalize(vec3(perp.x, 0.0, perp.y) * blade.z * 0.6 + vec3(0.0, 1.0, 0.0));
          vec3 transformedNormal = normalMatrix * bn;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vT;\nvarying vec3 vGrassCol;\nvarying float vGrassAo;`)
        .replace('#include <map_fragment>', `
          diffuseColor.rgb = vGrassCol * mix(0.55, 1.15, vT);
        `)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
          reflectedLight.indirectDiffuse *= vGrassAo;
          reflectedLight.directDiffuse *= mix(0.7, 1.0, vGrassAo);
          // Light through the blades when the sun is behind them.
          reflectedLight.directDiffuse += reflectedLight.directDiffuse * 0.35 * vT;
        `);
    };
    m.customProgramCacheKey = () => `cw-grass-${cell}`;
    const mesh = new THREE.Mesh(geo, worldLit(m));
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.root.add(mesh);
    return { mesh, geo, uniforms, cell, gridN, perCell, perCellNow: perCell, outer };
  }

  /**
   * Quality density (1 = full): fewer clumps per cell rather than discarding clumps in the shader,
   * so the vertex work shrinks with the density. The keep probability makes up the rounding.
   */
  setDensity(k: number): void {
    for (const r of this.rings) {
      const want = r.perCell * k;
      r.perCellNow = Math.max(1, Math.ceil(want - 1e-6));
      r.uniforms.uPerCell.value = r.perCellNow;
      r.uniforms.uDensity.value = want / r.perCellNow;
    }
  }

  setSeason(season: number): void {
    grassUniforms.uGrassSeason.value = season;
    this.root.visible = this.enabled && season !== 2;
  }

  private sampleCell(wx: number, wz: number, k: number): void {
    const x = wx * FIELD_RES + FIELD_RES * 0.5;
    const z = wz * FIELD_RES + FIELD_RES * 0.5;
    const h = this.store.heightAt(x, z);
    const mat = this.store.materialAt(x, z);
    const [dens, type] = Number.isFinite(h) && mat >= 0 ? grassOf(mat) : [0, 0];
    this.fieldH[k] = Number.isFinite(h) ? h : -1e4;
    // Stable per-cell variation (patchiness) from a hash of the cell.
    const v = Math.abs(Math.sin(wx * 12.9898 + wz * 78.233) * 43758.5453) % 1;
    const patch = 0.55 + 0.45 * Math.sin(wx * 0.071 + Math.sin(wz * 0.053) * 2.0) * Math.sin(wz * 0.067 + 1.3);
    this.fieldI[k * 4] = Math.round(Math.min(1, dens * (type === 1 ? 1 : patch)) * 255);
    this.fieldI[k * 4 + 1] = type;
    this.fieldI[k * 4 + 2] = Math.round(v * 255);
    this.fieldI[k * 4 + 3] = 255;
  }

  /** Refresh the toroidal field for a window centred on the camera. */
  private updateField(cam: THREE.Vector3): boolean {
    const c0x = Math.floor(cam.x / FIELD_RES) - FIELD_N / 2;
    const c0z = Math.floor(cam.z / FIELD_RES) - FIELD_N / 2;
    let changed = false;
    // Columns and rows that now map to different world cells.
    const newCols: number[] = [];
    for (let wx = c0x; wx < c0x + FIELD_N; wx++) {
      const i = ((wx % FIELD_N) + FIELD_N) % FIELD_N;
      if (this.colOf[i] !== wx) newCols.push(wx);
    }
    const newRows: number[] = [];
    for (let wz = c0z; wz < c0z + FIELD_N; wz++) {
      const j = ((wz % FIELD_N) + FIELD_N) % FIELD_N;
      if (this.rowOf[j] !== wz) newRows.push(wz);
    }
    const colSet = new Set(newCols);
    for (let wz = c0z; wz < c0z + FIELD_N; wz++) {
      const j = ((wz % FIELD_N) + FIELD_N) % FIELD_N;
      const rowNew = this.rowOf[j] !== wz;
      for (let wx = c0x; wx < c0x + FIELD_N; wx++) {
        if (!rowNew && !colSet.has(wx)) continue;
        const i = ((wx % FIELD_N) + FIELD_N) % FIELD_N;
        this.sampleCell(wx, wz, j * FIELD_N + i);
        changed = true;
      }
    }
    for (const wx of newCols) this.colOf[((wx % FIELD_N) + FIELD_N) % FIELD_N] = wx;
    for (const wz of newRows) this.rowOf[((wz % FIELD_N) + FIELD_N) % FIELD_N] = wz;
    // Terrain nodes that streamed in since: re-sample a few rows per frame.
    if (this.store.version !== this.storeVersion) {
      this.storeVersion = this.store.version;
      this.refreshRow = FIELD_N;
    }
    if (this.refreshRow > 0) {
      for (let r = 0; r < 16 && this.refreshRow > 0; r++) {
        this.refreshRow--;
        const wz = c0z + this.refreshRow;
        const j = ((wz % FIELD_N) + FIELD_N) % FIELD_N;
        for (let wx = c0x; wx < c0x + FIELD_N; wx++) this.sampleCell(wx, wz, j * FIELD_N + (((wx % FIELD_N) + FIELD_N) % FIELD_N));
      }
      changed = true;
    }
    return changed;
  }

  private readonly corner = new THREE.Vector3();
  private readonly invProj = new THREE.Matrix4();

  update(camera: THREE.PerspectiveCamera, player: THREE.Vector3 | null): void {
    if (!this.root.visible) return;
    const cam = camera.position;
    if (this.updateField(cam)) {
      this.texH.needsUpdate = true;
      this.texI.needsUpdate = true;
    }
    // The part of the ground the camera can see near it: the view pyramid cut off where the grass
    // ends (apex and the four corners at that depth), as a box on the ground.
    const g = this.store.heightAt(cam.x, cam.z);
    const above = Number.isFinite(g) ? Math.max(0, cam.y - g) : 50;
    let minX = cam.x, maxX = cam.x, minZ = cam.z, maxZ = cam.z;
    const outer = Math.max(...this.rings.map((r) => r.outer));
    const depth = Math.hypot(outer, above + 2) + 1;
    this.invProj.copy(camera.projectionMatrixInverse);
    for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      // A point on the ray through this corner, scaled to the cut-off depth along the view axis.
      const p = this.corner.set(nx, ny, 0.5).applyMatrix4(this.invProj);
      p.multiplyScalar(depth / Math.max(-p.z, 1e-4)).applyMatrix4(camera.matrixWorld);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    for (const r of this.rings) {
      // Above the ring's reach nothing of it can show.
      if (above > r.outer) {
        r.geo.instanceCount = 0;
        continue;
      }
      const cx = Math.floor(cam.x / r.cell);
      const cz = Math.floor(cam.z / r.cell);
      (r.uniforms.uCamSnap.value as THREE.Vector3).set(cx * r.cell, 0, cz * r.cell);
      // Cell range relative to the camera cell, clamped to the ring's square.
      const half = Math.floor(r.gridN / 2);
      const i0 = THREE.MathUtils.clamp(Math.floor(minX / r.cell) - cx - 1, -half, r.gridN - 1 - half);
      const i1 = THREE.MathUtils.clamp(Math.floor(maxX / r.cell) - cx + 1, -half, r.gridN - 1 - half);
      const j0 = THREE.MathUtils.clamp(Math.floor(minZ / r.cell) - cz - 1, -half, r.gridN - 1 - half);
      const j1 = THREE.MathUtils.clamp(Math.floor(maxZ / r.cell) - cz + 1, -half, r.gridN - 1 - half);
      const w = i1 - i0 + 1;
      (r.uniforms.uGridOrg.value as THREE.Vector2).set(i0, j0);
      r.uniforms.uGridW.value = w;
      r.geo.instanceCount = w * (j1 - j0 + 1) * r.perCellNow;
    }
    if (player) grassUniforms.uPlayer.value.copy(player);
  }
}
