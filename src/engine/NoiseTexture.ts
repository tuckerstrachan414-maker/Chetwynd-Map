import * as THREE from 'three';

/** Lattice size of the noise texture (the noise repeats every this many lattice cells). */
export const NOISE_SIZE = 512;

let shared: THREE.DataTexture | null = null;

/**
 * A tileable lattice of random values for value noise in shaders: four independent lattices (RGBA),
 * read with a smoothstep-remapped filtered lookup (`texNoiseGlsl`). One texture read replaces the four
 * sin-based hashes and three blends of each value-noise evaluation, which matters in fragment shaders
 * that evaluate a dozen octaves per pixel (terrain, roads). Same statistics as the hash noise, with a
 * period of NOISE_SIZE cells.
 */
export function noiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const n = NOISE_SIZE;
  const data = new Uint8Array(n * n * 4);
  // xorshift: deterministic, so the pattern is the same on every machine.
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    data[i] = s & 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  shared = t;
  return t;
}

/** GLSL: value noise (0..1) from the lattice texture `uNoiseTex`, channel 0..3. */
export const texNoiseGlsl = /* glsl */ `
uniform sampler2D uNoiseTex;
vec4 texNoise4(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoiseTex, (i + f + 0.5) / ${NOISE_SIZE.toFixed(1)}, 0.0);
}
float texNoise(vec2 p) { return texNoise4(p).r; }
`;
