import { atmosphereCommon, skyViewLookup } from './sky/atmosphereGlsl';

export const quadVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Scene + atmosphere composite: aerial perspective on geometry, physical sky elsewhere. */
export const compositeFrag = /* glsl */ `
precision highp float;
precision highp sampler3D;
${atmosphereCommon}
${skyViewLookup}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler3D tAerial;
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
  float n = hash13(floor(d * 90.0)) * 0.5 + hash13(floor(d * 37.0)) * 0.5;
  col += vec3(0.55, 0.6, 0.75) * band * (0.08 + 0.1 * n);
  return col;
}

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
    col += min(sun, vec3(60000.0)) * horizonFade;
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
    col += moon * horizonFade;
  }
  col += starField(dir) * uStars * horizonFade * transmittanceTo(dir);
  return col;
}

void main() {
  float depth = texture2D(tDepth, vUv).r;
  bool isSky = uReversed > 0.5 ? depth <= 0.0 : depth >= 1.0;
  float ndcZ = uReversed > 0.5 ? depth : depth * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, isSky ? (uReversed > 0.5 ? 0.5 : 0.0) : ndcZ, 1.0);
  vp.xyz /= vp.w;
  vec3 dir = normalize(mat3(uCamWorld) * vp.xyz);
  vec3 col;
  if (isSky) {
    col = skyRadiance(dir);
  } else {
    vec3 scene = texture2D(tColor, vUv).rgb;
    float distKm = length(vp.xyz) * 0.001;
    float w = sqrt(clamp(distKm / uApMaxKm, 0.0, 1.0));
    vec4 ap = texture(tAerial, vec3(vUv, w));
    float nearFade = clamp(w * float(${32}) * 2.0, 0.0, 1.0);
    float T = mix(1.0, ap.a, nearFade);
    col = scene * T + ap.rgb * uApE * nearFade;
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
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 hdr = texture2D(tColor, vUv).rgb;
  vec3 bloom = texture2D(tBloom, vUv).rgb;
  hdr = mix(hdr, bloom, uBloom);
  float avgLog = texture2D(tAdapt, vec2(0.5)).r;
  float exposure = uManualExposure > 0.0 ? uManualExposure : uKey / exp2(avgLog);
  exposure *= exp2(uExposureComp);
  vec3 c = hdr * exposure;
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
