/**
 * Physically based depth of field for photo mode (thin lens): the circle of confusion of every
 * pixel from its depth, focal length, f-number and focus distance on a 36x24 mm sensor, then a
 * scatter-as-gather disc blur (golden-angle spiral) in HDR, so highlights bloom into bokeh.
 */
export const dofFrag = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform float uReversed;
uniform vec2 uTexel;
uniform float uFocal;   // m
uniform float uAperture; // f-number
uniform float uFocus;   // m
uniform float uPxPerM;  // sensor metres -> pixels
uniform float uMaxR;    // px
varying vec2 vUv;

float viewDist(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  bool sky = uReversed > 0.5 ? d <= 0.0 : d >= 1.0;
  if (sky) return 1e6;
  float z = uReversed > 0.5 ? d : d * 2.0 - 1.0;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, z, 1.0);
  return length(v.xyz / v.w);
}

// Signed circle of confusion in pixels (negative in front of the focus plane).
float coc(float D) {
  float A = uFocal / uAperture;
  float c = A * uFocal * (D - uFocus) / (D * max(uFocus - uFocal, 1e-4));
  return clamp(c * uPxPerM, -uMaxR, uMaxR);
}

void main() {
  float D0 = viewDist(vUv);
  float c0 = coc(D0);
  // The pixel itself, then the spiral of neighbours.
  vec3 sharp = texture2D(tColor, vUv).rgb;
  float wsum = 1.0 / max(c0 * c0, 1.0);
  vec3 acc = sharp * wsum;
  const int N = 64;
  const float GA = 2.39996323;
  for (int i = 0; i < N; i++) {
    float r = sqrt((float(i) + 0.5) / float(N));
    float a = float(i) * GA;
    vec2 o = vec2(cos(a), sin(a)) * r;
    vec2 uv = vUv + o * uMaxR * uTexel;
    float D = viewDist(uv);
    float c = coc(D);
    // A sample contributes if its own blur disc covers this pixel; background samples cannot
    // spread over sharper foreground.
    float rad = r * uMaxR;
    float cs = abs(c);
    if (D > D0) cs = min(cs, abs(c0));
    float w = smoothstep(rad - 1.0, rad + 0.5, cs) / max(cs * cs, 1.0);
    vec3 col = texture2D(tColor, uv).rgb;
    acc += col * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;
