import * as THREE from 'three';

const MAX_TREES = 48;
const COUNT = 1800;

const vert = /* glsl */ `
uniform float uTime;
uniform vec4 uTrees[${MAX_TREES}]; // crown centre x, y, z, crown radius
uniform float uBase[${MAX_TREES}];  // ground height under each tree
uniform vec4 uTint[${MAX_TREES}];   // leaf colour of the species, amount
uniform float uCount;
uniform vec2 uWind;
attribute vec4 aSeed;
varying vec3 vCol;
varying float vA;
varying vec3 vN;
float h1(float n) { return fract(sin(n * 91.3458) * 47453.5453); }
void main() {
  if (uCount < 0.5) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float fall = 2.2 + 1.3 * aSeed.y;            // s of free fall per metre-ish
  float period = 14.0 + 10.0 * aSeed.z;
  float t = fract(uTime / period + aSeed.x);
  float cycle = floor(uTime / period + aSeed.x);
  float k = floor(h1(aSeed.w * 13.0 + cycle * 7.1) * uCount);
  vec4 tr = uTrees[int(k)];
  vec4 tint = uTint[int(k)];
  if (h1(aSeed.w * 3.0 + cycle) > tint.a) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  float base = uBase[int(k)];
  // Start somewhere in the crown.
  float ang = h1(aSeed.w + cycle * 1.7) * 6.2831;
  float rad = sqrt(h1(aSeed.w * 5.3 + cycle)) * tr.w;
  vec3 start = tr.xyz + vec3(cos(ang) * rad, (h1(aSeed.w * 2.1 + cycle) - 0.3) * tr.w, sin(ang) * rad);
  float drop = start.y - base;
  float tFall = drop * fall / 3.0;              // seconds to reach the ground (~0.8-1.2 m/s)
  float tt = t * period;
  float ft = min(tt, tFall);
  // Flutter: a leaf side-slips in a spiral as it falls, drifting downwind.
  float sw = 1.6 + aSeed.y;
  vec3 p = start + vec3(uWind.x, 0.0, uWind.y) * ft * 0.6
         + vec3(sin(ft * sw + aSeed.x * 6.0), 0.0, cos(ft * sw * 0.9 + aSeed.z * 6.0)) * 0.45;
  p.y = start.y - drop * (ft / tFall);
  bool landed = tt > tFall;
  // Tumbling orientation while falling; flat on the ground after landing.
  float a1 = landed ? 1.5708 : ft * (3.0 + 4.0 * aSeed.z) + aSeed.x * 6.0;
  float a2 = landed ? aSeed.y * 6.0 : ft * (2.0 + 3.0 * aSeed.y);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cos(a1), sin(a1), 0.0, -sin(a1), cos(a1));
  mat3 ry = mat3(cos(a2), 0.0, -sin(a2), 0.0, 1.0, 0.0, sin(a2), 0.0, cos(a2));
  mat3 R = ry * rx;
  vec3 local = vec3(position.x * 0.045, position.y * 0.06, 0.0);
  vec3 wp = p + R * local + (landed ? vec3(0.0, 0.03, 0.0) : vec3(0.0));
  vN = R * vec3(0.0, 0.0, 1.0);
  vCol = tint.rgb * (0.75 + 0.5 * h1(aSeed.w * 9.0));
  // Fade in at the start, out a while after landing.
  vA = smoothstep(0.0, 0.03, t) * (1.0 - smoothstep(tFall + 4.0, tFall + 8.0, tt));
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  vA *= 1.0 - smoothstep(35.0, 45.0, length(mv.xyz));
  gl_Position = projectionMatrix * mv;
}
`;

const frag = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform vec3 uAmb;
varying vec3 vCol;
varying float vA;
varying vec3 vN;
void main() {
  if (vA < 0.02) discard;
  vec3 n = normalize(vN);
  // Thin leaf: lit on either side, with some light through it.
  float d = abs(dot(n, uSunDir));
  vec3 c = vCol * (uSun * (0.35 + 0.65 * d) / 3.14159 + uAmb);
  gl_FragColor = vec4(c, vA);
}
`;

/** Autumn leaves drifting down from the deciduous trees around the camera. */
export class FallingLeaves {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;
  private lastPos = new THREE.Vector3(1e9, 0, 0);

  constructor() {
    // Leaf quad with the corners trimmed to an ovate outline.
    const shape = new THREE.Shape();
    shape.moveTo(0, -1);
    shape.quadraticCurveTo(1, -0.6, 0.8, 0.2);
    shape.quadraticCurveTo(0.5, 0.9, 0, 1);
    shape.quadraticCurveTo(-0.5, 0.9, -0.8, 0.2);
    shape.quadraticCurveTo(-1, -0.6, 0, -1);
    const base = new THREE.ShapeGeometry(shape, 3);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.getAttribute('position'));
    g.setIndex(base.getIndex());
    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = COUNT;
    this.uniforms = {
      uTime: { value: 0 },
      uTrees: { value: Array.from({ length: MAX_TREES }, () => new THREE.Vector4()) },
      uBase: { value: new Array(MAX_TREES).fill(0) },
      uTint: { value: Array.from({ length: MAX_TREES }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0.4) },
      uSun: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uAmb: { value: new THREE.Color() },
    };
    const m = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, side: THREE.DoubleSide, transparent: true, depthWrite: false });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 5;
  }

  /**
   * @param trees nearby deciduous trees as [x, groundY, z, height, crownR, r, g, b, amount]
   */
  update(cam: THREE.Vector3, time: number, on: boolean, trees: () => number[][]): void {
    this.mesh.visible = on;
    if (!on) return;
    this.uniforms.uTime.value = time;
    if (cam.distanceToSquared(this.lastPos) < 16) return;
    this.lastPos.copy(cam);
    const list = trees()
      .map((t) => ({ t, d: Math.hypot(t[0] - cam.x, t[2] - cam.z) }))
      .filter((e) => e.d < 40)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_TREES);
    const u = this.uniforms;
    list.forEach(({ t }, i) => {
      (u.uTrees.value as THREE.Vector4[])[i].set(t[0], t[1] + t[3] * 0.68, t[2], t[4]);
      (u.uBase.value as number[])[i] = t[1];
      (u.uTint.value as THREE.Vector4[])[i].set(t[5], t[6], t[7], t[8]);
    });
    u.uCount.value = list.length;
  }
}
