import * as THREE from 'three';
import { atmosphereCommon, skyViewLookup } from './atmosphereGlsl';
import { cloudGlsl, cloudSkyGlsl, worldLightUniforms } from '../WorldLight';
import type { Atmosphere } from './Atmosphere';

const envVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const envFrag = /* glsl */ `
${atmosphereCommon}
${skyViewLookup}
uniform sampler2D tSkySun;
uniform sampler2D tSkyMoon;
uniform sampler2D uTransmittance;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunE;
uniform float uMoonE;
uniform float uViewAltKm;
uniform vec3 uGroundAlbedo;
uniform vec3 uCloudGlow;
varying vec3 vDir;
${cloudGlsl}
vec3 cwSkyLut(vec3 dir) {
  return texture2D(tSkySun, skyViewUv(dir, uSunDir, uViewAltKm)).rgb * uSunE
       + texture2D(tSkyMoon, skyViewUv(dir, uMoonDir, uViewAltKm)).rgb * uMoonE;
}
${cloudSkyGlsl}
void main() {
  vec3 dir = normalize(vDir);
  vec3 pos = vec3(0.0, Rg + uViewAltKm, 0.0);
  vec3 sunT = texture2D(uTransmittance, lutUv(pos, uSunDir)).rgb;
  // Sky with the overcast blend and the cloud deck (cloud pattern around the origin).
  vec3 sky = cwSky(dir, cwSkyLut(dir), sunT);
  vec4 cl = cwCloudLayer(vec3(0.0, uViewAltKm * 1000.0, 0.0), dir, 1e9, sunT);
  sky = mix(sky, cl.rgb, cl.a);
  if (dir.y < 0.0) {
    // Below the horizon: reflected light from the ground plus the atmosphere between.
    vec3 zenith = cwSkyLut(vec3(0.0, 1.0, 0.0));
    vec3 E = sunT * uSunE * max(uSunDir.y, 0.0) * mix(1.0, 0.25, cwOvercastK()) + zenith * 3.14159;
    E = mix(E, cwOvercast(vec3(0.0, 1.0, 0.0), sunT) * 3.14159 * 7.0 / 9.0, cwOvercastK());
    vec3 ground = uGroundAlbedo * E / 3.14159;
    sky = mix(sky, ground, smoothstep(0.0, -0.08, dir.y));
  }
  gl_FragColor = vec4(sky, 1.0);
}
`;

/** Renders the sky into a cube map and prefilters it (PMREM) for image-based lighting. */
export class SkyEnvironment {
  private readonly cubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
  private readonly cubeCam = new THREE.CubeCamera(1, 1000, this.cubeRT);
  private readonly scene = new THREE.Scene();
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  readonly material: THREE.ShaderMaterial;
  private lastSun = new THREE.Vector3(0, -2, 0);
  private lastMoon = new THREE.Vector3(0, -2, 0);
  private lastCover = -1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    atmosphere: Atmosphere,
  ) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.material = new THREE.ShaderMaterial({
      vertexShader: envVert,
      fragmentShader: envFrag,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        tSkySun: { value: atmosphere.skyViewSun.texture },
        tSkyMoon: { value: atmosphere.skyViewMoon.texture },
        uTransmittance: { value: atmosphere.transmittance.texture },
        uHaze: atmosphere.haze,
        uSunDir: { value: new THREE.Vector3() },
        uMoonDir: { value: new THREE.Vector3() },
        uSunE: { value: 10 },
        uMoonE: { value: 0 },
        uViewAltKm: { value: 0.7 },
        uGroundAlbedo: { value: new THREE.Vector3(0.1, 0.1, 0.09) },
        uCloudCover: worldLightUniforms.uCloudCover,
        uCloudOffset: worldLightUniforms.uCloudOffset,
        uCloudShadowK: worldLightUniforms.uCloudShadowK,
        uCloudSunDir: worldLightUniforms.uCloudSunDir,
        uCloudGlow: worldLightUniforms.uCloudGlow,
      },
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material));
  }

  get texture(): THREE.Texture | null {
    return this.envRT?.texture ?? null;
  }

  /** Re-render when the sun or moon moved noticeably. Returns true if refreshed. */
  update(sunDir: THREE.Vector3, moonDir: THREE.Vector3, sunE: number, moonE: number, altKm: number, force = false): boolean {
    const cover = worldLightUniforms.uCloudCover.value;
    if (!force && sunDir.angleTo(this.lastSun) < 0.004 && moonDir.angleTo(this.lastMoon) < 0.01 && Math.abs(cover - this.lastCover) < 0.03) return false;
    this.lastCover = cover;
    this.lastSun.copy(sunDir);
    this.lastMoon.copy(moonDir);
    const u = this.material.uniforms;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(moonDir);
    u.uSunE.value = sunE;
    u.uMoonE.value = moonE;
    u.uViewAltKm.value = altKm;
    const prev = this.renderer.getRenderTarget();
    this.cubeCam.update(this.renderer, this.scene);
    const next = this.pmrem.fromCubemap(this.cubeRT.texture);
    this.envRT?.dispose();
    this.envRT = next;
    this.renderer.setRenderTarget(prev);
    return true;
  }
}
