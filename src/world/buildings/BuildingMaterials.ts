import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';

/** Shared uniforms driving time-of-day behaviour of building materials. */
export const buildingUniforms = {
  uNight: { value: 0 },
  uInterior: { value: 1 },
  uSnow: { value: 0 },
  uTime: { value: 0 },
};

const attrVert = /* glsl */ `
attribute vec2 aUv;
attribute vec4 a0;
attribute vec4 a1;
attribute vec4 a2;
attribute vec4 a3;
varying vec2 vWallUV;
varying vec4 vF0;
varying vec4 vF1;
varying vec4 vF2;
varying vec4 vF3;
varying vec3 vWPos;
varying vec3 vWN;
`;

const attrVertMain = /* glsl */ `
vWallUV = aUv;
vF0 = a0; vF1 = a1; vF2 = a2; vF3 = a3;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * objectNormal);
`;

const commonFrag = /* glsl */ `
varying vec2 vWallUV;
varying vec4 vF0;
varying vec4 vF1;
varying vec4 vF2;
varying vec4 vF3;
varying vec3 vWPos;
varying vec3 vWN;
uniform float uNight;
uniform float uInterior;
uniform float uSnow;
uniform float uTime;

float bh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float bh1(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
float bn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bh(i), bh(i + vec2(1, 0)), u.x), mix(bh(i + vec2(0, 1)), bh(i + vec2(1, 1)), u.x), u.y);
}
float bfbm(vec2 p) { return bn(p) * 0.5 + bn(p * 2.1) * 0.25 + bn(p * 4.3) * 0.125 + bn(p * 8.7) * 0.0625; }
`;

const facadeFrag = /* glsl */ `
struct Fac { vec3 albedo; float rough; float metal; vec3 nTS; vec3 emissive; float glass; };

float rectMask(vec2 p, vec2 lo, vec2 hi) { return step(lo.x, p.x) * step(p.x, hi.x) * step(lo.y, p.y) * step(p.y, hi.y); }

// Interior mapping: ray-cast a virtual room behind a window.
vec3 interior(vec2 local, vec2 half2, float roomH, float depth, vec3 rd, float rs, float lit) {
  vec3 o = vec3(local.x, local.y, 0.0);
  vec3 d = rd;
  float tx = ((d.x > 0.0 ? half2.x : -half2.x) - o.x) / (abs(d.x) < 1e-4 ? 1e-4 : d.x);
  float ty = ((d.y > 0.0 ? roomH : 0.0) - o.y) / (abs(d.y) < 1e-4 ? 1e-4 : d.y);
  float tz = depth / max(d.z, 1e-4);
  float t = min(min(tx, ty), tz);
  vec3 h = o + d * t;
  vec3 wallC = mix(vec3(0.75, 0.72, 0.66), vec3(0.62, 0.66, 0.7), bh1(rs * 7.1));
  wallC = mix(wallC, vec3(0.8, 0.74, 0.62), step(0.7, bh1(rs * 3.3)));
  vec3 c;
  if (t == tz) {
    c = wallC * 0.9;
    // Furniture silhouette against the back wall.
    float sofa = rectMask(h.xy, vec2(-half2.x * 0.6, 0.0), vec2(half2.x * 0.4, 0.8)) * step(0.35, bh1(rs * 5.7));
    c = mix(c, vec3(0.25, 0.22, 0.2) * (0.6 + bh1(rs * 2.1)), sofa);
    float pic = rectMask(h.xy, vec2(-0.4, 1.3), vec2(0.3, 1.8)) * step(0.5, bh1(rs * 9.2));
    c = mix(c, vec3(0.4, 0.35, 0.5), pic);
  } else if (t == ty) {
    c = d.y > 0.0 ? vec3(0.85) : mix(vec3(0.42, 0.3, 0.2), vec3(0.5, 0.48, 0.45), step(0.5, bh1(rs * 4.4)));
  } else {
    c = wallC * 0.78;
  }
  // Darker deeper in the room by day; lamp pool by night.
  float fall = exp(-h.z * 0.18);
  vec3 day = c * (0.35 + 0.65 * fall);
  vec3 night = c * vec3(1.0, 0.78, 0.52) * (0.4 + 1.2 * exp(-length(h - vec3(0.0, roomH * 0.8, depth * 0.5)) * 0.4));
  return mix(day * uInterior, night * lit, uNight);
}

Fac facade(vec3 V) {
  vec2 uv = vWallUV;
  vec3 wallCol = vF0.rgb;
  int wallType = int(vF0.a + 0.5);
  vec3 trim = vF1.rgb;
  int win = int(vF1.a + 0.5);
  float seed = vF2.x;
  float floorH = vF2.y;
  float isFront = vF2.z;
  float wallLen = vF2.w;
  float eaveRel = vF3.x;
  float garageCls = vF3.y;
  Fac f;
  f.albedo = wallCol;
  f.rough = 0.75;
  f.metal = 0.0;
  f.nTS = vec3(0.0, 0.0, 1.0);
  f.emissive = vec3(0.0);
  f.glass = 0.0;
  float grain = bfbm(uv * vec2(3.0, 8.0) + seed * 17.0);
  // ---- base wall material
  if (wallType == 0) { // vinyl lap siding, 0.2 m exposure
    float t = fract(uv.y / 0.2);
    float lip = smoothstep(0.0, 0.08, t);
    f.nTS = normalize(vec3(0.0, mix(1.8, -0.18, lip), 1.0));
    f.albedo *= mix(0.7, 1.0, lip) * (0.97 + 0.06 * grain);
    f.rough = 0.5;
  } else if (wallType == 1) { // stucco
    float n = bfbm(uv * 9.0 + seed * 3.0);
    f.nTS = normalize(vec3((bn(uv * 24.0) - 0.5) * 0.5, (bn(uv * 24.0 + 7.0) - 0.5) * 0.5, 1.0));
    f.albedo *= 0.9 + 0.18 * n;
    f.rough = 0.9;
  } else if (wallType == 2) { // brick 0.203 x 0.068 + 10 mm mortar
    vec2 b = uv / vec2(0.213, 0.078);
    float row = floor(b.y);
    b.x += mod(row, 2.0) * 0.5;
    vec2 cell = floor(b);
    vec2 fb = fract(b);
    float mortar = 1.0 - step(0.045, fb.x) * step(fb.x, 0.955) * step(0.12, fb.y) * step(fb.y, 0.88);
    vec3 brick = wallCol * (0.78 + 0.4 * bh(cell + seed)) * (0.93 + 0.1 * bn(uv * 30.0));
    f.albedo = mix(brick, vec3(0.62, 0.6, 0.56), mortar);
    f.nTS = normalize(vec3(0.0, 0.0, 1.0) + vec3((fb.x < 0.05 ? -0.6 : fb.x > 0.95 ? 0.6 : 0.0), (fb.y < 0.12 ? -0.6 : fb.y > 0.88 ? 0.6 : 0.0), 0.0) * mortar);
    f.rough = 0.85;
  } else if (wallType == 3) { // metal cladding, ribs every 0.3 m
    float t = fract(uv.x / 0.3);
    float rib = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.16, 0.24, t));
    f.nTS = normalize(vec3((t < 0.08 ? 1.2 : (t > 0.16 && t < 0.24) ? -1.2 : 0.0), 0.0, 1.0));
    f.albedo *= 0.92 + 0.08 * rib - 0.05 * grain;
    // Rust/dirt streaks.
    f.albedo *= 1.0 - 0.12 * smoothstep(0.55, 0.9, bn(vec2(uv.x * 3.0, uv.y * 0.3) + seed));
    f.metal = 0.55;
    f.rough = 0.4;
  } else if (wallType == 4) { // board and batten
    float t = fract(uv.x / 0.3);
    float batten = step(0.88, t);
    f.nTS = normalize(vec3(t > 0.86 && t < 0.88 ? -1.5 : (t > 0.98 ? 1.5 : 0.0), 0.0, 1.0));
    f.albedo *= (0.85 + 0.25 * bn(vec2(uv.x * 40.0, uv.y * 1.5))) * (1.0 - 0.1 * batten);
    f.rough = 0.8;
  } else { // concrete block
    vec2 b = uv / vec2(0.4, 0.2);
    b.x += mod(floor(b.y), 2.0) * 0.5;
    vec2 fb = fract(b);
    float joint = 1.0 - step(0.02, fb.x) * step(fb.y, 0.96);
    f.albedo *= (0.9 + 0.12 * bh(floor(b) + seed)) * mix(1.0, 0.8, joint);
    f.rough = 0.9;
  }
  // Grime near the ground and under the eaves.
  f.albedo *= 1.0 - 0.18 * (1.0 - smoothstep(0.3, 1.2, uv.y)) * bn(uv * vec2(2.0, 6.0));
  // ---- foundation band
  float found = win == 2 ? 0.2 : 0.45;
  if (uv.y < found) {
    f.albedo = vec3(0.47, 0.46, 0.43) * (0.85 + 0.2 * bfbm(uv * 12.0));
    f.nTS = vec3(0.0, 0.0, 1.0);
    f.rough = 0.9;
    f.metal = 0.0;
    return f;
  }
  if (uv.y > eaveRel + 0.01 && win != 4) return f; // gable ends above the eave: siding only
  // ---- openings
  float h1 = bh1(seed * 131.7);
  float h2 = bh1(seed * 71.3);
  int nFloors = int(max(1.0, floor((eaveRel - found) / floorH + 0.3)));
  vec3 Nw = normalize(vWN);
  vec3 Tw = normalize(cross(Nw, vec3(0.0, 1.0, 0.0)));
  vec3 rd = normalize(vec3(dot(V, Tw), dot(V, vec3(0.0, 1.0, 0.0)), dot(V, -Nw)));
  // Doors (front walls).
  bool isGarageBldg = garageCls > 0.5;
  if (isFront > 0.5 && (win == 0 || win == 5) && wallLen > 3.0) {
    float du = wallLen * (0.3 + 0.4 * h1);
    vec2 lo = vec2(du - 0.48, found), hi = vec2(du + 0.48, found + 2.05);
    if (rectMask(uv, lo - 0.07, hi + vec2(0.07, 0.07)) > 0.0) {
      vec3 doorC = mix(vec3(0.85, 0.84, 0.8), vec3(0.35, 0.18, 0.12), step(0.5, h2));
      doorC = mix(doorC, vec3(0.2, 0.3, 0.45), step(0.8, h2));
      bool inDoor = rectMask(uv, lo, hi) > 0.0;
      f.albedo = inDoor ? doorC : trim;
      vec2 dl = (uv - lo) / (hi - lo);
      float panel = step(0.12, fract(dl.y * 2.0)) * step(0.15, dl.x) * step(dl.x, 0.85);
      f.nTS = inDoor ? normalize(vec3(0.0, 0.0, 1.0) + vec3(0.0, (fract(dl.y * 2.0) < 0.12 ? 0.4 : 0.0), 0.0) * (1.0 - panel)) : f.nTS;
      f.rough = 0.45;
      f.metal = 0.0;
      // Door knob and a small window.
      if (inDoor && length((uv - vec2(du + 0.36, found + 0.95)) * vec2(1.0, 1.0)) < 0.03) { f.albedo = vec3(0.8, 0.7, 0.4); f.metal = 1.0; f.rough = 0.3; }
      // Porch light at night.
      if (!inDoor && length(uv - vec2(hi.x + 0.3, found + 1.9)) < 0.08) f.emissive = vec3(4.0, 3.1, 2.0) * uNight;
      return f;
    }
  }
  if (isGarageBldg && isFront > 0.5 && wallLen > 2.8) {
    float gw = wallLen > 7.5 ? 4.9 : min(2.7, wallLen - 0.6);
    float gu = wallLen * 0.5;
    vec2 lo = vec2(gu - gw * 0.5, found - 0.25), hi = vec2(gu + gw * 0.5, found + 2.1);
    if (rectMask(uv, lo - 0.08, hi + 0.08) > 0.0) {
      bool inDoor = rectMask(uv, lo, hi) > 0.0;
      float pr = fract((uv.y - lo.y) / 0.53);
      f.albedo = inDoor ? mix(vec3(0.88, 0.87, 0.84), wallCol, 0.25) * (pr < 0.06 ? 0.75 : 1.0) : trim;
      f.nTS = inDoor ? normalize(vec3(0.0, pr < 0.06 ? 1.2 : 0.0, 1.0)) : f.nTS;
      f.rough = 0.5;
      f.metal = 0.0;
      return f;
    }
  }
  if (win == 4) return f;
  // Industrial roll-up doors along the front wall.
  if (win == 2 && isFront > 0.5 && wallLen > 7.0) {
    float n = floor(wallLen / 9.0);
    float cell = wallLen / max(n, 1.0);
    float cu = (floor(uv.x / cell) + 0.5) * cell;
    vec2 lo = vec2(cu - 2.1, 0.1), hi = vec2(cu + 2.1, 4.4);
    if (rectMask(uv, lo, hi) > 0.0) {
      float pr = fract((uv.y - lo.y) / 0.09);
      f.albedo = mix(vec3(0.75, 0.76, 0.74), vec3(0.8, 0.55, 0.2), step(0.7, h1)) * (0.92 + 0.08 * step(0.5, pr));
      f.nTS = normalize(vec3(0.0, (pr - 0.5) * 0.8, 1.0));
      f.metal = 0.4;
      f.rough = 0.45;
      return f;
    }
  }
  // Window grid.
  float cellW;
  vec2 wsz;
  float sill;
  if (win == 1) { cellW = 1.6; wsz = vec2(1.45, 2.4); sill = found + 0.35; }
  else if (win == 2) { cellW = 6.0; wsz = vec2(1.2, 0.8); sill = 2.2; }
  else if (win == 3) { cellW = 1.3; wsz = vec2(1.15, 1.7); sill = found + 0.9; }
  else if (win == 5) { cellW = 2.9; wsz = vec2(1.2, 1.35); sill = found + 0.85; }
  else { cellW = 3.0 + h2 * 0.8; wsz = vec2(1.1 + 0.6 * h1, 1.2 + 0.25 * h2); sill = found + 0.8; }
  float margin = win == 1 ? 0.4 : 0.9;
  float usable = wallLen - 2.0 * margin;
  if (usable < wsz.x + 0.2) return f;
  float nW = max(1.0, floor(usable / cellW + 0.35));
  float cw = usable / nW;
  float ci = floor((uv.x - margin) / cw);
  if (ci < 0.0 || ci >= nW) return f;
  float cu = margin + (ci + 0.5) * cw;
  float fl = floor((uv.y - found) / floorH);
  if (fl < 0.0 || fl >= float(nFloors)) return f;
  // Storefronts only on the ground floor of front walls.
  if (win == 1 && (isFront < 0.5 || fl > 0.0)) { wsz = vec2(1.2, 1.4); sill = found + 0.9; }
  float by = found + fl * floorH;
  float wy0 = (win == 1 && isFront > 0.5 && fl == 0.0) ? sill : by + (sill - found);
  vec2 lo = vec2(cu - wsz.x * 0.5, wy0), hi = vec2(cu + wsz.x * 0.5, wy0 + wsz.y);
  if (hi.y > eaveRel - 0.15) return f;
  float wid = ci + fl * 17.0 + seed * 1000.0;
  if (win == 0 && isFront < 0.5 && bh1(wid * 3.7) < 0.18) return f;
  float fr = 0.07;
  if (rectMask(uv, lo - fr, hi + fr) == 0.0) {
    // Sill shadow and drip streaks below windows.
    if (uv.x > lo.x && uv.x < hi.x && uv.y < lo.y - fr && uv.y > lo.y - fr - 0.6) f.albedo *= 1.0 - 0.1 * bn(vec2(uv.x * 12.0, uv.y * 2.0));
    return f;
  }
  bool inGlass = rectMask(uv, lo, hi) > 0.0;
  if (!inGlass) {
    f.albedo = trim;
    f.rough = 0.4;
    f.metal = 0.0;
    f.nTS = vec3(0.0, 0.0, 1.0);
    if (uv.y < lo.y) { f.nTS = normalize(vec3(0.0, 1.0, 0.5)); }
    return f;
  }
  vec2 wl = (uv - lo) / (hi - lo);
  // Mullions / muntins.
  float mul = 0.0;
  if (win == 1) mul = step(abs(wl.y - 0.85), 0.012);
  else mul = step(abs(wl.x - 0.5), 0.018) * step(0.5, h1) + step(abs(wl.y - 0.5), 0.02) * step(0.3, h2);
  if (mul > 0.0) { f.albedo = trim; f.rough = 0.4; return f; }
  // Blinds / curtains per window.
  float rs = floor(wid) + 0.37;
  float blind = bh1(rs * 1.3);
  float blindDown = step(0.6, blind) * (0.2 + 0.7 * bh1(rs * 2.9));
  float roomH = floorH - 0.3;
  vec2 local = vec2(uv.x - cu, uv.y - by);
  float lit = step(0.45, bh1(rs * 8.3 + floor(uTime / 900.0) * 0.0));
  vec3 inside = interior(local, vec2(max(cw * 0.5, 1.2), 0.0), roomH, 3.5 + bh1(rs) * 2.0, rd, rs, lit);
  if (wl.y > 1.0 - blindDown) {
    float slat = fract(uv.y / 0.03);
    vec3 bc = mix(vec3(0.9, 0.88, 0.82), vec3(0.6, 0.55, 0.45), step(0.8, blind));
    inside = bc * (0.55 + 0.45 * slat) * mix(0.5 * uInterior, 1.2 * lit, uNight);
  }
  float curtain = step(0.75, bh1(rs * 5.1)) * (1.0 - smoothstep(0.12, 0.2, min(wl.x, 1.0 - wl.x)));
  inside = mix(inside, vec3(0.55, 0.45, 0.4) * mix(0.6 * uInterior, 1.3 * lit, uNight), curtain);
  f.albedo = vec3(0.0);
  f.emissive = inside;
  f.rough = 0.06;
  f.metal = 0.0;
  f.glass = 1.0;
  return f;
}
`;

const roofFrag = /* glsl */ `
struct RoofS { vec3 albedo; float rough; float metal; vec3 nTS; };
RoofS roofSurface() {
  vec2 uv = vWallUV;
  vec3 base = vF0.rgb;
  int type = int(vF0.a + 0.5);
  float seed = vF1.x;
  RoofS r;
  r.albedo = base;
  r.rough = 0.85;
  r.metal = 0.0;
  r.nTS = vec3(0.0, 0.0, 1.0);
  if (type == 0) {
    // 3-tab asphalt shingles: 0.143 m exposure, 0.333 m tabs, staggered courses.
    float row = floor(uv.y / 0.143);
    float fy = fract(uv.y / 0.143);
    float x = uv.x / 0.333 + row * 0.5 + bh1(row + seed * 10.0) * 0.37;
    float col = floor(x);
    float fx = fract(x);
    float slot = 1.0 - smoothstep(0.0, 0.02, fx) * smoothstep(1.0, 0.98, fx);
    float jitter = bh(vec2(col, row) + seed);
    r.albedo = base * (0.82 + 0.3 * jitter) * (0.9 + 0.2 * bn(uv * 30.0));
    // Butt edge shadow at the bottom of each course (fall line increases downslope).
    float butt = smoothstep(0.82, 1.0, fy);
    r.albedo *= 1.0 - 0.35 * butt - 0.3 * slot;
    r.nTS = normalize(vec3(0.0, mix(-0.15, 1.2, butt), 1.0));
    // Algae / weathering streaks.
    r.albedo *= 1.0 - 0.15 * smoothstep(0.6, 0.95, bn(vec2(uv.x * 0.8, uv.y * 0.15) + seed * 7.0));
    r.rough = 0.92;
  } else if (type == 1) {
    // Standing seam metal: seams every 0.43 m across the slope.
    float t = fract(uv.x / 0.43);
    float seam = 1.0 - smoothstep(0.0, 0.025, t) * smoothstep(1.0, 0.975, t);
    r.nTS = normalize(vec3((t < 0.025 ? 1.5 : t > 0.975 ? -1.5 : (bn(uv * vec2(3.0, 0.7)) - 0.5) * 0.08), 0.0, 1.0));
    r.albedo = base * (0.95 + 0.05 * bn(uv * 2.0)) * (1.0 - 0.08 * seam);
    r.metal = 0.7;
    r.rough = 0.35 + 0.2 * bn(uv * 0.5 + seed);
  } else {
    // Membrane / gravel ballast flat roof.
    float g = bfbm(uv * 25.0 + seed * 5.0);
    r.albedo = base * (0.85 + 0.3 * g);
    float seamL = step(fract(uv.x / 3.0), 0.01) + step(fract(uv.y / 3.0), 0.01);
    r.albedo *= 1.0 - 0.15 * min(seamL, 1.0);
    r.albedo *= 1.0 - 0.2 * smoothstep(0.65, 0.9, bn(uv * 0.3 + seed));
    r.rough = 0.9;
  }
  return r;
}
`;

function tangentNormal(): string {
  return /* glsl */ `
    {
      vec3 Nw = normalize(vWN);
      vec3 up = abs(Nw.y) > 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
      vec3 Tw = normalize(cross(Nw, up));
      vec3 Bw = normalize(cross(Tw, Nw));
      vec3 pn = normalize(Tw * surfN.x + Bw * surfN.y + Nw * surfN.z);
      normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
    }
  `;
}

export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, buildingUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${attrVert}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${attrVertMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${commonFrag}\n${facadeFrag}`)
      .replace('#include <map_fragment>', `
        vec3 Vw = normalize(vWPos - cameraPosition);
        Fac fc = facade(Vw);
        diffuseColor.rgb = fc.albedo;
        vec3 surfN = fc.nTS;
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fc.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fc.metal;')
      .replace('#include <normal_fragment_maps>', tangentNormal())
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = fc.emissive;');
  };
  m.customProgramCacheKey = () => 'cw-facade-v1';
  return worldLit(m);
}

export function createRoofMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, buildingUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${attrVert}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${attrVertMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${commonFrag}\n${roofFrag}`)
      .replace('#include <map_fragment>', `
        RoofS rf = roofSurface();
        // Snow cover on gentle slopes.
        float snowK = uSnow * smoothstep(0.35, 0.7, normalize(vWN).y) * (0.85 + 0.15 * bn(vWallUV * 3.0));
        diffuseColor.rgb = mix(rf.albedo, vec3(0.92, 0.94, 0.97), snowK);
        vec3 surfN = mix(rf.nTS, vec3(0.0, 0.0, 1.0), snowK);
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(rf.rough, 0.6, snowK);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(rf.metal, 0.0, snowK);')
      .replace('#include <normal_fragment_maps>', tangentNormal());
  };
  m.customProgramCacheKey = () => 'cw-roof-v1';
  return worldLit(m);
}

export function createTrimMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${attrVert}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${attrVertMain}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${commonFrag}`)
      .replace('#include <map_fragment>', 'diffuseColor.rgb = vF0.rgb;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vF0.a > 0.5 ? 0.6 : 0.0;');
  };
  m.customProgramCacheKey = () => 'cw-trim-v1';
  return worldLit(m);
}
