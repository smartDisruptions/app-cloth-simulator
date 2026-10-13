// Dye: ink that blooms along the weave, faster on wet cloth, drying to a darker tide line.
//
// A CPU simulation in cloth-uv space at world.q.dyeRes², uploaded to world.gpu.dyeTex. Each texel holds
//   W        ink liquid (1 ≈ a texel soaked by a drop), and
//   Ar,Ag,Ab the pigment as optical density (absorbance) per channel, in linear light.
// Liquid flows between neighbouring texels by capillarity: along the threads (u, v) fastest, weakly across
// them (diagonals), each row and column of texels a thread with its own wicking strength over a blotchy
// fibre field, so a blot feathers and never comes out a perfect circle. Part of the liquid is bound in dry
// fibre and stops moving, so a blot grows to a size set by its volume and stops; on rain-wet cloth little
// is bound and the ink runs further, faster. Pigment rides the liquid but lags into dry fibre (a pale
// water halo leads the colour). The front dries fastest, so liquid keeps flowing out to it and leaves its
// pigment there: the darker tide line of real dye. Wet ink reads darker than dry.
// Colours mix subtractively: densities add, so transmittance multiplies (Beer–Lambert).
//
// Cost follows the ink, not the texture: each step visits only texels holding liquid (and, on rain-wet
// cloth, pigment), each edge once, and re-encodes and uploads only what changed.
//
// Texture contract (gpu.dyeTex, RGBA8, linear filtered, uv space, row 0 = v 0; null until the first drop):
//   a   = ink amount, 1 − min(T) (0 = no ink)       rgb = the ink's own colour C, gamma-2 encoded (sqrt)
//   with T = 1 − a·(1 − C) the dye layer's transmittance. Correct shading: base_lin *= mix(1, C, a)
//   where C = rgb² — i.e. mix(base, base * toLinear(dye.rgb), dye.a). Undyed texels are (1,1,1,0).
import { DYES } from '../core/world.js';
import { texture, UNIT } from '../render/gl.js';

// optical density of each dye at concentration 1: a drop on white cloth shows exactly its DYES colour
const ABS = new Float32Array(DYES.length * 3);
for (let i = 0; i < DYES.length; i++) for (let c = 0; c < 3; c++) ABS[i * 3 + c] = -Math.log(Math.max(0.025, DYES[i].rgb[c] * DYES[i].rgb[c]));

const DROP_M = 0.012;     // radius of a fresh drop, m (it lands small and blooms)
const INK = 6.0;          // liquid at the centre of a fresh drop (1 = a soaked texel)
const CONC = 30;          // pigment at the centre of a fresh drop: it lands dense and dark, then blooms
const D_M = 0.0009;       // capillary diffusivity of the liquid on dry cloth, m²/s
const ALONG_V = 0.85;     // the weft (v) wicks a little slower than the warp (u)
const DIAG = 0.22;        // coupling across the threads (diagonal neighbours), relative
// explicit-step stability: a texel's couplings must sum to ≤ ½ (4 axis + 4 diagonal edges)
const KMAX = 0.1, KMAX_D = 0.025;
const BOUND = 0.14;       // liquid held by dry fibres (doesn't move): sets how far a blot spreads
const WET_BOOST = 3.0;    // rain-wet cloth: liquid moves up to (1 + this)× faster ...
const WET_UNBIND = 0.8;   // ... and this much less of it is held by the fibres
const KP = 0.1;           // pigment diffusion inside the liquid (relative to the liquid's)
const KP_WET = 0.015;     // pigment bleeding through rain-soaked cloth (no ink liquid needed)
const EVAP = 0.03;        // 1/s ink liquid drying
const EDGE_EVAP = 6.0;    // the wet front dries this much faster: liquid flows out to it → tide line
const LAG = 0.55;         // share of its pigment the liquid carries into DRY fibre (a pale halo leads)
const LIQ_MIN = 0.002;    // below this a texel's liquid is gone
const PIG_MIN = 0.002;    // below this a texel holds no pigment worth moving
const CW_MIN = 0.03;      // rain-wetness below this doesn't move pigment
const BLEED_MIN = 0.25;   // dried ink bleeds on only where the cloth is properly soaked

let R = 0, NR = 0, SH = 6;
let Wl, Ar, Ag, Ab, dW, dR, dG, dB, kR, kD, kX, kY, bind;
let piece, edge, texV, wrapOf;
let liq, nLiq = 0, pig, nPig = 0, act, nAct = 0, touch, nTouch = 0;
let actMark, touchMark, pigMark, mark = 1;
let pix, scratch, pix32, scratch32;
let tex = null, glx = null, gl = null, wetArr = null;
let texPerM = 30;
let hasInk = false, liquid = 0;
let ux0 = 1, uy0 = 1, ux1 = 0, uy1 = 0;       // dirty rectangle: needs upload (x0 > x1 = clean)
let stepAcc = 0, frame = 0, lastDrop = -1;
let tubeWide = false;                          // a tube piece spans the texture's width: u wraps
const EXPN = 2048, EXPMAX = 16;
const EXP = new Float32Array(EXPN + 1);
for (let i = 0; i <= EXPN; i++) EXP[i] = Math.exp(-(i / EXPN) * EXPMAX);

export function init(world) { glx = world.glx; gl = world.gl; }

function alloc(res) {
  R = res; NR = res * res; SH = Math.round(Math.log2(res));
  Wl = new Float32Array(NR); Ar = new Float32Array(NR); Ag = new Float32Array(NR); Ab = new Float32Array(NR);
  dW = new Float32Array(NR); dR = new Float32Array(NR); dG = new Float32Array(NR); dB = new Float32Array(NR);
  kR = new Float32Array(NR); kD = new Float32Array(NR); kX = new Float32Array(NR); kY = new Float32Array(NR);
  bind = new Float32Array(NR);
  piece = new Uint8Array(NR); edge = new Uint8Array(NR); texV = new Int32Array(NR); wrapOf = new Int32Array(NR);
  liq = new Int32Array(NR); pig = new Int32Array(NR); act = new Int32Array(NR); touch = new Int32Array(NR);
  actMark = new Int32Array(NR); touchMark = new Int32Array(NR); pigMark = new Uint8Array(NR);
  pix = new Uint8Array(NR * 4); scratch = new Uint8Array(NR * 4);
  pix32 = new Uint32Array(pix.buffer); scratch32 = new Uint32Array(scratch.buffer);
  if (tex && gl) { gl.deleteTexture(tex); tex = null; }
}

/**
 * The weave, as numbers. Each row of texels is a weft thread and each column a warp thread with its own
 * wicking strength (a few strong ones carry ink far: feathering along the threads), over a smooth blotchy
 * field (uneven fabric), plus a per-texel fibre density that decides where a spreading front stalls.
 * Deterministic and independent of the global rng (so dye never shifts anyone else's random sequence).
 */
function weave(blot, rowT, colT, bnd) {
  let s = 0x2f6b5a1d;
  const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const L = 12, lat = new Float32Array(L * L);
  for (let i = 0; i < L * L; i++) lat[i] = rnd();
  for (let i = 0; i < R; i++) { const a = rnd(), b = rnd(); rowT[i] = a * a; colT[i] = b * b; }
  for (let y = 0; y < R; y++) for (let x = 0; x < R; x++) {
    const fx = (x / R) * L, fy = (y / R) * L, ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = lat[(iy % L) * L + (ix % L)], b = lat[(iy % L) * L + ((ix + 1) % L)];
    const c = lat[((iy + 1) % L) * L + (ix % L)], d = lat[((iy + 1) % L) * L + ((ix + 1) % L)];
    const t = y * R + x;
    blot[t] = a + (b - a) * sx + (c - a + (a - b - c + d) * sx) * sy;
    bnd[t] = 0.6 + 0.8 * (0.5 * rnd() + 0.25 * rowT[y] + 0.25 * colT[x]);
  }
}

export function onScene(world) {
  const res = world.q.dyeRes || 64;
  if (res !== R) alloc(res);
  else { Wl.fill(0); Ar.fill(0); Ag.fill(0); Ab.fill(0); dW.fill(0); dR.fill(0); dG.fill(0); dB.fill(0); edge.fill(0); pigMark.fill(0); }
  const cl = world.cloth;
  wetArr = cl.wet;
  piece.fill(255); texV.fill(-1); wrapOf.fill(-1); kR.fill(0); kD.fill(0); kX.fill(0); kY.fill(0);
  pix32.fill(0x00ffffff);                      // white, no ink (little-endian RGBA = 255,255,255,0)
  // which texel belongs to which piece, and which vertex wets it
  tubeWide = false;
  for (let p = 0; p < cl.pieces.length; p++) {
    const P = cl.pieces[p], [u0, v0, u1, v1] = P.uv;
    const tx0 = Math.max(0, Math.ceil(u0 * R - 0.5)), tx1 = Math.min(R - 1, Math.floor(u1 * R - 0.5 - 1e-6));
    const ty0 = Math.max(0, Math.ceil(v0 * R - 0.5)), ty1 = Math.min(R - 1, Math.floor(v1 * R - 0.5 - 1e-6));
    const cols = P.cols, rows = P.rows, du = u1 - u0 || 1, dv = v1 - v0 || 1;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = ty * R + tx;
      piece[t] = P.index;
      const c = Math.min(cols - 1, Math.max(0, Math.round((((tx + 0.5) / R - u0) / du) * (cols - 1))));
      const r = Math.min(rows - 1, Math.max(0, Math.round((((ty + 0.5) / R - v0) / dv) * (rows - 1))));
      let v = P.id(c, r); if (cl.alias[v] >= 0) v = cl.alias[v];
      texV[t] = v;
    }
    // a tube wraps in u: its last column touches its first
    if (P.type === 'tube' && tx1 > tx0) {
      for (let ty = ty0; ty <= ty1; ty++) { wrapOf[ty * R + tx1] = ty * R + tx0; wrapOf[ty * R + tx0] = ty * R + tx1; }
      if (tx0 === 0 && tx1 === R - 1) tubeWide = true;
    }
  }
  // the physical size of a texel: metres per uv along intact threads (seams excluded)
  let sm = 0, su = 0;
  for (let j = 0; j < cl.m; j++) {
    if (cl.kind[j] !== 0) continue;
    const a = cl.cA[j], b = cl.cB[j];
    const du = cl.uv[a * 2] - cl.uv[b * 2], dv = cl.uv[a * 2 + 1] - cl.uv[b * 2 + 1], d = Math.hypot(du, dv);
    if (d > 1e-6 && d < 0.3) { sm += cl.rest[j]; su += d; }
  }
  texPerM = su > 0 ? R / (sm / su) : 30;
  // couplings: capillary rate per texel edge (1/s) along its thread, zero across pieces
  const blot = dW, rowT = dR, colT = dG;       // scratch (cleared below)
  weave(blot, rowT, colT, bind);
  const D = D_M * texPerM * texPerM;
  // individual threads only show when a texel is finer than a thread or so: fade their contrast at low res
  const tc = R >= 128 ? 1 : R / 128, t0 = 1 - tc;
  for (let ty = 0; ty < R; ty++) for (let tx = 0; tx < R; tx++) {
    const t = ty * R + tx, p = piece[t]; if (p === 255) continue;
    if (tx + 1 < R && piece[t + 1] === p) kR[t] = D * (t0 + tc * (0.2 + 2.0 * rowT[ty])) * (0.6 + 0.4 * (blot[t] + blot[t + 1]));
    if (ty + 1 < R && piece[t + R] === p) kD[t] = D * ALONG_V * (t0 + tc * (0.2 + 2.0 * colT[tx])) * (0.6 + 0.4 * (blot[t] + blot[t + R]));
    // diagonals: weak (across the threads), they round the blot without losing the weave's bias
    if (ty + 1 < R && tx + 1 < R && piece[t + R + 1] === p) kX[t] = D * DIAG * (0.6 + 0.4 * (blot[t] + blot[t + R + 1]));
    if (ty + 1 < R && tx > 0 && piece[t + R - 1] === p) kY[t] = D * DIAG * (0.6 + 0.4 * (blot[t] + blot[t + R - 1]));
  }
  // (a tube's seam edge reuses its first column's along-the-row coupling: see step())
  dW.fill(0); dR.fill(0); dG.fill(0);
  nLiq = 0; nPig = 0; nAct = 0; nTouch = 0;
  hasInk = false; liquid = 0; stepAcc = 0; frame = 0; lastDrop = -1;
  // a texture kept from the last scene still shows its ink: the first upload after the next drop sends
  // the whole cleared image
  if (tex) { ux0 = 0; uy0 = 0; ux1 = R - 1; uy1 = R - 1; } else { ux0 = uy0 = 1; ux1 = uy1 = 0; }
  world.gpu.dyeTex = null;
}

function ensureTexture() {
  if (tex || !glx) return;
  tex = texture(glx, { w: R, h: R, data: pix, filter: 'linear', wrap: 'clamp' });
}

/** An ink drop of colour index `c` (core/world.js DYES) at vertex v. Returns true when it landed. */
export function drop(world, v, c) {
  const cl = world.cloth; if (!cl || !R || v < 0 || v >= cl.n) return false;
  if (cl.alias[v] >= 0) v = cl.alias[v];
  if (!cl.vTri[v]) return false;
  const ci = (c | 0) >= 0 && (c | 0) < DYES.length ? c | 0 : 0;
  const pi = cl.piece[v];
  const cx = cl.uv[v * 2] * R - 0.5, cy = cl.uv[v * 2 + 1] * R - 0.5;
  // a quick stroke of the dye tool lays thinner ink than a deliberate drop
  const now = world.realTime;
  const amt = lastDrop >= 0 && now - lastDrop < 0.09 ? 0.4 : 1;
  lastDrop = now;
  let rb = DROP_M * texPerM; rb = rb < 0.6 ? 0.6 : rb > 7 ? 7 : rb;
  const reach = Math.ceil(rb * 2.2), ir2 = 1 / (rb * rb);
  const a0 = ABS[ci * 3] * CONC * amt, a1 = ABS[ci * 3 + 1] * CONC * amt, a2 = ABS[ci * 3 + 2] * CONC * amt;
  const rx = Math.round(cx), ry = Math.round(cy);
  let any = false;
  for (let dy = -reach; dy <= reach; dy++) {
    const ty = ry + dy; if (ty < 0 || ty >= R) continue;
    for (let dx = -reach; dx <= reach; dx++) {
      let tx = rx + dx;
      if (tubeWide) tx = (tx + R) % R; else if (tx < 0 || tx >= R) continue;
      const t = ty * R + tx; if (piece[t] !== pi) continue;
      const ex = rx + dx - cx, ey = ty - cy, q = (ex * ex + ey * ey) * ir2;
      if (q > 4.8) continue;
      const w = Math.exp(-q);
      if (Wl[t] <= 0) liq[nLiq++] = t;                 // newly wet: joins the active list
      Wl[t] += INK * amt * w; Ar[t] += a0 * w; Ag[t] += a1 * w; Ab[t] += a2 * w;
      liquid += INK * amt * w;
      if (!pigMark[t]) { pigMark[t] = 1; pig[nPig++] = t; }
      dirty(tx, ty);
      encode(t);
      any = true;
    }
  }
  if (!any) return false;
  ensureTexture();
  hasInk = true;
  world.gpu.dyeTex = tex;
  const o = v * 3;
  world.events.dye.push(cl.pos[o], cl.pos[o + 1], cl.pos[o + 2], ci);
  return true;
}

function dirty(tx, ty) {
  if (ux0 > ux1) { ux0 = ux1 = tx; uy0 = uy1 = ty; return; }
  if (tx < ux0) ux0 = tx; else if (tx > ux1) ux1 = tx;
  if (ty < uy0) uy0 = ty; else if (ty > uy1) uy1 = ty;
}

export function update(world, dt) {
  if (!hasInk || !R) return;
  const cl = world.cloth; if (!cl) return;
  wetArr = cl.wet;
  frame++;
  if (dt > 0) stepAcc += dt;
  const wetCloth = world.stats.wetness > 0.01;
  const flowing = nLiq > 0;
  // cadence: ink liquid moves every other frame; pigment bleeding through rain-soaked cloth every 8th
  const every = flowing ? 2 : 8;
  if ((flowing || wetCloth) && stepAcc > 0 && frame % every === 0) {
    step(Math.min(stepAcc, 0.1), wetCloth);
    stepAcc = 0;
  } else if (!flowing && !wetCloth) stepAcc = 0;
  // upload what changed, at most every other frame while it is moving
  if (ux0 <= ux1 && (frame % 2 === 0 || !flowing)) upload();
}

function step(h, wetCloth) {
  mark++;
  if (mark > 2e9) { mark = 1; actMark.fill(0); touchMark.fill(0); }
  // ---- who moves: every texel with liquid, and on rain-wet cloth every texel with pigment
  nAct = 0;
  for (let i = 0; i < nLiq; i++) { const t = liq[i]; if (actMark[t] !== mark) { actMark[t] = mark; act[nAct++] = t; } }
  if (wetCloth) for (let i = 0; i < nPig; i++) {
    const t = pig[i]; if (actMark[t] === mark) continue;
    const v = texV[t]; if (v < 0 || wetArr[v] < BLEED_MIN) continue;
    actMark[t] = mark; act[nAct++] = t;
  }
  nTouch = 0;
  // ---- each edge once: from an active texel to an inactive neighbour, or to an active one of higher index
  const RM = R - 1, wc = wetCloth;
  for (let i = 0; i < nAct; i++) {
    const t = act[i], tx = t & RM, ty = t >> SH;
    let n, k;
    if (tx < RM) { n = t + 1; k = kR[t]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX, wc); }
    if (tx > 0) { n = t - 1; k = kR[n]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX, wc); }
    if (ty < RM) {
      n = t + R; k = kD[t]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX, wc);
      if (tx < RM) { n = t + R + 1; k = kX[t]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX_D, wc); }
      if (tx > 0) { n = t + R - 1; k = kY[t]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX_D, wc); }
    }
    if (ty > 0) {
      n = t - R; k = kD[n]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX, wc);
      if (tx > 0) { n = t - R - 1; k = kX[n]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX_D, wc); }
      if (tx < RM) { n = t - R + 1; k = kY[n]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX_D, wc); }
    }
    n = wrapOf[t];
    if (n >= 0) { k = kR[t > n ? n : t]; if (k > 0 && (actMark[n] !== mark || n > t)) flux(t, n, k, h, KMAX, wc); }
  }
  // ---- apply to everything touched: dry, find who still holds liquid, re-encode
  nLiq = 0;
  let nl = 0;
  for (let i = 0; i < nTouch; i++) {
    const t = touch[i];
    let w = Wl[t] + dW[t], r = Ar[t] + dR[t], g = Ag[t] + dG[t], b = Ab[t] + dB[t];
    dW[t] = 0; dR[t] = 0; dG[t] = 0; dB[t] = 0;
    if (w > 0) {
      const v = texV[t], c = wc && v >= 0 ? wetArr[v] : 0;
      const ev = EVAP * (edge[t] ? EDGE_EVAP : 1) * (1 - 0.7 * c) * h;
      w = w > ev ? w - ev : 0;
      if (w < LIQ_MIN) w = 0;
    } else w = 0;
    edge[t] = 0;
    if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
    Wl[t] = w; Ar[t] = r; Ag[t] = g; Ab[t] = b;
    if (w > 0) { liq[nLiq++] = t; nl += w; }
    if (!pigMark[t] && r + g + b > PIG_MIN) { pigMark[t] = 1; pig[nPig++] = t; }
    encode(t);
    dirty(t & RM, t >> SH);
  }
  liquid = nl;
}

function touched(t) { if (touchMark[t] !== mark) { touchMark[t] = mark; touch[nTouch++] = t; } }

/** Liquid and pigment exchange across one texel edge (t, n), coupling k (1/s), over h seconds. */
function flux(t, n, k, h, kmax, wc) {
  const wt = Wl[t], wn = Wl[n];
  let c = 0;
  if (wc) { const vt = texV[t], vn = texV[n], ct = vt >= 0 ? wetArr[vt] : 0, cn = vn >= 0 ? wetArr[vn] : 0; c = ct > cn ? ct : cn; }
  if (wt <= 0 && wn <= 0 && c < CW_MIN) return;
  touched(t); touched(n);
  // the front: liquid next to dry fibre dries fastest (marks the wet texel for edge evaporation)
  if (wt > 0 && wn <= 0) edge[t] = 1; else if (wn > 0 && wt <= 0) edge[n] = 1;
  let kk = k * h * (1 + WET_BOOST * c); if (kk > kmax) kk = kmax;
  const bound = BOUND * (1 - WET_UNBIND * c), bt = bound * bind[t], bn = bound * bind[n];
  const et = wt > bt ? wt - bt : 0, en = wn > bn ? wn - bn : 0;
  const f = kk * (et - en);
  let pr = 0, pg = 0, pb = 0;
  // pigment rides the liquid, but dry fibres filter some out: the water front runs ahead of the colour
  if (f > 0) { const q = (f / wt) * (wn > 0 ? 1 : LAG); pr = Ar[t] * q; pg = Ag[t] * q; pb = Ab[t] * q; }
  else if (f < 0) { const q = (f / wn) * (wt > 0 ? 1 : LAG); pr = Ar[n] * q; pg = Ag[n] * q; pb = Ab[n] * q; }
  // pigment diffuses within the shared liquid, and bleeds slowly through rain-soaked cloth
  const kp = kk * (KP * (wt < wn ? wt : wn) + KP_WET * c * c);
  if (kp > 0) { pr += kp * (Ar[t] - Ar[n]); pg += kp * (Ag[t] - Ag[n]); pb += kp * (Ab[t] - Ab[n]); }
  dW[t] -= f; dW[n] += f;
  dR[t] -= pr; dR[n] += pr; dG[t] -= pg; dG[n] += pg; dB[t] -= pb; dB[n] += pb;
}

/** Pigment densities (+ liquid: wet ink reads darker) → the RGBA texel. */
function encode(t) {
  const r = Ar[t], g = Ag[t], b = Ab[t];
  if (r + g + b < 1e-3) { pix32[t] = 0x00ffffff; return; }
  const w = Wl[t], o = t * 4;
  const s = (EXPN / EXPMAX) * (1 + 0.45 * (w > 0.5 ? 1 : w * 2));
  const ir = r * s, ig = g * s, ib = b * s;
  const Tr = EXP[ir < EXPN ? ir | 0 : EXPN], Tg = EXP[ig < EXPN ? ig | 0 : EXPN], Tb = EXP[ib < EXPN ? ib | 0 : EXPN];
  const m = Tr < Tg ? (Tr < Tb ? Tr : Tb) : Tg < Tb ? Tg : Tb;
  const a = 1 - m;
  if (a < 0.004) { pix32[t] = 0x00ffffff; return; }
  const ia = 1 / a;
  const cr = 1 - (1 - Tr) * ia, cg = 1 - (1 - Tg) * ia, cb = 1 - (1 - Tb) * ia;
  pix[o] = (cr > 0 ? Math.sqrt(cr) : 0) * 255 + 0.5;
  pix[o + 1] = (cg > 0 ? Math.sqrt(cg) : 0) * 255 + 0.5;
  pix[o + 2] = (cb > 0 ? Math.sqrt(cb) : 0) * 255 + 0.5;
  pix[o + 3] = a * 255 + 0.5;
}

/** Upload the dirty rectangle (packed at the front of a scratch buffer: no per-frame allocation). */
function upload() {
  if (!tex || !gl) { ux0 = uy0 = 1; ux1 = uy1 = 0; return; }
  const w = ux1 - ux0 + 1, hgt = uy1 - uy0 + 1;
  const P = pix32, S = scratch32;
  for (let y = 0, d = 0; y < hgt; y++) {
    for (let s = (uy0 + y) * R + ux0, e = s + w; s < e; s++) S[d++] = P[s];
  }
  gl.activeTexture(gl.TEXTURE0 + UNIT.DYE);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, ux0, uy0, w, hgt, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
  ux0 = uy0 = 1; ux1 = uy1 = 0;
}

/** For tests and tools: the raw simulation state. */
export function debugState() { return { R, liquid, hasInk, texPerM, pix, Wl, Ar, Ag, Ab, piece, nLiq, nPig }; }
