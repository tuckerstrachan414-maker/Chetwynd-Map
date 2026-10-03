import * as THREE from 'three';

/**
 * Cascaded shadow maps (CSM) for the sun, rendered through three's sun-light shadow path
 * (three/examples/jsm/lights/SunLight: per-fragment cascade selection in every built-in material).
 *
 * The view frustum up to `maxDistance` is cut into four depth slices (practical split scheme: crisp
 * near the eye, coarse far away). Each slice gets its own orthographic light camera fitted to the
 * slice's bounding sphere and snapped to its texel grid (no shimmering), drawn into one tile of a
 * 2x2 depth atlas; fragments pick their cascade by view depth and blend over a short band.
 *
 * Distant cascades cost the most (they see the most casters) yet change the least, so they are
 * refreshed less often (per quality level, e.g. 0 every frame, 1 every second frame, 2 every fourth,
 * 3 every eighth), on staggered frames so the load is even: each frame redraws cascade 0 and at most
 * one other (`phase`), instead of the far cascades piling onto the same frames. A stale tile keeps the light camera it was drawn with, so
 * lookups stay consistent; its sphere carries a margin and it is redrawn early when the camera has
 * moved or turned more than that margin covers, or when the light moved. Tiles that are not redrawn
 * are not cleared (see `clearDue`).
 */
export const CASCADES = 4;

// three's sun-light chunks are written for two cascades with one normal bias; this build uses four,
// with the normal offset scaled per cascade by its texel size (`cascade.w`, metres) so the big texels
// of distant cascades get the bigger offset they need while near shadows stay attached.
THREE.ShaderChunk.shadowmap_pars_fragment = THREE.ShaderChunk.shadowmap_pars_fragment
  .replace('#define SUN_LIGHT_CASCADES 2', `#define SUN_LIGHT_CASCADES ${CASCADES}`)
  .replace(
    'vec4 shadowWorldPosition = vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * sunLightShadow.shadowNormalBias, 1.0 );',
    'vec3 shadowWorldPos = vSunShadowWorldPosition.xyz;',
  )
  .replace(
    'sunShadowMatrix[ cascadeOffset + i ] * shadowWorldPosition',
    'sunShadowMatrix[ cascadeOffset + i ] * vec4( shadowWorldPos + vSunShadowWorldNormal * ( sunLightShadow.shadowNormalBias * cascade.w ), 1.0 )',
  );

export interface CascadeSettings {
  /** Resolution of one cascade tile (the atlas is twice this on each side). */
  size: number;
  /** Shadows reach this far from the eye (m). */
  maxDistance: number;
  /** Refresh interval of each cascade in frames. */
  interval: readonly number[];
}

/** LightShadow members the renderer reads that three's type declarations leave out. */
interface ShadowInternals {
  _frameExtents: THREE.Vector2;
  _viewportCount: number;
  _viewports: THREE.Vector4[];
  _updateMatrix(camera: THREE.Camera, matrix: THREE.Matrix4, frustum: THREE.Frustum, viewport?: THREE.Vector4): void;
}

const _orient = new THREE.Matrix4();
const _orientInv = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();
const _p = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Shadow of a `SunLight` with four scheduled cascades. */
export class CascadedSunShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
  readonly isSunLightShadow = true;
  readonly cameras: THREE.OrthographicCamera[] = [];
  readonly matrices: THREE.Matrix4[] = [];
  readonly frustums: THREE.Frustum[] = [];
  /** Per cascade: (begin, end, fade start) view depths and the normal offset per unit normalBias (m). */
  readonly _cascadeData: THREE.Vector4[] = [];
  /** Slice boundaries (view depth, m), CASCADES + 1 values. */
  readonly splits = new Float32Array(CASCADES + 1);
  /** Per cascade: instanced casters farther than this from the eye cannot reach its slice (m). */
  readonly reach = new Float32Array(CASCADES);
  settings: CascadeSettings = { size: 2048, maxDistance: 600, interval: [1, 1, 2, 4] };
  /** Weight of logarithmic against uniform splits. */
  lambda = 0.86;
  /** Cascades the current frame redraws, in render order. */
  readonly due: number[] = [];
  /** Inside the renderer's shadow pass: the viewport loop walks only the due cascades. */
  rendering = false;
  /** Shared depth range of the light cameras (m), for converting world biases. */
  depthRange = 2000;
  private frame = 0;
  private forceAll = true;
  /** Per cascade: the eye position, view direction and light direction it was drawn with. */
  private readonly drawnEye: THREE.Vector3[] = [];
  private readonly drawnFwd: THREE.Vector3[] = [];
  private readonly drawnLight: THREE.Vector3[] = [];
  private readonly drawnRadius = new Float32Array(CASCADES);
  private lastAspect = 0;
  private lastFov = 0;
  private readonly internals: ShadowInternals;

  constructor() {
    super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
    this.internals = this as unknown as ShadowInternals;
    this.internals._frameExtents.set(2, 2);
    this.internals._viewportCount = CASCADES;
    for (let i = 0; i < CASCADES; i++) {
      const cam = new THREE.OrthographicCamera();
      cam.userData.cascade = i;
      this.cameras.push(cam);
      this.matrices.push(new THREE.Matrix4());
      this.frustums.push(new THREE.Frustum());
      this._cascadeData.push(new THREE.Vector4());
      this.drawnEye.push(new THREE.Vector3(1e9, 0, 0));
      this.drawnFwd.push(new THREE.Vector3());
      this.drawnLight.push(new THREE.Vector3());
      if (i >= this.internals._viewports.length) this.internals._viewports.push(new THREE.Vector4());
    }
    this.mapSize.set(this.settings.size, this.settings.size);
  }

  configure(s: CascadeSettings): void {
    this.settings = s;
    if (this.mapSize.x !== s.size) this.mapSize.set(s.size, s.size);
    this.forceAll = true;
    // Stagger the periodic cascades: each takes the phase whose frames carry the least work so far.
    const period = Math.max(...s.interval);
    const load = new Array<number>(period).fill(0);
    for (let i = 0; i < CASCADES; i++) {
      const n = s.interval[i];
      let best = 0, bestMax = Infinity;
      for (let p = 0; p < n; p++) {
        let m = 0;
        for (let f = p; f < period; f += n) m = Math.max(m, load[f]);
        if (m < bestMax) {
          bestMax = m;
          best = p;
        }
      }
      this.phase[i] = best;
      for (let f = best; f < period; f += n) load[f]++;
    }
  }

  /** Per cascade: the frame (modulo its interval) it is redrawn on. */
  private readonly phase = new Int32Array(CASCADES);

  /** Redraw every cascade next frame (after a teleport, a quality change, a jump in time of day). */
  invalidate(): void {
    this.forceAll = true;
  }

  override getViewportCount(): number {
    return this.rendering ? this.due.length : CASCADES;
  }

  override getViewport(face: number): THREE.Vector4 {
    return this.internals._viewports[this.rendering ? this.due[face] : face];
  }

  override getCamera(face = 0): THREE.OrthographicCamera {
    return this.cameras[this.rendering ? this.due[face] : face];
  }

  /**
   * Called as the renderer starts drawing a cascade's tile (with its index), so per-cascade caster
   * sets can be shown just for their own cascade instead of being visited, empty, by every cascade.
   */
  onCascade: ((cascade: number) => void) | null = null;

  override getFrustum(face = 0): THREE.Frustum {
    if (!this.rendering) return this.frustums[face];
    // The renderer asks for the frustum once per tile, right before drawing into it.
    const c = this.due[face];
    this.onCascade?.(c);
    return this.frustums[c];
  }

  getMatrix(cascade = 0): THREE.Matrix4 {
    return this.matrices[cascade];
  }

  /** The renderer calls this once per shadow pass; the cascades were fitted in `prepare`. */
  override updateMatrices(): void {
    /* fitted in prepare() */
  }

  /**
   * Fit the cascades due this frame to the view. `lightDir` points towards the sun (or moon).
   * Call after the camera's matrices are current and before the frame renders.
   */
  prepare(view: THREE.PerspectiveCamera, lightDir: THREE.Vector3, reversedDepth: boolean): void {
    this.frame++;
    const s = this.settings;
    const n = Math.max(view.near, 0.05);
    const f = Math.max(n + 1, Math.min(s.maxDistance, view.far));
    // Practical split scheme with the logarithmic part measured from 1 m (not the 0.1 m near plane).
    const splits = this.splits;
    splits[0] = n;
    for (let i = 1; i < CASCADES; i++) {
      const k = i / CASCADES;
      splits[i] = this.lambda * Math.pow(f, k) + (1 - this.lambda) * (n + (f - n) * k);
    }
    splits[CASCADES] = f;
    if (view.aspect !== this.lastAspect || view.fov !== this.lastFov) {
      this.lastAspect = view.aspect;
      this.lastFov = view.fov;
      this.forceAll = true;
    }

    // Light space: a rotation of world space, +z towards the light.
    _dir.copy(lightDir).normalize().negate();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_dir)) > 0.99) _up.set(0, 0, 1);
    _orient.lookAt(_c.set(0, 0, 0), _dir, _up);
    _orientInv.copy(_orient).transpose();
    _viewToLight.multiplyMatrices(_orientInv, view.matrixWorld);
    // Lateral extent of the view frustum per metre of depth, from the field of view (not the projection
    // matrix, which carries the TAA jitter: the fit must not change from frame to frame).
    const cy = Math.tan(THREE.MathUtils.degToRad(view.fov) / 2) / view.zoom;
    const cx = cy * view.aspect;
    const diag = Math.hypot(cx, cy);
    // Depth range of the whole shadowed frustum in light space.
    let maxZ = -Infinity;
    let minZ = Infinity;
    for (let i = 0; i < 8; i++) {
      const d = i < 4 ? n : f;
      _p.set((i & 1 ? cx : -cx) * d, (i & 2 ? cy : -cy) * d, -d).applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, _p.z);
      minZ = Math.min(minZ, _p.z);
    }
    // Casters up to one shadow range towards the light (and the hills beyond) still cast into view.
    maxZ += f + 400;
    const range = maxZ - minZ + 2;

    _fwd.set(0, 0, -1).transformDirection(view.matrixWorld);
    const eye = view.position;
    const internals = this.internals;
    const tile = s.size;
    const inset = Math.min(0.25, (Math.ceil(this.radius) + 2) / tile);
    const usable = tile * (1 - 2 * inset);
    this.due.length = 0;
    for (let i = 0; i < CASCADES; i++) {
      const begin = i === 0 ? n : splits[i];
      const end = splits[i + 1];
      // Bounding sphere of the slice: centre on the view axis at depth cz (corners at depth z lie
      // z * diag off the axis), radius to the farther ring of corners.
      const cz = THREE.MathUtils.clamp(((end + begin) * (1 + diag * diag)) / 2, begin, end);
      const r = Math.max(Math.hypot(end - cz, end * diag), Math.hypot(cz - begin, begin * diag));
      // Cascades refreshed every frame are fitted tightly; cached ones carry a 10 % margin.
      const cached = s.interval[i] > 1;
      // Pad by a texel so snapping cannot clip the slice.
      const radius = (r * (cached ? 1.1 : 1.0)) / (1 - 1 / usable);
      const texel = (2 * radius) / usable;
      const fade = end - 0.12 * (end - begin);
      this._cascadeData[i].set(i === 0 ? -1e10 : this._cascadeData[i - 1].z, end, fade, texel * 1.5);
      // Instanced casters beyond the slice's far corners plus a tall tree's shadow cannot reach it.
      this.reach[i] = end * Math.sqrt(1 + diag * diag) + 60;
      // Due on its schedule, or because the cached fit no longer covers the view or the light moved.
      let due = this.forceAll || this.frame % s.interval[i] === this.phase[i];
      if (!due) {
        const lightTurned = lightDir.angleTo(this.drawnLight[i]);
        if (cached) {
          const drift = eye.distanceTo(this.drawnEye[i]) + _fwd.angleTo(this.drawnFwd[i]) * cz;
          due = drift > 0.09 * this.drawnRadius[i] || lightTurned > 0.002;
        } else {
          due = lightTurned > 0.0005;
        }
      }
      if (!due) continue;
      this.due.push(i);
      this.drawnEye[i].copy(eye);
      this.drawnFwd[i].copy(_fwd);
      this.drawnLight[i].copy(lightDir);
      this.drawnRadius[i] = radius;
      // Sphere centre in light space, snapped to the tile's texel grid; the camera sits at the
      // caster ceiling. All cascades share one depth range, so a world-space bias is uniform.
      _c.copy(_fwd).multiplyScalar(cz).add(eye).applyMatrix4(_orientInv);
      _c.x = Math.round(_c.x / texel) * texel;
      _c.y = Math.round(_c.y / texel) * texel;
      _c.z = maxZ + 1;
      _c.applyMatrix4(_orient);
      const cam = this.cameras[i];
      cam.position.copy(_c);
      cam.quaternion.setFromRotationMatrix(_orient);
      cam.left = -radius;
      cam.right = radius;
      cam.top = radius;
      cam.bottom = -radius;
      cam.near = 1;
      cam.far = range;
      (cam as unknown as { _reversedDepth: boolean })._reversedDepth = reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      const vp = internals._viewports[i];
      vp.set((i % 2) + inset, Math.floor(i / 2) + inset, 1 - 2 * inset, 1 - 2 * inset);
      internals._updateMatrix(cam, this.matrices[i], this.frustums[i], vp);
    }
    this.depthRange = range;
    this.forceAll = false;
  }

  /** Depth bias for a world-space distance (all cascades share one depth range). */
  depthBias(metres: number, reversed: boolean): number {
    return (reversed ? 1 : -1) * (metres / this.depthRange);
  }

  /**
   * Clear only the tiles redrawn this frame (the renderer clears the whole atlas before its viewport
   * loop; the stale tiles must survive). Used in place of `renderer.clear` during the shadow pass.
   */
  clearDue(renderer: THREE.WebGLRenderer): void {
    const gl = renderer.getContext();
    const tile = this.mapSize.x;
    renderer.state.buffers.depth.setMask(true);
    gl.enable(gl.SCISSOR_TEST);
    for (const i of this.due) {
      gl.scissor((i % 2) * tile, Math.floor(i / 2) * tile, tile, tile);
      gl.clear(gl.DEPTH_BUFFER_BIT);
    }
    // The renderer's state cache has the scissor test off for this pass.
    gl.disable(gl.SCISSOR_TEST);
  }

  /**
   * The depth atlas: a small single-channel colour attachment (colour writes are masked off during
   * the shadow pass, so it only costs memory) and a depth texture for hardware PCF.
   */
  ensureMap(reversedDepth: boolean): void {
    const w = this.mapSize.x * 2, h = this.mapSize.y * 2;
    if (this.map && this.map.width === w && this.map.height === h) return;
    this.map?.dispose();
    this.map?.depthTexture?.dispose();
    const rt = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    const dt = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    dt.format = THREE.DepthFormat;
    dt.compareFunction = reversedDepth ? THREE.GreaterEqualCompare : THREE.LessEqualCompare;
    dt.minFilter = THREE.LinearFilter;
    dt.magFilter = THREE.LinearFilter;
    dt.name = 'sun.shadowMap';
    rt.depthTexture = dt;
    this.map = rt;
    this.forceAll = true;
  }

  /** Cascade index of a light camera the renderer is drawing with (-1 for other cameras). */
  static cascadeOf(camera: THREE.Camera): number {
    const c = camera.userData.cascade;
    return typeof c === 'number' ? c : -1;
  }
}
