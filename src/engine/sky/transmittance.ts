/** CPU port of the atmosphere transmittance integral (matches atmosphereGlsl). */
const Rg = 6360;
const Rt = 6460;
const RAY_S = [5.802e-3, 13.558e-3, 33.1e-3];
const MIE_E = 4.4e-3;
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3];

function raySphere(oy: number, dy: number, r: number): number {
  // Ray origin (0, oy, 0), unit direction with vertical component dy.
  const b = oy * dy;
  const c = oy * oy - r * r;
  if (c > 0 && b > 0) return -1;
  const d = b * b - c;
  if (d < 0) return -1;
  if (d > b * b) return -b + Math.sqrt(d);
  return -b - Math.sqrt(d);
}

/** Transmittance (rgb) from altitude `altKm` toward a direction with vertical component cosZ. */
export function transmittance(altKm: number, cosZ: number, haze = 1.6, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const oy = Rg + Math.max(altKm, 0.001);
  const dy = Math.max(-1, Math.min(1, cosZ));
  const dx = Math.sqrt(Math.max(0, 1 - dy * dy));
  if (raySphere(oy, dy, Rg) > 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const tMax = raySphere(oy, dy, Rt);
  let t = 0;
  const od = [0, 0, 0];
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const nt = ((i + 0.3) / steps) * tMax;
    const dt = nt - t;
    t = nt;
    const px = t * dx;
    const py = oy + t * dy;
    const h = Math.max(Math.hypot(px, py) - Rg, 0);
    const rd = Math.exp(-h / 8);
    const md = Math.exp(-h / 1.2) * (1 + (haze - 1) * Math.exp(-h / 0.8));
    const oz = Math.max(0, 1 - Math.abs(h - 25) / 15);
    for (let c = 0; c < 3; c++) od[c] += dt * (RAY_S[c] * rd + MIE_E * md + OZONE[c] * oz);
  }
  out[0] = Math.exp(-od[0]);
  out[1] = Math.exp(-od[1]);
  out[2] = Math.exp(-od[2]);
  return out;
}
