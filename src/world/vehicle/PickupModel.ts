import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { worldLit } from '../../engine/WorldLight';

/**
 * A generic full-size crew-cab pickup (the vehicle of the Peace country), built procedurally.
 * Chassis space: +X forward, +Y up, origin at the centre of mass (0.9 m above the ground at
 * ride height). Dimensions follow a typical crew cab with a 5.5 ft box: 5.9 m long, 2.03 m wide,
 * 1.95 m tall, 3.68 m wheelbase, 275/65R18 tyres.
 */
export const PICKUP = {
  length: 5.9,
  width: 2.03,
  wheelbase: 3.68,
  track: 1.72,
  wheelR: 0.41,
  wheelW: 0.28,
  frontX: 1.84,
  rearX: -1.84,
  rideY: 0.9, // centre of mass above ground
  mass: 2300,
};

const G = PICKUP.rideY; // ground is at y = -G in chassis space
const BED_FLOOR = -G + 0.95;

export interface PickupParts {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[]; // FL, FR, RL, RR (each spins about its local Z axis)
  headMat: THREE.MeshStandardMaterial;
  tailMat: THREE.MeshStandardMaterial;
  paint: THREE.MeshPhysicalMaterial;
}

function roundedProfile(pts: [number, number][], r: number): THREE.Shape {
  // Polygon with rounded corners (quadratic fillets), x forward, y up.
  const s = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = new THREE.Vector2(...pts[(i + n - 1) % n]);
    const p1 = new THREE.Vector2(...pts[i]);
    const p2 = new THREE.Vector2(...pts[(i + 1) % n]);
    const a = p0.clone().sub(p1);
    const b = p2.clone().sub(p1);
    const rr = Math.min(r, a.length() * 0.45, b.length() * 0.45);
    const pa = p1.clone().add(a.normalize().multiplyScalar(rr));
    const pb = p1.clone().add(b.normalize().multiplyScalar(rr));
    if (i === 0) s.moveTo(pa.x, pa.y);
    else s.lineTo(pa.x, pa.y);
    s.quadraticCurveTo(p1.x, p1.y, pb.x, pb.y);
  }
  s.closePath();
  return s;
}

/** Side profile of the lower body with both wheel arches cut out. */
function lowerBodyShape(): THREE.Shape {
  const y0 = -G + 0.42; // rocker panel bottom
  const beltF = 0.32; // hood line at the front
  const belt = 0.36; // beltline / bed rail
  const archR = PICKUP.wheelR + 0.07;
  const s = new THREE.Shape();
  const xF = 2.95, xR = -2.95;
  s.moveTo(xR, y0 + 0.08);
  // Rear arch.
  const ra = PICKUP.rearX, fa = PICKUP.frontX;
  const ay = -G + PICKUP.wheelR;
  s.lineTo(ra - archR - 0.05, y0);
  const th = Math.asin((y0 - ay) / archR);
  s.absarc(ra, ay, archR, Math.PI - th, th, true);
  // Rocker to the front arch.
  s.lineTo(fa - archR - 0.02, y0);
  s.absarc(fa, ay, archR, Math.PI - th, th, true);
  // Front bumper face and hood.
  s.lineTo(xF - 0.12, y0 + 0.02);
  s.quadraticCurveTo(xF, y0 + 0.05, xF, y0 + 0.3);
  s.lineTo(xF, beltF - 0.05);
  s.quadraticCurveTo(xF, beltF + 0.02, xF - 0.15, beltF + 0.04);
  s.lineTo(0.92, belt + 0.02); // hood rises gently to the cowl
  s.lineTo(-0.97, belt); // cab beltline
  // The box is open: the body stops at the bed floor; walls and tailgate are separate panels.
  s.lineTo(-0.97, BED_FLOOR);
  s.lineTo(xR, BED_FLOOR);
  s.lineTo(xR, y0 + 0.08);
  return s;
}

function tireTexture(): { map: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const W = 512, H = 64;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // Height map of an all-terrain tread: staggered blocks with sipes, shoulder lugs.
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const blocks = 36;
  for (let i = 0; i < blocks; i++) {
    const x = (i / blocks) * W;
    const off = i % 2 ? 4 : -4;
    g.fillStyle = '#fff';
    g.fillRect(x + 1, 3, W / blocks - 4, H / 2 - 6 + off);
    g.fillRect(x + 1 + (W / blocks) * 0.4, H / 2 + 2 + off, W / blocks - 4, H / 2 - 5 - off);
    g.fillStyle = '#555';
    g.fillRect(x + (W / blocks) * 0.5, 6, 1, H / 2 - 10);
  }
  const img = g.getImageData(0, 0, W, H);
  const h = (x: number, y: number) => img.data[(((y + H) % H) * W + ((x + W) % W)) * 4] / 255;
  const nc = document.createElement('canvas');
  nc.width = W;
  nc.height = H;
  const ng = nc.getContext('2d')!;
  const nimg = ng.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 2.5;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 2.5;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      const k = (y * W + x) * 4;
      nimg.data[k] = (n.x * 0.5 + 0.5) * 255;
      nimg.data[k + 1] = (n.y * 0.5 + 0.5) * 255;
      nimg.data[k + 2] = (n.z * 0.5 + 0.5) * 255;
      nimg.data[k + 3] = 255;
      // Grooves are darker and dusty.
      const v = h(x, y);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 18 + v * 14;
    }
  }
  ng.putImageData(nimg, 0, 0);
  g.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const normal = new THREE.CanvasTexture(nc);
  for (const t of [map, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
  }
  return { map, normal };
}

function wheel(mats: Record<string, THREE.Material>, tire: { map: THREE.Texture; normal: THREE.Texture }): THREE.Group {
  const R = PICKUP.wheelR, W = PICKUP.wheelW;
  const g = new THREE.Group();
  // Tyre: lathe of a rounded section; tread texture runs around the circumference.
  const rim = 0.235;
  const prof: THREE.Vector2[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI;
    const bulge = Math.sin(a);
    const y = -W / 2 + (i / steps) * W;
    const r = rim + (R - rim) * (0.55 + 0.45 * Math.pow(bulge, 0.35));
    prof.push(new THREE.Vector2(r, y));
  }
  const tireGeo = new THREE.LatheGeometry(prof, 48);
  tireGeo.rotateX(Math.PI / 2); // axle along Z
  const tMat = new THREE.MeshStandardMaterial({ map: tire.map, normalMap: tire.normal, roughness: 0.92, color: 0xffffff });
  tMat.map!.repeat.set(1, 1);
  worldLit(tMat);
  const tireMesh = new THREE.Mesh(tireGeo, tMat);
  tireMesh.castShadow = true;
  g.add(tireMesh);
  // Six-spoke alloy: dish, spokes and centre cap on the outer face (+Z is outboard).
  const face = W / 2 - 0.035;
  const dish = new THREE.CylinderGeometry(rim, rim, 0.02, 40);
  dish.rotateX(Math.PI / 2);
  dish.translate(0, 0, face - 0.08);
  const barrel = new THREE.CylinderGeometry(rim, rim, W - 0.06, 40, 1, true);
  barrel.rotateX(Math.PI / 2);
  const lip = new THREE.TorusGeometry(rim - 0.008, 0.012, 6, 48);
  lip.translate(0, 0, face);
  const parts: THREE.BufferGeometry[] = [dish, barrel, lip];
  for (let k = 0; k < 6; k++) {
    const sp = new THREE.BoxGeometry(0.06, rim - 0.05, 0.035);
    sp.translate(0, (rim - 0.05) / 2 + 0.05, face - 0.03);
    sp.rotateZ((k / 6) * Math.PI * 2);
    parts.push(sp);
  }
  const hub = new THREE.CylinderGeometry(0.075, 0.085, 0.05, 20);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, face - 0.02);
  parts.push(hub);
  const rimMesh = new THREE.Mesh(mergeGeometries(parts.map((p) => p.toNonIndexed())), mats.alloy);
  rimMesh.castShadow = true;
  g.add(rimMesh);
  // Brake rotor and caliper visible through the spokes.
  const rotor = new THREE.CylinderGeometry(0.17, 0.17, 0.03, 32);
  rotor.rotateX(Math.PI / 2);
  rotor.translate(0, 0, face - 0.13);
  g.add(new THREE.Mesh(rotor, mats.steel));
  return g;
}

export function buildPickup(color = 0xe9ecef): PickupParts {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paint = worldLit(new THREE.MeshPhysicalMaterial({
    color, metalness: 0.35, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.06,
  }));
  const mats: Record<string, THREE.Material> = {
    paint,
    black: worldLit(new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.75 })),
    trim: worldLit(new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 0.45 })),
    chrome: worldLit(new THREE.MeshStandardMaterial({ color: 0xdadde0, metalness: 1, roughness: 0.12 })),
    alloy: worldLit(new THREE.MeshStandardMaterial({ color: 0xb9bcc0, metalness: 0.9, roughness: 0.28 })),
    steel: worldLit(new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.8, roughness: 0.5 })),
    glass: worldLit(new THREE.MeshPhysicalMaterial({
      color: 0x0d1215, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.82,
    })),
    bedliner: worldLit(new THREE.MeshStandardMaterial({ color: 0x1a1a1b, roughness: 0.95 })),
    plate: worldLit(new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.5 })),
  };
  const headMat = worldLit(new THREE.MeshStandardMaterial({ color: 0xf2f4f5, roughness: 0.1, metalness: 0.2, emissive: 0xfff4e0, emissiveIntensity: 0 }));
  const tailMat = worldLit(new THREE.MeshStandardMaterial({ color: 0x6a0a0a, roughness: 0.15, emissive: 0xff1a0a, emissiveIntensity: 0 }));
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, shadow = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = shadow;
    m.receiveShadow = true;
    body.add(m);
    return m;
  };
  const W = PICKUP.width;
  // Lower body: profile extruded across the width with rounded side edges.
  const lower = new THREE.ExtrudeGeometry(lowerBodyShape(), {
    depth: W - 0.1, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 3, curveSegments: 16,
  });
  lower.translate(0, 0, -(W - 0.1) / 2);
  add(lower, paint);
  // Bed: side walls, front wall and tailgate as panels around a lined floor.
  const bedX0 = -2.95, bedX1 = -0.97, rail = 0.36;
  const bedLen = bedX1 - bedX0;
  const panel = (sx: number, sy: number, sz: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    geo.translate(x, y, z);
    return add(geo, mat);
  };
  const wallH = rail - BED_FLOOR;
  for (const sz of [-1, 1]) panel(bedLen, wallH, 0.06, (bedX0 + bedX1) / 2, BED_FLOOR + wallH / 2, sz * (W / 2 - 0.03), paint);
  panel(0.06, wallH, W - 0.1, bedX1 - 0.03, BED_FLOOR + wallH / 2, 0, paint);
  panel(0.07, wallH, W - 0.1, bedX0 + 0.035, BED_FLOOR + wallH / 2, 0, paint);
  const floor = panel(bedLen - 0.12, 0.02, W - 0.14, (bedX0 + bedX1) / 2, BED_FLOOR + 0.01, 0, mats.bedliner);
  floor.castShadow = false;
  // Corrugations in the floor.
  for (let k = -5; k <= 5; k++) panel(bedLen - 0.14, 0.025, 0.04, (bedX0 + bedX1) / 2, BED_FLOOR + 0.025, k * 0.15, mats.bedliner).castShadow = false;
  // Rail caps.
  for (const sz of [-1, 1]) panel(bedLen, 0.035, 0.1, (bedX0 + bedX1) / 2, rail + 0.018, sz * (W / 2 - 0.05), mats.black);
  // Cab greenhouse: tapered glass box with painted pillars and roof.
  const cabX0 = -0.95, cabX1 = 0.95, beltY = 0.37, roofY = 0.98;
  const gh = roundedProfile([[cabX0, beltY], [cabX1 - 0.05, beltY], [cabX1 - 0.62, roofY], [cabX0 + 0.06, roofY]], 0.06);
  const ghGeo = new THREE.ExtrudeGeometry(gh, { depth: W - 0.3, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelSegments: 2 });
  ghGeo.translate(0, 0, -(W - 0.3) / 2);
  add(ghGeo, mats.glass, false);
  const roof = new THREE.ExtrudeGeometry(roundedProfile([[cabX0 - 0.01, roofY - 0.03], [cabX1 - 0.6, roofY - 0.03], [cabX1 - 0.64, roofY + 0.045], [cabX0 + 0.04, roofY + 0.045]], 0.03), {
    depth: W - 0.26, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.03, bevelSegments: 3,
  });
  roof.translate(0, 0, -(W - 0.26) / 2);
  add(roof, paint);
  // Pillars (A, B, C) on each side.
  const pillar = (x0: number, x1: number, wdt: number, sz: number) => {
    const a = new THREE.Vector3(x0, beltY, sz * (W / 2 - 0.17));
    const b = new THREE.Vector3(x1, roofY, sz * (W / 2 - 0.17));
    const len = a.distanceTo(b);
    const geo = new THREE.BoxGeometry(wdt, len, 0.1);
    const m = add(geo, paint);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.rotation.z = -Math.atan2(b.x - a.x, b.y - a.y);
  };
  for (const sz of [-1, 1]) {
    pillar(cabX1 - 0.05, cabX1 - 0.62, 0.07, sz);
    pillar(0.02, 0.02, 0.09, sz);
    pillar(cabX0 + 0.02, cabX0 + 0.08, 0.14, sz);
  }
  // Door seams, handles and mirrors.
  for (const sz of [-1, 1]) {
    const z = sz * (W / 2 + 0.005);
    for (const x of [0.93, 0.02, -0.93]) {
      const seam = new THREE.BoxGeometry(0.008, 0.78, 0.01);
      seam.translate(x, -0.03, z);
      add(seam, mats.trim, false);
    }
    for (const x of [0.62, -0.28]) {
      const hdl = new THREE.BoxGeometry(0.2, 0.035, 0.03);
      hdl.translate(x, 0.24, z + sz * 0.01);
      add(hdl, mats.chrome, false);
    }
    const arm = new THREE.BoxGeometry(0.1, 0.05, 0.16);
    arm.translate(0.82, 0.45, sz * (W / 2 + 0.06));
    add(arm, mats.black);
    const mirror = new THREE.BoxGeometry(0.1, 0.26, 0.24);
    mirror.translate(0.82, 0.5, sz * (W / 2 + 0.2));
    add(mirror, mats.black);
    // Running boards.
    const step = new THREE.BoxGeometry(2.1, 0.05, 0.16);
    step.translate(0, -G + 0.4, sz * (W / 2 - 0.02));
    add(step, mats.black);
    // Fender flares.
    for (const ax of [PICKUP.frontX, PICKUP.rearX]) {
      const flare = new THREE.TorusGeometry(PICKUP.wheelR + 0.1, 0.045, 6, 20, Math.PI);
      flare.translate(ax, -G + PICKUP.wheelR, sz * (W / 2 - 0.02));
      add(flare, mats.black);
    }
  }
  // Front: grille, headlamps, bumper, plate.
  const xF = 2.99;
  const grille = new THREE.BoxGeometry(0.06, 0.42, 1.28);
  grille.translate(xF, -0.02, 0);
  add(grille, mats.trim);
  for (let k = 0; k < 4; k++) {
    const bar = new THREE.BoxGeometry(0.02, 0.03, 1.26);
    bar.translate(xF + 0.03, -0.18 + k * 0.1, 0);
    add(bar, mats.chrome, false);
  }
  for (const sz of [-1, 1]) {
    const lamp = new THREE.BoxGeometry(0.08, 0.16, 0.34);
    lamp.translate(xF - 0.03, 0.14, sz * 0.78);
    add(lamp, headMat, false);
    const drl = new THREE.BoxGeometry(0.05, 0.025, 0.36);
    drl.translate(xF - 0.01, 0.235, sz * 0.78);
    add(drl, headMat, false);
    const tail = new THREE.BoxGeometry(0.06, 0.42, 0.1);
    tail.translate(-2.97, 0.05, sz * (W / 2 - 0.08));
    add(tail, tailMat, false);
  }
  const bumperF = new THREE.BoxGeometry(0.22, 0.26, W - 0.02);
  bumperF.translate(xF - 0.02, -G + 0.62, 0);
  add(bumperF, mats.chrome);
  const bumperR = new THREE.BoxGeometry(0.2, 0.2, W - 0.06);
  bumperR.translate(-3.0, -G + 0.6, 0);
  add(bumperR, mats.chrome);
  const hitch = new THREE.BoxGeometry(0.25, 0.06, 0.06);
  hitch.translate(-3.12, -G + 0.5, 0);
  add(hitch, mats.steel);
  for (const [x, rot] of [[xF + 0.1, 0], [-3.11, Math.PI]] as const) {
    const plate = new THREE.BoxGeometry(0.01, 0.15, 0.3);
    const m = add(plate, mats.plate, false);
    m.position.set(x, rot ? -G + 0.8 : -G + 0.66, 0);
  }
  // Tailgate handle and underbody (frame rails, fuel tank, exhaust).
  const tgh = new THREE.BoxGeometry(0.03, 0.05, 0.22);
  tgh.translate(-2.99, 0.28, 0);
  add(tgh, mats.black, false);
  for (const sz of [-1, 1]) {
    const railG = new THREE.BoxGeometry(5.3, 0.18, 0.08);
    railG.translate(-0.1, -G + 0.5, sz * 0.5);
    add(railG, mats.steel);
  }
  const exhaust = new THREE.CylinderGeometry(0.04, 0.04, 0.3, 10);
  exhaust.rotateZ(Math.PI / 2);
  exhaust.translate(-2.9, -G + 0.42, -0.7);
  add(exhaust, mats.chrome);

  const tire = tireTexture();
  const wheels: THREE.Group[] = [];
  for (const [x, sz] of [[PICKUP.frontX, 1], [PICKUP.frontX, -1], [PICKUP.rearX, 1], [PICKUP.rearX, -1]] as const) {
    const pivot = new THREE.Group(); // steering pivot
    const w = wheel(mats, tire);
    if (sz < 0) w.rotation.y = Math.PI; // outer face outboard on both sides
    const spin = new THREE.Group();
    spin.add(w);
    pivot.add(spin);
    pivot.position.set(x, -G + PICKUP.wheelR, sz * PICKUP.track / 2);
    root.add(pivot);
    wheels.push(pivot);
  }
  return { root, body, wheels, headMat, tailMat, paint };
}
