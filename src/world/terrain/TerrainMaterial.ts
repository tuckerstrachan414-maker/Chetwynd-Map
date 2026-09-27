import * as THREE from 'three';
import { patchTerrainVertex } from './Terrain';
import { terrainFragmentPars } from './terrainShaders';

export interface ImageryInfo {
  x0: number;
  z0: number;
  size: number;
}

/** Fragment additions: macro albedo from Sentinel-2 plus procedural micro-variation. */
const albedoPars = /* glsl */ `
uniform sampler2D uImgNear;
uniform sampler2D uImgRoot;
uniform vec3 uImgNearBox; // x0, z0, size
uniform vec3 uImgRootBox;
uniform float uTime;

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

vec3 terrainAlbedo(vec3 wp, vec3 n) {
  vec2 uvN = (wp.xz - uImgNearBox.xy) / uImgNearBox.z;
  vec2 uvR = (wp.xz - uImgRootBox.xy) / uImgRootBox.z;
  vec3 root = texture2D(uImgRoot, uvR).rgb;
  vec3 col = root;
  if (all(greaterThan(uvN, vec2(0.002))) && all(lessThan(uvN, vec2(0.998)))) {
    vec3 nearC = texture2D(uImgNear, uvN).rgb;
    vec2 e = min(uvN, 1.0 - uvN);
    float w = clamp(min(e.x, e.y) * 40.0, 0.0, 1.0);
    col = mix(root, nearC, w);
  }
  // Micro variation so the 5-10 m satellite pixels do not read as flat colour up close.
  float n1 = tFbm(wp.xz * 0.35);
  float n2 = tFbm(wp.xz * 2.7);
  col *= 0.82 + 0.3 * n1 + 0.12 * (n2 - 0.5);
  float slope = 1.0 - n.y;
  col = mix(col, vec3(0.16, 0.14, 0.12), smoothstep(0.35, 0.6, slope));
  return max(col, vec3(0.0));
}
`;

export function createTerrainMaterials(
  terrainUniforms: Record<string, THREE.IUniform>,
  near: THREE.Texture,
  root: THREE.Texture,
  nearBox: ImageryInfo,
  rootBox: ImageryInfo,
): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  // Mutate the shared object: the terrain adds its own uniforms before the first compile.
  const uniforms = Object.assign(terrainUniforms, {
    uImgNear: { value: near },
    uImgRoot: { value: root },
    uImgNearBox: { value: new THREE.Vector3(nearBox.x0, nearBox.z0, nearBox.size) },
    uImgRootBox: { value: new THREE.Vector3(rootBox.x0, rootBox.z0, rootBox.size) },
  });
  const material = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  if (new URLSearchParams(location.search).has('skirts')) material.defines = { DEBUG_SKIRTS: '' };
  material.onBeforeCompile = (shader) => {
    patchTerrainVertex(shader, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${terrainFragmentPars}\n${albedoPars}`)
      .replace('#include <map_fragment>', `
        vec3 tWorldN = terrainWorldNormal();
        diffuseColor.rgb = terrainAlbedo(vTerrainPos, tWorldN);
        #ifdef DEBUG_SKIRTS
        if (vSkirt > 0.01) diffuseColor.rgb = vec3(1.0, 0.0, 0.0);
        #endif
      `)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize((viewMatrix * vec4(tWorldN, 0.0)).xyz);
        nonPerturbedNormal = normal;
      `);
  };
  material.customProgramCacheKey = () => 'cw-terrain';
  material.shadowSide = THREE.FrontSide;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.defines = { TERRAIN_DEPTH: '' };
  depth.onBeforeCompile = (shader) => patchTerrainVertex(shader, uniforms);
  depth.customProgramCacheKey = () => 'cw-terrain-depth';
  return { material, depth };
}
