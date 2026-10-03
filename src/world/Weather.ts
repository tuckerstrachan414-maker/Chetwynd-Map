import * as THREE from 'three';
import { worldLightUniforms } from '../engine/WorldLight';

export type WeatherKind = 'clear' | 'scattered' | 'overcast' | 'rain' | 'snow' | 'fog';
export const WEATHERS: WeatherKind[] = ['scattered', 'clear', 'overcast', 'rain', 'snow', 'fog'];

interface Preset {
  cover: number;
  shadow: number;
  haze: number;
  rain: number;
  snow: number;
  wet: number;
}

const PRESETS: Record<WeatherKind, Preset> = {
  clear: { cover: 0.05, shadow: 0.0, haze: 1.3, rain: 0, snow: 0, wet: 0 },
  scattered: { cover: 0.38, shadow: 0.75, haze: 1.6, rain: 0, snow: 0, wet: 0 },
  overcast: { cover: 0.9, shadow: 0.9, haze: 2.4, rain: 0, snow: 0, wet: 0 },
  rain: { cover: 0.97, shadow: 0.95, haze: 3.5, rain: 1, snow: 0, wet: 1 },
  snow: { cover: 0.95, shadow: 0.93, haze: 4.0, rain: 0, snow: 1, wet: 0 },
  fog: { cover: 0.92, shadow: 0.9, haze: 12.0, rain: 0, snow: 0, wet: 0.35 },
};

const precipVert = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec2 uWindV;
uniform float uFall;
uniform float uSnowMode;
uniform float uAmount;
attribute vec3 aSeed;
varying float vA;
varying vec2 vQ;
void main() {
  float id = float(gl_InstanceID);
  if (fract(aSeed.x * 7.13) > uAmount) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  vec3 drift = vec3(uWindV.x, -uFall, uWindV.y) * uTime;
  // Snow sways as it falls.
  if (uSnowMode > 0.5) drift.xz += vec2(sin(uTime * 0.9 + id), cos(uTime * 0.7 + id * 1.3)) * 0.35;
  vec3 p = mod(aSeed * uBox + drift - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
  vec3 vel = normalize(vec3(uWindV.x, -uFall, uWindV.y));
  vec4 mv = viewMatrix * vec4(p, 1.0);
  vec2 q = position.xy;
  vQ = q;
  if (uSnowMode > 0.5) {
    mv.xy += q * 0.03;
  } else {
    // Rain streaks: stretched along the fall direction in view space, a hair wide.
    vec3 vv = normalize((viewMatrix * vec4(vel, 0.0)).xyz);
    vec2 side = normalize(vec2(-vv.y, vv.x) + 1e-5);
    mv.xyz += vv * (q.y * 0.4) + vec3(side * q.x * 0.008, 0.0);
  }
  float dist = length(mv.xyz);
  vA = (1.0 - smoothstep(14.0, 22.0, dist)) * smoothstep(0.3, 1.2, dist);
  gl_Position = projectionMatrix * mv;
}
`;

const precipFrag = /* glsl */ `
uniform float uSnowMode;
uniform vec3 uLight;
varying float vA;
varying vec2 vQ;
void main() {
  float a;
  if (uSnowMode > 0.5) a = smoothstep(1.0, 0.2, length(vQ));
  else a = (1.0 - abs(vQ.x)) * (1.0 - abs(vQ.y) * 0.5) * 0.42;
  gl_FragColor = vec4(uLight * (uSnowMode > 0.5 ? 1.6 : 0.8), a * vA);
}
`;

/** Weather state: clouds, cloud shadows, haze, wet roads and precipitation around the camera. */
export class Weather {
  kind: WeatherKind = 'scattered';
  readonly root = new THREE.Group();
  private readonly precip: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private cur: Preset = { ...PRESETS.scattered };
  private readonly target: Preset = { ...PRESETS.scattered };
  readonly wind = new THREE.Vector2(3.0, 1.2);

  constructor() {
    const N = 16000;
    const base = new THREE.PlaneGeometry(2, 2);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setIndex(base.getIndex());
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) seeds[i] = Math.random();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
    geo.instanceCount = N;
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(44, 24, 44) },
      uWindV: { value: new THREE.Vector2() },
      uFall: { value: 7 },
      uSnowMode: { value: 0 },
      uAmount: { value: 0 },
      uLight: { value: new THREE.Color(0.3, 0.3, 0.32) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: precipVert,
      fragmentShader: precipFrag,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.precip = new THREE.Mesh(geo, mat);
    this.precip.frustumCulled = false;
    this.precip.renderOrder = 10;
    this.precip.visible = false;
    this.root.add(this.precip);
  }

  /** Switch weather; `instant` skips the gradual transition (URL parameter, screenshots). */
  set(kind: WeatherKind, instant = false): void {
    this.kind = kind;
    if (instant) this.cur = { ...PRESETS[kind] };
  }

  /** Current (blended) surface wetness 0..1. */
  get wetness(): number {
    return this.cur.wet;
  }

  cycle(): WeatherKind {
    this.kind = WEATHERS[(WEATHERS.indexOf(this.kind) + 1) % WEATHERS.length];
    return this.kind;
  }

  /** Blend towards the current preset; returns the values the world applies (haze, wetness). */
  update(dt: number, time: number, cam: THREE.Vector3, sunDir: THREE.Vector3, lightColor: THREE.Color, winter: boolean): Preset {
    const target = Object.assign(this.target, PRESETS[this.kind]);
    // Precipitation falls as snow in winter.
    if (winter && target.rain > 0) {
      target.snow = target.rain;
      target.rain = 0;
      target.wet = 0;
    }
    const k = 1 - Math.exp(-dt * 0.6);
    const c = this.cur;
    c.cover += (target.cover - c.cover) * k;
    c.shadow += (target.shadow - c.shadow) * k;
    c.haze += (target.haze - c.haze) * k;
    c.rain += (target.rain - c.rain) * k;
    c.snow += (target.snow - c.snow) * k;
    c.wet += (target.wet - c.wet) * k;
    worldLightUniforms.uCloudCover.value = c.cover;
    worldLightUniforms.uCloudShadowK.value = c.shadow;
    worldLightUniforms.uCloudSunDir.value.copy(sunDir);
    worldLightUniforms.uCloudOffset.value.set(this.wind.x * time * 4, this.wind.y * time * 4);
    const u = this.uniforms;
    const amount = Math.max(c.rain, c.snow);
    this.precip.visible = amount > 0.02;
    u.uAmount.value = amount;
    u.uTime.value = time;
    (u.uCam.value as THREE.Vector3).copy(cam);
    const snow = c.snow > c.rain;
    u.uSnowMode.value = snow ? 1 : 0;
    u.uFall.value = snow ? 1.1 : 8.5;
    (u.uWindV.value as THREE.Vector2).copy(this.wind).multiplyScalar(snow ? 0.4 : 0.6);
    // Precipitation is lit by the (diffuse) sky: a fraction of the light colour plus a floor.
    (u.uLight.value as THREE.Color).copy(lightColor).multiplyScalar(snow ? 0.12 : 0.06).addScalar(snow ? 0.05 : 0.03);
    return c;
  }
}
