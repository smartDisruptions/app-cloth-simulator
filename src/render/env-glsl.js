// GLSL for the environment (render/env.js). Owned by the scenes+environment agent.
//
// One full-screen pass draws the sky AND the floor: the floor is ray-traced against the plane y = floor, so
// it is infinite, meets the horizon without a seam, and costs no extra overdraw. Props are one static mesh
// (bones for the few animated parts). When the floor is wet or polished, props and cloth are drawn mirrored
// beneath it, blended by the floor's per-pixel reflectivity (floorRefl) — real planar reflections.
//
// Feature switches are #defines compiled per scene variant (and per QUALITY 0/1/2), so each scene pays only
// for what it shows. Everything is mediump-safe: noise comes from the shared uNoise texture, small angles are
// measured as chord lengths (never cos ≈ 1), and world coordinates stay within ~±100 m.

/** Shared by every env program that shades a world position. */
export const ENV_COMMON = `
uniform vec4 uFloor;    // x floor y · y polish 0..1 · z wetness 0..1 (eased) · w puddle amount 0..1
uniform vec4 uAoRect;   // x0, z0, 1/width, 1/depth of the baked floor map
uniform sampler2D uAo;  // r ambient occlusion · g puddle mask · b wear · a shelter (1 open sky)
uniform vec4 uAper;     // point-light aperture rectangle (x0, x1, y0, y1) in the plane z = uAperZ.x
uniform vec2 uAperZ;    // plane z, enabled
uniform vec4 uSpotA;    // key-light cone: apex xyz, cos(outer)
uniform vec4 uSpotB;    // axis xyz (from the apex into the scene), cos(inner) (<= 0: no cone)
uniform vec2 uShSel;    // the coloured shadow multiplies (key, point)
uniform vec3 uHaze;     // horizon haze colour (linear)
uniform vec3 uL2Pos; uniform vec3 uL2Col;  // a second lamp that lights the environment only (0 = off)

vec4 aoAt(vec3 p) { return texture2D(uAo, (p.xz - uAoRect.xy) * uAoRect.zw); }

// Light from the point lamp only leaves through the aperture (a doorway): an analytic gobo.
float aperture(vec3 p) {
#if APER
  float sa = p.z - uAperZ.x, sb = uPtPos.z - uAperZ.x;
  if (sa * sb >= 0.0) return 1.0;
  vec2 q = mix(uPtPos.xy, p.xy, sb / (sb - sa));
  vec2 e = min(q - uAper.xz, uAper.yw - q);
  return smoothstep(-0.03, 0.05, min(e.x, e.y));
#else
  return 1.0;
#endif
}

float spotK(vec3 p) {
#if SPOT
  return smoothstep(uSpotA.w, uSpotB.w, dot(normalize(p - uSpotA.xyz), uSpotB.xyz));
#else
  return 1.0;
#endif
}

// puddles: the baked mask (g) broken up by noise, scaled by how much water there is
float puddleAt(vec3 F, vec4 ao) {
  return smoothstep(0.5, 0.62, ao.g + (texture2D(uNoise, F.xz * 0.13).r - 0.5) * 0.45) * uFloor.w * ao.a;
}
// how much of the view the floor mirrors (cosV = cosine of the view ray to the floor normal)
float floorRefl(float cosV, float pud, float open) {
  float gloss = max(uFloor.y, uFloor.z * open * mix(0.22, 1.0, pud));
  float f = 1.0 - cosV;
  return clamp(gloss * (0.2 + 0.8 * f * f * f), 0.0, 0.95);
}
`;

/** Sky + ray-traced floor, full screen. Defines: QUALITY FLOOR SUN MOON CLOUDS STARS HILLS CASTERS CLOUDSHADOW RIPPLES PUDDLES. */
export const SKY_VS = `
attribute vec2 aPos;
uniform mat4 uInvViewProj; uniform vec3 uEye;
varying vec3 vDir;
void main() {
  vec4 p = uInvViewProj * vec4(aPos, 0.0, 1.0);
  vDir = p.xyz / p.w - uEye;
  gl_Position = vec4(aPos, 0.99999, 1.0);
}`;

const SKY_UNIFORMS = `
uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uNadir;
uniform vec4 uSkyK;   // x gradient curve · y haze amount at the horizon · z haze falloff · w sky intensity
uniform vec4 uSkyMid; // a middle colour stop (rgb) and where it sits (w, 0..1 of the curved height)
#if SUN
uniform vec3 uSunDir; uniform vec3 uSunCol;
uniform vec4 uSunG;   // x disc radius (rad) · y tight glow power · z tight glow · w wide glow
#endif
#if MOON
uniform vec3 uMoonDir; uniform vec3 uMoonCol;
uniform vec4 uMoonB;  // basis right xyz · radius (rad)
uniform vec4 uMoonC;  // basis up xyz · glow
uniform vec2 uMoonPh; // crescent: the shadow disc's offset in disc radii
#endif
#if CLOUDS
uniform vec4 uCloudA; // cover · softness · scale · stretch
uniform vec4 uCloudB; // drift x · drift z · opacity · silver lining
uniform vec3 uCloudLit; uniform vec3 uCloudShade;
#endif
#if STARS
uniform float uStars;
#endif
#if BIRDS > 0
uniform vec4 uBird[BIRDS];  // azimuth (rad) · elevation (rad) · size (rad) · wing phase
uniform vec3 uBirdCol;
#endif
#if HILLS > 0
uniform vec4 uHillA[HILLS]; // base elevation · amplitude · frequency (per turn) · texture row
uniform vec4 uHillB[HILLS]; // colour rgb (linear) · bump (tree) amplitude
uniform vec4 uHillC[HILLS]; // haze at the base · ridge rim · bump frequency · bump sharpness
uniform float uHillTop;     // no hill reaches above this elevation (skip the work up there)
#endif
`;

const SKY_FUNCS = `
float skyAA(float h) {
#ifdef HAS_DERIV
  return fwidth(h) * 0.8 + 0.0002;
#else
  return 0.0016;
#endif
}

#if HILLS > 0
float hillH(float az, vec4 A, vec4 B, vec4 C) {
  float x = az * 0.15915494 * A.z;
#if QUALITY > 0
  float h = texture2D(uNoise, vec2(x, A.w)).r * 0.72 + texture2D(uNoise, vec2(x * 2.7 + 0.3, A.w + 0.21)).g * 0.28;
#else
  float h = texture2D(uNoise, vec2(x, A.w)).r;
#endif
  float b = 0.0;
  if (B.w > 0.0) b = pow(texture2D(uNoise, vec2(x * C.z, A.w + 0.43)).g, C.w);
  return A.x + A.y * (h - 0.35) + B.w * b;
}
#endif

// the sky's own glow only (the floor's reflection uses it; no clouds or hills)
vec3 skyBase(vec3 d) {
  float h = d.y;
  float k = pow(clamp(h, 0.0, 1.0), uSkyK.x);
  vec3 c = mix(mix(uHorizon, uSkyMid.rgb, clamp(k / uSkyMid.w, 0.0, 1.0)), uZenith, clamp((k - uSkyMid.w) / (1.0 - uSkyMid.w), 0.0, 1.0));
  c = mix(c, uNadir, smoothstep(0.0, -0.35, h));
#if SUN
  float sd = max(dot(d, uSunDir), 0.0);
  float sd4 = sd * sd; sd4 *= sd4; sd4 *= sd4;
  c += uSunCol * (pow(sd, uSunG.y) * uSunG.z + sd4 * sd4 * uSunG.w);
#endif
  return c * uSkyK.w;
}

vec3 skyColor(vec3 d) {
  float h = d.y;
  vec3 c = skyBase(d);
  float aa = skyAA(h);
#if STARS
  if (h > 0.0) {
    vec2 sp = d.xz / (h + 1.0) * 420.0;
    vec2 id = floor(sp); vec2 f = fract(sp) - 0.5;
    vec4 r = texture2D(uNoise, (id + 0.5) / 256.0);
    float s = step(0.962, r.a) * smoothstep(0.42, 0.05, length(f));
    s *= (0.6 + 0.4 * sin(uTime * (1.3 + r.r * 3.0) + r.g * 40.0)) * uStars * smoothstep(0.02, 0.3, h);
    c += vec3(0.85, 0.92, 1.1) * s * (0.25 + r.r * r.r * 1.6);
  }
#endif
#if MOON
  {
    vec3 md = d - uMoonDir;
    vec2 q = vec2(dot(md, uMoonB.xyz), dot(md, uMoonC.xyz)) / uMoonB.w;
    float r = length(q);
    float ea = aa * 1.5 / uMoonB.w;
    float disc = smoothstep(1.0 + ea, 1.0 - ea, r) * step(0.0, dot(d, uMoonDir));
    float lit = smoothstep(0.92, 1.08, length(q - uMoonPh));
    float maria = 0.82 + 0.18 * texture2D(uNoise, q * 0.21 + 0.37).r;
    c = mix(c, mix(c * 0.7, uMoonCol * maria, lit), disc);
    c += uMoonCol * uMoonC.w * exp(-r * 0.9) * 0.08 * step(0.0, dot(d, uMoonDir));
  }
#endif
#if SUN
  {
    float r = length(d - uSunDir);
    c += uSunCol * 9.0 * smoothstep(uSunG.x + aa * 1.5, uSunG.x - aa * 1.5, r);
  }
#endif
#if CLOUDS
  if (h > 0.0) {
    vec2 uv = d.xz / (h + 0.1) * uCloudA.z;
    uv.y *= uCloudA.w;
    uv += uCloudB.xy * uTime;
    float n = texture2D(uNoise, uv).r * 0.64 + texture2D(uNoise, uv * 2.3 + 0.17).g * 0.36;
#if QUALITY > 0
    n += (texture2D(uNoise, uv * 5.3 + 0.53).r - 0.5) * 0.14;
#endif
    float dens = smoothstep(uCloudA.x, uCloudA.x + uCloudA.y, n) * smoothstep(0.0, 0.1, h) * uCloudB.z;
    float thick = smoothstep(uCloudA.x, uCloudA.x + uCloudA.y * 2.5, n);
    vec3 cc = mix(uCloudLit, uCloudShade, thick);
#if SUN
    float sd2 = max(dot(d, uSunDir), 0.0);
    cc += uSunCol * (sd2 * sd2 * sd2 * sd2) * uCloudB.w * (1.0 - thick * 0.8);
#endif
    c = mix(c, cc * uSkyK.w, dens);
  }
#endif
#if BIRDS > 0
  if (h > 0.0) {
    float baz = atan(d.x, -d.z);
    for (int i = 0; i < BIRDS; i++) {
      vec4 b = uBird[i];
      vec2 q = vec2(baz - b.x, h - b.y) / b.z;
      if (abs(q.x) < 1.3 && abs(q.y) < 1.3) {
        float ax = abs(q.x);
        float wing = q.y - ax * (0.55 * sin(b.w) + 0.15) + ax * ax * 0.35;
        float m = (1.0 - smoothstep(0.07, 0.16, abs(wing))) * (1.0 - smoothstep(0.85, 1.05, ax));
        m = max(m, 1.0 - smoothstep(0.12, 0.2, length(q * vec2(1.0, 1.6))));
        c = mix(c, uBirdCol, m * 0.9);
      }
    }
  }
#endif
  c = mix(c, uHaze, uSkyK.y * exp(-abs(h) * uSkyK.z));
#if HILLS > 0
  if (h < uHillTop) {
    float az = atan(d.x, -d.z);
#if SUN
    float sd3 = max(dot(normalize(vec3(d.x, 0.0, d.z) + vec3(1e-4, 0.0, 0.0)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-4, 0.0, 0.0))), 0.0);
#endif
    for (int i = 0; i < HILLS; i++) {
      float hh = hillH(az, uHillA[i], uHillB[i], uHillC[i]);
      float m = smoothstep(hh + aa, hh - aa, h);
      vec3 hc = mix(uHillB[i].rgb, uHaze, uHillC[i].x * exp(-max(h, 0.0) * 40.0));
#if SUN
      float sd6 = sd3 * sd3 * sd3; sd6 *= sd6;
      hc += uSunCol * uHillC[i].y * smoothstep(hh - 0.0025, hh, h) * sd6 * sd6;
#endif
      c = mix(c, hc, m);
    }
  }
#endif
  return c;
}
`;

const FLOOR_FUNCS = `
#if FLOOR > 0
uniform vec3 uFloorA; uniform vec3 uFloorB; uniform vec3 uFloorJ;
uniform vec4 uFloorK;   // x pattern scale · y bump · z detail fade distance · w horizon fade start
uniform float uRain;
#if CASTERS > 0
uniform vec4 uCast[CASTERS]; // vertical casters: base x, base z, top y, radius
#endif

// per-cell random from the white-noise channel (exact texel centres, so no filtering blur)
vec4 cellRand(vec2 id) { return texture2D(uNoise, (id + 0.5) / 256.0); }

vec3 floorAlbedo(vec3 P, float fade, out float joint) {
  vec2 p = P.xz * uFloorK.x;
  float m1 = texture2D(uNoise, p * 0.11).r;
#if QUALITY > 0
  float m2 = texture2D(uNoise, p * 0.53 + 0.31).g;
#else
  float m2 = m1;
#endif
  joint = 1.0;
#if FLOOR == 1
  // pavers in running bond (ishidatami)
  vec2 q = p * vec2(1.75, 3.1);
  float row = floor(q.y);
#if QUALITY > 0
  q.x += cellRand(vec2(row, 5.0)).a;
#else
  q.x += fract(row * 0.618);
#endif
  vec2 id = floor(q); vec2 f = fract(q);
  vec2 e = min(f, 1.0 - f) * vec2(0.57, 0.32);
  float ed = min(e.x, e.y);
  joint = mix(1.0, smoothstep(0.004, 0.02, ed), fade);
  vec4 r = cellRand(id);
  vec3 c = mix(uFloorA, uFloorB, r.a) * (0.82 + 0.36 * m2) * (0.92 + 0.16 * r.r);
  c *= mix(1.0, 0.82 + 0.18 * smoothstep(0.0, 0.07, ed), fade);
  return mix(uFloorJ, c, joint);
#elif FLOOR == 2
  // long boards along x
  vec2 q = p * vec2(0.55, 6.0);
  float row = floor(q.y);
  q.x += cellRand(vec2(row, 3.0)).a * 7.0;
  vec2 id = floor(q); vec2 f = fract(q);
  joint = mix(1.0, smoothstep(0.0, 0.05, min(f.y, 1.0 - f.y)) * smoothstep(0.0, 0.006, min(f.x, 1.0 - f.x)), fade);
  vec4 r = cellRand(id);
  float grain = texture2D(uNoise, vec2(P.x * 0.35, P.z * 2.6)).b;
  vec3 c = mix(uFloorA, uFloorB, r.a * 0.7 + grain * 0.3) * (0.85 + 0.3 * m1);
  return mix(uFloorJ, c, joint);
#elif FLOOR == 3
  // grass
  float blades = texture2D(uNoise, p * 3.1).a * 0.5 + texture2D(uNoise, p * 1.3 + 0.7).b * 0.5;
  vec3 c = mix(uFloorA, uFloorB, smoothstep(0.25, 0.75, m1 * 0.75 + m2 * 0.25));
  c *= mix(1.0, 0.72 + 0.56 * blades, fade);
  return c;
#elif FLOOR == 4
  // polished stone slabs with veins
  vec2 q = p * 0.8;
  vec2 f = fract(q);
  joint = mix(1.0, smoothstep(0.0, 0.004, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y))), fade);
  vec4 r = cellRand(floor(q));
  float v = abs(texture2D(uNoise, p * 0.17 + r.rg).r - 0.5);
  float vein = smoothstep(0.025, 0.0, v) * 0.55 + smoothstep(0.01, 0.0, abs(m2 - 0.5)) * 0.2;
  vec3 c = mix(uFloorA, uFloorB, vein) * (0.9 + 0.2 * r.a);
  return mix(uFloorJ, c, joint);
#else
  // packed earth and gravel
  float peb = texture2D(uNoise, p * 4.3).a;
  vec3 c = mix(uFloorA, uFloorB, smoothstep(0.2, 0.8, m1 * 0.6 + m2 * 0.4));
  c *= mix(1.0, 0.8 + 0.4 * smoothstep(0.55, 0.95, peb), fade);
  return c;
#endif
}

#if RIPPLES
// expanding rings from raindrops: two layers of jittered cells, each cell one drop at a time
vec2 ripples(vec2 p) {
  vec2 acc = vec2(0.0);
  for (int L = 0; L < 2; L++) {
    vec2 g = p * (3.4 + float(L) * 1.3) + float(L) * vec2(0.37, 0.71);
    vec2 id = floor(g); vec2 f = fract(g);
    vec4 r = cellRand(id + vec2(float(L) * 37.0, 11.0));
    vec2 c = 0.3 + 0.4 * r.ar;
    float ph = fract(uTime * (0.7 + 0.5 * r.g) + r.b);
    vec2 dv = f - c; float dist = length(dv) + 1e-4;
    float x = (dist - ph * 0.42) * 22.0;
    float w = x * exp(-x * x) * (1.0 - ph) * (1.0 - ph);
    acc += dv / dist * w;
  }
  return acc * 0.5;
}
#endif

#if CASTERS > 0
float casters(vec3 P) {
  float s = 1.0;
  vec2 L = uKeyDir.xz / max(uKeyDir.y, 0.03);
  for (int i = 0; i < CASTERS; i++) {
    vec4 c = uCast[i];
    vec2 ba = -L * (c.z - uFloor.x);
    vec2 pa = P.xz - c.xy;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    float dist = length(pa - ba * h);
    float w = c.w * (1.0 + h * 3.0);
    s *= 1.0 - 0.82 * smoothstep(w * 1.3, w * 0.35, dist);
  }
  return s;
}
#endif

#if CLOUDSHADOW
float cloudShadow(vec3 P) {
  vec2 uv = (P.xz / 30.0 + uKeyDir.xz / max(uKeyDir.y, 0.1)) * uCloudA.z;
  uv.y *= uCloudA.w;
  uv += uCloudB.xy * uTime;
  float n = texture2D(uNoise, uv).r * 0.64 + texture2D(uNoise, uv * 2.3 + 0.17).g * 0.36;
  return 1.0 - 0.55 * smoothstep(uCloudA.x, uCloudA.x + uCloudA.y, n) * uCloudB.z;
}
#endif

vec3 shadeFloor(vec3 P, vec3 d, float t) {
  vec4 ao = aoAt(P);
  float fade = clamp(1.0 - t / uFloorK.z, 0.0, 1.0);
  float joint;
  vec3 alb = floorAlbedo(P, fade, joint);
  float wet = uFloor.z * ao.a;
  float pud = 0.0;
#if PUDDLES
  pud = puddleAt(P, ao);
#endif
  alb *= (1.0 - 0.5 * wet) * (1.0 - 0.25 * pud) * (0.75 + 0.25 * ao.b);
#if QUALITY > 0
  vec2 bn = (texture2D(uNoise, P.xz * 1.7).rg - 0.5) * uFloorK.y * fade * (1.0 - pud);
#else
  vec2 bn = vec2(0.0);
#endif
#if RIPPLES
  if (uRain * wet > 0.02) bn += ripples(P.xz) * uRain * wet * fade * (0.35 + 0.65 * pud);
#endif
  vec3 N = normalize(vec3(bn.x, 1.0, bn.y));
  vec3 sh = shadowAt(P);
  vec3 shK = mix(vec3(1.0), sh, uShSel.x);
  vec3 shP = mix(vec3(1.0), sh, uShSel.y);
  float kv = max(dot(N, uKeyDir), 0.0) * spotK(P);
#if CASTERS > 0
  kv *= casters(P);
#endif
#if CLOUDSHADOW
  kv *= cloudShadow(P);
#endif
  float ap = aperture(P);
  vec3 Lp = pointLight(uPtPos, uPtCol, P, N, 0.0) * ap * shP;
  vec3 col = alb * (uKeyCol * kv * shK + Lp + pointLight(uFirePos, uFireCol, P, N, 0.0) + pointLight(uL2Pos, uL2Col, P, N, 0.0)
                    + hemi(N) * ao.r * (0.45 + 0.55 * joint));
#if FLOOR == 3
  // grass looking toward a low sun glows through its blades (forward scattering)
  float fwd = max(dot(d, uKeyDir), 0.0); fwd *= fwd; fwd *= fwd;
  col += alb * uKeyCol * shK * fwd * fwd * (0.4 + 0.9 * mix(0.5, texture2D(uNoise, P.xz * 3.7).a, fade)) * 1.6;
#endif
  float R = floorRefl(-d.y, pud, ao.a);
  if (R > 0.004) {
    vec3 rd = reflect(d, N);
    vec3 rc = skyBase(rd);
    float sp = mix(60.0, 900.0, max(pud, uFloor.y));
    float sk = sp * 0.015;
    rc += uKeyCol * shK * kv * pow(max(dot(rd, uKeyDir), 0.0), sp) * sk;
    vec3 lp = uPtPos - P; float dl = dot(lp, lp); lp *= inversesqrt(dl);
    // a lamp seen through cloth is no longer a point (the fibres scatter it), so behind cloth its glint fades
    float clear = mix(0.12, 1.0, smoothstep(0.9, 0.995, min(min(shP.r, shP.g), shP.b)));
    rc += uPtCol * ap * shP * clear * pow(max(dot(rd, lp), 0.0), sp) * sk / (1.0 + dl);
    vec3 lf = uFirePos - P; float df = dot(lf, lf); lf *= inversesqrt(df);
    rc += uFireCol * pow(max(dot(rd, lf), 0.0), sp) * sk / (1.0 + df);
    vec3 l2 = uL2Pos - P; float d2 = dot(l2, l2); l2 *= inversesqrt(d2);
    rc += uL2Col * pow(max(dot(rd, l2), 0.0), sp) * sk / (1.0 + d2);
    col = mix(col, rc, R);
  }
  col = fog(col, P);
  float far = smoothstep(uFloorK.w, uFloorK.w * 2.6, t);
  if (far > 0.002) col = mix(col, skyColor(d), far);
  return col;
}
#endif
`;

const SKY_MAIN = `
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col;
#if FLOOR > 0
  if (d.y < -0.0004 && uCamPos.y > uFloor.x) {
    col = shadeFloor(uCamPos + d * ((uFloor.x - uCamPos.y) / d.y), d, (uFloor.x - uCamPos.y) / d.y);
  } else {
    col = skyColor(d);
  }
#else
  col = skyColor(d);
#endif
  gl_FragColor = vec4(toGamma(tonemap(col)), 1.0);
}`;

/** The sky's glow into the bloom buffer (¼ res): sun or moon disc and halo, hidden behind the hills. */
const GLOW_MAIN = `
uniform vec3 uGlowDir; uniform vec3 uGlowCol; uniform vec2 uGlowR; // disc radius, halo
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float r = length(d - uGlowDir);
  float g = smoothstep(uGlowR.x * 1.2, uGlowR.x * 0.8, r) + exp(-r / max(uGlowR.x * uGlowR.y, 1e-4)) * 0.45;
  g *= step(0.0, dot(d, uGlowDir));
#if HILLS > 0
  if (d.y < uHillTop) {
    float az = atan(d.x, -d.z);
    for (int i = 0; i < HILLS; i++) g *= smoothstep(-0.002, 0.002, d.y - hillH(az, uHillA[i], uHillB[i], uHillC[i]));
  }
#endif
  gl_FragColor = vec4(uGlowCol * g, 1.0);
}`;

const defs = (D) => Object.keys(D).map((k) => `#define ${k} ${D[k]}\n`).join('');
/** Fragment source for the sky + floor pass. */
export const skyFS = (D, COMMON, SHADOW) => defs(D) + COMMON + SHADOW + ENV_COMMON + SKY_UNIFORMS + SKY_FUNCS + FLOOR_FUNCS + SKY_MAIN;
/** Fragment source for the sky-glow (bloom) pass. */
export const glowFS = (D, COMMON) => defs(D) + COMMON + ENV_COMMON + SKY_UNIFORMS + SKY_FUNCS + GLOW_MAIN;

// ------------------------------------------------------------------ props
/** Props: one static mesh; aUvB.z picks a bone (0 static, 1..3 = uB1..uB3). uMirror.x = 1 mirrors in the floor. */
export const PROP_VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol; attribute vec4 aEmi; attribute vec4 aMat; attribute vec3 aUvB;
uniform mat4 uViewProj; uniform mat4 uB1; uniform mat4 uB2; uniform mat4 uB3;
uniform vec2 uMirror;
varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol; varying vec4 vEmi; varying vec4 vMat; varying vec2 vUv;
void main() {
  vec4 p = vec4(aPos, 1.0); vec4 n = vec4(aNrm, 0.0);
  float b = aUvB.z;
  if (b > 0.5) {
    if (b < 1.5) { p = uB1 * p; n = uB1 * n; }
    else if (b < 2.5) { p = uB2 * p; n = uB2 * n; }
    else { p = uB3 * p; n = uB3 * n; }
  }
  vPos = p.xyz; vNrm = n.xyz; vCol = aCol; vEmi = aEmi; vMat = aMat; vUv = aUvB.xy;
  if (uMirror.x > 0.5) p.y = 2.0 * uMirror.y - p.y;
  gl_Position = uViewProj * p;
}`;

const PROP_HEAD = `
uniform vec4 uGain;   // emissive gain per glow group 0..3 (lamp flicker)
uniform vec3 uEyeS;   // the eye used for shading (the mirrored eye in the reflection pass)
varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol; varying vec4 vEmi; varying vec4 vMat; varying vec2 vUv;
float gainOf(float g) { return g < 0.5 ? uGain.x : (g < 1.5 ? uGain.y : (g < 2.5 ? uGain.z : uGain.w)); }
float ribsOf(float f, float v) {
  if (f <= 0.0) return 1.0;
  float x = fract(v * f); x = min(x, 1.0 - x);
  return 1.0 - 0.55 * (1.0 - smoothstep(0.04, 0.13, x));
}
`;

const PROP_MAIN = `
void main() {
#ifdef MIRROR
  if (vPos.y < uFloor.x - 0.01) discard;
#endif
  vec3 N = normalize(vNrm);
  vec4 n1 = texture2D(uNoise, vUv * 0.37);
#ifdef MIRROR
  vec3 alb = toLinear(vCol.rgb) * max(0.0, 1.0 + (n1.r - 0.5) * (vMat.y + max(vMat.x, 0.0) * 0.5));
#else
  vec4 n2 = texture2D(uNoise, vec2(vUv.y * 0.33, vUv.x * 2.0));
  vec3 alb = toLinear(vCol.rgb) * max(0.0, 1.0 + (n2.b - 0.5) * max(vMat.x, 0.0) * 1.5 + (n1.r - 0.5) * vMat.y + (n2.a - 0.5) * vMat.y * 0.3);
#endif
  float ao = vCol.a;
  vec3 sh = shadowAt(vPos);
  vec3 shK = mix(vec3(1.0), sh, uShSel.x);
  vec3 shP = mix(vec3(1.0), sh, uShSel.y);
  float ndl = max(dot(N, uKeyDir), 0.0) * spotK(vPos);
  float ap = aperture(vPos);
  vec3 col = alb * (uKeyCol * ndl * shK * (0.25 + 0.75 * ao) + hemi(N) * ao
                    + pointLight(uPtPos, uPtCol, vPos, N, 0.1) * ap * shP
                    + pointLight(uFirePos, uFireCol, vPos, N, 0.2) + pointLight(uL2Pos, uL2Col, vPos, N, 0.2));
#ifndef MIRROR
  if (vMat.z > 0.2) {
    vec3 V = normalize(uEyeS - vPos);
    float sp = mix(10.0, 160.0, vMat.z);
    col += uKeyCol * shK * pow(max(dot(N, normalize(uKeyDir + V)), 0.0), sp) * vMat.z * ndl * 2.0;
    vec3 lp = uPtPos - vPos; float dl = dot(lp, lp); lp *= inversesqrt(dl);
    col += uPtCol * ap * shP * pow(max(dot(N, normalize(lp + V)), 0.0), sp) * vMat.z * 2.0 / (1.0 + dl);
    vec3 lf = uFirePos - vPos; float df = dot(lf, lf); lf *= inversesqrt(df);
    col += uFireCol * pow(max(dot(N, normalize(lf + V)), 0.0), sp) * vMat.z * 2.0 / (1.0 + df);
  }
#endif
  float limb = 1.0;
  if (vMat.x < 0.0) limb = mix(1.0, 0.35 + 0.65 * sqrt(max(dot(N, normalize(uEyeS - vPos)), 0.0)), -vMat.x);
  col += toLinear(vEmi.rgb) * gainOf(vEmi.a) * ribsOf(vMat.w, vUv.y) * (1.0 + (n1.r - 0.5) * vMat.y * 0.8) * limb;
#ifdef MIRROR
  vec3 M = vec3(vPos.x, 2.0 * uFloor.x - vPos.y, vPos.z);
  vec3 dv = M - uCamPos;
  vec3 F = uCamPos + dv * ((uFloor.x - uCamPos.y) / min(dv.y, -1e-4));
  vec4 aoF = aoAt(F);
  float R = floorRefl(-normalize(dv).y, puddleAt(F, aoF), aoF.a);
  gl_FragColor = vec4(finish(col, M), R);
#else
  gl_FragColor = vec4(finish(col, vPos), 1.0);
#endif
}`;

/** Depth only (the reflection's pre-pass). */
export const DEPTH_FS = `void main() { gl_FragColor = vec4(0.0); }`;

export const propFS = (D, COMMON, SHADOW, mirror) => defs(D) + (mirror ? '#define MIRROR 1\n' : '') + COMMON + SHADOW + ENV_COMMON + PROP_HEAD + PROP_MAIN;

/** Emissive props into the bloom buffer; everything else is a black occluder. */
export const propEmiFS = (COMMON) => COMMON + PROP_HEAD + `
uniform float uEmiK;
void main() {
  float mott = texture2D(uNoise, vUv * 0.37).r;
  float limb = 1.0;
  if (vMat.x < 0.0) { float nv = max(dot(normalize(vNrm), normalize(uEyeS - vPos)), 0.0); limb = mix(1.0, 0.3 + 0.7 * (1.0 - nv) * (1.0 - nv), -vMat.x); }
  vec3 e = toLinear(vEmi.rgb) * gainOf(vEmi.a) * ribsOf(vMat.w, vUv.y) * (1.0 + (mott - 0.5) * vMat.y * 0.8) * limb;
  gl_FragColor = vec4(e * uEmiK, 1.0);
}`;

// ------------------------------------------------------------------ the cloth, mirrored in the floor
export const MCLOTH_VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV; attribute vec4 aFx;
uniform mat4 uViewProj; uniform float uMirrorY;
varying vec3 vPos; varying vec3 vNrm; varying vec2 vUV; varying vec4 vFx; varying float vH;
void main() {
  vPos = aPos; vNrm = aNrm; vUV = aUV; vFx = aFx; vH = aPos.y - uMirrorY;
  gl_Position = uViewProj * vec4(aPos.x, 2.0 * uMirrorY - aPos.y, aPos.z, 1.0);
}`;

/** Its depth pre-pass: where the sheet folds over itself only the nearest layer reflects (one blend, any order). */
export const MCLOTH_DEPTH_FS = `
varying vec4 vFx; varying float vH;
void main() { if (vFx.y < 0.2 || vH < -0.01) discard; gl_FragColor = vec4(0.0); }`;

export const mclothFS = (D, COMMON) => defs(D) + COMMON + ENV_COMMON + `
uniform sampler2D uPrint; uniform sampler2D uDye; uniform vec3 uTint;
varying vec3 vPos; varying vec3 vNrm; varying vec2 vUV; varying vec4 vFx;
void main() {
  float fuel = vFx.y;
#if QUALITY > 0
  float burnt = 1.0 - fuel + (fbm(vUV * 2.7) - 0.5) * 0.45 * step(0.001, 1.0 - fuel);
#else
  float burnt = 1.0 - fuel;
#endif
  if (burnt > 0.8 || vPos.y < uFloor.x - 0.01) discard;
  // the reflection reverses the winding, so a front face shows the cloth's back (per triangle: no seams)
  vec3 N = normalize(vNrm);
  if (gl_FrontFacing) N = -N;
  vec3 base = toLinear(texture2D(uPrint, vUV).rgb) * uTint;
  vec4 dy = texture2D(uDye, vUV);
  base = mix(base, base * toLinear(dy.rgb) * 1.6, dy.a);
  base *= 1.0 - 0.5 * vFx.w;
  base = mix(base, vec3(0.025, 0.018, 0.012), clamp(vFx.z * 1.15, 0.0, 1.0));
  float ndl = dot(N, uKeyDir);
  vec3 col = base * (uKeyCol * max(ndl, 0.0) + uKeyCol * max(-ndl, 0.0) * 0.35 + hemi(N)
                     + pointLight(uPtPos, uPtCol, vPos, N, 0.6) + pointLight(uPtPos, uPtCol, vPos, -N, 0.6) * 0.45
                     + pointLight(uFirePos, uFireCol, vPos, N, 0.6));
  col += vec3(1.0, 0.42, 0.08) * vFx.x * vFx.x * 1.5;
  vec3 M = vec3(vPos.x, 2.0 * uFloor.x - vPos.y, vPos.z);
  vec3 dv = M - uCamPos;
  vec3 F = uCamPos + dv * ((uFloor.x - uCamPos.y) / min(dv.y, -1e-4));
  vec4 aoF = aoAt(F);
  float R = floorRefl(-normalize(dv).y, puddleAt(F, aoF), aoF.a);
  gl_FragColor = vec4(finish(col, M), R);
}`;

// ------------------------------------------------------------------ light beams (dust in a spotlight)
/** A soft cone of light: bright where you look through its middle, fading at its edges and its ends. */
export const BEAM_VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute float aT;
uniform mat4 uViewProj;
varying vec3 vPos; varying vec3 vNrm; varying float vT;
void main() { vPos = aPos; vNrm = aNrm; vT = aT; gl_Position = uViewProj * vec4(aPos, 1.0); }`;

export const beamFS = (COMMON) => COMMON + `
uniform vec3 uBeamCol; uniform vec3 uEyeS;
varying vec3 vPos; varying vec3 vNrm; varying float vT;
void main() {
  float e = abs(dot(normalize(vNrm), normalize(uEyeS - vPos)));
  float dust = 0.65 + 0.7 * texture2D(uNoise, vec2(vPos.x * 0.6 + vPos.z * 0.35, vPos.y * 0.3 - uTime * 0.012)).r;
  float a = e * e * e * dust * smoothstep(0.0, 0.3, vT) * (1.0 - 0.55 * vT);
  gl_FragColor = vec4(uBeamCol * a, 1.0);
}`;
