import * as THREE from 'three';

/**
 * A tileable water detail texture generated at startup:
 *  R, G  surface slope (d/dx, d/dz) of a sum of integer-wavenumber waves with a power-law spectrum
 *  B     the matching height field (for caustics)
 *  A     a cellular foam pattern
 */
export function createWaterTexture(size = 256, seed = 7): THREE.DataTexture {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const waves: { kx: number; ky: number; a: number; ph: number }[] = [];
  for (let i = 0; i < 56; i++) {
    const ang = rnd() * Math.PI * 2;
    const k = Math.exp(Math.log(3) + rnd() * (Math.log(34) - Math.log(3)));
    const kx = Math.round(Math.cos(ang) * k);
    const ky = Math.round(Math.sin(ang) * k);
    if (kx === 0 && ky === 0) continue;
    const km = Math.hypot(kx, ky);
    waves.push({ kx, ky, a: Math.pow(km, -1.6) * (0.6 + 0.8 * rnd()), ph: rnd() * Math.PI * 2 });
  }
  const n = size * size;
  const h = new Float32Array(n);
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let hv = 0;
      let dx = 0;
      let dy = 0;
      for (const w of waves) {
        const t = TAU * (w.kx * u + w.ky * v) + w.ph;
        const sn = Math.sin(t);
        const cs = Math.cos(t);
        hv += w.a * sn;
        dx += w.a * TAU * w.kx * cs;
        dy += w.a * TAU * w.ky * cs;
      }
      const i = y * size + x;
      h[i] = hv;
      sx[i] = dx;
      sy[i] = dy;
    }
  }
  let hmin = Infinity;
  let hmax = -Infinity;
  let smax = 0;
  for (let i = 0; i < n; i++) {
    hmin = Math.min(hmin, h[i]);
    hmax = Math.max(hmax, h[i]);
    smax = Math.max(smax, Math.abs(sx[i]), Math.abs(sy[i]));
  }
  // Cellular foam: distance between the two nearest feature points on a tiled 10x10 grid, plus detail.
  const cells = 10;
  const fx = new Float32Array(cells * cells);
  const fy = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    fx[i] = rnd();
    fy[i] = rnd();
  }
  const foam = new Float32Array(n);
  let fmin = Infinity;
  let fmax = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x / size) * cells;
      const py = (y / size) * cells;
      const cx = Math.floor(px);
      const cy = Math.floor(py);
      let d1 = 9;
      let d2 = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox;
          const gy = cy + oy;
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const d = Math.hypot(gx + fx[k] - px, gy + fy[k] - py);
          if (d < d1) {
            d2 = d1;
            d1 = d;
          } else if (d < d2) d2 = d;
        }
      }
      const i = y * size + x;
      // Bright foam along cell borders, broken up by the wave height.
      const edge = 1 - Math.min(1, (d2 - d1) * 2.2);
      const f = edge * 0.75 + ((h[i] - hmin) / (hmax - hmin)) * 0.25;
      foam[i] = f;
      fmin = Math.min(fmin, f);
      fmax = Math.max(fmax, f);
    }
  }
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    data[i * 4] = Math.round((0.5 + 0.5 * (sx[i] / smax)) * 255);
    data[i * 4 + 1] = Math.round((0.5 + 0.5 * (sy[i] / smax)) * 255);
    data[i * 4 + 2] = Math.round(((h[i] - hmin) / (hmax - hmin)) * 255);
    data[i * 4 + 3] = Math.round(((foam[i] - fmin) / (fmax - fmin)) * 255);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
