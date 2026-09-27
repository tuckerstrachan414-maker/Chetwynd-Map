import * as THREE from 'three';
import { worldLit } from '../../engine/WorldLight';

/** Global vegetation uniforms (wind, time, season). */
export const vegUniforms = {
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uWind: { value: 0.35 },
  /** 0 summer, 1 autumn, 2 winter (leafless deciduous), 3 spring. */
  uSeason: { value: 0 },
  uSnow: { value: 0 },
};

const windVert = /* glsl */ `
attribute vec4 wind;
attribute float ao;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
uniform float uTreeH;
varying float vAo;
varying float vInstSeed;

vec3 applyWind(vec3 p, vec3 nrm, float instPh) {
  float h = max(uTreeH, 1.0);
  float t = clamp(p.y / h, 0.0, 1.2);
  float gust = 0.65 + 0.35 * sin(uTime * 0.37 + instPh * 0.3) * sin(uTime * 0.11 + instPh);
  float sway = (0.6 * sin(uTime * 0.9 + instPh) + 0.4 * sin(uTime * 1.7 + instPh * 1.9)) * gust;
  vec3 disp = vec3(uWindDir.x, 0.0, uWindDir.y) * (t * t * h * 0.012 * uWind * (1.0 + sway));
  float b = wind.x;
  float bs = sin(uTime * 2.3 + wind.y + instPh) + 0.5 * sin(uTime * 3.7 + wind.y * 1.3);
  disp += (vec3(uWindDir.x, 0.25, uWindDir.y) * bs) * b * 0.07 * uWind * gust;
  float f = wind.z;
  disp += nrm * sin(uTime * 13.0 + wind.w + instPh * 3.0) * f * 0.035 * uWind * (0.5 + gust);
  return p + disp;
}
`;

function instancePhase(): string {
  return /* glsl */ `
  #ifdef USE_INSTANCING
    vec3 ipos = vec3(instanceMatrix[3]);
  #else
    vec3 ipos = vec3(0.0);
  #endif
    float instPh = fract(sin(dot(ipos.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
    vInstSeed = instPh / 6.2831;
  `;
}

export interface FoliageOptions {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  H: number;
  deciduous: boolean;
  flutter: number;
}

/** Foliage: alpha-tested cards with volumetric normals, translucency, wind and season tint. */
export function createFoliageMaterial(o: FoliageOptions): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: o.map,
    normalMap: o.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.62,
    metalness: 0,
    vertexColors: false,
  });
  m.alphaToCoverage = true;
  const uniforms = { ...vegUniforms, uTreeH: { value: o.H }, uDeciduous: { value: o.deciduous ? 1 : 0 } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${windVert}`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        ${instancePhase()}
        transformed = applyWind(transformed, normal, instPh);
        vAo = ao;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vAo;
        varying float vInstSeed;
        uniform float uSeason;
        uniform float uDeciduous;
        uniform float uSnow;
        vec3 foliageTranslucency;
      `)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>
        void RE_Direct_Foliage(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
          RE_Direct_Physical(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          float back = pow(clamp(dot(geometryViewDir, -directLight.direction), 0.0, 1.0), 3.0);
          float wrap = clamp(dot(-geometryNormal, directLight.direction) * 0.5 + 0.5, 0.0, 1.0);
          reflectedLight.directDiffuse += directLight.color * material.diffuseColor * foliageTranslucency * (back * 1.6 + wrap * 0.35);
        }
        #undef RE_Direct
        #define RE_Direct RE_Direct_Foliage
      `)
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        // Season tint (instance colour carries per-species leaf colour); keep texture luminance detail.
        float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 leafCol = vColor.rgb;
        float var = 0.85 + 0.3 * fract(vInstSeed * 7.13);
        // Compress the atlas's luminance range: sunlit tips stay leaf-coloured instead of washing out.
        diffuseColor.rgb = leafCol * pow(lum / 0.35, 0.6) * var;
        // Leafless deciduous trees in winter.
        if (uDeciduous > 0.5 && uSeason > 1.5 && uSeason < 2.5) discard;
        // Snow load on the upper side of conifer sprays.
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.92), uSnow * (1.0 - uDeciduous) * smoothstep(0.2, 0.8, normalize(vNormal).y) * 0.8);
        foliageTranslucency = mix(vec3(0.9, 1.0, 0.6), vec3(1.0, 0.8, 0.4), step(0.5, uSeason) * step(uSeason, 1.5));
        // Needles are thick and waxy: little light passes through compared with thin leaves.
        foliageTranslucency *= mix(0.25, 1.0, uDeciduous);
      `)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        // Volumetric crown normals: do not flip for back faces.
        normal = normalize(vNormal);
        nonPerturbedNormal = normal;
      `)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        reflectedLight.indirectDiffuse *= vAo;
        reflectedLight.indirectSpecular *= vAo;
        reflectedLight.directDiffuse *= mix(1.0, vAo, 0.5);
      `);
    // Leaf colour comes from instanceColor (vColor) applied above; skip the default multiply.
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '');
  };
  m.customProgramCacheKey = () => `cw-foliage-${o.deciduous ? 1 : 0}-${o.H}`;
  return worldLit(m);
}

export function createBarkMaterial(map: THREE.Texture, normalMap: THREE.Texture, H: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, normalMap, roughness: 0.95, metalness: 0 });
  const uniforms = { ...vegUniforms, uTreeH: { value: H } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${windVert}`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        ${instancePhase()}
        transformed = applyWind(transformed, normal, instPh);
        vAo = ao;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAo;\nvarying float vInstSeed;\nuniform float uSnow;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.88, 0.92), uSnow * smoothstep(0.5, 0.9, normalize(vNormal).y));
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = 0.9;');
  };
  m.customProgramCacheKey = () => `cw-bark-${H}`;
  return worldLit(m);
}

/** Depth material for foliage shadows: alpha-tested cards with wind. */
export function createFoliageDepthMaterial(map: THREE.Texture, H: number, deciduous: boolean): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ map, alphaTest: 0.45, depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  const uniforms = { ...vegUniforms, uTreeH: { value: H }, uDeciduous: { value: deciduous ? 1 : 0 } };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${windVert}`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        ${instancePhase()}
        transformed = applyWind(transformed, normal, instPh);
        vAo = ao;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSeason;\nuniform float uDeciduous;')
      .replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\nif (uDeciduous > 0.5 && uSeason > 1.5 && uSeason < 2.5) discard;');
  };
  m.customProgramCacheKey = () => `cw-foliage-depth-${deciduous ? 1 : 0}-${H}`;
  return m;
}
