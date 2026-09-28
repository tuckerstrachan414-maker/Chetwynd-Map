// Pack downloaded CC0 ground materials into per-layer KTX2 (UASTC) textures.
//   albedo_NN.ktx2: RGB albedo (sRGB) + A height
//   normal_NN.ktx2: RG normal (OpenGL, 0..1) + B roughness + A ambient occlusion
// Usage: node assets-src/build_terrain_textures.mjs [size=1024]
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const SIZE = Number(process.argv[2] || 1024);
const SRC = 'pipeline/cache/textures';
const OUT = 'public/assets/terrain';
// Order defines the material IDs used by the pipeline classifier (pipeline/ground.py).
// [name, tile size (m), roughness min, roughness max] - scanned roughness is remapped into a
// physically plausible range per surface (e.g. grass is never glossy).
const LAYERS = [
  ['lawn', 2.0, 0.72, 1.0], ['meadow', 2.5, 0.75, 1.0], ['forest_floor', 2.0, 0.62, 1.0], ['conifer_floor', 1.5, 0.62, 1.0],
  ['dirt', 2.0, 0.6, 1.0], ['gravel', 1.5, 0.6, 1.0], ['asphalt', 3.0, 0.55, 0.95], ['concrete', 2.0, 0.5, 0.95],
  ['river_cobbles', 2.9, 0.35, 0.95], ['cutbank', 4.0, 0.7, 1.0], ['mud', 1.3, 0.25, 0.9], ['moss', 2.0, 0.7, 1.0],
  ['ballast', 2.0, 0.6, 1.0], ['stubble', 2.0, 0.75, 1.0], ['snow', 2.5, 0.35, 0.8], ['sand', 2.5, 0.7, 1.0],
];

mkdirSync(OUT, { recursive: true });

async function channel(file, fallback) {
  if (!existsSync(file)) return fallback;
  const { data } = await sharp(file).resize(SIZE, SIZE, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return data;
}

const decoder = async (buf) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};

async function encode(rgba, srgb, normal) {
  const png = await sharp(Buffer.from(rgba), { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
  return encodeToKTX2(new Uint8Array(png), {
    isUASTC: true,
    generateMipmap: true,
    needSupercompression: true,
    isSetKTX2SRGBTransferFunc: srgb,
    isPerceptual: srgb,
    isNormalMap: normal,
    uastcLDRQualityLevel: 2,
    enableRDO: true,
    rdoQualityLevel: 1.5,
    imageDecoder: decoder,
  });
}

const meta = [];
for (let k = 0; k < LAYERS.length; k++) {
  const [name, tile, rmin, rmax] = LAYERS[k];
  const dir = `${SRC}/${name}`;
  const n = SIZE * SIZE;
  const alb = await sharp(`${dir}/albedo.jpg`).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const height = await channel(`${dir}/height.jpg`, Buffer.alloc(n, 128));
  const nrm = await sharp(`${dir}/normal.jpg`).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const rough = await channel(`${dir}/rough.jpg`, Buffer.alloc(n, 220));
  const ao = await channel(`${dir}/ao.jpg`, Buffer.alloc(n, 255));
  const A = new Uint8Array(n * 4);
  const B = new Uint8Array(n * 4);
  let r = 0, g = 0, b = 0;
  for (let p = 0; p < n; p++) {
    A[p * 4] = alb[p * 3];
    A[p * 4 + 1] = alb[p * 3 + 1];
    A[p * 4 + 2] = alb[p * 3 + 2];
    A[p * 4 + 3] = height[p];
    B[p * 4] = nrm[p * 3];
    B[p * 4 + 1] = nrm[p * 3 + 1];
    B[p * 4 + 2] = Math.round(255 * (rmin + (rmax - rmin) * (rough[p] / 255)));
    B[p * 4 + 3] = ao[p];
    r += alb[p * 3]; g += alb[p * 3 + 1]; b += alb[p * 3 + 2];
  }
  const id = String(k).padStart(2, '0');
  writeFileSync(`${OUT}/albedo_${id}.ktx2`, await encode(A, true, false));
  writeFileSync(`${OUT}/normal_${id}.ktx2`, await encode(B, false, true));
  const src = JSON.parse(readFileSync(`${dir}/source.json`, 'utf8'));
  meta.push({ id: k, name, tile, mean: [r / n, g / n, b / n].map((v) => Math.round(v)), source: src });
  console.log(id, name, 'done');
}
writeFileSync(`${OUT}/index.json`, JSON.stringify({ size: SIZE, layers: meta }, null, 1));
