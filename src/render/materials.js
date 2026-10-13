// Fabric shading: the six materials' parameters, their procedural weave textures, and the GLSL that renders
// them. Owned by cloth-render. One shader source, specialised per material (#define MAT_X), per quality
// tier (#define QUALITY 0|1|2) and per pass (PASS_MAIN · PASS_EMISSIVE · PASS_SHADOW), so every compiled
// program carries only its own material's maths and the parameters fold into constants.
//
// Parameters (all per material):
//   weave     plain · twill · satin · pile · rings · film   threads   weave repeats per metre (stylised:
//             real cotton is ~400/m; at phone distances that would only shimmer)
//   tint      multiplies the print (linear)            wrap      diffuse wrap (soft light bleeding round folds)
//   trans     diffuse transmission (backlit glow)      direct    light seen straight through the weave gaps
//   back      how much duller the reverse side is      spec      specular strength   gloss / gloss2  lobes
//   sheen     grazing-angle fibre sheen (Charlie)      sheenRough  its spread (lower = tighter rim)
//   normal    weave micro-normal strength              threadAO  shading in the gaps between threads
//   cavity    fold darkening per unit curvature        shadowT   how much light the cloth lets through
//                                                                (the coloured shadow's brightness)
export const RENDER_MATERIALS = {
  cotton:    { weave: 'plain', threads: 64, tint: [1, 1, 1], wrap: 0.36, trans: 0.42, direct: 0.14, back: 0.16, spec: 0.03, gloss: 10, sheen: 0.5, sheenRough: 0.62, normal: 0.85, threadAO: 0.4, cavity: 0.016, shadowT: 0.62 },
  silk:      { weave: 'satin', threads: 96, tint: [1, 1, 1], wrap: 0.3, trans: 0.62, direct: 0.3, back: 0.42, spec: 0.5, gloss: 90, gloss2: 16, sheen: 0.22, sheenRough: 0.4, normal: 0.3, threadAO: 0.15, cavity: 0.014, shadowT: 0.72, shot: 0.65 },
  denim:     { weave: 'twill', threads: 110, tint: [1, 1, 1], wrap: 0.38, trans: 0.07, direct: 0.0, back: 0.0, spec: 0.04, gloss: 14, sheen: 0.32, sheenRough: 0.7, normal: 0.9, threadAO: 0.35, cavity: 0.018, shadowT: 0.08 },
  velvet:    { weave: 'pile', threads: 140, tint: [1, 1, 1], wrap: 0.6, trans: 0.1, direct: 0.0, back: 0.35, spec: 0.0, gloss: 8, sheen: 1.15, sheenRough: 0.33, normal: 0.45, threadAO: 0.2, cavity: 0.013, shadowT: 0.06 },
  chainmail: { weave: 'rings', threads: 15, tint: [1, 1, 1], wrap: 0.0, trans: 0.0, direct: 0.0, back: 0.0, spec: 1.6, rough: 0.3, sheen: 0.0, sheenRough: 0.5, normal: 1.0, threadAO: 0.7, cavity: 0.01, shadowT: 0.0 },
  aurora:    { weave: 'film', threads: 3, tint: [1, 1, 1], wrap: 0.3, trans: 0.78, direct: 0.42, back: 0.0, spec: 0.85, rough: 0.16, sheen: 0.15, sheenRough: 0.4, normal: 0.25, threadAO: 0.0, cavity: 0.012, shadowT: 0.84 },
};

/** Shader quality from the tier name (CONTRACT: low → 0, mid → 1, high/ultra → 2). */
export const qualityOf = (q) => (q && q.name === 'low' ? 0 : q && q.name === 'mid' ? 1 : 2);

// ------------------------------------------------------------------------------------------------ weaves
// A small tileable texture per material: rg = micro-normal (tangent space, u → x, v → y), b = thread height
// (gaps are low: shading, fray and see-through), a = which thread is on top (1 warp along v, 0 weft along u)
// or, for chainmail, ring coverage. Mipmapped, so the weave fades to its average with distance instead of
// shimmering.
const hashU = (a, b, c) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);
const mod = (a, m) => ((a % m) + m) % m;

/** Tileable 1D value noise along a thread (lumps and slubs in the yarn). */
function yarn(id, t, period) {
  const i = Math.floor(t), f = t - i;
  return hashU(id, mod(i, period), 7) * (1 - smooth(f)) + hashU(id, mod(i + 1, period), 7) * smooth(f);
}

function wovenField(kind, S, H, A) {
  // over(i, j): warp end i floats over pick j.  N threads per tile side (a multiple of the repeat).
  const N = kind === 'plain' ? 8 : kind === 'twill' ? 8 : 10;
  const over = kind === 'plain' ? (i, j) => ((i + j) & 1) === 0
    : kind === 'twill' ? (i, j) => mod(i - j, 4) !== 3      // 3/1 twill: the denim diagonal
      : (i, j) => mod(i - 2 * j, 5) !== 0;                    // 5-end warp satin (move 2): long glossy floats
  const lo = kind === 'satin' ? 0.42 : 0.32;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const tx = (x + 0.5) / S * N, ty = (y + 0.5) / S * N;
    const i = Math.floor(tx), j = Math.floor(ty), fx = tx - i, fy = ty - j;
    // warp i runs along y: its height rises where it floats over, eases between picks
    const ky = Math.floor(ty - 0.5), sy = smooth(ty - 0.5 - ky);
    const hw = (over(i, mod(ky, N)) ? 1 : lo) * (1 - sy) + (over(i, mod(ky + 1, N)) ? 1 : lo) * sy;
    const kx = Math.floor(tx - 0.5), sx = smooth(tx - 0.5 - kx);
    const hf = (over(mod(kx, N), j) ? lo : 1) * (1 - sx) + (over(mod(kx + 1, N), j) ? lo : 1) * sx;
    const pw = Math.pow(Math.sin(Math.PI * fx), 0.55), pf = Math.pow(Math.sin(Math.PI * fy), 0.55);
    const Hw = pw * hw * (0.9 + 0.1 * yarn(i, ty * 3, N * 3)), Hf = pf * hf * (0.9 + 0.1 * yarn(j + 99, tx * 3, N * 3));
    const o = y * S + x;
    H[o] = Math.max(Hw, Hf);
    A[o] = Math.min(1, Math.max(0, (Hw - Hf) * 8 + 0.5));
  }
  return N;
}

function pileField(S, H, A) {
  const tmp = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) tmp[i] = hashU(i, 3, 11);
  for (let pass = 0; pass < 2; pass++) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let s = 0; for (let k = -1; k <= 1; k++) s += tmp[y * S + mod(x + k, S)] + tmp[mod(y + k, S) * S + x];
    H[y * S + x] = s / 6;
    if (pass === 0) A[y * S + x] = 1;
  }
  for (let i = 0; i < S * S; i++) H[i] = 0.5 + (H[i] - 0.5) * 2.2;
  return 16;
}

function ringField(S, H, A) {
  // European 4-in-1 in one tile: two rows of two rings; rows lean opposite ways, so neighbours pass over
  // and under each other.
  const C = [[0.25, 0.25, 1], [0.75, 0.25, 1], [0.0, 0.75, -1], [0.5, 0.75, -1], [1.0, 0.75, -1]];
  const R = 0.345, w = 0.066;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const px = (x + 0.5) / S, py = (y + 0.5) / S;
    let h = 0, a = 0;
    for (const [cx, cy, lean] of C) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const dx = px - (cx + ox), dy = py - (cy + oy), d = Math.hypot(dx, dy), e = (d - R) / w;
      if (e <= -1 || e >= 1) continue;
      const prof = Math.sqrt(1 - e * e);
      const z = 0.35 + prof * 0.4 + lean * (dx / R) * 0.22;
      if (z > h) h = z;
      a = Math.max(a, Math.min(1, (1 - Math.abs(e)) * 3.2));
    }
    H[y * S + x] = h; A[y * S + x] = a;
  }
  return 2;
}

function filmField(S, H, A) {
  const P = 4;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, amp = 0.6, sum = 0;
    for (let oct = 0; oct < 3; oct++) {
      const f = P << oct, gx = (x / S) * f, gy = (y / S) * f, ix = Math.floor(gx), iy = Math.floor(gy);
      const tx = smooth(gx - ix), ty = smooth(gy - iy), s = 31 + oct;
      const L = (i, j) => hashU(mod(i, f), mod(j, f), s);
      v += amp * ((L(ix, iy) * (1 - tx) + L(ix + 1, iy) * tx) * (1 - ty) + (L(ix, iy + 1) * (1 - tx) + L(ix + 1, iy + 1) * tx) * ty);
      sum += amp; amp *= 0.5;
    }
    H[y * S + x] = v / sum; A[y * S + x] = 1;
  }
  return 1;
}

/** Weave repeats (threads, rings) in one tile of each weave kind. */
const PER_TILE = { plain: 8, twill: 8, satin: 10, pile: 16, rings: 2, film: 1 };

/**
 * RGBA8 weave texture for a material: { data, size, perTile, mean: [nx, ny, height, top] } (perTile = weave
 * repeats in one tile; mean = the tile's average, what the weave fades to once threads get too small to see).
 */
export function makeWeave(id, S = 128) {
  const kind = (RENDER_MATERIALS[id] || RENDER_MATERIALS.cotton).weave;
  const H = new Float32Array(S * S), A = new Float32Array(S * S);
  const perTile = kind === 'pile' ? pileField(S, H, A) : kind === 'rings' ? ringField(S, H, A)
    : kind === 'film' ? filmField(S, H, A) : wovenField(kind, S, H, A);
  let mh = 0, ma = 0;
  for (let i = 0; i < S * S; i++) { mh += Math.min(1, Math.max(0, H[i])); ma += A[i]; }
  const k = kind === 'rings' ? 7 : kind === 'film' ? 3 : kind === 'pile' ? 2.5 : 5;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = y * S + x;
    const nx = (H[y * S + mod(x - 1, S)] - H[y * S + mod(x + 1, S)]) * k;
    const ny = (H[mod(y - 1, S) * S + x] - H[mod(y + 1, S) * S + x]) * k;
    const il = 1 / Math.hypot(nx, ny, 1);
    data[o * 4] = Math.round((nx * il * 0.5 + 0.5) * 255);
    data[o * 4 + 1] = Math.round((ny * il * 0.5 + 0.5) * 255);
    data[o * 4 + 2] = Math.round(Math.min(1, Math.max(0, H[o])) * 255);
    data[o * 4 + 3] = Math.round(Math.min(1, Math.max(0, A[o])) * 255);
  }
  return { data, size: S, perTile, mean: [0.5, 0.5, mh / (S * S), ma / (S * S)] };
}

// ------------------------------------------------------------------------------------------------ GLSL
const f = (x) => (Number.isFinite(x) ? (+x).toFixed(5) : '0.0');
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

function defines(id, quality, pass, opts) {
  const m = RENDER_MATERIALS[id] || RENDER_MATERIALS.cotton;
  return `#define QUALITY ${quality}
#define MAT_${(RENDER_MATERIALS[id] ? id : 'cotton').toUpperCase()} 1
#define PASS_${pass.toUpperCase()} 1
${opts.a2c ? '#define A2C 1' : ''}
#define M_TINT ${v3(m.tint)}
#define M_WRAP ${f(m.wrap)}
#define M_TRANS ${f(m.trans)}
#define M_DIRECT ${f(m.direct)}
#define M_BACK ${f(m.back)}
#define M_SPEC ${f(m.spec)}
#define M_GLOSS ${f(m.gloss || 10)}
#define M_GLOSS2 ${f(m.gloss2 || 10)}
#define M_ROUGH ${f(m.rough || 0.5)}
#define M_SHEEN ${f(m.sheen)}
#define M_SHEEN_INV ${f(1 / (m.sheenRough || 0.5))}
#define M_NORMAL ${f(m.normal)}
#define M_THREAD_AO ${f(m.threadAO)}
#define M_CAVITY ${f(m.cavity)}
#define M_SHADOW_T ${f(m.shadowT)}
#define M_SHOT ${f(m.shot || 0)}
#define PER_TILE ${f(PER_TILE[m.weave] || 8)}
`;
}

/**
 * Vertex shader. Attributes: aPos, aNrm (float), aUV (float), aFx = heat, fuel (with burn eat-in), char,
 * wet and aFx2 = fold curvature (signed, 0.5 = flat), torn-edge factor, standing-water depth (byte = mm)
 * (unsigned bytes, normalised). Standing water lifts the surface to the water's level (cloth.pool: the skin
 * sits at pos + (0, pool, 0)), so where it pools, what is drawn is the water.
 * At QUALITY 0 the main pass lights per vertex (key + lamp + fire, both faces) to keep the fragment cheap.
 */
export function clothVS(id, quality, pass, opts) {
  const LP = opts.highp ? 'highp' : 'mediump';
  return defines(id, quality, pass, opts) + `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUV; attribute vec4 aFx; attribute vec4 aFx2;
uniform mat4 uViewProj;
varying vec3 vPos; varying vec3 vNrm; varying vec4 vUV; varying vec4 vFx;
#ifndef PASS_SHADOW
varying float vPool;
#endif
#if defined(PASS_MAIN) && QUALITY == 0
uniform ${LP} vec3 uKeyDir; uniform ${LP} vec3 uKeyCol; uniform ${LP} vec3 uPtPos; uniform ${LP} vec3 uPtCol;
uniform ${LP} vec3 uFirePos; uniform ${LP} vec3 uFireCol;
varying vec3 vLA; varying vec3 vLB;
void lightV(vec3 n, vec3 L, vec3 C) {
  float d = dot(n, L);
  vLA += C * max((d + M_WRAP) / (1.0 + M_WRAP), 0.0);
  vLB += C * max((M_WRAP - d) / (1.0 + M_WRAP), 0.0);
}
#endif
void main() {
  vec3 p = aPos;
#ifndef PASS_SHADOW
  vPool = aFx2.z * 0.255;
  p.y += vPool;
#endif
  vPos = p; vNrm = aNrm; vUV = vec4(aUV, aFx2.xy); vFx = aFx;
#if defined(PASS_MAIN) && QUALITY == 0
  vLA = vec3(0.0); vLB = vec3(0.0);
  vec3 n = normalize(aNrm);
  lightV(n, uKeyDir, uKeyCol);
  vec3 lp = uPtPos - aPos; float dp = dot(lp, lp);
  lightV(n, lp * inversesqrt(max(dp, 1e-4)), uPtCol / (1.0 + dp));
  vec3 lf = uFirePos - aPos; float df = dot(lf, lf);
  lightV(n, lf * inversesqrt(max(df, 1e-4)), uFireCol / (1.0 + df));
#endif
  gl_Position = uViewProj * vec4(p, 1.0);
}`;
}

/** Fragment shader body (append to COMMON). pass: 'main' | 'emissive' | 'shadow'. */
export function clothFS(id, quality, pass, opts) {
  return defines(id, quality, pass, opts) + `
uniform sampler2D uPrint; uniform sampler2D uDye; uniform sampler2D uWeave;
uniform vec2 uWeaveRep; uniform vec2 uNoiseRep;
uniform vec4 uWeaveMean;       // the weave tile's average: what it fades to when threads are sub-pixel
uniform vec2 uMask;            // print alpha as a mask: x = damask (thread direction flips), y = gold thread
uniform vec3 uShot;            // the print's shot-silk colour (linear)
uniform float uShadowStrength; // shadow pass: how strongly the casting light is filtered
// time as phases wrapped on the CPU (mediump-safe however long the page runs): ember flicker (t·9 mod 2π),
// spark crawl (t·2.7 mod 2π), film flow (t·0.4 mod 2π), raindrop cycle (fract(t·0.9))
uniform vec4 uPhase;
varying vec3 vPos; varying vec3 vNrm; varying vec4 vUV; varying vec4 vFx;
#ifndef PASS_SHADOW
varying float vPool;
#endif
#if defined(PASS_MAIN) && QUALITY == 0
varying vec3 vLA; varying vec3 vLB;
#endif

#if defined(HAS_DERIV) && (QUALITY >= 1 || defined(MAT_SILK) || defined(MAT_CHAINMAIL))
#define USE_TBN 1
#endif

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Fine noise (a few cm) for burn edges, fetched only where something burns: 0.5 elsewhere. The noise texture
// has no mips, so it needs no derivatives and the branch is safe.
float fineNoise(float fuel, vec2 uv) {
  if (fuel >= 0.999) return 0.5;
  vec4 nf = texture2D(uNoise, uv * uNoiseRep * 4.0);
  return nf.r * 0.55 + nf.g * 0.45;
}
// Burn: the interpolated fuel field broken up at three scales (cloth-scale fbm, the fine octave, the weave's
// own threads), so a coarse physics grid still burns with an organic, pixel-sharp edge: the noise must vary
// WITHIN a triangle, or the edge would run straight across it. > 0 cloth, < 0 burnt away.
float burnField(float fuel, vec4 nz, vec4 wv, float nf) {
  float n = nz.r * 0.6 + nz.g * 0.4;
  if (fuel < 0.999) n = n * 0.4 + nf * 0.6;
  return fuel - 0.3 + (n - 0.5) * 0.66 + (wv.b - 0.5) * 0.16;
}
// Cut-outs: burn holes, threads fraying along tears and burnt rims (a katana cut stays clean: its cloth
// still has all its fuel), and the gaps between chainmail rings.
float cutField(float burn, float edge, vec4 nz, vec4 wv, float nf) {
#ifdef MAT_CHAINMAIL
  return wv.a - 0.5;
#else
  return min(burn, 0.6 - edge * 1.2 + (wv.b - 0.5) * 0.42 + (nz.b - 0.5) * 0.3 + (nf - 0.5) * 0.9);
#endif
}
// Scorch → brown char → black, spreading ahead of the flame (char), always black right behind the edge.
float charAmount(float charv, float burn, float fuel, vec4 nz) {
  float ch = clamp(charv * 1.25 + (nz.g - 0.5) * 0.6 * step(0.002, charv), 0.0, 1.0);
  return max(ch, (1.0 - smoothstep(0.0, 0.2, burn)) * step(fuel, 0.995));
}
vec3 charRamp(vec3 c, float ch) {
  c = mix(c, c * vec3(0.8, 0.56, 0.32), smoothstep(0.0, 0.3, ch));
  c = mix(c, vec3(0.075, 0.04, 0.02), smoothstep(0.25, 0.65, ch));
  return mix(c, vec3(0.011, 0.009, 0.008), smoothstep(0.6, 0.95, ch));
}
// The ember line at the burning edge (flickering), and sparks crawling through hot char.
vec3 ember(float burn, float heat, float charv, vec4 nz) {
  float hot = smoothstep(0.03, 0.4, heat);
  float rim = 1.0 - smoothstep(0.0, 0.1, burn);
  rim *= rim;
  // the line breathes along its length (smooth noise, so it flickers rather than glitters)
  float flick = 0.68 + 0.32 * sin(uPhase.x + nz.r * 21.0 + nz.g * 13.0);
  float crawl = 0.5 + 0.5 * sin(nz.b * 23.0 + nz.g * 17.0 - uPhase.y);
  crawl = smoothstep(0.82, 0.98, crawl) * smoothstep(0.35, 0.85, heat) * smoothstep(0.25, 0.75, charv);
  return (mix(vec3(0.95, 0.19, 0.02), vec3(1.0, 0.74, 0.32), rim) * (rim * 2.4 * flick) + vec3(1.0, 0.34, 0.05) * crawl * 1.4) * hot;
}
// Steel glowing with heat: dull red → cherry → orange → yellow-white.
vec3 blackbody(float h) {
  float t = clamp((h - 0.1) / 0.9, 0.0, 1.0);
  vec3 c = vec3(1.0, 0.1, 0.01) * smoothstep(0.0, 0.32, t) + vec3(0.0, 0.38, 0.06) * smoothstep(0.3, 0.75, t) + vec3(0.0, 0.3, 0.42) * smoothstep(0.7, 1.0, t);
  return c * (t * t * 1.5 + t * 0.3);
}
// Thin-film interference, optical thickness d in micrometres: phase 4·pi·d·cos(theta) / lambda for R, G, B.
vec3 filmPhase(float d, float cosT) { return d * cosT * vec3(19.33, 23.71, 27.93); }
// The aurora film's thickness: slow drifts over the cloth, a ripple from the weave, a slow flow in time.
float filmThickness(vec4 nz, vec4 wv) {
  return 0.42 + (nz.r - 0.5) * 0.1 + (wv.b - 0.5) * 0.04 + 0.03 * sin(uPhase.z + nz.g * 6.283);
}

#ifdef PASS_MAIN
vec3 gN; vec3 gNg; vec3 gV; vec3 gT; vec3 gB; float gNV; float gWa; vec3 gF0; vec3 gShot;
vec3 gLd = vec3(0.0); vec3 gLt = vec3(0.0); vec3 gLs = vec3(0.0); float gWet; float gGold;

#if QUALITY >= 1
uniform float uRain;         // rain intensity 0..1 (raindrop rings on standing water)
uniform float uShadowSelf;   // 1 when the shadow map's alpha holds the nearest cloth depth
uniform float uShadowPoint;  // 1 when the casting light is the point light, 0 the key light
// Self-shadowing: the casting light that gets past the cloth's OTHER layers, coloured by them. The map's
// alpha is the depth of the layer nearest the light, so the nearest layer is lit and anything behind it
// receives the light filtered through the layers in front.
vec3 clothShadow(vec3 wp) {
  if (uShadowOn * uShadowSelf < 0.5) return vec3(1.0);
  vec4 s = uShadowMat * vec4(wp, 1.0);
  if (s.w <= 1e-4) return vec3(1.0);
  vec3 p = s.xyz / s.w;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return vec3(1.0);
  vec4 t = texture2D(uShadow, p.xy);
  // never quite black: light scatters into a fold even behind opaque cloth
  return mix(vec3(1.0), max(t.rgb, vec3(0.18)), smoothstep(0.01, 0.04, p.z - t.a));
}
#endif

float charlie(float NH) {
  float s2 = max(1.0 - NH * NH, 0.0078125);
  return (2.0 + M_SHEEN_INV) * pow(s2, M_SHEEN_INV * 0.5) * 0.15915;
}
float ggx(float NH, float a) {
  float a2 = a * a; float d = NH * NH * (a2 - 1.0) + 1.0;
  return a2 / (3.14159 * d * d + 1e-4);
}

// Highlights for one light (reflection only; diffuse and transmission are accumulated by light()).
void lightSpec(vec3 L, vec3 C) {
  float NL = dot(gN, L);
  vec3 H = normalize(L + gV);
  float NH = max(dot(gN, H), 0.0);
  float sNL = max(NL, 0.0);
#if defined(MAT_SILK)
  // Kajiya-Kay on both thread families, weighted by which thread floats on top: the streak runs across
  // the threads and flips direction where a damask pattern turns the satin.
  float tu = dot(gT, H), tv = dot(gB, H);
  float su = sqrt(max(1.0 - tu * tu, 0.0)), sv = sqrt(max(1.0 - tv * tv, 0.0));
  float k = smoothstep(-0.15, 0.35, NL);
  float s1 = mix(pow(su, M_GLOSS), pow(sv, M_GLOSS), gWa);
  float s2 = mix(pow(su, M_GLOSS2), pow(sv, M_GLOSS2), gWa);
  gLs += C * k * (vec3(s1 * M_SPEC) + gShot * (s2 * M_SPEC * 0.22));
#elif defined(MAT_CHAINMAIL) || defined(MAT_AURORA)
  float VH = max(dot(gV, H), 0.0);
  vec3 F = gF0 + (1.0 - gF0) * pow(1.0 - VH, 5.0);
  gLs += C * F * (ggx(NH, M_ROUGH) * sNL * 0.25 * M_SPEC);
#else
  // fibre sheen (Charlie distribution, Neubelt visibility) and a soft, faint highlight
  float vis = 1.0 / (4.0 * (sNL + gNV - sNL * gNV) + 0.001);
#if QUALITY == 0
  float s2 = 1.0 - NH * NH;   // Charlie's sin(θh)^(1/r) with the power folded to a square: no pow
  gLs += C * gShot * ((2.0 + M_SHEEN_INV) * 0.15915 * s2 * s2 * vis * sNL * M_SHEEN);
#else
  gLs += C * gShot * (charlie(NH) * vis * sNL * M_SHEEN);
  gLs += C * (pow(NH, M_GLOSS) * M_SPEC * sNL);
#endif
#endif
#if QUALITY >= 1
  // a film of water (on chainmail and the aurora film too: a skin of water on the surface), and gold
  // thread from the print's mask
  float fw = 0.02 + 0.98 * pow(1.0 - max(dot(gV, H), 0.0), 5.0);
  gLs += C * (gWet * fw * (ggx(NH, 0.09) + ggx(NH, 0.28) * 0.6) * sNL * 0.25);
  gLs += C * vec3(1.0, 0.76, 0.33) * (gGold * ggx(NH, 0.32) * sNL * 0.3);
#endif
}

#if QUALITY >= 1
// Diffuse (wrapped), transmitted (from behind: diffuse through the fibres + straight through the gaps),
// and highlights, for one light.
void light(vec3 L, vec3 C, float open) {
  float NL = dot(gN, L);
  gLd += C * max((NL + M_WRAP) / (1.0 + M_WRAP), 0.0);
  float BL = max(-dot(gNg, L), 0.0);
  float VL = max(-dot(gV, L), 0.0);
  gLt += C * (BL + M_DIRECT * open * pow(VL, 6.0) * 3.0 * step(0.0, -dot(gNg, L)));
  lightSpec(L, C);
}
#endif
#endif

void main() {
  vec2 uv = vUV.xy;
  float heat = vFx.x, fuel = vFx.y, charv = vFx.z, wet = vFx.w;
  float edge = vUV.w;
#if defined(MAT_CHAINMAIL) || (QUALITY >= 1 && defined(PASS_MAIN))
  vec2 wuv = uv * uWeaveRep;
  vec4 wv = texture2D(uWeave, wuv);
#ifdef HAS_DERIV
  // threads only show once they span a few pixels: below that the weave would alias into a grid, so it
  // fades to its average (rings keep their coverage: that is the chainmail's silhouette)
  vec2 tpp = fwidth(wuv) * PER_TILE;
  float wvis = 1.0 - smoothstep(0.14, 0.34, max(tpp.x, tpp.y));
#ifdef MAT_CHAINMAIL
  wv.rgb = mix(uWeaveMean.rgb, wv.rgb, wvis);
#else
  wv = mix(uWeaveMean, wv, wvis);
#endif
#endif
#else
  // no weave tap: on the low tier's small screens the threads are sub-pixel, and the quarter-res glow and
  // shadow passes never see them; the weave's average stands in
  vec4 wv = uWeaveMean;
#endif
  vec4 nz = texture2D(uNoise, uv * uNoiseRep);
  float nf = fineNoise(fuel, uv);
  // a charred rim of a burnt hole burns on into the cloth (the torn-edge factor is highest on the rim), so
  // the visible edge always lies between the rim and the next intact ring, shaped by the noise
  float burn = burnField(fuel, nz, wv, nf) - edge * 1.4 * smoothstep(0.1, 0.4, charv);
  float cut = cutField(burn, edge, nz, wv, nf);
  float alpha = step(0.0, cut);
#if defined(PASS_MAIN) && defined(A2C) && defined(HAS_DERIV)
  alpha = clamp(cut / max(fwidth(cut), 1e-4) + 0.5, 0.0, 1.0);   // alpha-to-coverage: anti-aliased cut edges
#endif
#if defined(PASS_SHADOW) && defined(MAT_CHAINMAIL)
  alpha = 1.0;   // rings filter the light by coverage instead (smooth at shadow-map resolution)
#endif
  if (alpha <= 0.0) discard;

#ifdef PASS_SHADOW
  // ---- transmittance: what colour of light gets through (white = all of it) ----
#ifdef MAT_CHAINMAIL
  vec3 Tr = vec3(1.0 - wv.a * 0.96);
#else
  vec3 base = toLinear(texture2D(uPrint, uv).rgb) * M_TINT;
  vec4 dy = texture2D(uDye, uv);
  base *= mix(vec3(1.0), toLinear(dy.rgb), dy.a);
  float ch = charAmount(charv, burn, fuel, nz);
  // light through dyed cloth keeps the dye's hue even where it is dark (indigo throws a deep blue, not
  // black), and white cloth lets most of it through
  vec3 Tr = M_SHADOW_T * pow(max(base, vec3(1e-4)), vec3(0.8)) * (1.0 + wet * 0.8) * (1.0 - ch * 0.96);
#endif
  gl_FragColor = vec4(mix(vec3(1.0), min(Tr, vec3(1.0)), uShadowStrength), gl_FragCoord.z);

#elif defined(PASS_EMISSIVE)
  // ---- glow only (black elsewhere: the cloth still occludes what glows behind it) ----
#ifdef MAT_CHAINMAIL
  vec3 glow = blackbody(heat) * (0.55 + 0.45 * wv.b);
#else
  vec3 glow = heat > 0.01 ? ember(burn, heat, charv, nz) : vec3(0.0);
  // a lamp behind thin cloth makes the cloth itself luminous: the brightest transmitted light blooms
  // (the noren's crest glows; dark dye stays dark)
  vec3 lpe = uPtPos - vPos; float dpe = dot(lpe, lpe);
  float behind = max(-dot(normalize(vNrm) * (gl_FrontFacing ? 1.0 : -1.0), lpe * inversesqrt(max(dpe, 1e-4))), 0.0);
  vec3 pr0 = toLinear(texture2D(uPrint, uv).rgb);
  vec3 lit = pr0 * (0.45 + pr0) * M_TRANS * uPtCol * (behind / (1.0 + dpe)) * (1.0 + wet) * (1.0 - smoothstep(0.1, 0.6, charv));
  glow += max(lit - 0.3, vec3(0.0)) * 0.7;
#endif
#ifdef MAT_AURORA
  vec3 Ne = normalize(vNrm); vec3 Ve = normalize(uCamPos - vPos);
  float ce = abs(dot(Ne, Ve));
  glow += (0.5 - 0.5 * cos(filmPhase(filmThickness(nz, wv), sqrt(1.0 - (1.0 - ce * ce) / 1.77)))) * (0.012 + 0.03 * (1.0 - ce));
#endif
  gl_FragColor = vec4(min(glow, vec3(1.0)), 1.0);

#else
  // ---- the full look ----
  bool ff = gl_FrontFacing;
  float side = ff ? 1.0 : -1.0;
  vec3 Ng = normalize(vNrm) * side;
  vec3 V = normalize(uCamPos - vPos);
#ifdef USE_TBN
  vec3 dp1 = dFdx(vPos) * 256.0, dp2 = dFdy(vPos) * 256.0;
  vec2 du1 = dFdx(uv) * 256.0, du2 = dFdy(uv) * 256.0;
  vec3 dp2p = cross(dp2, Ng), dp1p = cross(Ng, dp1);
  vec3 T = dp2p * du1.x + dp1p * du2.x;
  vec3 B = dp2p * du1.y + dp1p * du2.y;
  float im = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-4));   // (scaled ×256 above: mediump-safe)
  T *= im; B *= im;
#else
  vec3 T = normalize(cross(abs(Ng.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0), Ng));
  vec3 B = cross(Ng, T);
#endif
  vec3 N = Ng;
#if QUALITY >= 1 && defined(USE_TBN)
  vec2 wn = (wv.rg * 2.0 - 1.0) * M_NORMAL;
  N = normalize(Ng + T * wn.x + B * wn.y);
#endif
  vec4 pr = texture2D(uPrint, uv);
  vec3 base = toLinear(pr.rgb) * M_TINT;
  float mask = 1.0 - pr.a;
  float wa = mix(wv.a, 1.0 - wv.a, mask * uMask.x);   // damask: the motif turns the satin
  gN = N; gNg = Ng; gV = V; gT = T; gB = B; gWa = wa; gWet = wet;
  gNV = clamp(dot(N, V), 0.02, 1.0);
  gGold = mask * uMask.y;
  gShot = vec3(1.0);
  gF0 = vec3(0.04);
  float open = 1.0 - wv.b;      // gaps between threads let light straight through
  vec3 glow = vec3(0.0);
  vec4 dy = texture2D(uDye, uv);

#ifdef MAT_COTTON
  if (!ff) base = mix(base, vec3(lum(base)) * 0.92 + 0.05, M_BACK);
  gShot = mix(sqrt(base), vec3(lum(sqrt(base))), 0.3);
#endif
#ifdef MAT_DENIM
  // indigo warp carries the print (discharge-style); ecru weft shows on the reverse
  vec3 indigo = vec3(0.016, 0.034, 0.115);
  vec3 warpC = indigo * (0.45 + 0.9 * base) + base * 0.04;
  vec3 weftC = vec3(0.62, 0.58, 0.5);
  // the face is warp-faced: weft peeks through the twill; the reverse is mostly weft
  float onTop = ff ? mix(0.7, 1.0, wv.a) : 1.0 - wv.a * 0.75;
  base = mix(weftC, warpC, onTop);
  // wear: ridges of the folds rub toward the white core of the yarn
  base = mix(base, weftC * 0.85, clamp((vUV.z * 2.0 - 1.0) * side * 2.2, 0.0, 0.3) * onTop);
  base *= 0.88 + 0.24 * nz.b;   // slub yarn
  gShot = vec3(0.55, 0.6, 0.72);
#endif
#ifdef MAT_SILK
  vec3 shot = uShot * (lum(base) / max(lum(uShot), 0.02));
  float gz = 1.0 - gNV;
  base = mix(base, shot, gz * gz * M_SHOT);
  if (!ff) base = mix(base, vec3(lum(base)) * 0.85 + 0.04, M_BACK);   // crepe back: duller
  gShot = mix(base, shot, 0.5) * 1.1 + 0.02;   // the secondary sheen carries the dye (and its shot hue)
#endif
#ifdef MAT_VELVET
  // pile: the dye sits deep, so it is dark where it faces you; the fibre tips glow at grazing angles.
  // Crushed velvet: the pile leans in patches, so the sheen brightens and fades across the cloth.
  vec2 cr = (nz.rg - 0.5) * 2.0;
  gN = normalize(N + (T * cr.x + B * cr.y) * (ff ? 0.22 : 0.0));
  gNV = clamp(dot(gN, V), 0.02, 1.0);
  vec3 deep = base * (0.3 + 0.7 * base);
  float facing = clamp(dot(N, V), 0.0, 1.0);
  gShot = (sqrt(base) * 1.35 + 0.03) * (0.55 + 0.9 * nz.r);
  base = ff ? deep * (0.42 + 0.58 * (1.0 - facing * facing)) : deep * 0.75;
  if (!ff) gShot *= 0.12;
#endif
#ifdef MAT_CHAINMAIL
  vec3 steel = vec3(0.58, 0.59, 0.61);
  gF0 = mix(steel, steel * min(base * 1.8, vec3(1.0)), 0.22);
  // temper colours where fire heated the steel (char accumulates on chainmail as oxide): straw → blue
  gF0 *= mix(vec3(1.0), 0.5 + 0.5 * cos(filmPhase(charv * 0.25, 1.0)), smoothstep(0.0, 0.1, charv));
  gF0 *= mix(vec3(1.0), toLinear(dy.rgb), dy.a * 0.6);
  gF0 *= 1.0 - 0.18 * wet;   // under a skin of water the steel reflects a little less (and the film glints)
  base = vec3(0.0);
#endif
#ifdef MAT_AURORA
  // a thin film: the colour comes mostly from the viewing angle (bands slide across every fold) while the
  // thickness drifts slowly over the cloth and in time
  float d = filmThickness(nz, wv);
  float cosT = sqrt(1.0 - (1.0 - gNV * gNV) / 1.77);
  vec3 irid = 0.5 - 0.5 * cos(filmPhase(d, cosT));
  irid = mix(vec3(lum(irid)), irid, 0.78);
  gF0 = mix(vec3(0.04), irid * 0.8 + 0.04, 0.9);
  base = base * 0.2 + irid * 0.03;
  glow += irid * (0.012 + 0.03 * (1.0 - gNV));   // luminous: a faint glow of its own, brightest at the rims
#endif

#ifndef MAT_CHAINMAIL
  // dye: absorbed into the fibre, so it multiplies. fx/dye.js already encodes density (ink lands dark and
  // dense, a darker tide line where it dried): rgb = the ink's colour (gamma 2), a = the layer's amount
  base *= mix(vec3(1.0), toLinear(dy.rgb), dy.a);
  // wet, char and embers are skipped where the cloth is dry and whole (most pixels, most of the time)
  if (wet > 0.002) {
    // wet: water fills the gaps between fibres, so less light scatters back out: darker, richer, sheerer
#if QUALITY == 0
    base *= mix(vec3(1.0), base + 0.12, wet) * (1.0 - 0.38 * wet);
#else
    base = pow(max(base, vec3(1e-4)), vec3(1.0 + 0.8 * wet)) * (1.0 - 0.38 * wet);
#endif
  }
  float ch = 0.0;
  if (charv > 0.002 || fuel < 0.995) {
    ch = charAmount(charv, burn, fuel, nz);
    base = charRamp(base, ch);
  }
  // transmitted colour: light through dyed fibres comes out more saturated than it reflects
  vec3 tcol = base * (0.45 + base) * M_TRANS * (1.0 + wet * 0.9) * (1.0 - ch);
  if (heat > 0.01) glow += ember(burn, heat, charv, nz);
  gGold *= 1.0 - ch;
  base = mix(base, base * 0.35, gGold);
#else
  float ch = 0.0;
  vec3 tcol = vec3(0.0);
  if (heat > 0.01) glow += blackbody(heat) * (0.55 + 0.45 * wv.b);
#endif

  // ---- light ----
#if QUALITY == 0
  gLd = ff ? vLA : vLB;
  gLt = ff ? vLB : vLA;
  lightSpec(uKeyDir, uKeyCol);
  vec3 lp = normalize(uPtPos - vPos);
  gLt += uPtCol * (M_DIRECT * open * 3.0 * pow(max(-dot(V, lp), 0.0), 6.0) * step(0.0, -dot(Ng, lp)) / (1.0 + dot(uPtPos - vPos, uPtPos - vPos)));
#else
  vec3 sh = clothShadow(vPos);
  light(uKeyDir, uKeyCol * mix(sh, vec3(1.0), uShadowPoint), open);
  vec3 lp = uPtPos - vPos; float dp = dot(lp, lp);
  light(lp * inversesqrt(max(dp, 1e-4)), uPtCol * mix(vec3(1.0), sh, uShadowPoint) / (1.0 + dp), open);
  vec3 lf = uFirePos - vPos; float df = dot(lf, lf);
  light(lf * inversesqrt(max(df, 1e-4)), uFireCol / (1.0 + df), open);
#endif

  // folds: a cavity term from the vertex curvature (valleys on this side), and the gaps between threads
  float curv = (vUV.z * 2.0 - 1.0) * 60.0 * side;
  float ao = 1.0 - clamp(-curv * M_CAVITY, 0.0, 0.62);
  ao *= mix(1.0, 0.5 + 0.5 * wv.b, M_THREAD_AO);
  vec3 amb = hemi(gN) * ao;
  vec3 col = base * (gLd * mix(1.0, ao, 0.55) + amb) + tcol * (gLt + hemi(-Ng) * 0.35) + gLs * mix(1.0, ao, 0.5);
#if defined(MAT_COTTON) || defined(MAT_DENIM) || defined(MAT_VELVET)
  // sheen from the sky at grazing angles
  float gr = 1.0 - gNV;
  col += amb * gShot * (gr * gr * gr * M_SHEEN * 0.5);
#endif
#if defined(MAT_SILK) || defined(MAT_CHAINMAIL) || defined(MAT_AURORA) || QUALITY >= 1
  // reflections of the sky and ground (silk, metal, film, and wet or gilded cloth)
  vec3 R = reflect(-V, gN);
  vec3 env = hemi(R) * (0.6 + 0.4 * ao);
  float fr = pow(1.0 - gNV, 5.0);
#if defined(MAT_CHAINMAIL) || defined(MAT_AURORA)
  col += env * (gF0 + (1.0 - gF0) * fr) * (1.0 - M_ROUGH * 0.6);
#elif defined(MAT_SILK)
  col += env * (0.02 + 0.2 * fr) * gShot;
#endif
#if QUALITY >= 1
  // a wet surface catches a little of the sky (most of wet's look is the darkening and the highlights)
  col += env * ((0.03 + 0.45 * fr) * wet + gGold * vec3(1.0, 0.76, 0.33) * 0.6);
#endif
#endif
  // standing water (cloth.pool, from the weather): the vertex shader lifted this surface to the water's
  // level, so here we draw the water itself: the cloth seen through it, darker the deeper it is, under a
  // skin that mirrors the sky, catches the light, and rings with raindrops while it rains
  float pool = smoothstep(0.002, 0.012, vPool);
  if (pool > 0.001) {
    // QA 2026-10-13: under a grey rain sky the first pass read as nothing; deeper water now absorbs more,
    // and the scene lamp (the Monsoon lantern) glints off the skin, so a pool reads at a glance
    vec3 under = col * exp(-vPool * vec3(22.0, 14.0, 11.0)) * 0.45;
#if QUALITY >= 1
    vec2 pc = uv * uNoiseRep * 14.0;
    vec2 cell = floor(pc), fc = fract(pc) - 0.5;
    vec4 rnd = texture2D(uNoise, (cell + 0.5) / 256.0);
    float t = fract(uPhase.w + rnd.a);
    vec2 dv = fc - (rnd.rg - 0.5) * 0.4;
    float dd = length(dv) + 1e-4, wd = (dd - t * 0.42) / 0.045;
    float ring = exp(-wd * wd) * (1.0 - t) * uRain;
    vec2 tilt = dv / dd * ring * 0.5 + (nz.rg - 0.5) * 0.03;
    vec3 Np = normalize(vec3(tilt.x, 1.0, tilt.y));
#else
    vec3 Np = vec3(0.0, 1.0, 0.0);
#endif
    vec3 Rp = reflect(-V, Np);
    float fp = 0.02 + 0.98 * pow(1.0 - max(dot(Np, V), 0.0), 5.0);
    vec3 Hk = normalize(uKeyDir + V);
    float nh = max(dot(Np, Hk), 0.0);
    vec3 dP = uPtPos - vPos;
    float nP = max(dot(Np, normalize(normalize(dP) + V)), 0.0), aP = 1.0 / (1.0 + dot(dP, dP));
    vec3 water = under + hemi(Rp) * (0.12 + 0.88 * fp) * (1.0 + 1.5 * max(Rp.y, 0.0))
               + uKeyCol * (pow(nh, 420.0) * 3.0 + pow(nh, 36.0) * 0.12)
               + uPtCol * aP * (pow(nP, 260.0) * 5.0 + pow(nP, 24.0) * 0.18);
    col = mix(col, water, pool);
  }
  col += glow;
  gl_FragColor = vec4(finish(col, vPos), alpha);
#endif
}`;
}
