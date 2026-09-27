import * as THREE from 'three';
import { patchTerrainVertex } from './Terrain';
import { terrainFragmentPars } from './terrainShaders';

export interface ImageryInfo {
  x0: number;
  z0: number;
  size: number;
}

export interface GroundLayers {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  tiles: number[];
  means: THREE.Vector3[];
}

/**
 * Ground shading: per-vertex material IDs (1 m) blended with height-aware weights, sampling
 * photoscanned PBR layers with anti-tiling, modulated by Sentinel-2 macro colour; far terrain
 * falls back to the satellite albedo.
 */
const groundPars = /* glsl */ `
uniform sampler2D uImgNear;
uniform sampler2D uImgRoot;
uniform vec3 uImgNearBox;
uniform vec3 uImgRootBox;
uniform highp usampler2DArray uMats;
uniform highp sampler2DArray uGroundA;
uniform highp sampler2DArray uGroundN;
uniform float uTile[16];
uniform vec3 uMean[16];
uniform float uDetailDist;
uniform float uSnow;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1, 0)), u.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), u.x), u.y);
}
float tFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * tNoise(p); p *= 2.03; a *= 0.5; }
  return s;
}

vec3 macroAlbedo(vec3 wp) {
  vec2 uvN = (wp.xz - uImgNearBox.xy) / uImgNearBox.z;
  vec2 uvR = (wp.xz - uImgRootBox.xy) / uImgRootBox.z;
  vec3 col = texture2D(uImgRoot, uvR).rgb;
  if (all(greaterThan(uvN, vec2(0.002))) && all(lessThan(uvN, vec2(0.998)))) {
    vec3 nearC = texture2D(uImgNear, uvN).rgb;
    vec2 e = min(uvN, 1.0 - uvN);
    col = mix(col, nearC, clamp(min(e.x, e.y) * 40.0, 0.0, 1.0));
  }
  return col;
}

int gMat(vec4 d, ivec2 t) {
  return int(texelFetch(uMats, ivec3(clamp(t, ivec2(0), ivec2(256)), int(d.x + 0.5)), 0).r);
}

// Two decorrelated samples blended by low-frequency noise hide texture repetition.
void gLayer(int id, vec2 wp, float nb, out vec4 A, out vec4 B) {
  float tile = uTile[id];
  vec2 uv = wp / tile;
  const mat2 R = mat2(0.7374, -0.6755, 0.6755, 0.7374);
  vec2 uv2 = R * uv * 0.71 + vec2(0.37, 0.61);
  vec4 A1 = texture(uGroundA, vec3(uv, float(id)));
  vec4 B1 = texture(uGroundN, vec3(uv, float(id)));
  vec4 A2 = texture(uGroundA, vec3(uv2, float(id)));
  vec4 B2 = texture(uGroundN, vec3(uv2, float(id)));
  // Height-aware blend between the two samples keeps detail crisp instead of averaging it.
  float w = clamp((nb - 0.5) * 3.0 + (A2.a - A1.a) * 1.5 + 0.5, 0.0, 1.0);
  A = mix(A1, A2, w);
  B = mix(B1, B2, w);
  // Rotating the second sample rotates its normals too.
  vec2 n2 = (B2.xy * 2.0 - 1.0) * R;
  B.xy = mix(B1.xy, n2 * 0.5 + 0.5, w);
}

struct GSurf { vec3 albedo; vec3 nts; float rough; float ao; };

GSurf groundSurface(vec3 wp, vec3 N, float dist) {
  GSurf s;
  vec3 macro = macroAlbedo(wp);
  s.albedo = macro;
  s.nts = vec3(0.0, 0.0, 1.0);
  s.rough = 0.9;
  s.ao = 1.0;
  float nb = tFbm(wp.xz * 0.045);
  float micro = tFbm(wp.xz * 0.35);
  // Distant or coarse terrain: satellite albedo with gentle breakup.
  float detail = (vA.w > 0.99 && vA.w < 1.01) ? 1.0 - smoothstep(uDetailDist * 0.4, uDetailDist, dist) : 0.0;
  if (detail <= 0.0) {
    s.albedo = macro * (0.85 + 0.3 * micro);
    return s;
  }
  // Domain-warp the lookup into the 1 m material grid so cell edges never read as a grid.
  vec2 warp = vec2(tNoise(wp.xz * 0.9 + 3.1), tNoise(wp.xz * 0.9 + 17.7)) - 0.5;
  warp += (vec2(tNoise(wp.xz * 3.1), tNoise(wp.xz * 3.1 + 9.3)) - 0.5) * 0.45;
  vec2 t = (wp.xz - vA.yz) * vA.w + warp * 1.3;
  ivec2 p = ivec2(floor(t));
  vec2 f = fract(t);
  int m0 = gMat(vA, p);
  int m1 = gMat(vA, p + ivec2(1, 0));
  int m2 = gMat(vA, p + ivec2(0, 1));
  int m3 = gMat(vA, p + ivec2(1, 1));
  vec2 fs = f * f * (3.0 - 2.0 * f);
  vec4 w4 = vec4((1.0 - fs.x) * (1.0 - fs.y), fs.x * (1.0 - fs.y), (1.0 - fs.x) * fs.y, fs.x * fs.y);
  vec4 A0, B0, A1, B1, A2, B2, A3, B3;
  gLayer(m0, wp.xz, nb, A0, B0);
  vec4 A = A0, B = B0;
  vec3 meanC = uMean[m0];
  if (m1 != m0 || m2 != m0 || m3 != m0) {
    gLayer(m1, wp.xz, nb, A1, B1);
    gLayer(m2, wp.xz, nb, A2, B2);
    gLayer(m3, wp.xz, nb, A3, B3);
    // Height-aware blend: taller texture detail (stones, tufts) pokes through its neighbours.
    vec4 h = w4 + vec4(A0.a, A1.a, A2.a, A3.a) * 0.45;
    float mx = max(max(h.x, h.y), max(h.z, h.w));
    vec4 k = max(h - mx + 0.3, 0.0);
    k /= dot(k, vec4(1.0));
    A = A0 * k.x + A1 * k.y + A2 * k.z + A3 * k.w;
    B = B0 * k.x + B1 * k.y + B2 * k.z + B3 * k.w;
    meanC = uMean[m0] * k.x + uMean[m1] * k.y + uMean[m2] * k.z + uMean[m3] * k.w;
  }
  vec3 alb = A.rgb;
  // Keep the real-world large-scale tone from the satellite image (luminance only, gently).
  float lm = dot(macro, vec3(0.2126, 0.7152, 0.0722));
  float lt = dot(meanC, vec3(0.2126, 0.7152, 0.0722));
  float farK = smoothstep(60.0, uDetailDist, dist);
  alb *= clamp(mix(1.0, lm / max(lt, 1e-3), mix(0.25, 0.8, farK)), 0.6, 1.5);
  alb *= 0.9 + 0.2 * nb;
  s.albedo = mix(macro, alb, detail);
  s.nts = normalize(vec3(B.xy * 2.0 - 1.0, 1.0));
  s.nts.xy *= detail;
  s.rough = mix(0.9, B.z, detail);
  s.ao = mix(1.0, B.w, detail);
  return s;
}
`;

export function createTerrainMaterials(
  terrainUniforms: Record<string, THREE.IUniform>,
  near: THREE.Texture,
  root: THREE.Texture,
  nearBox: ImageryInfo,
  rootBox: ImageryInfo,
  layers: GroundLayers,
  matAtlas: THREE.Texture,
): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  // Mutate the shared object: the terrain adds its own uniforms before the first compile.
  const uniforms = Object.assign(terrainUniforms, {
    uImgNear: { value: near },
    uImgRoot: { value: root },
    uImgNearBox: { value: new THREE.Vector3(nearBox.x0, nearBox.z0, nearBox.size) },
    uImgRootBox: { value: new THREE.Vector3(rootBox.x0, rootBox.z0, rootBox.size) },
    uMats: { value: matAtlas },
    uGroundA: { value: layers.albedo },
    uGroundN: { value: layers.normal },
    uTile: { value: layers.tiles },
    uMean: { value: layers.means },
    uDetailDist: { value: 700 },
    uSnow: { value: 0 },
  });
  const material = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  const q = new URLSearchParams(location.search);
  if (q.has('skirts')) material.defines = { DEBUG_SKIRTS: '' };
  if (q.has('gdebug')) material.defines = { DEBUG_GROUND: '' };
  material.onBeforeCompile = (shader) => {
    patchTerrainVertex(shader, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${terrainFragmentPars}\n${groundPars}`)
      .replace('#include <map_fragment>', `
        vec3 tWorldN = terrainWorldNormal();
        GSurf gs = groundSurface(vTerrainPos, tWorldN, length(vTerrainPos - uCamPos));
        diffuseColor.rgb = gs.albedo;
        #ifdef DEBUG_SKIRTS
        if (vSkirt > 0.01) diffuseColor.rgb = vec3(1.0, 0.0, 0.0);
        #endif
        #ifdef DEBUG_GROUND
        diffuseColor.rgb = vec3(gs.rough, gs.ao, gs.nts.x * 0.5 + 0.5);
        #endif
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gs.rough;')
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          vec3 Nw = tWorldN;
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
          vec3 Bt = normalize(vec3(0.0, 0.0, 1.0) - Nw * Nw.z);
          vec3 nw = normalize(T * gs.nts.x - Bt * gs.nts.y + Nw * gs.nts.z);
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
          nonPerturbedNormal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
        }
      `)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= gs.ao;
        reflectedLight.indirectSpecular *= gs.ao;
      `);
  };
  material.customProgramCacheKey = () => 'cw-terrain-v2';
  material.shadowSide = THREE.FrontSide;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.defines = { TERRAIN_DEPTH: '' };
  depth.onBeforeCompile = (shader) => patchTerrainVertex(shader, uniforms);
  depth.customProgramCacheKey = () => 'cw-terrain-depth';
  return { material, depth };
}
