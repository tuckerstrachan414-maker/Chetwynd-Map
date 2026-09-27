import * as THREE from 'three';
import { loadKtx2Array } from '../../engine/textures/TextureArrays';
import { ktx2Loader } from '../../engine/textures/TextureArrays';
import { ARCHETYPES, type Archetype } from './species';
import { generateTree, type MeshPart, type TreeModel } from './TreeGen';
import { createBarkMaterial, createFoliageDepthMaterial, createFoliageMaterial } from './TreeMaterials';

export const VARIANTS = 3;
export const IMP_VIEWS = 8;
export const IMP_W = 128;
export const IMP_H = 256;

export interface ModelEntry {
  arch: Archetype;
  variant: number;
  model: TreeModel;
  geo: { bark0: THREE.BufferGeometry; leaves0: THREE.BufferGeometry; bark1: THREE.BufferGeometry; leaves1: THREE.BufferGeometry };
  foliage: THREE.Material;
  foliageDepth: THREE.Material;
  bark: THREE.Material;
  layer: number;
  frameW: number;
  frameH: number;
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
  return g;
}

const FOLIAGE_OF: Record<Archetype, string> = { spruce: 'spruce', bspruce: 'spruce', pine: 'pine', aspen: 'aspen', poplar: 'leafy', round: 'leafy', shrub: 'leafy' };
const BARK_OF: Record<Archetype, string> = { spruce: 'spruce', bspruce: 'spruce', pine: 'pine', aspen: 'birch', poplar: 'spruce', round: 'spruce', shrub: 'spruce' };

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
        const deciduous = arch === 'aspen' || arch === 'poplar' || arch === 'round';
        this.entries.push({
          arch,
          variant: v,
          model,
          geo: {
            bark0: toGeometry(model.lod0.bark),
            leaves0: toGeometry(model.lod0.leaves),
            bark1: toGeometry(model.lod1.bark),
            leaves1: toGeometry(model.lod1.leaves),
          },
          foliage: createFoliageMaterial({ map: fmap, normalMap: fnrm, H: model.H, deciduous, flutter: arch === 'aspen' ? 1 : 0.5 }),
          foliageDepth: createFoliageDepthMaterial(fmap, model.H, deciduous),
          bark: createBarkMaterial(bmap, bnrm, model.H),
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
      const deciduous = e.arch === 'aspen' || e.arch === 'poplar' || e.arch === 'round';
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
