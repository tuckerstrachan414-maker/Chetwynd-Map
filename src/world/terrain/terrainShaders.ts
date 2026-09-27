/** GLSL chunks for CDLOD terrain rendering from the height texture array. */

export const TERRAIN_GRID = 64;

export const terrainCommon = /* glsl */ `
uniform highp sampler2DArray uHeights;
uniform vec3 uCamPos;
uniform float uLodRange[16];

float thFetch(int slot, ivec2 t) {
  t = clamp(t, ivec2(0), ivec2(256));
  return texelFetch(uHeights, ivec3(t, slot), 0).r;
}

// Bilinear height from a data node. d = (slot, originX, originZ, texelsPerMetre).
float thSample(vec4 d, vec2 xz) {
  vec2 t = clamp((xz - d.yz) * d.w, vec2(0.0), vec2(256.0));
  vec2 f = floor(t);
  vec2 w = t - f;
  ivec2 p = ivec2(f);
  int s = int(d.x + 0.5);
  float a = thFetch(s, p);
  float b = thFetch(s, p + ivec2(1, 0));
  float c = thFetch(s, p + ivec2(0, 1));
  float e = thFetch(s, p + ivec2(1, 1));
  return mix(mix(a, b, w.x), mix(c, e, w.x), w.y);
}
`;

export const terrainVertexPars = /* glsl */ `
${terrainCommon}
attribute vec3 aGrid;
attribute vec4 iNode;
attribute vec4 iA;
attribute vec4 iB;
varying vec3 vTerrainPos;
varying float vMorph;
varying float vSkirt;
flat varying vec4 vA;
flat varying vec4 vB;

vec3 terrainPosition() {
  float size = iNode.z;
  int level = int(iNode.w + 0.5);
  float spacing = size / ${TERRAIN_GRID}.0;
  vec2 g = aGrid.xy;
  vec2 xz = iNode.xy + g * spacing;
  float h0 = thSample(iA, xz);
  float dist = distance(uCamPos, vec3(xz.x, h0, xz.y));
  float range = uLodRange[level + 2];
  float k = clamp((dist - range * 0.7) / (range * 0.3), 0.0, 1.0);
  g -= fract(g * 0.5) * 2.0 * k;
  xz = iNode.xy + g * spacing;
  float h = mix(thSample(iA, xz), thSample(iB, xz), k);
  vSkirt = aGrid.z;
#ifndef TERRAIN_DEPTH
  if (aGrid.z > 0.5) h -= spacing * 0.75 + 0.5;
#endif
  vMorph = k;
  vA = iA;
  vB = iB;
  vTerrainPos = vec3(xz.x, h, xz.y);
  return vTerrainPos;
}
`;

export const terrainFragmentPars = /* glsl */ `
${terrainCommon}
varying vec3 vTerrainPos;
varying float vMorph;
varying float vSkirt;
flat varying vec4 vA;
flat varying vec4 vB;

float thLinear(vec4 d, vec2 t) {
  vec2 uv = (clamp(t, vec2(0.0), vec2(256.0)) + 0.5) / 257.0;
  return texture(uHeights, vec3(uv, d.x)).r;
}

vec3 thNormal(vec4 d, vec2 xz) {
  vec2 t = (xz - d.yz) * d.w;
  float sp = 1.0 / d.w;
  float hl = thLinear(d, t - vec2(1.0, 0.0));
  float hr = thLinear(d, t + vec2(1.0, 0.0));
  float hu = thLinear(d, t - vec2(0.0, 1.0));
  float hd = thLinear(d, t + vec2(0.0, 1.0));
  return normalize(vec3(hl - hr, 2.0 * sp, hu - hd));
}

vec3 terrainWorldNormal() {
  vec3 na = thNormal(vA, vTerrainPos.xz);
  if (vMorph <= 0.0) return na;
  vec3 nb = thNormal(vB, vTerrainPos.xz);
  return normalize(mix(na, nb, vMorph));
}
`;
