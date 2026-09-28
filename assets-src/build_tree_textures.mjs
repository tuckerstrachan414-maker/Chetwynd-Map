// Encode prepared foliage/bark images (assets-src/prep_tree_textures.py for conifers and bark,
// assets-src/gen_leaf_atlases.py for broadleaf twigs) to KTX2.
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const SRC = 'pipeline/cache/treetex/out';
const OUT = 'public/assets/trees';
mkdirSync(OUT, { recursive: true });
const decoder = async (buf) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
};
const jobs = [
  ['spruce_albedo', true], ['spruce_normal', false], ['pine_albedo', true], ['pine_normal', false],
  ['aspen_albedo', true], ['aspen_normal', false], ['poplar_albedo', true], ['poplar_normal', false],
  ['birch_albedo', true], ['birch_normal', false], ['willow_albedo', true], ['willow_normal', false],
  ['shrub_albedo', true], ['shrub_normal', false],
  ['bark_spruce_albedo', true], ['bark_spruce_normal', false], ['bark_pine_albedo', true], ['bark_pine_normal', false],
  ['bark_birch_albedo', true], ['bark_birch_normal', false],
];
for (const [name, srgb] of jobs) {
  const png = readFileSync(`${SRC}/${name}.png`);
  const ktx = await encodeToKTX2(new Uint8Array(png), {
    isUASTC: true, generateMipmap: true, needSupercompression: true,
    isSetKTX2SRGBTransferFunc: srgb, isPerceptual: srgb, isNormalMap: !srgb, uastcLDRQualityLevel: 2,
    imageDecoder: decoder,
  });
  writeFileSync(`${OUT}/${name}.ktx2`, ktx);
  console.log(name, ktx.length);
}
copyFileSync(`${SRC}/cells.json`, `${OUT}/cells.json`);
