import { atmosphereCommon, skyViewLookup } from './sky/atmosphereGlsl';
import { cloudGlsl, cloudSkyGlsl } from './WorldLight';

export const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Scene + atmosphere composite: aerial perspective on geometry, physical sky elsewhere. */
export const compositeFrag = /* glsl */ `
precision highp float;
${atmosphereCommon}
${skyViewLookup}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAerial;
// Aerial-perspective froxels: 32 slices of 32x32 side by side; trilinear lookup with clamped depth.
vec4 aerialAt(vec2 uv, float w) {
  float s = clamp(w * 32.0 - 0.5, 0.0, 31.0);
  float s0 = floor(s);
  float s1 = min(s0 + 1.0, 31.0);
  float u = clamp(uv.x, 0.5 / 32.0, 1.0 - 0.5 / 32.0);
  vec4 a = texture2D(tAerial, vec2((s0 + u) / 32.0, uv.y));
  vec4 b = texture2D(tAerial, vec2((s1 + u) / 32.0, uv.y));
  return mix(a, b, s - s0);
}
uniform sampler2D tSkySun;
uniform sampler2D tSkyMoon;
uniform sampler2D uTransmittance;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform float uReversed;
uniform float uViewAltKm;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uSunE;
uniform float uMoonE;
uniform float uApE;
uniform float uApMaxKm;
uniform float uStars;
uniform float uTime;
uniform mat3 uStarRot;
uniform float uUnder;
uniform vec3 uCloudGlow;
uniform sampler2D tAO;
uniform float uAOK;
${cloudGlsl}
uniform vec3 uUnderSigma;
uniform vec3 uUnderDeep;
varying vec2 vUv;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 starField(vec3 d) {
  d = uStarRot * d;
  vec3 col = vec3(0.0);
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 180.0 : 420.0;
    vec3 p = d * scale;
    vec3 c = floor(p);
    float h = hash13(c + float(layer) * 17.0);
    if (h > (layer == 0 ? 0.985 : 0.992)) {
      vec3 jitter = vec3(hash13(c + 1.3), hash13(c + 2.7), hash13(c + 4.1));
      vec3 sp = normalize(c + 0.2 + 0.6 * jitter);
      float ang = acos(clamp(dot(sp, normalize(p)), -1.0, 1.0)) * scale;
      float mag = pow(hash13(c + 9.1), 6.0);
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 6.0 * hash13(c + 5.0)) + h * 60.0);
      float temp = hash13(c + 7.7);
      vec3 tint = mix(vec3(1.0, 0.78, 0.6), vec3(0.72, 0.82, 1.0), temp);
      col += tint * (0.2 + 6.0 * mag) * tw * exp(-ang * ang * 900.0);
    }
  }
  // Faint Milky Way band.
  vec3 gp = normalize(vec3(-0.0548, -0.8734, -0.4838));
  float band = exp(-pow(dot(d, gp) * 5.5, 2.0));
  // Smooth clumps and dark dust lanes (continuous in direction, no cell artefacts); faint, as seen
  // from a small town.
  float n = 0.5 + 0.25 * sin(dot(d, vec3(23.1, 7.3, 17.9))) * sin(dot(d, vec3(-9.7, 29.3, 5.1)))
          + 0.25 * sin(dot(d, vec3(61.0, -37.0, 43.0)) + 1.3);
  float lane = smoothstep(0.25, 0.0, abs(dot(d, gp) + 0.04 * sin(dot(d, vec3(11.0, 5.0, -7.0)))));
  col += vec3(0.55, 0.6, 0.75) * band * (0.006 + 0.01 * n) * (1.0 - 0.6 * lane);
  return col;
}

// Visibility of the sun/moon disks and stars through the cloud deck (set per pixel in main).
float gDiskVis = 1.0;

vec3 transmittanceTo(vec3 dir) {
  vec3 pos = vec3(0.0, Rg + uViewAltKm, 0.0);
  return texture2D(uTransmittance, lutUv(pos, dir)).rgb;
}

vec3 skyRadiance(vec3 dir) {
  vec3 col = texture2D(tSkySun, skyViewUv(dir, uSunDir, uViewAltKm)).rgb * uSunE;
  col += texture2D(tSkyMoon, skyViewUv(dir, uMoonDir, uViewAltKm)).rgb * uMoonE;
  float horizonFade = smoothstep(-0.02, 0.03, dir.y);
  // Sun disk with limb darkening.
  float cs = dot(dir, uSunDir);
  const float sunCos = 0.99998918; // 0.2666 deg
  if (cs > sunCos) {
    float r = sqrt(clamp((1.0 - cs) / (1.0 - sunCos), 0.0, 1.0));
    float limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - r * r)));
    vec3 sun = transmittanceTo(uSunDir) * uSunE / 6.8e-5 * limb;
    col += min(sun, vec3(60000.0)) * horizonFade * gDiskVis;
  }
  // Moon disk: lit by the sun, with a subtle mare pattern.
  float cm = dot(dir, uMoonDir);
  const float moonCos = 0.99998971;
  if (cm > moonCos) {
    vec3 t = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 b = cross(t, uMoonDir);
    vec3 off = dir - uMoonDir * cm;
    vec2 q = vec2(dot(off, t), dot(off, b)) / sqrt(1.0 - moonCos * moonCos);
    float z = sqrt(max(0.0, 1.0 - dot(q, q)));
    vec3 n = normalize(t * q.x + b * q.y - uMoonDir * z);
    float lit = clamp(dot(n, uSunDir), 0.0, 1.0);
    float mare = 0.78 + 0.22 * sin(q.x * 7.0 + 1.3) * sin(q.y * 5.0 - 0.4) + 0.08 * hash13(floor(vec3(q * 40.0, 1.0)));
    vec3 moon = transmittanceTo(uMoonDir) * 10.0 * 0.12 / ATM_PI * mare * lit;
    col += moon * horizonFade * gDiskVis;
  }
  col += starField(dir) * uStars * horizonFade * transmittanceTo(dir) * gDiskVis;
  return col;
}

vec3 cwSkyLut(vec3 dir) {
  return texture2D(tSkySun, skyViewUv(dir, uSunDir, uViewAltKm)).rgb * uSunE
       + texture2D(tSkyMoon, skyViewUv(dir, uMoonDir, uViewAltKm)).rgb * uMoonE;
}
${cloudSkyGlsl}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  bool isSky = uReversed > 0.5 ? depth <= 0.0 : depth >= 1.0;
  float ndcZ = uReversed > 0.5 ? depth : depth * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, isSky ? (uReversed > 0.5 ? 0.5 : 0.0) : ndcZ, 1.0);
  vp.xyz /= vp.w;
  vec3 dir = normalize(mat3(uCamWorld) * vp.xyz);
  vec3 col;
  vec3 camPos = uCamWorld[3].xyz;
  vec3 sunT = transmittanceTo(uSunDir);
  float ovK = cwOvercastK();
  if (isSky) {
    vec4 cl = cwCloudLayer(camPos, dir, 1e9, sunT);
    gDiskVis = pow(1.0 - cl.a, 4.0);
    col = cwSky(dir, skyRadiance(dir), sunT);
    col = mix(col, cl.rgb, cl.a);
  } else {
    vec3 scene = texture2D(tColor, vUv).rgb;
    if (uAOK > 0.0) scene *= mix(1.0, texture2D(tAO, vUv).r, uAOK);
    float dist = length(vp.xyz);
    float w = sqrt(clamp(dist * 0.001 / uApMaxKm, 0.0, 1.0));
    vec4 ap = aerialAt(vUv, w);
    float nearFade = clamp(w * float(${32}) * 2.0, 0.0, 1.0);
    float T = mix(1.0, ap.a, nearFade);
    // Under an overcast deck the haze is lit by the grey dome instead of the sun: in-scattering
    // tends to the horizon radiance of the overcast sky.
    vec3 inscatter = mix(ap.rgb * uApE, cwOvercast(normalize(vec3(dir.x, 0.05, dir.z)), sunT) * (1.0 - ap.a), ovK);
    col = scene * T + inscatter * nearFade;
    // Cloud deck in front of high terrain (mountain tops in the clouds).
    vec4 cl = cwCloudLayer(camPos, dir, dist, sunT);
    col = mix(col, cl.rgb, cl.a);
  }
  if (uUnder > 0.5) {
    // Camera below the water surface: everything is seen through the water column.
    float d = isSky ? 40.0 : length(vp.xyz);
    vec3 Tw = exp(-uUnderSigma * d);
    col = col * Tw + uUnderDeep * (1.0 - Tw);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export const lumFrag = /* glsl */ `
uniform sampler2D tColor;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tColor, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Centre-weighted metering.
  float wgt = 1.0 - 0.6 * length(vUv - 0.5);
  gl_FragColor = vec4(log2(max(l, 1e-5)) * wgt, wgt, 0.0, 1.0);
}
`;

export const adaptFrag = /* glsl */ `
uniform sampler2D tLum;
uniform sampler2D tPrev;
uniform float uLumLod;
uniform float uBlend;
uniform float uMinLog;
uniform float uMaxLog;
varying vec2 vUv;
void main() {
  vec2 s = textureLod(tLum, vec2(0.5), uLumLod).rg;
  float avgLog = clamp(s.x / max(s.y, 1e-4), uMinLog, uMaxLog);
  float prev = texture2D(tPrev, vec2(0.5)).r;
  gl_FragColor = vec4(mix(prev, avgLog, uBlend), 0.0, 0.0, 1.0);
}
`;

export const downFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uFirst > 0.5) col = min(col, vec3(4000.0));
  gl_FragColor = vec4(col, 1.0);
}
`;

export const upFrag = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += (texture2D(tSrc, vUv + vec2(-r.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(r.x, 0.0)).rgb
      + texture2D(tSrc, vUv + vec2(0.0, -r.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, r.y)).rgb) * 2.0;
  c += texture2D(tSrc, vUv + vec2(-r.x, -r.y)).rgb + texture2D(tSrc, vUv + vec2(r.x, -r.y)).rgb
      + texture2D(tSrc, vUv + vec2(-r.x, r.y)).rgb + texture2D(tSrc, vUv + vec2(r.x, r.y)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}
`;

export const finalFrag = /* glsl */ `
#include <tonemapping_pars_fragment>
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform sampler2D tAdapt;
uniform float uBloom;
uniform float uExposureComp;
uniform float uKey;
uniform float uManualExposure;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uNight;
uniform float uBarrel;
uniform float uAspect;
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  // FPV lens: barrel distortion (centre magnified, edges compressed; corners stay in frame).
  vec2 uv = vUv;
  if (uBarrel > 0.0) {
    vec2 cq = (vUv - 0.5) * vec2(uAspect, 1.0);
    float norm = 1.0 + uBarrel * 0.25 * (uAspect * uAspect + 1.0);
    uv = 0.5 + (vUv - 0.5) * (1.0 + uBarrel * dot(cq, cq)) / norm;
  }
  vec3 hdr = texture2D(tColor, uv).rgb;
  vec3 bloom = texture2D(tBloom, uv).rgb;
  hdr = mix(hdr, bloom, uBloom);
  float avgLog = texture2D(tAdapt, vec2(0.5)).r;
  // Luminance-adaptive key (Krawczyk et al. 2005): dim scenes are shown dimmer than daylight, as
  // the eye sees them, instead of being lifted to mid-grey. One unit is about 10^4 cd/m2.
  float Lcd = exp2(avgLog) * 1.0e4;
  float keyAd = clamp((1.03 - 2.0 / (2.0 + log(Lcd + 1.0) / log(10.0))) / 0.665, 0.18, 1.1);
  float exposure = uManualExposure > 0.0 ? uManualExposure : uKey * keyAd / exp2(avgLog);
  exposure *= exp2(uExposureComp);
  vec3 c = hdr * exposure;
  // Night vision: dark areas lose colour towards blue (rods); lamp-lit areas keep their warmth.
  if (uNight > 0.0) {
    float lr = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float rod = uNight * 0.65 * (1.0 - smoothstep(0.04, 0.5, lr));
    c = mix(c, vec3(lr) * vec3(0.74, 0.88, 1.18), rod);
  }
  // Grading in linear before the view transform.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = c * uGain + uLift * 0.01;
  c = AgXToneMapping(c);
  c = clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  vec2 q = vUv - 0.5;
  c *= 1.0 - uVignette * dot(q, q) * 1.6;
  vec3 outc = srgbEncode(c);
  float n = ign(gl_FragCoord.xy + fract(uTime * 7.13) * 64.0) - 0.5;
  outc += n * (1.0 / 255.0 + uGrain);
  gl_FragColor = vec4(outc, 1.0);
}
`;

export const fxaaFrag = /* glsl */ `
uniform sampler2D tColor;
uniform vec2 uTexel;
varying vec2 vUv;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 rgbM = texture2D(tColor, vUv).rgb;
  float lM = luma(rgbM);
  float lNW = luma(texture2D(tColor, vUv + vec2(-1, -1) * uTexel).rgb);
  float lNE = luma(texture2D(tColor, vUv + vec2(1, -1) * uTexel).rgb);
  float lSW = luma(texture2D(tColor, vUv + vec2(-1, 1) * uTexel).rgb);
  float lSE = luma(texture2D(tColor, vUv + vec2(1, 1) * uTexel).rgb);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
  dir = clamp(dir * rcp, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture2D(tColor, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tColor, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture2D(tColor, vUv - dir * 0.5).rgb + texture2D(tColor, vUv + dir * 0.5).rgb);
  float lB = luma(b);
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? a : b, 1.0);
}
`;
