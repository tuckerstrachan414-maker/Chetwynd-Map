import * as THREE from 'three';
import { loadKtx2Array } from '../../engine/textures/TextureArrays';
import { ktx2Loader } from '../../engine/textures/TextureArrays';
import { ARCHETYPES, type Archetype } from './species';
import { generateTree, type MeshPart, type TreeModel } from './TreeGen';
import { createBarkDepthMaterial, createBarkMaterial, createFoliageDepthMaterial, createFoliageMaterial } from './TreeMaterials';

export const VARIANTS = 3;
export const IMP_VIEWS = 8;
export const IMP_W = 128;
export const IMP_H = 256;

export interface ModelEntry {
  arch: Archetype;
  variant: number;
  model: TreeModel;
  /** Full detail (0), middle distance (M: thinned from 0, see thinCards) and low-poly (1). */
  geo: {
    bark0: THREE.BufferGeometry; leaves0: THREE.BufferGeometry;
    barkM: THREE.BufferGeometry; leavesM: THREE.BufferGeometry;
    bark1: THREE.BufferGeometry; leaves1: THREE.BufferGeometry;
  };
  foliage: THREE.Material;
  foliageDepth: THREE.Material;
  bark: THREE.Material;
  barkDepth: THREE.Material;
  layer: number;
  frameW: number;
  frameH: number;
}

/**
 * Reorder a foliage part's cards (two triangles, six indices each) from the outside of the crown
 * inwards: by distance from the trunk axis relative to the crown's width at that height. Leaves are
 * alpha-tested, so a fragment's depth is only written once it is known to survive, but the depth test
 * itself still runs before shading: with the outer shell drawn first, the cards hidden inside the crown
 * fail it instead of being shaded and then covered (the same triangles, in a better order).
 */
function outerFirst(p: MeshPart): MeshPart {
  const idx = p.idx;
  const pos = p.pos;
  const cards = Math.floor(idx.length / 6);
  if (cards < 2) return p;
  const cy = new Float32Array(cards), cr = new Float32Array(cards);
  let ymin = Infinity, ymax = -Infinity;
  for (let c = 0; c < cards; c++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 6; k++) {
      const v = idx[c * 6 + k] * 3;
      x += pos[v];
      y += pos[v + 1];
      z += pos[v + 2];
    }
    cy[c] = y / 6;
    cr[c] = Math.hypot(x / 6, z / 6);
    ymin = Math.min(ymin, cy[c]);
    ymax = Math.max(ymax, cy[c]);
  }
  // The crown's width per height band.
  const BINS = 16;
  const span = Math.max(ymax - ymin, 1e-3);
  const bin = (y: number) => Math.min(BINS - 1, Math.floor(((y - ymin) / span) * BINS));
  const width = new Float32Array(BINS);
  for (let c = 0; c < cards; c++) width[bin(cy[c])] = Math.max(width[bin(cy[c])], cr[c]);
  const key = new Float32Array(cards);
  for (let c = 0; c < cards; c++) key[c] = cr[c] / Math.max(width[bin(cy[c])], 1e-3);
  const order = Array.from({ length: cards }, (_, c) => c).sort((a, b) => key[b] - key[a]);
  const out = new Uint32Array(idx.length);
  for (let n = 0; n < cards; n++) out.set(idx.subarray(order[n] * 6, order[n] * 6 + 6), n * 6);
  return { ...p, idx: out };
}

/**
 * The middle-distance foliage: half of the cards, kept or dropped in pairs (a spray's crossed cards
 * stay together), each enlarged about its centre by sqrt 2 so the crown keeps its coverage and outline
 * with half the vertices. Cards are four vertices and six indices each (see TreeGen.card).
 */
function thinCards(p: MeshPart): MeshPart {
  const cards = Math.floor(p.idx.length / 6);
  const s = Math.SQRT2;
  const keep: number[] = [];
  for (let c = 0; c < cards; c++) {
    const pair = c >> 1;
    if (((Math.imul(pair + 1, 2654435761) >>> 0) / 4294967296) < 0.5) keep.push(c);
  }
  const n = keep.length;
  const pos = new Float32Array(n * 12), nrm = new Float32Array(n * 12), uv = new Float32Array(n * 8);
  const wind = new Float32Array(n * 16), ao = new Float32Array(n * 4), idx = new Uint32Array(n * 6);
  for (let k = 0; k < n; k++) {
    const o = keep[k] * 6;
    const vs = [p.idx[o], p.idx[o + 1], p.idx[o + 2], p.idx[o + 5]];
    let cx = 0, cy = 0, cz = 0;
    for (const v of vs) {
      cx += p.pos[v * 3] / 4;
      cy += p.pos[v * 3 + 1] / 4;
      cz += p.pos[v * 3 + 2] / 4;
    }
    for (let j = 0; j < 4; j++) {
      const v = vs[j], d = k * 4 + j;
      pos[d * 3] = cx + (p.pos[v * 3] - cx) * s;
      pos[d * 3 + 1] = cy + (p.pos[v * 3 + 1] - cy) * s;
      pos[d * 3 + 2] = cz + (p.pos[v * 3 + 2] - cz) * s;
      nrm.set(p.nrm.subarray(v * 3, v * 3 + 3), d * 3);
      uv.set(p.uv.subarray(v * 2, v * 2 + 2), d * 2);
      wind.set(p.wind.subarray(v * 4, v * 4 + 4), d * 4);
      ao[d] = p.ao[v];
    }
    // Same winding as TreeGen.card: (0, 1, 2), (0, 2, 3).
    idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
  }
  return { pos, nrm, uv, wind, ao, idx };
}

/** A geometry drawing the same buffers as `g` (its own object: instanced attributes are set per LOD set). */
function shareGeometry(g: THREE.BufferGeometry, drawCount?: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  out.index = g.index;
  for (const [name, attr] of Object.entries(g.attributes)) out.setAttribute(name, attr);
  out.boundingSphere = g.boundingSphere;
  out.userData = { ...g.userData };
  if (drawCount !== undefined) out.setDrawRange(0, drawCount);
  return out;
}

function toGeometry(p: MeshPart): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(p.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
  g.setAttribute('wind', new THREE.BufferAttribute(p.wind, 4));
  g.setAttribute('ao', new THREE.BufferAttribute(p.ao, 1));
  g.setIndex(new THREE.BufferAttribute(p.idx, 1));
  g.computeBoundingSphere();
  // Shadow copies draw only this many indices (see CulledInstances).
  if (p.shadowIdx !== undefined) g.userData.shadowCount = p.shadowIdx;
  return g;
}

const FOLIAGE_OF: Record<Archetype, string> = {
  spruce: 'spruce', bspruce: 'spruce', pine: 'pine', aspen: 'aspen', poplar: 'poplar', round: 'birch', shrub: 'shrub', willow: 'willow',
};
const BARK_OF: Record<Archetype, string> = {
  spruce: 'spruce', bspruce: 'spruce', pine: 'pine', aspen: 'birch', poplar: 'spruce', round: 'spruce', shrub: 'spruce', willow: 'spruce',
};

const isDeciduous = (a: Archetype) => a !== 'spruce' && a !== 'bspruce' && a !== 'pine';

/** Loads tree textures, generates model variants and bakes impostor atlases. */
export class TreeLibrary {
  readonly entries: ModelEntry[] = [];
  impAlbedo!: THREE.WebGLArrayRenderTarget;
  impNormal!: THREE.WebGLArrayRenderTarget;
  private textures = new Map<string, THREE.Texture>();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  entry(arch: Archetype, variant: number): ModelEntry {
    return this.entries[ARCHETYPES.indexOf(arch) * VARIANTS + (variant % VARIANTS)];
  }

  private async tex(name: string, srgb: boolean, repeat: boolean): Promise<THREE.Texture> {
    const key = name;
    if (this.textures.has(key)) return this.textures.get(key)!;
    const t = await ktx2Loader(this.renderer).loadAsync(`./assets/trees/${name}.ktx2`);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    this.textures.set(key, t);
    return t;
  }

  async init(): Promise<void> {
    void loadKtx2Array;
    const cells = (await fetch('./assets/trees/cells.json').then((r) => r.json())) as Record<string, number[][]>;
    for (let a = 0; a < ARCHETYPES.length; a++) {
      const arch = ARCHETYPES[a];
      const fol = FOLIAGE_OF[arch];
      const bk = BARK_OF[arch];
      const [fmap, fnrm, bmap, bnrm] = await Promise.all([
        this.tex(`${fol}_albedo`, true, false),
        this.tex(`${fol}_normal`, false, false),
        this.tex(`bark_${bk}_albedo`, true, true),
        this.tex(`bark_${bk}_normal`, false, true),
      ]);
      for (let v = 0; v < VARIANTS; v++) {
        const model = generateTree(arch, 11 + v * 7 + a * 101, cells[fol] ?? [[0, 0, 1, 1]]);
        const deciduous = isDeciduous(arch);
        const fo = { map: fmap, normalMap: fnrm, H: model.H, R: model.R, deciduous, flutter: arch === 'aspen' ? 1 : 0.5 };
        const bark0 = toGeometry(model.lod0.bark);
        // Spruces at middle distance: the trunk alone (their branches are hidden in the sprays).
        const trunkOnly = arch === 'spruce' || arch === 'bspruce';
        this.entries.push({
          arch,
          variant: v,
          model,
          geo: {
            bark0,
            leaves0: toGeometry(outerFirst(model.lod0.leaves)),
            barkM: shareGeometry(bark0, trunkOnly ? model.lod0.bark.shadowIdx : undefined),
            leavesM: toGeometry(outerFirst(thinCards(model.lod0.leaves))),
            bark1: toGeometry(model.lod1.bark),
            leaves1: toGeometry(outerFirst(model.lod1.leaves)),
          },
          foliage: createFoliageMaterial(fo),
          foliageDepth: createFoliageDepthMaterial(fmap, model.H, model.R, deciduous),
          bark: createBarkMaterial(bmap, bnrm, model.H, model.R),
          barkDepth: createBarkDepthMaterial(model.H, model.R),
          layer: a * VARIANTS + v,
          frameW: model.R * 2 * 1.35,
          frameH: model.H * 1.12,
        });
      }
    }
  }

  /**
   * Bake 8 horizontal views of each LOD0 model into array render targets
   * (albedo with season leaf tint + alpha; model-space normal).
   */
  bakeImpostors(leafColors: (arch: Archetype) => THREE.Color, barkColors: (arch: Archetype) => THREE.Color, leafless: boolean): void {
    const layers = this.entries.length;
    const mk = () => {
      const rt = new THREE.WebGLArrayRenderTarget(IMP_W * IMP_VIEWS, IMP_H, layers, { type: THREE.UnsignedByteType, depthBuffer: true });
      rt.texture.generateMipmaps = true;
      rt.texture.minFilter = THREE.LinearMipmapLinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      return rt;
    };
    this.impAlbedo?.dispose();
    this.impNormal?.dispose();
    this.impAlbedo = mk();
    this.impNormal = mk();
    const bakeVert = /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying float vAo;
      attribute float ao;
      void main() { vUv = uv; vN = normalize(normal); vAo = ao; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `;
    const bakeFrag = /* glsl */ `
      uniform sampler2D map; uniform vec3 tint; uniform float mode; uniform float isLeaf; uniform float leafless;
      varying vec2 vUv; varying vec3 vN; varying float vAo;
      void main() {
        vec4 t = texture2D(map, vUv);
        if (isLeaf > 0.5 && (t.a < 0.45 || leafless > 0.5)) discard;
        if (mode < 0.5) {
          vec3 c = isLeaf > 0.5 ? tint * (dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)) / 0.35) : t.rgb * tint;
          gl_FragColor = vec4(c * mix(1.0, vAo, 0.6), 1.0);
        } else {
          gl_FragColor = vec4(normalize(vN) * 0.5 + 0.5, 1.0);
        }
      }
    `;
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
    for (const e of this.entries) {
      const deciduous = isDeciduous(e.arch);
      const matFor = (isLeaf: boolean, mode: number) =>
        new THREE.ShaderMaterial({
          vertexShader: bakeVert,
          fragmentShader: bakeFrag,
          side: THREE.DoubleSide,
          uniforms: {
            map: { value: isLeaf ? (e.foliage as THREE.MeshStandardMaterial).map : (e.bark as THREE.MeshStandardMaterial).map },
            tint: { value: isLeaf ? leafColors(e.arch) : barkColors(e.arch) },
            mode: { value: mode },
            isLeaf: { value: isLeaf ? 1 : 0 },
            leafless: { value: leafless && deciduous ? 1 : 0 },
          },
        });
      const barkMesh = new THREE.Mesh(e.geo.bark0, matFor(false, 0));
      const leafMesh = new THREE.Mesh(e.geo.leaves0, matFor(true, 0));
      scene.add(barkMesh, leafMesh);
      const hw = e.frameW / 2;
      cam.left = -hw;
      cam.right = hw;
      cam.bottom = -0.02 * e.model.H;
      cam.top = e.frameH - 0.02 * e.model.H;
      cam.updateProjectionMatrix();
      for (const [target, mode] of [[this.impAlbedo, 0], [this.impNormal, 1]] as const) {
        (barkMesh.material as THREE.ShaderMaterial).uniforms.mode.value = mode;
        (leafMesh.material as THREE.ShaderMaterial).uniforms.mode.value = mode;
        r.setRenderTarget(target, e.layer);
        r.setClearColor(mode === 0 ? 0x000000 : 0x8080ff, 0);
        target.scissorTest = false;
        target.viewport.set(0, 0, IMP_W * IMP_VIEWS, IMP_H);
        r.setRenderTarget(target, e.layer);
        r.clear(true, true, false);
        for (let k = 0; k < IMP_VIEWS; k++) {
          const az = (k / IMP_VIEWS) * Math.PI * 2;
          cam.position.set(Math.sin(az) * 200, 0, Math.cos(az) * 200);
          cam.lookAt(0, 0, 0);
          target.viewport.set(k * IMP_W, 0, IMP_W, IMP_H);
          target.scissor.set(k * IMP_W, 0, IMP_W, IMP_H);
          target.scissorTest = true;
          r.setRenderTarget(target, e.layer);
          r.render(scene, cam);
        }
        target.scissorTest = false;
      }
      scene.remove(barkMesh, leafMesh);
      (barkMesh.material as THREE.Material).dispose();
      (leafMesh.material as THREE.Material).dispose();
    }
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
  }
}
