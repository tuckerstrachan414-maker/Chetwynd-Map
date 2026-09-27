import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

let loader: KTX2Loader | null = null;

export function ktx2Loader(renderer: THREE.WebGLRenderer): KTX2Loader {
  if (!loader) {
    loader = new KTX2Loader().setTranscoderPath('./libs/basis/').detectSupport(renderer);
  }
  return loader;
}

/**
 * Load several same-sized KTX2 textures and assemble them into one CompressedArrayTexture
 * (or a DataArrayTexture when the transcoder falls back to uncompressed RGBA).
 */
export async function loadKtx2Array(renderer: THREE.WebGLRenderer, urls: string[], srgb: boolean): Promise<THREE.Texture> {
  const l = ktx2Loader(renderer);
  const texs = await Promise.all(urls.map((u) => l.loadAsync(u)));
  const first = texs[0] as THREE.CompressedTexture;
  const depth = texs.length;
  const mips0 = first.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[];
  const mipmaps = mips0.map((m, level) => {
    const layerBytes = m.data.byteLength;
    const data = new Uint8Array(layerBytes * depth);
    texs.forEach((t, k) => {
      const mm = (t as THREE.CompressedTexture).mipmaps as unknown as { data: Uint8Array }[];
      data.set(mm[level].data, k * layerBytes);
    });
    return { data, width: m.width, height: m.height };
  });
  let arr: THREE.Texture;
  if (first.isCompressedTexture) {
    arr = new THREE.CompressedArrayTexture(mipmaps as unknown as ImageData[], mips0[0].width, mips0[0].height, depth, first.format as THREE.CompressedPixelFormat, first.type);
  } else {
    const dat = new THREE.DataArrayTexture(mipmaps[0].data, mips0[0].width, mips0[0].height, depth);
    dat.format = first.format as THREE.PixelFormat;
    dat.type = first.type;
    dat.mipmaps = mipmaps as unknown as ImageData[];
    arr = dat;
  }
  arr.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  arr.wrapS = arr.wrapT = THREE.RepeatWrapping;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.magFilter = THREE.LinearFilter;
  arr.anisotropy = renderer.capabilities.getMaxAnisotropy();
  arr.generateMipmaps = false;
  arr.needsUpdate = true;
  texs.forEach((t) => t.dispose());
  return arr;
}
