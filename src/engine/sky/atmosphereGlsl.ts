/**
 * Physically based atmosphere (after Hillaire 2020, "A Scalable and Production Ready Sky and
 * Atmosphere Rendering Technique"). Distances in kilometres; radiance is per unit sun illuminance.
 */
export const atmosphereCommon = /* glsl */ `
#define ATM_PI 3.14159265359
const float Rg = 6360.0;
const float Rt = 6460.0;
const vec3 kRayleighS = vec3(5.802, 13.558, 33.1) * 1e-3;
const float kRayleighH = 8.0;
const float kMieS = 3.996e-3;
const float kMieE = 4.40e-3;
const float kMieH = 1.2;
const vec3 kOzoneA = vec3(0.650, 1.881, 0.085) * 1e-3;

uniform float uHaze; // multiplier on Mie density near the ground (valley haze / smoke)

void atmScattering(float altKm, out vec3 rayS, out float mieS, out vec3 ext) {
  float h = max(altKm, 0.0);
  float rd = exp(-h / kRayleighH);
  float md = exp(-h / kMieH) * (1.0 + (uHaze - 1.0) * exp(-h / 0.8));
  float od = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  rayS = kRayleighS * rd;
  mieS = kMieS * md;
  ext = rayS + kMieE * md + kOzoneA * od;
}

float raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  if (c > 0.0 && b > 0.0) return -1.0;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  if (d > b * b) return -b + sqrt(d);
  return -b - sqrt(d);
}

float rayleighPhase(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }
float miePhase(float c) {
  const float g = 0.8;
  float s = 3.0 / (8.0 * ATM_PI) * (1.0 - g * g) * (1.0 + c * c);
  float d = (2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
  return s / d;
}

vec2 lutUv(vec3 pos, vec3 sunDir) {
  float h = length(pos);
  return vec2(clamp(0.5 + 0.5 * dot(sunDir, pos / h), 0.0, 1.0), clamp((h - Rg) / (Rt - Rg), 0.0, 1.0));
}
`;

export const transmittanceFrag = /* glsl */ `
${atmosphereCommon}
varying vec2 vUv;
void main() {
  float cosZ = 2.0 * vUv.x - 1.0;
  float h = Rg + vUv.y * (Rt - Rg) + 0.001;
  vec3 pos = vec3(0.0, h, 0.0);
  vec3 dir = normalize(vec3(0.0, cosZ, -sqrt(max(0.0, 1.0 - cosZ * cosZ))));
  vec3 T = vec3(1.0);
  if (raySphere(pos, dir, Rg) <= 0.0) {
    float tMax = raySphere(pos, dir, Rt);
    float t = 0.0;
    for (int i = 0; i < 40; i++) {
      float nt = (float(i) + 0.3) / 40.0 * tMax;
      float dt = nt - t;
      t = nt;
      vec3 rs; float ms; vec3 ext;
      atmScattering(length(pos + t * dir) - Rg, rs, ms, ext);
      T *= exp(-dt * ext);
    }
  } else {
    T = vec3(0.0);
  }
  gl_FragColor = vec4(T, 1.0);
}
`;

export const multiScatterFrag = /* glsl */ `
${atmosphereCommon}
uniform sampler2D uTransmittance;
varying vec2 vUv;
const vec3 kGroundAlbedo = vec3(0.25);
void main() {
  float cosZ = 2.0 * vUv.x - 1.0;
  float h = Rg + vUv.y * (Rt - Rg) + 0.001;
  vec3 pos = vec3(0.0, h, 0.0);
  vec3 sunDir = normalize(vec3(0.0, cosZ, -sqrt(max(0.0, 1.0 - cosZ * cosZ))));
  vec3 lum2 = vec3(0.0);
  vec3 fms = vec3(0.0);
  const int N = 8;
  for (int a = 0; a < N; a++) {
    for (int b = 0; b < N; b++) {
      float theta = ATM_PI * (float(a) + 0.5) / float(N);
      float phi = acos(clamp(1.0 - 2.0 * (float(b) + 0.5) / float(N), -1.0, 1.0));
      vec3 dir = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));
      float tG = raySphere(pos, dir, Rg);
      float tA = raySphere(pos, dir, Rt);
      float tMax = tG > 0.0 ? tG : tA;
      float cosT = dot(dir, sunDir);
      float rP = rayleighPhase(cosT);
      float mP = miePhase(cosT);
      vec3 L = vec3(0.0);
      vec3 f = vec3(0.0);
      vec3 T = vec3(1.0);
      float t = 0.0;
      for (int s = 0; s < 20; s++) {
        float nt = (float(s) + 0.3) / 20.0 * tMax;
        float dt = nt - t;
        t = nt;
        vec3 p = pos + t * dir;
        vec3 rs; float ms; vec3 ext;
        atmScattering(length(p) - Rg, rs, ms, ext);
        vec3 sT = exp(-dt * ext);
        vec3 scatNoPhase = rs + ms;
        vec3 fInt = (scatNoPhase - scatNoPhase * sT) / ext;
        f += fInt * T;
        vec3 sunT = texture2D(uTransmittance, lutUv(p, sunDir)).rgb;
        vec3 inS = (rs * rP + ms * mP) * sunT;
        L += (inS - inS * sT) / ext * T;
        T *= sT;
      }
      if (tG > 0.0) {
        vec3 hp = pos + tG * dir;
        vec3 up = normalize(hp);
        L += T * texture2D(uTransmittance, lutUv(hp, sunDir)).rgb * clamp(dot(up, sunDir), 0.0, 1.0) * kGroundAlbedo / ATM_PI;
      }
      fms += f / float(N * N);
      lum2 += L / float(N * N);
    }
  }
  vec3 psi = lum2 / (1.0 - fms);
  gl_FragColor = vec4(psi, 1.0);
}
`;

export const atmosphereMarch = /* glsl */ `
uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;

// Returns in-scattered radiance (rgb) and mean transmittance (a) from pos along dir for tMax km.
vec4 atmMarch(vec3 pos, vec3 dir, vec3 sunDir, float tMax, int steps) {
  float cosT = dot(dir, sunDir);
  float rP = rayleighPhase(cosT);
  float mP = miePhase(cosT);
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float t = 0.0;
  for (int s = 0; s < 64; s++) {
    if (s >= steps) break;
    float nt = (float(s) + 0.3) / float(steps) * tMax;
    float dt = nt - t;
    t = nt;
    vec3 p = pos + t * dir;
    vec3 rs; float ms; vec3 ext;
    atmScattering(length(p) - Rg, rs, ms, ext);
    vec3 sT = exp(-dt * ext);
    vec2 uv = lutUv(p, sunDir);
    vec3 sunT = texture2D(uTransmittance, uv).rgb;
    vec3 psi = texture2D(uMultiScatter, uv).rgb;
    vec3 inS = rs * (rP * sunT + psi) + ms * (mP * sunT + psi);
    L += (inS - inS * sT) / max(ext, vec3(1e-7)) * T;
    T *= sT;
  }
  return vec4(L, dot(T, vec3(1.0 / 3.0)));
}
`;

export const skyViewFrag = /* glsl */ `
${atmosphereCommon}
${atmosphereMarch}
uniform float uViewAltKm;
uniform float uSunCosZ;
varying vec2 vUv;
void main() {
  float h = Rg + uViewAltKm;
  vec3 pos = vec3(0.0, h, 0.0);
  float horizon = -acos(clamp(sqrt(h * h - Rg * Rg) / h, -1.0, 1.0));
  float alt;
  if (vUv.y < 0.5) {
    float c = 1.0 - 2.0 * vUv.y;
    alt = horizon - c * c * (0.5 * ATM_PI + horizon);
  } else {
    float c = 2.0 * vUv.y - 1.0;
    alt = horizon + c * c * (0.5 * ATM_PI - horizon);
  }
  float az = (vUv.x - 0.5) * 2.0 * ATM_PI;
  vec3 dir = vec3(cos(alt) * sin(az), sin(alt), -cos(alt) * cos(az));
  vec3 sunDir = vec3(0.0, uSunCosZ, -sqrt(max(0.0, 1.0 - uSunCosZ * uSunCosZ)));
  float tG = raySphere(pos, dir, Rg);
  float tA = raySphere(pos, dir, Rt);
  float tMax = tG > 0.0 ? tG : tA;
  gl_FragColor = vec4(atmMarch(pos, dir, sunDir, tMax, 32).rgb, 1.0);
}
`;

/** Lookup into the sky-view LUT for a world direction (y up). */
export const skyViewLookup = /* glsl */ `
vec2 skyViewUv(vec3 dir, vec3 sunDir, float viewAltKm) {
  float h = Rg + viewAltKm;
  float horizon = -acos(clamp(sqrt(h * h - Rg * Rg) / h, -1.0, 1.0));
  float alt = asin(clamp(dir.y, -1.0, 1.0));
  float v;
  if (alt < horizon) v = 0.5 - 0.5 * sqrt(clamp((horizon - alt) / (0.5 * ATM_PI + horizon), 0.0, 1.0));
  else v = 0.5 + 0.5 * sqrt(clamp((alt - horizon) / (0.5 * ATM_PI - horizon), 0.0, 1.0));
  vec2 d = normalize(dir.xz + vec2(1e-6, 0.0));
  vec2 s = normalize(sunDir.xz + vec2(1e-6, 0.0));
  // Sun lies along -z in LUT space; azimuth is measured from it.
  float az = atan(s.x * d.y - s.y * d.x, d.x * s.x + d.y * s.y);
  return vec2(az / (2.0 * ATM_PI) + 0.5, v);
}
`;

export const aerialFrag = /* glsl */ `
${atmosphereCommon}
${atmosphereMarch}
uniform float uViewAltKm;
uniform vec3 uSunDir;
uniform mat4 uInvViewProj;
uniform vec3 uCamWorld;
uniform float uMaxDistKm;
uniform float uSlices;
void main() {
  // The slices lie side by side along x (32 texels each); y is the screen's vertical.
  float slice = floor(gl_FragCoord.x / 32.0);
  vec2 uv = vec2(gl_FragCoord.x - slice * 32.0, gl_FragCoord.y) / 32.0;
  vec4 clip = vec4(uv * 2.0 - 1.0, 0.5, 1.0);
  vec4 wp = uInvViewProj * clip;
  vec3 dir = normalize(wp.xyz / wp.w - uCamWorld);
  float w = (slice + 0.5) / uSlices;
  float dist = uMaxDistKm * w * w;
  vec3 pos = vec3(0.0, Rg + uViewAltKm, 0.0);
  float tG = raySphere(pos, dir, Rg);
  if (tG > 0.0) dist = min(dist, tG);
  int steps = int(clamp(4.0 + 28.0 * w, 4.0, 32.0));
  gl_FragColor = atmMarch(pos, dir, uSunDir, dist, steps);
}
`;
