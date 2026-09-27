import * as THREE from 'three';
import { atmosphereCommon, skyViewLookup } from '../../engine/sky/atmosphereGlsl';

/** Water kinds written by pipeline/water.py (meta.x). */
export const WATER_KIND = { river: 0, pond: 1, lagoon: 2, creek: 3, ditch: 4 } as const;

/** Uniforms shared by every water mesh (near chunks and the far valley mesh). */
/** Bound to the shadow sampler until the sun's shadow map exists (a sampler2DShadow needs a depth texture). */
function dummyShadow(): THREE.DepthTexture {
  const t = new THREE.DepthTexture(1, 1, THREE.FloatType);
  t.format = THREE.DepthFormat;
  t.compareFunction = THREE.GreaterEqualCompare;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  return t;
}

export function createWaterUniforms(): Record<string, THREE.IUniform> {
  return {
    tRefr: { value: null },
    tDepthC: { value: null },
    tWater: { value: null },
    tSkySun: { value: null },
    tSkyMoon: { value: null },
    uShadowMap: { value: dummyShadow() },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowOn: { value: 0 },
    uShadowBias: { value: 0.0003 },
    uHaze: { value: 1.6 },
    uProj: { value: new THREE.Matrix4() },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uReversed: { value: 1 },
    uTime: { value: 0 },
    uViewAltKm: { value: 0.6 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uSunE: { value: 10 },
    uMoonE: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0, 1, 0) },
    uLightColor: { value: new THREE.Color(1, 1, 1) },
    uWind: { value: new THREE.Vector2(0.8, 0.3) },
    uIce: { value: 0 },
    uTurbid: { value: 0 },
    uSwitch: { value: 2400 },
    uNearBox: { value: new THREE.Vector4(-9000, -9500, 9000, 8500) },
    uSSR: { value: 1 },
    uDebug: { value: 0 },
  };
}

const vert = /* glsl */ `
attribute vec2 flow;
attribute vec4 tint;
attribute vec4 meta;
uniform float uFar;
uniform mat4 uShadowMatrix;
varying vec3 vWPos;
varying vec2 vFlow;
varying vec3 vTint;
varying float vTurb;
varying float vKind;
varying vec4 vShadowCoord;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vFlow = flow * 0.001;
  vTint = tint.rgb * 0.255;
  vTurb = tint.a;
  vKind = meta.x;
  vShadowCoord = uShadowMatrix * vec4(wp.xyz + vec3(0.0, 0.4, 0.0), 1.0);
  vec4 mv = viewMatrix * wp;
  // The coarse valley mesh is pulled a hair towards the camera so coarse terrain LODs never cover it.
  if (uFar > 0.5) mv.xyz *= 0.9993;
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
precision highp float;
precision highp sampler2DShadow;
${atmosphereCommon}
${skyViewLookup}
uniform sampler2D tRefr;
uniform sampler2D tDepthC;
uniform sampler2D tWater;
uniform sampler2D tSkySun;
uniform sampler2D tSkyMoon;
uniform sampler2DShadow uShadowMap;
uniform float uShadowOn;
uniform float uShadowBias;
uniform mat4 uProj;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec2 uResolution;
uniform float uReversed;
uniform float uTime;
uniform float uViewAltKm;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunE;
uniform float uMoonE;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec2 uWind;
uniform float uIce;
uniform float uTurbid;
uniform float uSwitch;
uniform vec4 uNearBox;
uniform float uFar;
uniform float uSSR;
uniform float uDebug;
varying vec3 vWPos;
varying vec2 vFlow;
varying vec3 vTint;
varying float vTurb;
varying float vKind;
varying vec4 vShadowCoord;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}

vec3 skyLut(vec3 dir) {
  vec3 col = texture2D(tSkySun, skyViewUv(dir, uSunDir, uViewAltKm)).rgb * uSunE;
  col += texture2D(tSkyMoon, skyViewUv(dir, uMoonDir, uViewAltKm)).rgb * uMoonE;
  return col;
}

bool isSky(float d) { return uReversed > 0.5 ? d <= 0.0 : d >= 1.0; }
vec3 viewPos(vec2 uv, float d) {
  float z = uReversed > 0.5 ? d : d * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, z, 1.0);
  return v.xyz / v.w;
}

// Two-phase flow-map advection of a tiled slope texture (Vlachos 2010), in world metres.
vec4 flowSample(vec2 p, vec2 flow, float tile, float cycle, vec2 seed) {
  float t0 = fract(uTime / cycle);
  float t1 = fract(uTime / cycle + 0.5);
  float w1 = abs(1.0 - 2.0 * t0);
  vec4 a = texture2D(tWater, (p - flow * t0 * cycle) / tile + seed);
  vec4 b = texture2D(tWater, (p - flow * t1 * cycle) / tile + seed + vec2(0.37, 0.61));
  return mix(a, b, w1);
}

vec2 slopeOf(vec4 t) { return t.rg * 2.0 - 1.0; }

float sunShadow() {
  if (uShadowOn < 0.5) return 1.0;
  vec3 c = vShadowCoord.xyz / vShadowCoord.w;
  c.z += uShadowBias;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  vec2 texel = vec2(1.0 / 4096.0);
  float s = 0.0;
  s += texture(uShadowMap, vec3(c.xy + texel * vec2(-0.7, -0.4), c.z));
  s += texture(uShadowMap, vec3(c.xy + texel * vec2(0.6, -0.6), c.z));
  s += texture(uShadowMap, vec3(c.xy + texel * vec2(-0.5, 0.7), c.z));
  s += texture(uShadowMap, vec3(c.xy + texel * vec2(0.7, 0.5), c.z));
  return s * 0.25;
}

// Screen-space reflection against the opaque scene copy. Returns colour and confidence.
vec4 traceSSR(vec3 pV, vec3 rV, float jitter) {
  float t = 0.25 + 0.5 * jitter;
  float tPrev = 0.0;
  for (int i = 0; i < 26; i++) {
    vec3 q = pV + rV * t;
    if (q.z > -0.1) break;
    vec4 c = uProj * vec4(q, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float d = texture2D(tDepthC, uv).r;
    if (!isSky(d)) {
      vec3 s = viewPos(uv, d);
      float dz = -q.z + s.z;
      if (dz > 0.0 && dz < max(0.5, t * 0.07)) {
        float lo = tPrev;
        float hi = t;
        for (int k = 0; k < 5; k++) {
          float m = 0.5 * (lo + hi);
          vec3 qm = pV + rV * m;
          vec4 cm = uProj * vec4(qm, 1.0);
          vec2 um = cm.xy / cm.w * 0.5 + 0.5;
          vec3 sm = viewPos(um, texture2D(tDepthC, um).r);
          if (-qm.z + sm.z > 0.0) hi = m; else lo = m;
          uv = um;
        }
        vec2 e = abs(uv - 0.5) * 2.0;
        float fade = (1.0 - pow(max(e.x, e.y), 6.0)) * (1.0 - float(i) / 26.0);
        return vec4(texture2D(tRefr, uv).rgb, clamp(fade, 0.0, 1.0));
      }
    }
    tPrev = t;
    t = t * 1.2 + 0.2;
  }
  return vec4(0.0);
}

void main() {
  vec3 toCam = cameraPosition - vWPos;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float hd = length(vWPos.xz - cameraPosition.xz);
  bool inNear = vWPos.x > uNearBox.x && vWPos.z > uNearBox.y && vWPos.x < uNearBox.z && vWPos.z < uNearBox.w;
  float dither = hash12(gl_FragCoord.xy) * 60.0;
  if (uFar > 0.5) { if (inNear && hd < uSwitch + dither) discard; }
  else if (hd > uSwitch + dither) discard;

  bool river = vKind < 0.5;
  bool still = vKind > 0.5 && vKind < 2.5;
  vec2 flow = vFlow;
  float speed = length(flow);
  float turb = vTurb;
  vec2 p = vWPos.xz;

  // ---- surface normal ----
  float cyc = mix(2.2, 1.1, clamp(speed / 1.5, 0.0, 1.0));
  vec2 s = vec2(0.0);
  s += slopeOf(flowSample(p, flow, 7.0, cyc * 1.6, vec2(0.0))) * 0.10;
  s += slopeOf(flowSample(p, flow, 2.3, cyc, vec2(0.21, 0.73))) * (0.07 + 0.10 * turb);
  s += slopeOf(flowSample(p, flow * 1.15, 0.8, cyc * 0.8, vec2(0.53, 0.19))) * (0.035 + 0.09 * turb);
  // Wind ripples: strongest on still water, drifting with the breeze.
  float windAmt = still ? 1.0 : 0.35;
  vec2 wv = uWind;
  s += slopeOf(texture2D(tWater, (p + wv * uTime * 0.6) / 1.7 + vec2(0.4, 0.1))) * 0.045 * windAmt;
  s += slopeOf(texture2D(tWater, (p.yx * vec2(1.0, -1.0) + wv * uTime * 0.9) / 0.6)) * 0.025 * windAmt;
  // Gusts sweep across ponds as slowly moving patches.
  float gust = smoothstep(0.35, 0.8, vnoise(p * 0.03 + wv * uTime * 0.05));
  s *= still ? mix(0.35, 1.3, gust) : 1.0;
  s /= 1.0 + dist * 0.004;
  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  if (!gl_FrontFacing) N = -N;

  // ---- lighting environment ----
  float shadow = sunShadow();
  float NdotLs = max(dot(N, uLightDir), 0.0);
  vec3 Esun = uLightColor * max(uLightDir.y, 0.0) * shadow;
  vec3 Esky = (skyLut(normalize(vec3(0.3, 1.0, 0.1))) + skyLut(normalize(vec3(-0.3, 0.8, -0.2)))) * 0.5 * 3.14159;

  // ---- refraction and absorption ----
  vec2 suv = gl_FragCoord.xy / uResolution;
  float d0 = texture2D(tDepthC, suv).r;
  float dist0 = isSky(d0) ? 1e6 : length(viewPos(suv, d0));
  float thick0 = max(dist0 - dist, 0.0);
  float depthV = thick0 * max(V.y, 0.02);
  vec3 nV = (viewMatrix * vec4(N.x, 0.0, N.z, 0.0)).xyz;
  vec2 ruv = suv + nV.xy * 0.045 * clamp(depthV, 0.0, 1.5) / (1.0 + dist * 0.015);
  float dR = texture2D(tDepthC, ruv).r;
  vec3 vpR = viewPos(ruv, dR);
  float distR = isSky(dR) ? 1e6 : length(vpR);
  if (distR < dist) {
    ruv = suv;
    distR = dist0;
    vpR = viewPos(suv, d0);
  }
  vec3 bed = texture2D(tRefr, ruv).rgb;
  float thick = max(distR - dist, 0.0);
  float depthR = thick * max(V.y, 0.02);
  // Caustics on the bed: two drifting layers of the wave height interfere into bright ridges.
  vec3 bedW = (uCamWorld * vec4(vpR, 1.0)).xyz;
  vec2 cp = bedW.xz + flow * uTime * 0.4;
  float c1 = texture2D(tWater, cp / 2.1 + uTime * vec2(0.013, 0.021)).b;
  float c2 = texture2D(tWater, cp.yx / 1.7 - uTime * vec2(0.017, 0.011)).b;
  float caus = pow(1.0 - abs(c1 + c2 - 1.0), 8.0);
  float causAmt = shadow * smoothstep(0.02, 0.2, uLightDir.y) * exp(-depthR * 1.3) * smoothstep(0.0, 0.08, depthR);
  bed *= 1.0 + 2.2 * caus * causAmt;
  // Beer-Lambert: silty Pine River green, murkier ponds and lagoons, clear creeks.
  vec3 sigma = river ? vec3(0.62, 0.30, 0.38) : (vKind < 1.5 ? vec3(0.9, 0.5, 0.65) : (vKind < 2.5 ? vec3(2.2, 1.3, 1.9) : vec3(0.45, 0.2, 0.26)));
  sigma *= 1.0 + 1.6 * uTurbid;
  vec3 T = exp(-sigma * (thick + depthR * 1.1));
  // Deep-water radiance from the measured Sentinel-2 reflectance of this very water body.
  vec3 tint = mix(vTint, vTint * vec3(1.45, 1.25, 0.9), uTurbid);
  vec3 deep = tint * 0.85 * (Esun + Esky) / 3.14159;
  vec3 under = bed * T + deep * (1.0 - T);

  // ---- reflection ----
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.01);
  R = normalize(R);
  vec3 refl = skyLut(R);
  if (uSSR > 0.5 && dist < 900.0 && gl_FrontFacing) {
    vec3 pV = (viewMatrix * vec4(vWPos, 1.0)).xyz;
    vec3 rV = normalize((viewMatrix * vec4(R, 0.0)).xyz);
    // Ordered 4x4 jitter keeps the step pattern stable from frame to frame.
    ivec2 bp = ivec2(mod(gl_FragCoord.xy, 4.0));
    int bi = bp.x + bp.y * 4;
    float bayer = float((bi * 7 + (bi / 4) * 3) % 16) / 16.0;
    vec4 hit = traceSSR(pV, rV, bayer);
    refl = mix(refl, hit.rgb, hit.a * (1.0 - smoothstep(500.0, 900.0, dist)));
  }
  float NdotV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 col = mix(under, refl, F);

  // ---- sun / moon glint (GGX) ----
  vec3 L = uLightDir;
  vec3 H = normalize(L + V);
  float NdotH = max(dot(N, H), 0.0);
  float a = clamp(0.035 + 0.05 * turb + dist * 0.00012, 0.02, 0.3);
  float a2 = a * a;
  float dd = NdotH * NdotH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float FL = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float k = a * 0.5;
  float G = NdotLs / (NdotLs * (1.0 - k) + k) * NdotV / (NdotV * (1.0 - k) + k);
  col += D * FL * G / max(4.0 * NdotV, 1e-3) * uLightColor * shadow * step(0.0, L.y);

  // ---- foam: thin lace at the waterline, streaks trailing riffles in the current ----
  vec4 fa = flowSample(p, flow, 3.1, cyc, vec2(0.11, 0.37));
  vec4 fb = flowSample(p * 1.7 + 3.0, flow * 1.7, 3.1, cyc * 1.3, vec2(0.71, 0.13));
  // Stretch the pattern along the current so foam reads as streaks, not cells.
  vec2 fd = speed > 0.05 ? flow / speed : vec2(1.0, 0.0);
  vec2 streakUv = vec2(dot(p, fd) * 0.35, dot(p, vec2(-fd.y, fd.x)) * 2.2) - vec2(uTime * speed * 0.35, 0.0);
  float streak = texture2D(tWater, streakUv / 3.0 + vec2(0.3, 0.8)).a;
  float fpat = fa.a * 0.45 + fb.a * 0.25 + streak * 0.3;
  float lace = 1.0 - smoothstep(0.0, 0.05 + 0.08 * turb, depthV);
  float foamAmt = lace * (still ? 0.25 : 0.5) + turb * 0.55;
  float foam = smoothstep(0.62, 0.95, fpat + foamAmt * 0.5) * clamp(foamAmt * 1.6, 0.0, 1.0);
  vec3 foamCol = vec3(0.8, 0.82, 0.8) * (Esun * (0.5 + 0.5 * NdotLs) + Esky) / 3.14159;
  col = mix(col, foamCol, foam * 0.75);

  // ---- winter ice: still water freezes over; the river keeps open leads in the fast current ----
  if (uIce > 0.0) {
    float n = vnoise(p * 0.05) * 0.5 + vnoise(p * 0.21) * 0.3 + vnoise(p * 0.9) * 0.2;
    float freeze = river ? smoothstep(0.95, 0.6, speed + (n - 0.5) * 0.6) : 1.0;
    freeze *= uIce;
    // Snow on the ice, blown into drifts along the wind; wind-scoured patches show grey-blue ice.
    vec2 wd = normalize(uWind);
    float drift = vnoise(vec2(dot(p, wd) * 0.08, dot(p, vec2(-wd.y, wd.x)) * 0.8));
    float scour = smoothstep(0.62, 0.8, vnoise(p * 0.035 + 11.0) * 0.7 + drift * 0.3);
    float crust = vnoise(p * 1.7) * 0.5 + vnoise(p * 6.0) * 0.5;
    vec3 iceN = normalize(vec3((vnoise(p * 2.0) - 0.5) * 0.12, 1.0, (vnoise(p * 2.0 + 7.0) - 0.5) * 0.12));
    float iceNL = max(dot(iceN, uLightDir), 0.0);
    vec3 snowAlb = vec3(0.84, 0.88, 0.94) * (0.88 + 0.12 * crust) * (0.94 + 0.06 * drift);
    vec3 bareIce = vec3(0.32, 0.4, 0.46) * (0.8 + 0.3 * crust);
    vec3 alb = mix(snowAlb, bareIce, scour * (river ? 0.8 : 0.5));
    // Pressure cracks in bare ice.
    float crack = 1.0 - smoothstep(0.0, 0.04, abs(vnoise(p * 0.6) - 0.5));
    alb *= 1.0 - 0.35 * crack * scour;
    vec3 ice = alb * (uLightColor * iceNL * shadow + Esky) / 3.14159;
    // Clear ice glints a little where it is bare.
    vec3 Hi = normalize(uLightDir + V);
    ice += uLightColor * shadow * pow(max(dot(iceN, Hi), 0.0), 200.0) * 0.6 * scour;
    // Shelf edge along open leads: dark wet rim then clear ice.
    float rim = smoothstep(0.25, 0.4, freeze) * (1.0 - smoothstep(0.4, 0.55, freeze));
    ice = mix(ice, deep * 1.2 + vec3(0.03, 0.045, 0.06) * (Esky + Esun) / 3.14159, rim * 0.7);
    col = mix(col, ice, smoothstep(0.3, 0.45, freeze));
  }
  if (!gl_FrontFacing) col = under * 0.6;
  if (uDebug > 0.5) {
    // 1: SSR confidence, 2: water column thickness (10 m = white), 3: vertical depth, 4: flow speed.
    vec4 hitD = vec4(0.0);
    if (uDebug < 1.5) {
      vec3 pV = (viewMatrix * vec4(vWPos, 1.0)).xyz;
      vec3 rV = normalize((viewMatrix * vec4(R, 0.0)).xyz);
      hitD = traceSSR(pV, rV, 0.5);
    }
    float v = uDebug < 1.5 ? hitD.a : uDebug < 2.5 ? thick0 / 10.0 : uDebug < 3.5 ? depthV / 3.0 : speed / 2.0;
    col = vec3(v) * 5.0;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createWaterMaterial(uniforms: Record<string, THREE.IUniform>, far: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: far ? 'water-far' : 'water',
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...uniforms, uFar: { value: far ? 1 : 0 } },
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
  });
}

/** Full-screen restore of the resolved opaque colour into the multisampled target (see Post). */
export function createRestoreMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'water-restore',
    uniforms: { tSrc: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }',
    depthTest: false,
    depthWrite: false,
  });
}
