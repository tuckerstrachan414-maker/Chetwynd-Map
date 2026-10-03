/**
 * Temporal anti-aliasing resolve. The scene is drawn with a sub-pixel jitter that changes every frame
 * (Halton 2,3); this pass reprojects last frame's result to the current view (camera motion, from the
 * depth buffer), clips it to the colour range of the current 3x3 neighbourhood (variance clipping in
 * YCoCg, which rejects stale history after disocclusion or motion instead of ghosting) and blends a
 * little of the current frame in. Over a few frames every pixel integrates many sub-pixel samples:
 * edges, thin branches, grass blades and alpha-tested leaves resolve without multisampling.
 *
 * All blending happens in a reversible tone-mapped space (c / (1 + luma)), so a few very bright
 * samples (sun glints) do not dominate; the history is stored as linear HDR.
 *
 * The frame may be rendered below the output resolution (dynamic resolution): the history stays at the
 * output resolution and each output pixel gathers the current samples around it by their jittered
 * positions, trusting the frame less where no sample landed close (temporal upsampling). At scale 1
 * this is plain TAA.
 */
export const taaFrag = /* glsl */ `
precision highp float;
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform mat4 uInvProj;   // current (jittered) inverse projection
uniform mat4 uCamWorld;  // current camera-to-world
uniform mat4 uPrevVP;    // previous frame's unjittered projection x view
uniform vec2 uJitter;    // current image shift in uv: a sample at uv shows the unjittered point uv - uJitter
uniform vec2 uTexel;     // render texel (current frame and depth)
uniform vec2 uOutTexel;  // output texel (history)
uniform float uReversed;
uniform float uReset;
uniform float uAlpha;    // weight of the current frame
varying vec2 vUv;

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 tm(vec3 c) { return c / (1.0 + lum(c)); }
vec3 itm(vec3 c) { return c / max(1.0 - lum(c), 1e-4); }
vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }

// History with a 5-tap Catmull-Rom filter (bilinear taps): sharp, so repeated resampling does not blur.
vec3 history(vec2 uv) {
  vec2 pos = uv / uOutTexel;
  vec2 c = floor(pos - 0.5) + 0.5;
  vec2 f = pos - c;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (c - 1.0) * uOutTexel;
  vec2 t3 = (c + 2.0) * uOutTexel;
  vec2 t12 = (c + w2 / w12) * uOutTexel;
  vec3 r = texture2D(tHist, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture2D(tHist, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture2D(tHist, t12).rgb * (w12.x * w12.y)
         + texture2D(tHist, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture2D(tHist, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, vec3(0.0));
}

void main() {
  // This output pixel in render pixels, the render pixel it falls in, and the jitter in render pixels.
  vec2 pr = vUv / uTexel;
  vec2 c0 = floor(pr) + 0.5;
  vec2 jPx = uJitter / uTexel;
  // Current 3x3 neighbourhood: colour moments for the clip box, the reconstruction of this pixel's
  // unjittered sample (Gaussian fit of Blackman-Harris over the jittered samples), and the nearest depth.
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), sum = vec3(0.0);
  float wsum = 0.0, wmax = 0.0;
  float dBest = uReversed > 0.5 ? -1.0 : 2.0;
  vec2 oBest = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 uv = (c0 + o) * uTexel;
      vec3 c = tm(texture2D(tCur, uv).rgb);
      vec3 yc = toYCoCg(c);
      m1 += yc;
      m2 += yc * yc;
      vec2 d = c0 + o - jPx - pr;
      float w = exp(-2.29 * dot(d, d));
      sum += c * w;
      wsum += w;
      wmax = max(wmax, w);
      // Nearest surface among the centre and the diagonals: edges reproject with the foreground.
      if ((x != 0 && y != 0) || (x == 0 && y == 0)) {
        float z = texture2D(tDepth, uv).r;
        if (uReversed > 0.5 ? z > dBest : z < dBest) { dBest = z; oBest = o; }
      }
    }
  }
  vec3 cur = sum / wsum;
  vec3 mu = m1 / 9.0;
  vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));

  // Reproject the nearest surface's sample: world position from this frame's (jittered) projection,
  // to last frame's unjittered view; its motion carries this pixel's history.
  vec2 uvS = (c0 + oBest) * uTexel;
  bool sky = uReversed > 0.5 ? dBest <= 0.0 : dBest >= 1.0;
  float ndcZ = uReversed > 0.5 ? max(dBest, 1e-7) : dBest * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(uvS * 2.0 - 1.0, sky ? (uReversed > 0.5 ? 1e-7 : 1.0) : ndcZ, 1.0);
  vec3 world = (uCamWorld * vec4(vp.xyz / vp.w, 1.0)).xyz;
  // The sky (and anything at infinity) moves with the view direction only.
  vec4 pc = sky ? uPrevVP * vec4(world - uCamWorld[3].xyz, 0.0) : uPrevVP * vec4(world, 1.0);
  vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5;
  vec2 hUv = vUv + (prevUv - (uvS - uJitter));

  vec3 res;
  if (uReset > 0.5 || pc.w <= 0.0 || any(lessThan(hUv, vec2(0.0))) || any(greaterThan(hUv, vec2(1.0)))) {
    res = cur;
  } else {
    // Clip the history towards the neighbourhood mean, inside mean +- 1.25 sigma.
    vec3 h = toYCoCg(tm(history(hUv)));
    vec3 ext = sigma * 1.25 + 1e-5;
    vec3 v = h - mu;
    vec3 a = abs(v / ext);
    float k = max(a.x, max(a.y, a.z));
    if (k > 1.0) h = mu + v / k;
    // Where no current sample landed near this output pixel (upsampling), lean on the history.
    res = mix(fromYCoCg(h), cur, uAlpha * clamp(wmax * 1.25, 0.4, 1.0));
  }
  // Never let a NaN or infinity into the history (it would persist): max/min drop NaNs on the GPU
  // (isnan() itself may be optimised away by the shader compiler).
  res = clamp(itm(max(res, vec3(0.0))), vec3(0.0), vec3(65000.0));
  gl_FragColor = vec4(res, 1.0);
}
`;
