import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { AP_MAX_KM, type Atmosphere } from './sky/Atmosphere';
import type { FrameProfiler } from './FrameProfiler';
import { worldLightUniforms } from './WorldLight';
import { aoBlurFrag, aoDepthFrag, aoFrag } from './aoGlsl';
import { dofFrag } from './dofGlsl';
import { adaptFrag, compositeFrag, downFrag, finalFrag, fxaaFrag, lumFrag, quadVert, skyFrag, skyVert, upFrag } from './postGlsl';
import { taaFrag } from './taaGlsl';

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
  /** FPV lens barrel distortion strength (0 = off). */
  barrel: number;
  /** Screen-space ambient occlusion. */
  ao: boolean;
  /** Temporal anti-aliasing (in place of MSAA: `msaa` should then be 0). */
  taa: boolean;
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
/** TAA jitter: Halton (2, 3) points, a fresh sub-pixel offset each frame. */
const JITTER_PHASES = 8;
function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}
/** A camera move longer than this in one frame (m) is a cut: the TAA history starts over. */
const TAA_CUT = 30;

/**
 * HDR frame pipeline: scene -> atmosphere composite -> (TAA) -> bloom + auto exposure -> AgX -> (FXAA) -> screen.
 *
 * Bandwidth matters most on integrated GPUs, so the pipeline avoids full-screen work it does not need:
 * with MSAA the water pass samples the scene's resolved colour and depth directly (they are separate
 * from the multisampled buffers it draws into), AO works from a half-resolution linear depth made once
 * per frame, and each bloom level is upsampled and summed in a single pass.
 *
 * Anti-aliasing is MSAA or temporal (TAA). On integrated GPUs 4x MSAA roughly doubled the cost of the
 * dense geometry (terrain, foliage, grass: every pixel any sample of a small triangle touches is shaded
 * again for that triangle) and added a resolve; TAA instead jitters the projection by a sub-pixel
 * offset every frame (`beginFrame` / `endFrame` around everything that reads it) and accumulates the
 * frames (see taaGlsl), which also steadies shimmering leaves and grass. Thin fast particles (rain and
 * snow streaks: `overlays`) would be smeared away by the history, so they are drawn after the
 * resolve, depth-tested against the scene; a contrast-adaptive sharpen in the final pass restores the
 * crispness the accumulation softens.
 *
 * With TAA the scene can also be rendered below the output resolution (`setRenderScale`, driven by
 * dynamic resolution when a frame runs over budget): the scene, water, AO and atmosphere composite run
 * at the render size, and the TAA resolve reconstructs the output resolution from the jittered frames
 * (temporal upsampling), so the post-processing, the HUD and the final image stay at full resolution.
 */
export class Post {
  readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly compRT: THREE.WebGLRenderTarget;
  private readonly dofRT: THREE.WebGLRenderTarget;
  private readonly aoRT: THREE.WebGLRenderTarget;
  private readonly aoBlurRT: THREE.WebGLRenderTarget;
  /** Half-resolution linear view depth (m) for AO and its blur. */
  private readonly aoDepthRT: THREE.WebGLRenderTarget;
  private readonly mAODepth: THREE.ShaderMaterial;
  private readonly mAO: THREE.ShaderMaterial;
  private readonly mAOBlur: THREE.ShaderMaterial;
  private readonly mDof: THREE.ShaderMaterial;
  /** Photo-mode depth of field (thin lens, metres); null = off. */
  dof: { focal: number; aperture: number; focus: number } | null = null;
  private readonly ldrRT: THREE.WebGLRenderTarget;
  private readonly lumRT: THREE.WebGLRenderTarget;
  private adaptA = hdrTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private adaptB = hdrTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  private readonly bloomDown: THREE.WebGLRenderTarget[] = [];
  private readonly bloomUp: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new FullScreenQuad();
  readonly composite: THREE.ShaderMaterial;
  /**
   * The sky, drawn inside the scene render right after the opaque objects, only where none of them
   * is: thin and transparent things (leaf edges, wires, rain) then blend with the real sky.
   */
  readonly skyMesh: THREE.Mesh;
  private readonly mLum: THREE.ShaderMaterial;
  private readonly mAdapt: THREE.ShaderMaterial;
  private readonly mDown: THREE.ShaderMaterial;
  private readonly mUp: THREE.ShaderMaterial;
  readonly final: THREE.ShaderMaterial;
  private readonly mFxaa: THREE.ShaderMaterial;
  /**
   * Copy of the opaque scene for water refraction/reflection: colour (half float) and raw depth (float).
   * Only used without MSAA (or with render-to-texture MSAA), where the scene textures are the very
   * attachments the water draws into; see `refrTexture` / `refrDepthTexture`.
   */
  readonly refrColor: THREE.WebGLRenderTarget;
  readonly refrDepth: THREE.WebGLRenderTarget;

  /** The water samples the scene's resolved textures directly (no copies): MSAA without render-to-texture. */
  get directRefraction(): boolean {
    return this.settings.msaa > 0 && !this.rtt;
  }

  /**
   * The resolved colour must be written back into the multisampled buffer before the water draws:
   * three invalidates multisampled colour after resolving only in Oculus Browser, and implicit
   * (render-to-texture) MSAA keeps no samples between passes.
   */
  get restoreColor(): boolean {
    return this.settings.msaa > 0 && (this.rtt || this.oculus);
  }
  private readonly mCopyColor: THREE.ShaderMaterial;
  private readonly mCopyDepth: THREE.ShaderMaterial;
  /** TAA: the resolve and its history (read B, write A, then swapped). */
  private readonly mTaa: THREE.ShaderMaterial;
  private histA: THREE.WebGLRenderTarget;
  private histB: THREE.WebGLRenderTarget;
  /** TAA: the resolved frame with the overlays blended over it. */
  private readonly displayRT: THREE.WebGLRenderTarget;
  private readonly mOverlay: THREE.ShaderMaterial;
  /** Scene render size relative to the output (TAA only; 1 otherwise). */
  private renderScale = 1;
  private rw = 1;
  private rh = 1;
  /** Drawn after the TAA resolve (rain and snow); in the scene pass otherwise. */
  readonly overlays: THREE.Object3D[] = [];
  private readonly overlayShown: boolean[] = [];
  private taaFrame = 0;
  private taaValid = false;
  private jittered = false;
  /** This frame's image shift (uv) and the unjittered projection it replaced. */
  private readonly jitter = new THREE.Vector2();
  private readonly unjittered = new THREE.Matrix4();
  private readonly jitterMatrix = new THREE.Matrix4();
  /** Last frame's unjittered projection x view, and its camera position. */
  private readonly prevVP = new THREE.Matrix4();
  private readonly prevCam = new THREE.Vector3();
  /** Objects on this layer are drawn after the opaque copy (water). */
  secondLayer = 1;
  secondPass = false;
  private width = 1;
  private height = 1;
  private firstFrame = true;
  readonly settings: PostSettings;
  prof: FrameProfiler | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    atmosphere: Atmosphere,
    settings: Partial<PostSettings> = {},
  ) {
    this.settings = {
      msaa: 4, bloom: 0.035, fxaa: false, exposureComp: 0, manualExposure: 0, vignette: 0.22, grain: 0.004,
      saturation: 1.05, contrast: 1.02, barrel: 0, ao: true, taa: false, ...settings,
    };
    const reversed = renderer.capabilities.reversedDepthBuffer && renderer.state.buffers.depth.getReversed();
    const depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);
    depthTexture.format = THREE.DepthFormat;
    this.sceneRT = hdrTarget(1, 1, { depthBuffer: true, samples: this.settings.msaa, depthTexture });
    this.compRT = hdrTarget(1, 1);
    this.dofRT = hdrTarget(1, 1);
    const aoTarget = () => new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.aoRT = aoTarget();
    this.aoBlurRT = aoTarget();
    this.aoDepthRT = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RedFormat, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
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
      uUnder: { value: 0 },
      uCloudCover: worldLightUniforms.uCloudCover,
      uCloudOffset: worldLightUniforms.uCloudOffset,
      uCloudShadowK: worldLightUniforms.uCloudShadowK,
      uCloudSunDir: worldLightUniforms.uCloudSunDir,
      uCloudGlow: worldLightUniforms.uCloudGlow,
      uUnderSigma: { value: new THREE.Vector3(0.62, 0.3, 0.38) },
      uUnderDeep: { value: new THREE.Vector3() },
    });
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: skyVert,
      fragmentShader: skyFrag,
      uniforms: this.composite.uniforms,
      depthWrite: false,
    });
    this.skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), skyMat);
    this.skyMesh.name = 'sky';
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = 1e9; // last of the opaque objects
    this.mDof = mk(dofFrag, {
      tColor: { value: this.compRT.texture },
      tDepth: { value: depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uReversed: { value: reversed ? 1 : 0 },
      uTexel: { value: new THREE.Vector2() },
      uFocal: { value: 0.035 },
      uAperture: { value: 5.6 },
      uFocus: { value: 10 },
      uPxPerM: { value: 1 },
      uMaxR: { value: 16 },
    });
    this.mAODepth = mk(aoDepthFrag, {
      tDepth: { value: depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uReversed: { value: reversed ? 1 : 0 },
    });
    this.mAO = mk(aoFrag, {
      tLin: { value: this.aoDepthRT.texture },
      uTan: { value: new THREE.Vector2(1, 1) },
      uProjScale: { value: 1 },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: 1.1 },
    });
    this.mAOBlur = mk(aoBlurFrag, {
      tAO: { value: null },
      tLin: { value: this.aoDepthRT.texture },
      uDir: { value: new THREE.Vector2() },
    });
    this.composite.uniforms.tAO = { value: this.aoRT.texture };
    this.composite.uniforms.uAOK = { value: 0 };
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
    // up[k] = blur(down[k]) + upsample(up[k+1]) in one pass per level.
    this.mUp = mk(upFrag, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      tPrev: { value: null }, uTexelPrev: { value: new THREE.Vector2() }, uHasPrev: { value: 0 },
    });
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
      uNight: { value: 0 },
      uBarrel: { value: 0 },
      uAspect: { value: 1 },
      uSharpen: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
      toneMappingExposure: { value: 1 },
    });
    this.mFxaa = mk(fxaaFrag, { tColor: { value: this.ldrRT.texture }, uTexel: { value: new THREE.Vector2() } });
    this.refrColor = hdrTarget(1, 1);
    this.refrDepth = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
    this.mCopyColor = mk('uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }', {
      tSrc: { value: this.sceneRT.texture },
    });
    this.mCopyDepth = mk('uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).r, 0.0, 0.0, 1.0); }', {
      tSrc: { value: depthTexture },
    });
    this.rtt = renderer.extensions.has('WEBGL_multisampled_render_to_texture');
    this.oculus = typeof navigator !== 'undefined' && /OculusBrowser/.test(navigator.userAgent);
    this.histA = hdrTarget(1, 1);
    this.histB = hdrTarget(1, 1);
    this.displayRT = hdrTarget(1, 1);
    this.mTaa = mk(taaFrag, {
      tCur: { value: this.compRT.texture },
      tHist: { value: this.histB.texture },
      tDepth: { value: depthTexture },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uPrevVP: { value: new THREE.Matrix4() },
      uJitter: { value: new THREE.Vector2() },
      uTexel: { value: new THREE.Vector2() },
      uOutTexel: { value: new THREE.Vector2() },
      uReversed: { value: reversed ? 1 : 0 },
      uReset: { value: 1 },
      uAlpha: { value: 0.1 },
    });
    // Premultiplied overlay layer (render size, upsampled bilinearly) over the resolved frame.
    this.mOverlay = mk(`uniform sampler2D tBase; uniform sampler2D tOver; varying vec2 vUv;
      void main() { vec4 o = texture2D(tOver, vUv); gl_FragColor = vec4(texture2D(tBase, vUv).rgb * (1.0 - o.a) + o.rgb, 1.0); }`, {
      tBase: { value: null },
      tOver: { value: null },
    });
    this.setAntialias(this.settings.msaa, this.settings.taa);
  }

  private readonly rtt: boolean;
  private readonly oculus: boolean;

  get taa(): boolean {
    return this.settings.taa;
  }

  /**
   * Switch anti-aliasing at run time: MSAA samples for the scene target, or TAA (with `msaa` 0). The
   * scene target is reallocated with the new sample count on its next use.
   */
  setAntialias(msaa: number, taa: boolean): void {
    this.settings.msaa = msaa;
    this.settings.taa = taa;
    if (this.sceneRT.samples !== msaa) {
      this.sceneRT.samples = msaa;
      this.sceneRT.dispose();
    }
    this.taaValid = false;
    if (this.width > 1) this.setSize(this.width, this.height);
  }

  /** Opaque scene colour for the water pass. */
  get refrTexture(): THREE.Texture {
    return this.directRefraction ? this.sceneRT.texture : this.refrColor.texture;
  }

  /** Opaque scene depth (raw) for the water pass. */
  get refrDepthTexture(): THREE.Texture {
    return this.directRefraction ? this.sceneRT.depthTexture! : this.refrDepth.texture;
  }

  /** Output (canvas) size in pixels. */
  get pixelWidth(): number {
    return this.width;
  }

  get pixelHeight(): number {
    return this.height;
  }

  /** Scene render size in pixels (below the output size while dynamic resolution scales TAA down). */
  get renderWidth(): number {
    return this.rw;
  }

  get renderHeight(): number {
    return this.rh;
  }

  /** TAA only: render the scene at this fraction of the output size (0.5..1); the resolve upsamples. */
  setRenderScale(s: number): void {
    s = Math.min(1, Math.max(0.5, s));
    if (s === this.renderScale) return;
    this.renderScale = s;
    if (!this.settings.taa || this.width <= 1) return;
    const rw = Math.max(1, Math.round(this.width * s)), rh = Math.max(1, Math.round(this.height * s));
    if (rw === this.rw && rh === this.rh) return;
    this.rw = rw;
    this.rh = rh;
    this.sizeScene();
  }

  /** The targets the scene and its depth-based passes render at (render size). */
  private sizeScene(): void {
    const w = this.rw, h = this.rh;
    this.sceneRT.setSize(w, h);
    // The refraction copies are only allocated where they are used.
    const cw = this.directRefraction ? 1 : w, ch = this.directRefraction ? 1 : h;
    this.refrColor.setSize(cw, ch);
    this.refrDepth.setSize(cw, ch);
    this.compRT.setSize(w, h);
    this.aoRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.aoBlurRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.aoDepthRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  get reversed(): boolean {
    return this.composite.uniforms.uReversed.value > 0.5;
  }

  setSize(w: number, h: number): void {
    this.width = w;
    this.height = h;
    const s = this.settings.taa ? this.renderScale : 1;
    this.rw = Math.max(1, Math.round(w * s));
    this.rh = Math.max(1, Math.round(h * s));
    this.sizeScene();
    // Output size from here on.
    this.dofRT.setSize(w, h);
    this.ldrRT.setSize(w, h);
    // The TAA history and overlay target are only allocated while TAA is on.
    const tw = this.settings.taa ? w : 1, th = this.settings.taa ? h : 1;
    this.histA.setSize(tw, th);
    this.histB.setSize(tw, th);
    this.displayRT.setSize(tw, th);
    this.taaValid = false;
    (this.final.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    let bw = Math.max(1, w >> 1);
    let bh = Math.max(1, h >> 1);
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      this.bloomDown[k].setSize(bw, bh);
      this.bloomUp[k].setSize(bw, bh);
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
    }
    (this.mFxaa.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.final.uniforms.uAspect.value = w / Math.max(h, 1);
  }

  /**
   * TAA: offset the camera's projection by this frame's sub-pixel jitter. Call once the camera is in
   * place for the frame, before anything reads its projection (culling, shadows, water, rendering);
   * `endFrame` restores it.
   */
  beginFrame(camera: THREE.PerspectiveCamera): void {
    this.jittered = false;
    if (!this.settings.taa || this.width <= 1) return;
    // three switches a camera to the reversed-depth projection the first time it renders with it; do it
    // now, or endFrame would restore the matrix from before the switch (and break the depth test).
    if (this.renderer.state.buffers.depth.getReversed() && !camera.reversedDepth) {
      (camera as unknown as { _reversedDepth: boolean })._reversedDepth = true;
      camera.updateProjectionMatrix();
    }
    this.unjittered.copy(camera.projectionMatrix);
    const i = (this.taaFrame++ % JITTER_PHASES) + 1;
    const jx = halton(i, 2) - 0.5, jy = halton(i, 3) - 0.5;
    // Perspective projection: lowering elements 8/9 by d moves the image by +d in NDC (jitter in render pixels).
    const e = camera.projectionMatrix.elements;
    e[8] -= (2 * jx) / this.rw;
    e[9] -= (2 * jy) / this.rh;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    this.jittered = true;
    this.jitterMatrix.copy(camera.projectionMatrix);
    this.jitter.set(jx / this.rw, jy / this.rh);
  }

  /** Undo `beginFrame` and remember this frame's view for the next frame's reprojection. */
  endFrame(camera: THREE.PerspectiveCamera): void {
    if (!this.jittered) return;
    this.jittered = false;
    // A projection recomputed during the frame (a field-of-view change) carries no jitter: keep it.
    if (camera.projectionMatrix.equals(this.jitterMatrix)) {
      camera.projectionMatrix.copy(this.unjittered);
      camera.projectionMatrixInverse.copy(this.unjittered).invert();
    } else {
      this.unjittered.copy(camera.projectionMatrix);
    }
    this.prevVP.multiplyMatrices(this.unjittered, camera.matrixWorldInverse);
    this.prevCam.setFromMatrixPosition(camera.matrixWorld);
  }

  /** The camera's projection without this frame's TAA jitter. */
  projection(camera: THREE.PerspectiveCamera): THREE.Matrix4 {
    return this.jittered ? this.unjittered : camera.projectionMatrix;
  }

  /** The TAA history starts over next frame (after a teleport or a cut). */
  resetHistory(): void {
    this.taaValid = false;
  }

  private pass(mat: THREE.Material, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /** Render the scene through the full pipeline to the canvas. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, dt: number, time: number): void {
    const r = this.renderer;
    const pr = this.prof;
    const cu = this.composite.uniforms;
    // Camera uniforms first: the sky pass draws inside the scene render with them.
    (cu.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (cu.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    cu.uViewAltKm.value = Math.max(camera.position.y / 1000, 0.01);
    cu.uTime.value = time;
    pr?.begin('render');
    pr?.gpu('opaque');
    // With TAA the overlays wait for the resolve (see resolveTaa).
    const taa = this.jittered;
    for (let k = 0; k < this.overlays.length; k++) {
      this.overlayShown[k] = this.overlays[k].visible;
      if (taa) this.overlays[k].visible = false;
    }
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, false);
    r.render(scene, camera);
    pr?.end('render');
    if (this.secondPass) {
      pr?.begin('render.water');
      pr?.gpu('water');
      if (pr) pr.pass = 'water';
      // Draw the second layer (water) into the same target in a single render call, sampling the opaque
      // frame: with MSAA straight from the resolved textures (they are not the buffers being drawn
      // into); otherwise from copies. Where resolving discards the multisampled colour (restoreColor),
      // a full-screen quad on that layer writes it back first; the depth samples are kept.
      if (!this.directRefraction) {
        this.pass(this.mCopyColor, this.refrColor);
        this.pass(this.mCopyDepth, this.refrDepth);
      }
      const autoClear = r.autoClear;
      const autoShadow = r.shadowMap.autoUpdate;
      const layers = camera.layers.mask;
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;
      camera.layers.set(this.secondLayer);
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);
      camera.layers.mask = layers;
      r.autoClear = autoClear;
      r.shadowMap.autoUpdate = autoShadow;
      pr?.end('render.water');
    }
    pr?.begin('post');
    if (pr) pr.pass = 'post';
    // Ambient occlusion at half resolution from a half-resolution linear depth (made once, read by the
    // AO and both blur passes without re-projecting), blurred along x then y (depth-aware).
    cu.uAOK.value = this.settings.ao ? 0.75 : 0;
    if (this.settings.ao) {
      pr?.gpu('ao');
      (this.mAODepth.uniforms.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      this.pass(this.mAODepth, this.aoDepthRT);
      const a = this.mAO.uniforms;
      const pe = camera.projectionMatrix.elements;
      (a.uTan.value as THREE.Vector2).set(1 / pe[0], 1 / pe[5]);
      a.uProjScale.value = pe[5] * this.aoRT.height * 0.5;
      (a.uTexel.value as THREE.Vector2).set(1 / this.aoRT.width, 1 / this.aoRT.height);
      this.pass(this.mAO, this.aoRT);
      const b = this.mAOBlur.uniforms;
      b.tAO.value = this.aoRT.texture;
      (b.uDir.value as THREE.Vector2).set(1 / this.aoRT.width, 0);
      this.pass(this.mAOBlur, this.aoBlurRT);
      b.tAO.value = this.aoBlurRT.texture;
      (b.uDir.value as THREE.Vector2).set(0, 1 / this.aoRT.height);
      this.pass(this.mAOBlur, this.aoRT);
    }
    pr?.gpu('composite');
    this.pass(this.composite, this.compRT);
    let comp = this.compRT;
    if (taa) {
      pr?.gpu('taa');
      comp = this.resolveTaa(camera);
    }
    if (this.dof) {
      // Circle of confusion on a 24 mm tall sensor, in pixels; blur radius capped for cost.
      const du = this.mDof.uniforms;
      (du.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      (du.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
      du.uFocal.value = this.dof.focal;
      du.uAperture.value = this.dof.aperture;
      du.uFocus.value = Math.max(this.dof.focus, this.dof.focal * 1.5);
      du.uPxPerM.value = this.height / 0.024;
      du.uMaxR.value = Math.max(4, Math.round((this.height / 1080) * 22));
      this.pass(this.mDof, this.dofRT);
      comp = this.dofRT;
    }
    this.mLum.uniforms.tColor.value = comp.texture;
    this.final.uniforms.tColor.value = comp.texture;
    // Sharper as the render scale drops (the resolve has fewer samples per output pixel to work with).
    this.final.uniforms.uSharpen.value = taa ? 0.35 + 0.6 * (1 - this.rw / this.width) : 0;

    // Auto exposure.
    pr?.gpu('bloom+exposure');
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
    let src: THREE.Texture = comp.texture;
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
      // up[k] = down[k] + upsample(up[k+1]), one pass per level.
      uu.tSrc.value = this.bloomDown[k].texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / this.bloomDown[k].width, 1 / this.bloomDown[k].height);
      const prev = k < BLOOM_LEVELS - 1 ? this.bloomUp[k + 1] : null;
      uu.uHasPrev.value = prev ? 1 : 0;
      uu.tPrev.value = prev ? prev.texture : this.bloomDown[k].texture;
      if (prev) (uu.uTexelPrev.value as THREE.Vector2).set(1 / prev.width, 1 / prev.height);
      this.pass(this.mUp, this.bloomUp[k]);
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
    fu.uBarrel.value = this.settings.barrel;
    pr?.gpu('final');
    if (this.settings.fxaa) {
      this.pass(this.final, this.ldrRT);
      this.pass(this.mFxaa, null);
    } else {
      this.pass(this.final, null);
    }
    pr?.gpuStop();
    pr?.end('post');
  }

  /** TAA resolve into the history, then the overlays over a copy of it; returns the target to post-process. */
  private resolveTaa(camera: THREE.PerspectiveCamera): THREE.WebGLRenderTarget {
    const camPos = _camPos.setFromMatrixPosition(camera.matrixWorld);
    const u = this.mTaa.uniforms;
    u.tCur.value = this.compRT.texture;
    u.tHist.value = this.histB.texture;
    (u.uInvProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.uCamWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    (u.uPrevVP.value as THREE.Matrix4).copy(this.prevVP);
    (u.uJitter.value as THREE.Vector2).copy(this.jitter);
    (u.uTexel.value as THREE.Vector2).set(1 / this.rw, 1 / this.rh);
    (u.uOutTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    u.uReset.value = !this.taaValid || camPos.distanceTo(this.prevCam) > TAA_CUT ? 1 : 0;
    this.pass(this.mTaa, this.histA);
    [this.histA, this.histB] = [this.histB, this.histA];
    this.taaValid = true;
    let out = this.histB;
    let any = false;
    for (let k = 0; k < this.overlays.length; k++) {
      this.overlays[k].visible = this.overlayShown[k];
      any ||= this.overlayShown[k] && hasVisibleMesh(this.overlays[k]);
    }
    if (any) {
      // Not in the history (they would smear): drawn unjittered into the scene target's colour, cleared
      // to transparent (the composite has consumed it; its depth still holds the scene, so they are
      // depth-tested), which with normal blending leaves a premultiplied layer; then blended over the
      // resolved frame at the output size.
      const r = this.renderer;
      const autoClear = r.autoClear;
      const autoShadow = r.shadowMap.autoUpdate;
      r.getClearColor(_clear);
      const clearAlpha = r.getClearAlpha();
      r.setRenderTarget(this.sceneRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, false, false);
      r.autoClear = false;
      r.shadowMap.autoUpdate = false;
      _jit.copy(camera.projectionMatrix);
      camera.projectionMatrix.copy(this.unjittered);
      for (let k = 0; k < this.overlays.length; k++) if (this.overlayShown[k]) r.render(this.overlays[k], camera);
      camera.projectionMatrix.copy(_jit);
      r.autoClear = autoClear;
      r.shadowMap.autoUpdate = autoShadow;
      r.setClearColor(_clear, clearAlpha);
      this.mOverlay.uniforms.tBase.value = out.texture;
      this.mOverlay.uniforms.tOver.value = this.sceneRT.texture;
      this.pass(this.mOverlay, this.displayRT);
      out = this.displayRT;
    }
    return out;
  }
}

const _camPos = new THREE.Vector3();
const _jit = new THREE.Matrix4();
const _clear = new THREE.Color();

/** Some mesh under `o` (or `o` itself) is visible. */
function hasVisibleMesh(o: THREE.Object3D): boolean {
  if (!o.visible) return false;
  if ((o as THREE.Mesh).isMesh) return true;
  for (const c of o.children) if (hasVisibleMesh(c)) return true;
  return false;
}
