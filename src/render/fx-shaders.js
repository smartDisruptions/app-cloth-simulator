// GLSL for the particles and the post stack (owner: particles-post). GLSL ES 1.00, mediump-safe in every
// fragment shader. Programs are compiled per QUALITY (0 low · 1 mid · 2 high/ultra) with a #define.
//
// Precision rule: a uniform declared in both stages must have the same precision, and the fragment stage
// may be mediump while the vertex stage is highp. So no uniform name appears in both stages here.

// ---------------------------------------------------------------- particles
//
// One vertex format for every kind (36 bytes, 4 vertices per particle, written by particles.js; the byte
// layout is in fx-buffer.js):
//   aPos   vec3   centre (world m), or the corner itself for prebuilt quads
//   aAxis  int16  streak vector (1/4096 m): the quad spans centre ± axis/2 on screen, plus round caps
//   aShape uint16 x half-width across, y half-length along (1/4096 m), z screen angle (1/65536 turn) when
//                 not streaking
//   aColA  u8×4  lit: albedo (sRGB) + opacity · unlit: colour on the G channel + intensity
//   aColB  u8×4  lit: sheen colour (sRGB) · unlit: colour on the B channel; a = heat (the blackbody ramp)
//   aMisc  u8×4  x mode bits, y atlas cell + 16·corner, z erosion threshold, w: lit kinds, how much the
//                 coloured shadow tints it; unlit kinds, how much it feeds the bloom (the emissive pass)
// mode bits: 1 lit · 2 volumetric (fire lights the B side) · 4 additive · 8 depth of field · 16 prebuilt
//            quad (no billboarding) · 32 forward scattering (glints toward lights)
// Opacity vs intensity: lit kinds and additive kinds scale their light by aColA.a. An unlit kind that is
// NOT additive (flames) keeps full intensity and writes aColA.a as alpha: "soft additive", so a dense
// fire converges on a bright gold instead of summing to white.
export const particleVS = (Q) => `#define QUALITY ${Q}
attribute vec3 aPos; attribute vec3 aAxis; attribute vec3 aShape;
attribute vec4 aColA; attribute vec4 aColB; attribute vec4 aMisc;
uniform mat4 uViewProj;
uniform vec3 uView;       // half target size (px) x, y; z = px per metre at view depth 1
uniform vec4 uLimits;     // x min half-width (px), y max radius (px), z CoC px at the extremes, w focus depth
uniform vec3 uCamPos;
uniform vec3 uKeyDir; uniform vec3 uKeyCol; uniform vec3 uSkyCol; uniform vec3 uGndCol;
uniform vec3 uPtPos; uniform vec3 uPtCol; uniform vec3 uFirePos; uniform vec3 uFireCol;
uniform vec3 uFogCol; uniform float uFogDen; uniform float uExposure;
uniform vec2 uShade;      // x: 1 when the coloured shadow belongs to the point light (else the key), y: shadow on
uniform float uEmis;      // 1 in the emissive (bloom) pass, else 0
#if QUALITY > 0
uniform mat4 uShadowMat;
uniform vec3 uShLight;    // the shadow light's position (point) or its direction of travel (dir)
uniform vec3 uClothC;     // cloth centre: only particles beyond it, seen from the light, are in its shadow
uniform vec3 uCamRight; uniform vec3 uCamUp;
varying vec3 vSh;
varying vec2 vWp;         // world position of this corner (x + z folded in, y), for the fire's turbulence
#endif
varying vec4 vUv;         // xy atlas uv, z erosion threshold, w erosion gain
varying vec4 vA;          // rgb × G·shadow, a = alpha written (0 = additive)
varying vec4 vB;          // rgb × B, a = heat for the ramp
varying vec4 vC;          // rgb flat fill, a = ramp intensity

float bit(float m, float b) { return mod(floor(m / b + 0.001), 2.0); }
vec3 tonemap(vec3 c) { c *= uExposure; return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  float mode = aMisc.x;
  float corner = floor(aMisc.y / 16.0 + 0.001);
  float cell = aMisc.y - corner * 16.0, fade = 1.0;
  vec3 axis = aAxis * (1.0 / 4096.0);
  vec3 shp = vec3(aShape.xy * (1.0 / 4096.0), aShape.z * (6.2831853 / 65536.0));
  vec2 c = vec2(mod(corner, 2.0), floor(corner * 0.5 + 0.001)) * 2.0 - 1.0;
  float lit = bit(mode, 1.0), vol = bit(mode, 2.0), add = bit(mode, 4.0);
  float dof = bit(mode, 8.0), pre = bit(mode, 16.0), scat = bit(mode, 32.0);

  vec4 h0 = uViewProj * vec4(aPos - axis * 0.5, 1.0);
  vec4 h1 = uViewProj * vec4(aPos + axis * 0.5, 1.0);
  vec4 hc = 0.5 * (h0 + h1);
  vec3 wp = aPos;
  if (pre > 0.5) {
    gl_Position = hc;
  } else {
    float w = max(hc.w, 1e-3);
    vec2 p0 = h0.xy / max(h0.w, 1e-3) * uView.xy, p1 = h1.xy / max(h1.w, 1e-3) * uView.xy;
    vec2 dir = p1 - p0; float len = length(dir);
    vec2 along = len > 0.75 ? dir / len : vec2(cos(shp.z), sin(shp.z));
    vec2 across = vec2(-along.y, along.x);
    float k = uView.z / w;
    float ra = shp.x * k, rl = shp.y * k;
    if (dof > 0.5) {
      // depth of field, foreground only: sprites well in front of the subject swell into lens discs and
      // dim (light is conserved, but never below a third so they stay visible); the mid-ground stays sharp
      float coc = uLimits.z * max(uLimits.w / w - 1.4, 0.0);
      float ra2 = sqrt(ra * ra + coc * coc), rl2 = sqrt(rl * rl + coc * coc);
      fade *= max((max(ra, 0.5) * max(rl, 0.5)) / (ra2 * rl2 + 0.25), 0.22);
      if (coc > 2.0 * max(max(ra, rl), 2.0)) cell = 15.0;
      ra = ra2; rl = rl2;
    }
    float m = min(1.0, uLimits.y / max(max(ra, rl), 1e-3)); ra *= m; rl *= m;
    // never thinner than ~a pixel: a sub-pixel line shimmers, so widen it and dim it instead
    fade *= min(1.0, ra / uLimits.x); ra = max(ra, uLimits.x); rl = max(rl, uLimits.x);
    vec2 off = along * (c.y * (0.5 * len + rl)) + across * (c.x * ra);
    // depth pulled toward the camera by the sprite's own radius: a puff or flame born on the cloth shows
    // its whole front instead of being sliced by the surface it sits on (soft particles, no depth texture)
    vec4 hz = uViewProj * vec4(aPos + normalize(uCamPos - aPos) * min(shp.x, w * 0.4), 1.0);
    gl_Position = vec4((0.5 * (p0 + p1) + off) / uView.xy * w, hz.z / max(hz.w, 1e-3) * w, w);
    if (hc.w < 0.02) gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // behind the camera: clipped away
#if QUALITY > 0
    wp = aPos + (uCamRight * off.x + uCamUp * off.y) / k;
#endif
  }

  vec2 cxy = vec2(mod(cell, 4.0), floor(cell * 0.25 + 0.001));
  vec2 uv = (cxy + 0.5 + c * 0.47) * 0.25;
  if (cell == 14.0) uv.y = (cxy.y + 0.5) * 0.25; // the beam profile is constant along its length
  float ero = aMisc.z / 255.0;
  // erosion gain; its sign marks "soft additive" (unlit, not additive: flames) for the fragment stage
  vUv = vec4(uv, ero, (1.0 / max(1.0 - ero, 0.25)) * ((1.0 - lit) * (1.0 - add) > 0.5 ? -1.0 : 1.0));

  float op = aColA.a * fade;
  vec3 A = aColA.rgb, B = aColB.rgb, C = vec3(0.0);
  if (lit > 0.5) {
    vec3 V = normalize(uCamPos - aPos);
    // a sprite has no normal: light it like a small volume, with a forward-scattering lobe so dust,
    // rain and smoke flare up when they sit between the camera and a light
    float ck = max(dot(-V, uKeyDir), 0.0), k2 = ck * ck, k8 = k2 * k2; k8 *= k8;
    vec3 key = uKeyCol * (0.65 + 0.25 * ck + scat * 2.4 * k8);
    vec3 dp = uPtPos - aPos; float pd2 = dot(dp, dp) + 1e-3;
    float cp = max(dot(-V, dp) * inversesqrt(pd2), 0.0), p2 = cp * cp, p8 = p2 * p2; p8 *= p8;
    vec3 pt = uPtCol * (0.65 + 0.25 * cp + scat * 2.4 * p8) / (1.0 + pd2);
    vec3 df = uFirePos - aPos; float fd2 = dot(df, df) + 1e-3;
    float cf = max(dot(-V, df) * inversesqrt(fd2), 0.0), f2 = cf * cf;
    vec3 fire = uFireCol * (0.75 + scat * 1.8 * f2 * f2) / (1.0 + 1.6 * fd2);
    vec3 amb = mix(uGndCol, uSkyCol, 0.6);
    vec3 shL = mix(key, pt, uShade.x), unL = mix(pt, key, uShade.x);
    vec3 alb = aColA.rgb * aColA.rgb, sh = aColB.rgb * aColB.rgb;
    A = alb * shL;
    B = vol > 0.5 ? alb * fire : sh * (shL + unL + fire + amb); // sheen mirrors the lights and the sky
    C = alb * (amb + unL + fire * (1.0 - vol));
    float fg = clamp(1.0 - exp(-uFogDen * length(uCamPos - aPos)), 0.0, 1.0);
    A *= 1.0 - fg; B *= 1.0 - fg; C = C * (1.0 - fg) + uFogCol * (fg * (1.0 - add));
    // tonemap + gamma the body (a typical interior: A at the atlas's usual shading, plus the fill) and share
    // that out in proportion; the B term (rims, sheen, the fire-lit underside) only adds what it brightens
    // on top of the body, so a bright rim never darkens the middle of the sprite
    vec3 body = A * 0.85 + C;
    vec3 tb = sqrt(tonemap(body));
    vec3 Rb = tb / max(body, vec3(1e-4));
    vec3 Rs = (sqrt(tonemap(body + B)) - tb) / max(B, vec3(1e-4));
    A *= Rb; C *= Rb; B *= Rs;
  }
  // in the bloom pass an unlit sprite contributes its own share (flames glow softly, sparks fully)
  float ew = mix(1.0, lit > 0.5 ? 1.0 : aMisc.w / 255.0, uEmis);
  float I = (lit + add > 0.5 ? op : fade) * ew;
  vA = vec4(A * I, op * (1.0 - add));
  vB = vec4(B * I, aColB.a * 2.0);
  vC = vec4(C * I, I);
#if QUALITY > 0
  vec4 sp = uShadowMat * vec4(aPos, 1.0);
  vec2 suv = sp.xy / max(abs(sp.w), 1e-4);
  float inside = step(0.0, suv.x) * step(suv.x, 1.0) * step(0.0, suv.y) * step(suv.y, 1.0) * step(0.0, sp.w);
  float beyond = uShade.x > 0.5
    ? step(length(uClothC - uShLight) - 0.05, length(aPos - uShLight))
    : step(-0.05, dot(aPos - uClothC, uShLight));
  vSh = vec3(suv, inside * beyond * uShade.y * (aMisc.w / 255.0));
  vWp = vec2(wp.x + wp.z * 0.6, wp.y);
#endif
}`;

export const particleFS = (Q) => `#define QUALITY ${Q}
uniform sampler2D uAtlas;
uniform vec3 uGlow;
#if QUALITY > 0
uniform sampler2D uShadow; uniform sampler2D uNoise; uniform float uTime;
varying vec3 vSh;
varying vec2 vWp;
#endif
varying vec4 vUv; varying vec4 vA; varying vec4 vB; varying vec4 vC;
void main() {
  vec4 t = texture2D(uAtlas, vUv.xy);
  float d = clamp((t.r - vUv.z) * abs(vUv.w), 0.0, 1.0);
  // (both optional fetches below depend only on per-quad values, so whole quads take the same branch:
  // particles that can't be in the cloth's shadow, and everything that isn't a flame, skip a texture tap)
  vec3 S = vec3(1.0);
#if QUALITY > 0
  if (vSh.z > 0.004) S = mix(S, texture2D(uShadow, vSh.xy).rgb, vSh.z);
#endif
  // blackbody-ish ramp: red rises first, then green, then blue, so cooling reads white → gold → orange → red
  float T = t.g * vB.a;
#if QUALITY > 0
  // flames: a world-space turbulence that climbs through the whole fire. Neighbouring flames share it, so
  // a dense fire keeps bright tongues and darker gaps instead of summing to one flat sheet of gold
  if (vUv.w < 0.0) {
    float nz = texture2D(uNoise, vWp * vec2(2.3, 1.15) + vec2(0.0, -uTime * 1.05)).r;
    T *= 0.3 + 1.25 * nz * nz;
  }
#endif
  float T2 = T * T;
  vec3 heat = vec3(1.6 * T, 1.12 * T2, 0.75 * T2 * T2) * vC.a;
  vec3 col = vA.rgb * (t.g * S) + vB.rgb * t.b + vC.rgb + heat;
  // soft additive (flames): only the hot body occludes, so cool red edges add light without a dark fringe
  float a = vA.a * (vUv.w < 0.0 ? clamp(T * 1.5, 0.0, 1.0) : 1.0);
  gl_FragColor = vec4(col * uGlow, a) * d;
}`;

// ---------------------------------------------------------------- post
// Dual-filter (Marius Bjørge, "Bandwidth-efficient rendering", SIGGRAPH 2015): 5 taps down, 8 taps up.
// The up pass also folds in the same-resolution level, so the glow is a sum of every scale: a tight core
// near the source and a wide halo, the way a real lens blooms.
// Levels below the emissive buffer store sqrt(colour): 8-bit targets keep the faint, wide halo instead
// of banding it to black. uDec / uSameDec say whether an input is encoded, uEnc whether to encode output.
export const DOWN_FS = `
uniform sampler2D uTex; uniform vec2 uHalf; uniform float uDec; varying vec2 vUv;
vec3 tap(vec2 p) { vec3 c = texture2D(uTex, p).rgb; return mix(c, c * c, uDec); }
void main() {
  vec3 s = tap(vUv) * 4.0 + tap(vUv - uHalf) + tap(vUv + uHalf)
         + tap(vUv + vec2(uHalf.x, -uHalf.y)) + tap(vUv - vec2(uHalf.x, -uHalf.y));
  gl_FragColor = vec4(sqrt(s * 0.125), 1.0);
}`;

export const UP_FS = `
uniform sampler2D uTex; uniform sampler2D uSame; uniform vec2 uHalf; uniform vec2 uMix;
uniform float uSameDec; uniform float uEnc; varying vec2 vUv;
vec3 tap(vec2 p) { vec3 c = texture2D(uTex, p).rgb; return c * c; }
void main() {
  vec2 h = uHalf;
  vec3 s = tap(vUv + vec2(-h.x * 2.0, 0.0)) + tap(vUv + vec2(h.x * 2.0, 0.0))
         + tap(vUv + vec2(0.0, h.y * 2.0)) + tap(vUv + vec2(0.0, -h.y * 2.0))
         + (tap(vUv + vec2(-h.x, h.y)) + tap(vUv + vec2(h.x, h.y)) + tap(vUv + vec2(h.x, -h.y)) + tap(vUv + vec2(-h.x, -h.y))) * 2.0;
  vec3 same = texture2D(uSame, vUv).rgb;
  same = mix(same, same * same, uSameDec);
  vec3 o = s * (uMix.x / 12.0) + same * uMix.y;
  gl_FragColor = vec4(mix(o, sqrt(o), uEnc), 1.0);
}`;

/**
 * The one full-resolution pass: bloom + grade + vignette + grain + the slow-mo look, blended over the
 * screen with (ONE, ONE_MINUS_SRC_ALPHA). The screen is never read, so every effect is "add some colour,
 * and scale what is there": out = rgb + screen × (1 − a). Vignette, lift and the slow-mo edge mute are
 * lerps toward a colour; grain is a dark/bright speckle; chromatic fringing splits the bloom itself.
 */
export const compositeFS = (Q, bloom) => `#define QUALITY ${Q}
#define BLOOM ${bloom ? 1 : 0}
uniform sampler2D uBloom; uniform sampler2D uNoise;
uniform float uBloomK;
uniform vec2 uAspect;
uniform vec4 uVig;        // rgb colour the corners sink toward, a strength
uniform vec4 uEdge;       // slow-mo: rgb muted colour the edges drift toward, a strength
uniform vec4 uLift;       // rgb matte lift colour, a amount
uniform vec4 uGrain;      // x amount, yz offset, w unused
uniform vec2 uGrainScale;
uniform float uChroma;
varying vec2 vUv;
void main() {
  vec2 d = vUv - 0.5, da = d * uAspect;
  float r2 = dot(da, da);
  float v = smoothstep(0.06, 0.62, r2) * uVig.a;
  float e = smoothstep(0.0, 0.45, r2) * uEdge.a;
#if BLOOM
#if QUALITY > 0
  vec2 off = d * uChroma;
  vec3 b = vec3(texture2D(uBloom, vUv + off).r, texture2D(uBloom, vUv).g, texture2D(uBloom, vUv - off).b);
#else
  vec3 b = texture2D(uBloom, vUv).rgb;
#endif
  b *= uBloomK * (1.0 - 0.6 * v);
#else
  vec3 b = vec3(0.0);
#endif
  float n = texture2D(uNoise, gl_FragCoord.xy * uGrainScale + uGrain.yz).a - 0.5;
  float g = n * uGrain.x;
  float a = v + e + uLift.a + max(-g, 0.0);
  vec3 rgb = b + uVig.rgb * v + uEdge.rgb * e + uLift.rgb * uLift.a + vec3(max(g, 0.0));
  gl_FragColor = vec4(rgb, clamp(a, 0.0, 1.0));
}`;
