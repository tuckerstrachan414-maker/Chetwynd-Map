import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { aerialFrag, multiScatterFrag, skyViewFrag, transmittanceFrag } from './atmosphereGlsl';

const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

function rt(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
}

export const AP_SLICES = 32;
export const AP_MAX_KM = 80;

/**
 * Owns the atmosphere look-up tables. Transmittance and multiple scattering are computed once;
 * sky-view (sun and moon) and the aerial-perspective froxel volume are refreshed per frame.
 */
export class Atmosphere {
  readonly transmittance = rt(256, 64);
  readonly multiScatter = rt(32, 32);
  readonly skyViewSun = rt(192, 108);
  readonly skyViewMoon = rt(192, 108);
  readonly aerial: THREE.WebGL3DRenderTarget;
  readonly haze = { value: 1.6 };
  private readonly quad = new FullScreenQuad();
  private readonly mTrans: THREE.ShaderMaterial;
  private readonly mMulti: THREE.ShaderMaterial;
  private readonly mSky: THREE.ShaderMaterial;
  private readonly mAerial: THREE.ShaderMaterial;
  private staticDone = false;
  private readonly invViewProj = new THREE.Matrix4();

  constructor() {
    this.aerial = new THREE.WebGL3DRenderTarget(32, 32, AP_SLICES, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
    });
    this.aerial.texture.minFilter = THREE.LinearFilter;
    this.aerial.texture.magFilter = THREE.LinearFilter;
    this.aerial.texture.wrapR = THREE.ClampToEdgeWrapping;
    const common = { uHaze: this.haze };
    this.mTrans = new THREE.ShaderMaterial({ vertexShader: quadVert, fragmentShader: transmittanceFrag, uniforms: { ...common } });
    this.mMulti = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: multiScatterFrag,
      uniforms: { ...common, uTransmittance: { value: this.transmittance.texture } },
    });
    const lutUniforms = {
      ...common,
      uTransmittance: { value: this.transmittance.texture },
      uMultiScatter: { value: this.multiScatter.texture },
    };
    this.mSky = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: skyViewFrag,
      uniforms: { ...lutUniforms, uViewAltKm: { value: 0.7 }, uSunCosZ: { value: 0.5 } },
    });
    this.mAerial = new THREE.ShaderMaterial({
      vertexShader: quadVert,
      fragmentShader: aerialFrag,
      uniforms: {
        ...lutUniforms,
        uViewAltKm: { value: 0.7 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uInvViewProj: { value: this.invViewProj },
        uCamWorld: { value: new THREE.Vector3() },
        uSlice: { value: 0 },
        uMaxDistKm: { value: AP_MAX_KM },
        uSlices: { value: AP_SLICES },
      },
    });
    for (const m of [this.mTrans, this.mMulti, this.mSky, this.mAerial]) {
      m.depthTest = false;
      m.depthWrite = false;
    }
  }

  private draw(renderer: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | THREE.WebGL3DRenderTarget, layer = 0): void {
    this.quad.material = mat;
    renderer.setRenderTarget(target, layer);
    this.quad.render(renderer);
  }

  /**
   * @param lightDir direction toward the dominant light (sun, or moon at night) for aerial perspective
   */
  update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, moonDir: THREE.Vector3, lightDir: THREE.Vector3): void {
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    if (!this.staticDone) {
      this.draw(renderer, this.mTrans, this.transmittance);
      this.draw(renderer, this.mMulti, this.multiScatter);
      this.staticDone = true;
    }
    const altKm = Math.max(camera.position.y / 1000, 0.01);
    this.mSky.uniforms.uViewAltKm.value = altKm;
    this.mSky.uniforms.uSunCosZ.value = sunDir.y;
    this.draw(renderer, this.mSky, this.skyViewSun);
    this.mSky.uniforms.uSunCosZ.value = moonDir.y;
    this.draw(renderer, this.mSky, this.skyViewMoon);

    const u = this.mAerial.uniforms;
    u.uViewAltKm.value = altKm;
    (u.uSunDir.value as THREE.Vector3).copy(lightDir);
    (u.uCamWorld.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
    this.invViewProj.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    for (let s = 0; s < AP_SLICES; s++) {
      u.uSlice.value = s;
      this.draw(renderer, this.mAerial, this.aerial, s);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    for (const t of [this.transmittance, this.multiScatter, this.skyViewSun, this.skyViewMoon]) t.dispose();
    this.aerial.dispose();
  }
}
