import * as THREE from 'three';

/**
 * Lighting terms shared by every lit material, injected with `worldLit(material)`:
 *  - night light pools: a top-down irradiance field around the camera, splatted from street
 *    lights (see LightField), lighting ground, roads, walls and foliage with their own albedo;
 *  - moving cloud shadows: the sun's direct light is attenuated by the cloud layer's shadow
 *    projected onto each surface.
 */
export const worldLightUniforms = {
  uLightField: { value: null as THREE.Texture | null },
  uLightFieldBox: { value: new THREE.Vector3(0, 0, 1) },
  /** Reference elevation of the light field's lamp-head heights (alpha channel). */
  uLightFieldY: { value: 0 },
  uNightLightK: { value: 0 },
  uCloudCover: { value: 0.35 },
  uCloudOffset: { value: new THREE.Vector2() },
  uCloudShadowK: { value: 0 },
  uCloudSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** Town light reflected by the cloud base at night (sky glow). */
  uCloudGlow: { value: new THREE.Vector3() },
  /** Rain wetness: darker diffuse, glossier up-facing surfaces. */
  uWLWet: { value: 0 },
  /** Vehicle low beams: lamp position, world->vehicle basis (rows forward, up, right), strength. */
  uHeadPos: { value: new THREE.Vector3() },
  uHeadMat: { value: new THREE.Matrix3() },
  uHeadK: { value: 0 },
};

/** Shared cloud uniforms and density (also used by the sky composite, sky probe and water). World units: metres. */
export const CLOUD_BASE = 2400.0;
export const cloudGlsl = /* glsl */ `
uniform float uCloudCover;
uniform vec2 uCloudOffset;
uniform float uCloudShadowK;
uniform vec3 uCloudSunDir;
float cwcHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float cwcNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(cwcHash(i), cwcHash(i + vec2(1, 0)), u.x), mix(cwcHash(i + vec2(0, 1)), cwcHash(i + vec2(1, 1)), u.x), u.y);
}
float cwcFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) { s += a * cwcNoise(p); p = r * p * 2.03; a *= 0.5; }
  return s;
}
// Cloud density (0..1) at a point of the cloud layer, for a coverage 0 (clear) .. 1 (overcast).
float cloudDensity(vec2 xz, float cover, vec2 offset) {
  vec2 p = (xz + offset) / 2600.0;
  float base = cwcFbm(p);
  float detail = cwcFbm(p * 4.3 + 7.1);
  float d = base * 0.75 + detail * 0.25;
  float thr = mix(0.78, 0.2, cover);
  return clamp((d - thr) / 0.18, 0.0, 1.0);
}
// Direct-light factor at a world point: where the ray towards the sun (or moon) meets the deck.
float cloudShadow(vec3 wpos) {
  if (uCloudShadowK <= 0.0 || uCloudSunDir.y <= 0.05) return 1.0;
  vec2 cp = wpos.xz + uCloudSunDir.xz / uCloudSunDir.y * (${CLOUD_BASE.toFixed(1)} - wpos.y);
  float cs = cloudDensity(cp, uCloudCover, uCloudOffset);
  return 1.0 - uCloudShadowK * smoothstep(0.05, 0.6, cs);
}
`;

/**
 * Sky seen through the cloud deck. The host shader defines `vec3 cwSkyLut(vec3 dir)` (sky
 * radiance without sun/moon disks) and the uniforms uSunDir, uSunE, uMoonDir, uMoonE, uCloudGlow.
 */
export const cloudSkyGlsl = /* glsl */ `
// How much of the sky is a uniform overcast deck (vs. broken clouds with blue between).
float cwOvercastK() { return smoothstep(0.55, 0.95, uCloudCover); }
// Overcast dome (CIE overcast luminance distribution, zenith three times the horizon) lit by
// the fraction of the clear-sky global irradiance the deck transmits.
vec3 cwOvercast(vec3 dir, vec3 sunT) {
  vec3 E = sunT * uSunE * max(uSunDir.y, 0.0) + cwSkyLut(vec3(0.0, 1.0, 0.0)) * 3.14159
         + vec3(uMoonE) * max(uMoonDir.y, 0.0);
  float tau = mix(0.42, 0.2, smoothstep(0.85, 1.0, uCloudCover));
  float Lz = 9.0 * tau / (7.0 * 3.14159);
  return E * Lz * (1.0 + 2.0 * max(dir.y, 0.0)) / 3.0 * vec3(0.94, 0.98, 1.04) + uCloudGlow;
}
// Cloud deck along a ray from org: radiance in rgb, coverage in a (0 = sky shows through).
vec4 cwCloudLayer(vec3 org, vec3 dir, float maxDist, vec3 sunT) {
  if (dir.y <= 1e-4 || uCloudCover <= 0.01) return vec4(0.0);
  float t = (${CLOUD_BASE.toFixed(1)} - org.y) / dir.y;
  if (t <= 0.0 || t > maxDist) return vec4(0.0);
  vec2 p = org.xz + dir.xz * t;
  float d = cloudDensity(p, uCloudCover, uCloudOffset);
  if (d <= 0.0) return vec4(0.0);
  // Broken cumulus: sunlit with a forward-scattering lobe, self-shadowed towards the sun.
  vec2 toSun = uSunDir.xz / max(uSunDir.y, 0.08) * 260.0;
  float ds = cloudDensity(p + toSun, uCloudCover, uCloudOffset);
  float fwd = 0.6 + 1.6 * pow(max(dot(dir, uSunDir), 0.0), 12.0);
  vec3 sunLit = sunT * uSunE * 0.2 * exp(-2.2 * ds) * fwd * smoothstep(-0.05, 0.1, uSunDir.y);
  vec3 amb = cwSkyLut(normalize(vec3(0.3, 1.0, 0.2))) * (0.9 - 0.35 * d) + vec3(uMoonE) * max(uMoonDir.y, 0.0) * 0.08 + uCloudGlow;
  vec3 cloud = mix(sunLit + amb, cwOvercast(dir, sunT) * mix(1.0, 0.8, d), cwOvercastK());
  // Distant cloud dissolves into the sky (aerial perspective) and thins at the horizon.
  float fade = exp(-t / 45000.0);
  float a = d * mix(0.55, 1.0, d) * smoothstep(0.0, 0.06, dir.y) * fade;
  return vec4(cloud, a);
}
// Sky radiance (without disks) with the overcast blend applied.
vec3 cwSky(vec3 dir, vec3 sky, vec3 sunT) {
  return mix(sky, cwOvercast(dir, sunT), cwOvercastK() * smoothstep(-0.1, 0.02, dir.y));
}
`;

export function worldLit<T extends THREE.Material>(m: T): T {
  if ((m as unknown as { __worldLit?: boolean }).__worldLit) return m;
  (m as unknown as { __worldLit?: boolean }).__worldLit = true;
  const prev = m.onBeforeCompile;
  const defaultKey = m.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const prevSrc = prev.toString();
  m.onBeforeCompile = (shader, renderer) => {
    prev.call(m, shader, renderer);
    Object.assign(shader.uniforms, worldLightUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWLWorld;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        {
          vec4 wlw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            wlw = instanceMatrix * wlw;
          #endif
          vWLWorld = (modelMatrix * wlw).xyz;
        }`);
    const wet = !(m.userData as { wlNoWet?: boolean }).wlNoWet;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWLWorld;
        uniform sampler2D uLightField;
        uniform vec3 uLightFieldBox;
        uniform float uLightFieldY;
        uniform float uNightLightK;
        uniform float uWLWet;
        uniform vec3 uHeadPos;
        uniform mat3 uHeadMat;
        uniform float uHeadK;
        ${cloudGlsl}`)
      .replace('#include <lights_physical_fragment>', `
        #if defined(STANDARD)
        if (uWLWet > 0.0 && ${wet ? 'true' : 'false'}) {
          // Rain: water fills the pores (darker diffuse) and films up-facing surfaces (gloss).
          float wlUp = clamp(inverseTransformDirection(normal, viewMatrix).y, 0.0, 1.0);
          diffuseColor.rgb *= 1.0 - 0.28 * uWLWet;
          float film = uWLWet * wlUp * wlUp * (1.0 - smoothstep(0.7, 0.95, roughnessFactor));
          roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45, film);
        }
        #endif
        #include <lights_physical_fragment>`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          float k = cloudShadow(vWLWorld);
          reflectedLight.directDiffuse *= k;
          reflectedLight.directSpecular *= k;
          if (uNightLightK > 0.0) {
            // The field is rendered north-up: v runs from the south edge (v = 0) to the north edge.
            vec2 luv = vec2((vWLWorld.x - uLightFieldBox.x) / uLightFieldBox.z, 1.0 - (vWLWorld.z - uLightFieldBox.y) / uLightFieldBox.z);
            if (all(greaterThan(luv, vec2(0.0))) && all(lessThan(luv, vec2(1.0)))) {
              vec4 L = texture2D(uLightField, luv);
              // Full cut-off luminaires light only what is below their heads: alpha holds the
              // light-weighted lamp-head elevation, so roofs and tree crowns above stay dark.
              float lw = dot(L.rgb, vec3(0.3333));
              float headY = L.a / max(lw, 1e-7) + uLightFieldY;
              float below = smoothstep(headY + 0.3, headY - 1.5, vWLWorld.y);
              vec3 nW = inverseTransformDirection(normal, viewMatrix);
              float facing = clamp(nW.y, 0.0, 1.0) * 0.7 + 0.3;
              reflectedLight.directDiffuse += L.rgb * below * facing * BRDF_Lambert(material.diffuseColor) * uNightLightK;
            }
          }
          if (uHeadK > 0.0) {
            // Low beams: wide horizontal fan, sharp cut-off just below the horizon, plus near spill.
            vec3 hv = vWLWorld - uHeadPos;
            vec3 lp = uHeadMat * hv;
            if (lp.x > 0.3) {
              float d2 = dot(hv, hv);
              float ah = atan(lp.z, lp.x);
              float av = atan(lp.y, lp.x);
              float beam = exp(-ah * ah / 0.16) * smoothstep(0.015, -0.02, av) + 0.12 * exp(-ah * ah / 1.1) * smoothstep(0.0, -0.25, av);
              vec3 nW = inverseTransformDirection(normal, viewMatrix);
              float ndl = max(dot(nW, -hv * inversesqrt(d2)), 0.0);
              reflectedLight.directDiffuse += vec3(1.0, 0.95, 0.86) * (uHeadK * 80.0 * beam * ndl / max(d2, 1.0)) * BRDF_Lambert(material.diffuseColor);
            }
          }
        }`);
  };
  if (defaultKey) m.customProgramCacheKey = () => `wl-${(m.userData as { wlNoWet?: boolean }).wlNoWet ? 'd' : 'w'}-${prevSrc}`;
  return m;
}

/**
 * Top-down street-light irradiance around the camera: each lamp splats the illuminance of a
 * point source at its head height (cosine law) into a half-float target; re-rendered when the
 * camera has moved or the light list changes.
 */
export class LightField {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly cam: THREE.OrthographicCamera;
  private readonly mesh: THREE.InstancedMesh;
  private lights: Float32Array = new Float32Array(0); // x, z, h, intensity, r, g, b, headY per light
  private last = new THREE.Vector3(1e9, 0, 1e9);
  readonly size = 700;
  private dirty = true;

  constructor(res = 512) {
    this.target = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.cam.up.set(0, 0, -1);
    this.cam.lookAt(0, -1, 0);
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(4 * 4096), 4);
    const col = new THREE.InstancedBufferAttribute(new Float32Array(4 * 4096), 4);
    geo.setAttribute('aLight', inst);
    geo.setAttribute('aColor', col);
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        attribute vec4 aLight; // x, z, head height, intensity
        attribute vec4 aColor; // r, g, b, head elevation relative to the field's reference
        varying vec2 vRel;
        varying float vH;
        varying float vI;
        varying vec3 vCol;
        varying float vHY;
        void main() {
          float R = 38.0;
          vec3 p = vec3(aLight.x + position.x * 2.0 * R, 0.0, aLight.y + position.z * 2.0 * R);
          vRel = position.xz * 2.0 * R;
          vH = aLight.z;
          vI = aLight.w;
          vCol = aColor.rgb;
          vHY = aColor.a;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vRel;
        varying float vH;
        varying float vI;
        varying vec3 vCol;
        varying float vHY;
        void main() {
          float r2 = dot(vRel, vRel);
          // Horizontal illuminance from a point source: E = I h / (r^2 + h^2)^1.5, soft window at 38 m.
          float e = vI * vH / pow(r2 + vH * vH, 1.5);
          e *= 1.0 - smoothstep(26.0 * 26.0, 38.0 * 38.0, r2);
          vec3 c = vCol * e;
          gl_FragColor = vec4(c, dot(c, vec3(0.3333)) * vHY);
        }`,
      // Plain sums in every channel (alpha accumulates light-weighted head elevations).
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, 4096);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    worldLightUniforms.uLightField.value = this.target.texture;
  }

  /** Lights as [x, z, headHeight, intensity(cd-like), r, g, b, headElevation]. */
  setLights(list: number[][]): void {
    this.lights = new Float32Array(list.flat());
    this.dirty = true;
  }

  update(renderer: THREE.WebGLRenderer, cam: THREE.Vector3, night: number): void {
    worldLightUniforms.uNightLightK.value = night;
    if (night <= 0.01) return;
    if (!this.dirty && Math.hypot(cam.x - this.last.x, cam.z - this.last.z) < 60 && Math.abs(cam.y - this.last.y) < 40) return;
    this.dirty = false;
    this.last.copy(cam);
    const half = this.size / 2;
    const cx = Math.round(cam.x / 10) * 10;
    const cz = Math.round(cam.z / 10) * 10;
    worldLightUniforms.uLightFieldBox.value.set(cx - half, cz - half, this.size);
    this.cam.left = -half;
    this.cam.right = half;
    this.cam.top = half;
    this.cam.bottom = -half;
    this.cam.position.set(cx, 5, cz);
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
    const L = this.lights;
    const a = this.mesh.geometry.getAttribute('aLight') as THREE.InstancedBufferAttribute;
    const c = this.mesh.geometry.getAttribute('aColor') as THREE.InstancedBufferAttribute;
    let n = 0;
    const yRef = Math.round(cam.y);
    worldLightUniforms.uLightFieldY.value = yRef;
    for (let k = 0; k + 7 < L.length && n < 4096; k += 8) {
      if (Math.abs(L[k] - cx) > half + 40 || Math.abs(L[k + 1] - cz) > half + 40) continue;
      a.setXYZW(n, L[k], L[k + 1], L[k + 2], L[k + 3]);
      c.setXYZW(n, L[k + 4], L[k + 5], L[k + 6], L[k + 7] - yRef);
      n++;
    }
    a.needsUpdate = true;
    c.needsUpdate = true;
    this.mesh.count = n;
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    const autoShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.render(this.scene, this.cam);
    renderer.shadowMap.autoUpdate = autoShadow;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
  }
}
