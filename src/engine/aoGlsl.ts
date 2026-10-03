/**
 * Screen-space ambient occlusion (scalable AO, McGuire et al. 2012) at half resolution, then a
 * depth-aware separable blur. The composite darkens the scene with it, fading it out with distance,
 * so contact areas (under eaves, around trunks, between props and the ground) get the soft occlusion
 * that sky light has there.
 *
 * Every pass reads a half-resolution linear view depth made once per frame (aoDepthFrag): a view
 * position is then two multiplies away, instead of a texture read at full resolution and a matrix
 * inverse per tap (14 AO taps, 4 normal taps, 18 blur taps per pixel).
 */
export const aoDepthFrag = /* glsl */ `
precision highp float;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform float uReversed;
varying vec2 vUv;
void main() {
  float d = texture2D(tDepth, vUv).r;
  bool sky = uReversed > 0.5 ? d <= 0.0 : d >= 1.0;
  float z = uReversed > 0.5 ? d : d * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(vUv * 2.0 - 1.0, z, 1.0);
  // Linear view distance along the axis (m); 0 marks the sky.
  gl_FragColor = vec4(sky ? 0.0 : -v.z / v.w, 0.0, 0.0, 1.0);
}
`;

export const aoFrag = /* glsl */ `
precision highp float;
uniform sampler2D tLin;
uniform vec2 uTan;        // tan of the half field of view (x, y)
uniform float uProjScale; // pixels per metre at 1 m distance (half-res target)
uniform vec2 uTexel;      // texel of the half-resolution target
uniform float uRadius;    // m
varying vec2 vUv;

vec3 viewPos(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) * uTan * z, -z); }
vec3 viewAt(vec2 uv) { return viewPos(uv, texture2D(tLin, uv).r); }

void main() {
  float z0 = texture2D(tLin, vUv).r;
  if (z0 <= 0.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv, z0);
  float dist = z0;
  // Normal from the flatter of the two neighbour differences in x and y (no halo at edges).
  vec3 px1 = viewAt(vUv + vec2(uTexel.x, 0.0)) - P;
  vec3 px0 = P - viewAt(vUv - vec2(uTexel.x, 0.0));
  vec3 py1 = viewAt(vUv + vec2(0.0, uTexel.y)) - P;
  vec3 py0 = P - viewAt(vUv - vec2(0.0, uTexel.y));
  vec3 dx = abs(px1.z) < abs(px0.z) ? px1 : px0;
  vec3 dy = abs(py1.z) < abs(py0.z) ? py1 : py0;
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  float rPix = uRadius * uProjScale / max(dist, 0.1);
  if (rPix < 1.5 || dist > 220.0) { gl_FragColor = vec4(1.0); return; }
  rPix = min(rPix, 90.0);
  float spin = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float sum = 0.0;
  const int S = 14;
  float R2 = uRadius * uRadius;
  for (int i = 0; i < S; i++) {
    float a = float(i) * 2.39996323 + spin;
    float r = (float(i) + 0.5) / float(S);
    vec2 uv = vUv + vec2(cos(a), sin(a)) * r * rPix * uTexel;
    float zq = texture2D(tLin, uv).r;
    if (zq <= 0.0) continue;
    vec3 v = viewPos(uv, zq) - P;
    float vv = dot(v, v);
    float vn = dot(v, N);
    float f = max(R2 - vv, 0.0) / R2;
    sum += f * f * f * max(vn - 0.015 * dist, 0.0) / (vv + 0.02);
  }
  float ao = clamp(1.0 - 2.2 * sum / float(S), 0.0, 1.0);
  // Fade out with distance so far terrain keeps its baked shading only.
  ao = mix(ao, 1.0, smoothstep(120.0, 220.0, dist));
  gl_FragColor = vec4(ao, 0.0, 0.0, 1.0);
}
`;

export const aoBlurFrag = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform sampler2D tLin;
uniform vec2 uDir;       // texel step of the AO target along the blur axis
varying vec2 vUv;
void main() {
  float z0 = texture2D(tLin, vUv).r;
  float sum = 0.0, wsum = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + uDir * float(i);
    float z = texture2D(tLin, uv).r;
    float w = exp(-float(i * i) / 10.0) * exp(-abs(z - z0) / (0.03 * z0 + 0.05) * 2.0);
    sum += texture2D(tAO, uv).r * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
}
`;
