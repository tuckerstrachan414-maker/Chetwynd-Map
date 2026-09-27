import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { AP_MAX_KM, type Atmosphere } from './sky/Atmosphere';
import { adaptFrag, compositeFrag, downFrag, finalFrag, fxaaFrag, lumFrag, quadVert, upFrag } from './postGlsl';

export interface PostSettings {
  msaa: number;
  bloom: number;
  fxaa: boolean;
  exposureComp: number;
  manualExposure: number;
  vignette: number;
  grain: number;
  saturation: number;
  contrast: number;
}

function hdrTarget(w: number, h: number, opts: Partial<THREE.RenderTargetOptions> = {}): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    ...opts,
  });
}

const BLOOM_LEVELS = 6;

/**
 * HDR frame pipeline: scene -> atmosphere composite -> bloom + auto exposure -> AgX -> (FXAA) -> screen.
 */
export class Post {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly compRT: THREE.WebGLRenderTarget;
  private readonly ldrRT: THREE.WebGLRenderTarget;
  private readonly lumRT: THREE.WebGLRenderTarget;
  private adaptA = hdrTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private adaptB = hdrTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private readonly bloomDown: THREE.WebGLRenderTarget[] = [];
  private readonly bloomUp: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new FullScreenQuad();
  readonly composite: THREE.ShaderMaterial;
  private readonly mLum: THREE.ShaderMaterial;
  private readonly mAdapt: THREE.ShaderMaterial;
  private readonly mDown: THREE.ShaderMaterial;
  private readonly mUp: THREE.ShaderMaterial;
  readonly final: THREE.ShaderMaterial;
  private readonly mFxaa: THREE.ShaderMaterial;
  private width = 1;
  private height = 1;
  private firstFrame = true;
  readonly settings: PostSettings;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    atmosphere: Atmosphere,
    settings: Partial<PostSettings> = {},
  ) {
    this.settings = {
      msaa: 4, bloom: 0.035, fxaa: false, exposureComp: 0, manualExposure: 0, vignette: 0.22, grain: 0.004,
      saturation: 1.05, contrast: 1.02, ...settings,
    };
    const reversed = renderer.capabilities.reversedDepthBuffer && renderer.state.buffers.depth.getReversed();
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    depthTexture.format = THREE.DepthFormat;
    this.sceneRT = hdrTarget(1, 1, { depthBuffer: true, samples: this.settings.msaa, depthTexture });
    this.compRT = hdrTarget(1, 1);
    this.ldrRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.lumRT = hdrTarget(128, 64, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      this.bloomDown.push(hdrTarget(1, 1));
      this.bloomUp.push(hdrTarget(1, 1));
    }
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.composite = mk(compositeFrag, {
      tColor: { value: this.sceneRT.texture },
      tDepth: { value: depthTexture },
      tAerial: { value: atmosphere.aerial.texture },
      tSkySun: { value: atmosphere.skyViewSun.texture },
      tSkyMoon: { value: atmosphere.skyViewMoon.texture },
      uTransmittance: { value: atmosphere.transmittance.texture },
      uHaze: atmosphere.haze,
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uReversed: { value: reversed ? 1 : 0 },
      uViewAltKm: { value: 0.7 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunE: { value: 10 },
      uMoonE: { value: 0 },
      uApE: { value: 10 },
      uApMaxKm: { value: AP_MAX_KM },
      uStars: { value: 0 },
      uTime: { value: 0 },
      uStarRot: { value: new THREE.Matrix3() },
    });
    this.mLum = mk(lumFrag, { tColor: { value: this.compRT.texture } });
    this.mAdapt = mk(adaptFrag, {
      tLum: { value: this.lumRT.texture },
      tPrev: { value: this.adaptA.texture },
      uLumLod: { value: 7 },
      uBlend: { value: 1 },
      uMinLog: { value: -12 },
      uMaxLog: { value: 8 },
    });
    this.mDown = mk(downFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 } });
    this.mUp = mk(upFrag, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 } });
    this.mUp.blending = THREE.AdditiveBlending;
    this.mUp.transparent = true;
    this.final = mk(finalFrag, {
      tColor: { value: this.compRT.texture },
      tBloom: { value: this.bloomUp[0].texture },
      tAdapt: { value: this.adaptA.texture },
      uBloom: { value: this.settings.bloom },
      uExposureComp: { value: 0 },
      uKey: { value: 0.16 },
      uManualExposure: { value: 0 },
      uVignette: { value: this.settings.vignette },
      uGrain: { value: this.settings.grain },
      uTime: { value: 0 },
      uSaturation: { value: this.settings.saturation },
      uContrast: { value: this.settings.contrast },
      uLift: { value: new THREE.Vector3(0, 0, 0) },
      uGain: { value: new THREE.Vector3(1, 1, 1) },
      toneMappingExposure: { value: 1 },
    });
    this.mFxaa = mk(fxaaFrag, { tColor: { value: this.ldrRT.texture }, uTexel: { value: new THREE.Vector2() } });
  }

  get reversed(): boolean {
    return this.composite.uniforms.uReversed.value > 0.5;
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    this.sceneRT.setSize(w, h);
    this.compRT.setSize(w, h);
    this.ldrRT.setSize(w, h);
    let bw = Math.max(1, w >> 1);
    let bh = Math.max(1, h >> 1);
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      this.bloomDown[k].setSize(bw, bh);
      this.bloomUp[k].setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    (this.mFxaa.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /** Render the scene through the full pipeline to the canvas. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number, time: number): void {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);
    const cu = this.composite.uniforms;
    (cu.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (cu.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    cu.uViewAltKm.value = Math.max(camera.position.y / 1000, 0.01);
    cu.uTime.value = time;
    this.pass(this.composite, this.compRT);

    // Auto exposure.
    this.pass(this.mLum, this.lumRT);
    const au = this.mAdapt.uniforms;
    au.tPrev.value = this.adaptA.texture;
    au.uBlend.value = this.firstFrame ? 1 : 1 - Math.exp(-dt * 1.8);
    this.firstFrame = false;
    this.pass(this.mAdapt, this.adaptB);
    [this.adaptA, this.adaptB] = [this.adaptB, this.adaptA];
    this.final.uniforms.tAdapt.value = this.adaptA.texture;

    // Bloom chain.
    const du = this.mDown.uniforms;
    let src: THREE.Texture = this.compRT.texture;
    let sw = this.width;
    let sh = this.height;
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      du.tSrc.value = src;
      (du.uTexel.value as THREE.Vector2).set(1 / sw, 1 / sh);
      du.uFirst.value = k === 0 ? 1 : 0;
      this.pass(this.mDown, this.bloomDown[k]);
      src = this.bloomDown[k].texture;
      sw = this.bloomDown[k].width;
      sh = this.bloomDown[k].height;
    }
    const uu = this.mUp.uniforms;
    for (let k = BLOOM_LEVELS - 1; k >= 0; k--) {
      // up[k] = down[k] + upsample(up[k+1])
      this.renderer.setRenderTarget(this.bloomUp[k]);
      this.renderer.clear(true, false, false);
      uu.tSrc.value = this.bloomDown[k].texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / this.bloomDown[k].width, 1 / this.bloomDown[k].height);
      uu.uRadius.value = 0.5;
      this.pass(this.mUp, this.bloomUp[k]);
      if (k < BLOOM_LEVELS - 1) {
        uu.tSrc.value = this.bloomUp[k + 1].texture;
        (uu.uTexel.value as THREE.Vector2).set(1 / this.bloomUp[k + 1].width, 1 / this.bloomUp[k + 1].height);
        uu.uRadius.value = 1;
        this.pass(this.mUp, this.bloomUp[k]);
      }
    }

    const fu = this.final.uniforms;
    fu.uTime.value = time;
    fu.uBloom.value = this.settings.bloom;
    fu.uExposureComp.value = this.settings.exposureComp;
    fu.uManualExposure.value = this.settings.manualExposure;
    fu.uVignette.value = this.settings.vignette;
    fu.uGrain.value = this.settings.grain;
    fu.uSaturation.value = this.settings.saturation;
    fu.uContrast.value = this.settings.contrast;
    if (this.settings.fxaa) {
      this.pass(this.final, this.ldrRT);
      this.pass(this.mFxaa, null);
    } else {
      this.pass(this.final, null);
    }
  }
}
