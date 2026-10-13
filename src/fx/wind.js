// Wind: a field you can see sweep across the cloth.
//
// Three layers, all cheap to sample:
//  1. The mean wind: the scene's direction (scene.windDir), meandering a few degrees, at the toggle's
//     level (still · breeze · gale), eased so switching levels never snaps.
//  2. Gusts: discrete events with a sharp onset and a slow decay. Their envelope is recorded in a ring
//     buffer (30 samples per simulated second). sample() reads it DELAYED by the point's distance
//     downwind ÷ the convection speed, so a gust front arrives at the upwind edge first and visibly
//     travels across the cloth.
//  3. Turbulence: a static, tileable 16³ volume of smooth 3-D vector noise, carried downwind with the
//     flow (Taylor's frozen turbulence), so eddies sweep across the cloth instead of shimmering in place.
//
// sample(x, y, z, out) is one ring lookup + one trilinear lookup + a few multiplies (≈50 ns on the test
// container, cheaper than the old sin/cos baseline). Physics calls it per triangle, particles per particle.
// gustAt() adds a local puff of air (for a future swipe-to-gust gesture).
import { PK } from '../core/world.js';
import { rand } from '../core/rng.js';
import { fbm3 } from '../core/noise.js';
import { spawn } from '../render/particles.js';
import { updraft } from './fire.js'; // the fire's plume rides in the wind field (one compare when nothing burns)

/** Mean wind speed per toggle level, m/s (still air is never perfectly still). */
const LEVELS = [0.15, 2.8, 7.2];
/** Gust character per level: mean gap between gusts (s), envelope amplitude, attack and decay ranges (s),
 *  turbulence intensity (fraction of the mean speed; real gusty wind runs ~10–20%), and how far a gust
 *  veers the wind (radians). */
const GUSTS = [
  { gap: 6.0, amp: 0.4, att0: 0.6, att1: 1.2, dec0: 2.0, dec1: 4.0, turb: 0.3, veer: 0.2 },
  { gap: 3.4, amp: 0.8, att0: 0.22, att1: 0.5, dec0: 1.1, dec1: 2.8, turb: 0.2, veer: 0.15 },
  { gap: 1.8, amp: 0.5, att0: 0.14, att1: 0.34, dec0: 0.8, dec1: 2.1, turb: 0.15, veer: 0.08 },
];
const BASE = 0.76;           // the lull between gusts, as a fraction of the mean
const SHEAR = 0.1;           // wind grows ~10% per metre of height (a gentle boundary-layer profile)

// ---- turbulence volume: N³ lattice of 3-vectors, tileable ----
const N = 16, NM = N - 1, NN = N * N;
const KN = 2.6;              // lattice cells per metre → eddies of ~1.2–4 m, tile = N/KN ≈ 6.2 m
const TILE = N / KN;
const BIG = N * 256;         // keeps lattice coordinates positive for |0 truncation (multiple of N)
const VOL = new Float64Array(N * N * N * 3);

// ---- gust envelope ring ----
const RING_HZ = 30, RLEN = 256, RMASK = RLEN - 1;
const TAU_MAX = (RLEN - 8) / RING_HZ;
const ring = new Float64Array(RLEN);
let ringK = 0, ringT = 0;    // next slot to write, simulated time of the next sample

// ---- gust events (fixed pool) ----
const NG = 4;
const gStart = new Float64Array(NG), gAmp = new Float64Array(NG), gAtt = new Float64Array(NG), gDec = new Float64Array(NG), gVeer = new Float64Array(NG);
let nextGust = 0;

// ---- local air puffs (gustAt) ----
const NB = 4;
const bX = new Float64Array(NB), bY = new Float64Array(NB), bZ = new Float64Array(NB);
const bVX = new Float64Array(NB), bVY = new Float64Array(NB), bVZ = new Float64Array(NB);
const bR = new Float64Array(NB), bAge = new Float64Array(NB), bLife = new Float64Array(NB), bEnv = new Float64Array(NB);
let nBlobs = 0;

// ---- live state read by sample() (module scope: no property lookups in the hot path) ----
let dX = 1, dY = 0, dZ = 0;          // current wind direction (unit)
let lX = 0, lZ = 1;                  // lateral unit vector (horizontal, ⟂ wind)
let spd = 0;                          // eased mean speed (m/s)
let amp = 0.8, turbA = 0;            // gust amplitude, turbulence amplitude (m/s)
let refS = 0, invUc = 1;             // gust delay reference (upwind edge) and 1/convection speed
let head = 0;                         // newest ring index
let offX = 0, offY = 0, offZ = 0;    // turbulence advection offset (m), wrapped to the tile
let yRef = 1.5;                       // height where the shear factor is 1
let simT = 0;
let level = 1, levelEased = 1;
let W = null;

const baseDir = new Float64Array([1, 0, 0.12]);
const box = new Float64Array(6);     // cloth box at scene load: min xyz, max xyz
const tmp = new Float32Array(3);
let streakCarry = 0;

/** The gust envelope at simulated time t (sum of live gusts), and the veer it causes. */
let envVeer = 0;
function envelope(t) {
  let g = 0, v = 0;
  for (let k = 0; k < NG; k++) {
    const a = gAmp[k]; if (a <= 0) continue;
    const tau = t - gStart[k]; if (tau < 0) continue;
    let e;
    if (tau < gAtt[k]) { const x = tau / gAtt[k]; e = x * x * (3 - 2 * x); }
    else e = Math.exp(-(tau - gAtt[k]) / gDec[k]);
    e *= a; g += e; v += gVeer[k] * e;
  }
  envVeer = g > 0 ? v / (1 + g) : 0;
  return g > 1.6 ? 1.6 : g;
}

function scheduleGust(t, G) {
  let slot = 0, best = Infinity;
  for (let k = 0; k < NG; k++) {
    // a free or finished slot, else the oldest
    const done = gAmp[k] <= 0 || t - gStart[k] > gAtt[k] + gDec[k] * 6;
    const score = done ? -1 : gStart[k];
    if (score < best) { best = score; slot = k; }
  }
  const r = rand();
  gStart[slot] = t;
  gAmp[slot] = G.amp * (0.35 + 0.65 * r * r) * (rand() < 0.15 ? 1.45 : 1); // now and then a big one
  gAtt[slot] = G.att0 + (G.att1 - G.att0) * rand();
  gDec[slot] = G.dec0 + (G.dec1 - G.dec0) * rand();
  gVeer[slot] = (rand() * 2 - 1) * G.veer;
  // exponential gaps, never back to back
  nextGust = t + Math.max(0.45, -Math.log(1 - rand() * 0.98) * G.gap);
}

function buildVolume() {
  // Tileable smooth vector noise: a few random Fourier modes per component on integer wave vectors,
  // with a falling spectrum (big slow eddies dominate). Normalised to unit RMS per component.
  const MODES = 9;
  const kx = new Int8Array(MODES), ky = new Int8Array(MODES), kz = new Int8Array(MODES);
  const am = new Float64Array(MODES), ph = new Float64Array(MODES);
  const TWO_PI_N = (Math.PI * 2) / N;
  for (let c = 0; c < 3; c++) {
    for (let m = 0; m < MODES; m++) {
      let a, b, d, mag;
      do {
        a = Math.round((rand() * 2 - 1) * 4); b = Math.round((rand() * 2 - 1) * 3); d = Math.round((rand() * 2 - 1) * 4);
        mag = Math.hypot(a, b, d);
      } while (mag < 1.4 || mag > 4.6);
      kx[m] = a; ky[m] = b; kz[m] = d; am[m] = Math.pow(mag, -0.9); ph[m] = rand() * Math.PI * 2;
    }
    let ss = 0;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      let v = 0;
      for (let m = 0; m < MODES; m++) v += am[m] * Math.cos((kx[m] * x + ky[m] * y + kz[m] * z) * TWO_PI_N + ph[m]);
      VOL[((z * N + y) * N + x) * 3 + c] = v; ss += v * v;
    }
    const s = 1 / Math.sqrt(ss / (N * N * N) || 1);
    for (let i = c; i < VOL.length; i += 3) VOL[i] *= s;
  }
}

/**
 * The wind at a point (m/s) into out. Allocation-free; safe to call anywhere at any time.
 * Installed as world.wind.sample.
 */
function sample(x, y, z, out) {
  // 1) the gust front: how long ago did the gust now arriving here pass the upwind edge?
  let tau = (x * dX + z * dZ - refS) * invUc;
  tau = tau < 0 ? 0 : tau > TAU_MAX ? TAU_MAX : tau;
  const fi = head - tau * RING_HZ + RLEN * 4, i0 = fi | 0, fr = fi - i0;
  const r0 = ring[i0 & RMASK];
  const g = r0 + (ring[(i0 + 1) & RMASK] - r0) * fr;
  // 2) turbulence: frozen eddies carried downwind, trilinear from the tileable volume
  const px = (x - offX) * KN + BIG, py = (y - offY) * KN + BIG, pz = (z - offZ) * KN + BIG;
  const ix = px | 0, iy = py | 0, iz = pz | 0;
  const tx = px - ix, ty = py - iy, tz = pz - iz;
  const x0 = ix & NM, x1 = (ix + 1) & NM, y0 = (iy & NM) * N, y1 = ((iy + 1) & NM) * N, z0 = (iz & NM) * NN, z1 = ((iz + 1) & NM) * NN;
  const a = (z0 + y0 + x0) * 3, b = (z0 + y0 + x1) * 3, c = (z0 + y1 + x0) * 3, d = (z0 + y1 + x1) * 3;
  const e = (z1 + y0 + x0) * 3, f = (z1 + y0 + x1) * 3, h = (z1 + y1 + x0) * 3, j = (z1 + y1 + x1) * 3;
  const V = VOL;
  let l00 = V[a] + (V[b] - V[a]) * tx, l10 = V[c] + (V[d] - V[c]) * tx, l01 = V[e] + (V[f] - V[e]) * tx, l11 = V[h] + (V[j] - V[h]) * tx;
  let l0 = l00 + (l10 - l00) * ty, l1 = l01 + (l11 - l01) * ty;
  const n0 = l0 + (l1 - l0) * tz;
  l00 = V[a + 1] + (V[b + 1] - V[a + 1]) * tx; l10 = V[c + 1] + (V[d + 1] - V[c + 1]) * tx; l01 = V[e + 1] + (V[f + 1] - V[e + 1]) * tx; l11 = V[h + 1] + (V[j + 1] - V[h + 1]) * tx;
  l0 = l00 + (l10 - l00) * ty; l1 = l01 + (l11 - l01) * ty;
  const n1 = l0 + (l1 - l0) * tz;
  l00 = V[a + 2] + (V[b + 2] - V[a + 2]) * tx; l10 = V[c + 2] + (V[d + 2] - V[c + 2]) * tx; l01 = V[e + 2] + (V[f + 2] - V[e + 2]) * tx; l11 = V[h + 2] + (V[j + 2] - V[h + 2]) * tx;
  l0 = l00 + (l10 - l00) * ty; l1 = l01 + (l11 - l01) * ty;
  const n2 = l0 + (l1 - l0) * tz;
  // 3) compose in the wind's frame: gusty along-wind speed, crosswind and vertical eddies
  let hy = 1 + SHEAR * (y - yRef); hy = hy < 0.55 ? 0.55 : hy > 1.3 ? 1.3 : hy;
  const tg = turbA * (1 + 0.5 * g);
  const u = (spd * (BASE + amp * g) + tg * n0) * hy;
  const lat = tg * n1 * 0.8, ver = tg * n2 * 0.45;
  out[0] = dX * u + lX * lat;
  out[1] = dY * u + ver;
  out[2] = dZ * u + lZ * lat;
  if (nBlobs > 0) puffs(x, y, z, out);
  updraft(x, y, z, out);
  return out;
}

function puffs(x, y, z, out) {
  for (let k = 0; k < NB; k++) {
    const env = bEnv[k]; if (env <= 0) continue;
    const ex = x - bX[k], ey = y - bY[k], ez = z - bZ[k], r = bR[k];
    const q = (ex * ex + ey * ey + ez * ez) / (r * r);
    if (q >= 1) continue;
    const w = (1 - q) * (1 - q) * env;
    out[0] += bVX[k] * w; out[1] += bVY[k] * w; out[2] += bVZ[k] * w;
  }
}

/**
 * Push a local puff of air: centred at (x, y, z), blowing along (dx, dy, dz) (m/s, its length is the
 * speed), strength 0..1 scales the speed and size. It drifts with its own push and fades in ~0.9 s.
 * For a swipe-to-gust gesture: dx,dy,dz = the swipe's world-space velocity.
 */
export function gustAt(world, x, y, z, dx, dy, dz, strength = 1) {
  let k = 0, oldest = -1;
  for (let i = 0; i < NB; i++) { if (bEnv[i] <= 0) { k = i; oldest = Infinity; break; } if (bAge[i] > oldest) { oldest = bAge[i]; k = i; } }
  let s = strength < 0 ? 0 : strength > 1.5 ? 1.5 : strength;
  const sp = Math.hypot(dx, dy, dz); const cap = 14;
  const m = sp > cap ? cap / sp : 1;
  bX[k] = x; bY[k] = y; bZ[k] = z;
  bVX[k] = dx * m * s; bVY[k] = dy * m * s; bVZ[k] = dz * m * s;
  bR[k] = 0.35 + 0.35 * s; bAge[k] = 0; bLife[k] = 0.7 + 0.4 * s; bEnv[k] = 0.001;
  if (!(bVX[k] === bVX[k])) { bEnv[k] = 0; return; } // NaN guard
  nBlobs = 0; for (let i = 0; i < NB; i++) if (bEnv[i] > 0) nBlobs++;
  if (W) W.gust = Math.max(W.gust, 0.6 * s);
}

export function init(world) {
  W = world.wind;
  buildVolume();
  W.sample = sample;
  W.gustAt = (x, y, z, dx, dy, dz, s) => gustAt(world, x, y, z, dx, dy, dz, s);
  W.level = 0;      // [wind] eased base speed (m/s) before gusts
  W.dirX = 1; W.dirY = 0; W.dirZ = 0; // [wind] current mean direction (unit)
}

function readDir(world) {
  const d = (world.scene && world.scene.windDir) || null;
  let x = d ? d[0] : 1, y = d ? d[1] : 0, z = d ? d[2] : 0.12;
  const l = Math.hypot(x, y, z) || 1;
  baseDir[0] = x / l; baseDir[1] = y / l; baseDir[2] = z / l;
}

export function onScene(world) {
  readDir(world);
  const cl = world.cloth;
  // the cloth's box at load: gusts are timed from its upwind edge
  box[0] = box[1] = box[2] = Infinity; box[3] = box[4] = box[5] = -Infinity;
  if (cl) for (let i = 0; i < cl.n; i++) {
    const o = i * 3;
    for (let a = 0; a < 3; a++) { const v = cl.pos[o + a]; if (v < box[a]) box[a] = v; if (v > box[3 + a]) box[3 + a] = v; }
  }
  if (!(box[0] < Infinity)) { box[0] = box[1] = box[2] = -1; box[3] = box[4] = box[5] = 1; }
  yRef = (box[1] + box[4]) * 0.5;
  // A new scene starts in its own weather: the level snaps to the scene's (main.js has already applied
  // its default to toggles.wind), with no gust, puff or envelope carried over from the last scene. The
  // gust ring is empty and the first gust arrives a moment later, so the cloth starts in a lull.
  level = Math.max(0, Math.min(2, world.toggles.wind | 0));
  spd = levelEased = LEVELS[level];
  for (let k = 0; k < NG; k++) gAmp[k] = 0;
  for (let k = 0; k < NB; k++) bEnv[k] = 0;
  nBlobs = 0;
  ring.fill(0); ringK = 0; ringT = simT; head = 0;
  nextGust = simT + 0.6 + rand() * 1.2;
  streakCarry = 0;
  W.gust = 0;
  update(world, 0);
}

export function update(world, dt) {
  if (dt > 0) simT += dt;
  const t = simT;
  // ---- level: ease toward the toggle (faster up than down, like a front arriving)
  level = Math.max(0, Math.min(2, world.toggles.wind | 0));
  const target = LEVELS[level];
  const k = 1 - Math.exp(-dt * (target > levelEased ? 0.9 : 0.6));
  levelEased += (target - levelEased) * k;
  spd = levelEased;
  // interpolate gust character between the levels the eased speed lies between
  const G = GUSTS[spd > LEVELS[1] + 0.5 ? 2 : spd > LEVELS[0] + 0.3 ? 1 : 0];
  amp = G.amp; turbA = spd * G.turb;
  // ---- gust events
  if (dt > 0 && t >= nextGust) scheduleGust(t, G);
  // ---- record the envelope at 30 Hz of simulated time (a few samples per frame at most)
  let guard = 0;
  while (ringT <= t && guard++ < 12) {
    ring[ringK & RMASK] = envelope(ringT);
    ringK++; ringT += 1 / RING_HZ;
  }
  if (guard >= 12) ringT = t + 1 / RING_HZ; // after a long pause: resync instead of catching up
  head = ringK - 1;
  const gNow = envelope(t);
  // ---- direction: the scene's wind, meandering slowly, veering a little with each gust
  readDir(world);
  const meander = (level === 2 ? 0.07 : 0.14) * fbm3(t * 0.05, 11.7, 3.3) + envVeer;
  const cs = Math.cos(meander), sn = Math.sin(meander);
  const bx = baseDir[0], bz = baseDir[2];
  dX = bx * cs - bz * sn; dZ = bx * sn + bz * cs; dY = baseDir[1];
  const hl = Math.hypot(dX, dZ);
  if (hl > 1e-4) { lX = -dZ / hl; lZ = dX / hl; } else { lX = 1; lZ = 0; }
  // ---- gust delays are measured from the cloth box's upwind edge
  let s0 = Infinity;
  for (let c = 0; c < 4; c++) { const s = box[c & 1 ? 3 : 0] * dX + box[c & 2 ? 5 : 2] * dZ; if (s < s0) s0 = s; }
  refS = s0 - 0.25;
  const uc = Math.max(1.1, spd * (BASE + amp * gNow) * 0.9);
  invUc = 1 / uc;
  // ---- carry the eddies downwind (and drift them up a touch so they evolve), wrapped to the tile
  if (dt > 0) {
    offX += dX * uc * dt; offY += (dY * uc + 0.05 + 0.04 * uc) * dt; offZ += dZ * uc * dt;
    if (offX > TILE) offX -= TILE; else if (offX < -TILE) offX += TILE;
    if (offY > TILE) offY -= TILE; else if (offY < -TILE) offY += TILE;
    if (offZ > TILE) offZ -= TILE; else if (offZ < -TILE) offZ += TILE;
  }
  // ---- local puffs: drift along their push, grow, fade
  if (nBlobs > 0 && dt > 0) {
    nBlobs = 0;
    for (let b = 0; b < NB; b++) {
      if (bEnv[b] <= 0) continue;
      bAge[b] += dt;
      const a = bAge[b] / bLife[b];
      if (a >= 1) { bEnv[b] = 0; continue; }
      bEnv[b] = (a < 0.08 ? a / 0.08 : 1) * (1 - a) * (1 - a);
      bX[b] += bVX[b] * 0.3 * dt; bY[b] += bVY[b] * 0.3 * dt; bZ[b] += bVZ[b] * 0.3 * dt;
      bR[b] += 0.35 * dt;
      nBlobs++;
    }
  }
  // ---- publish the mean wind at the cloth's centre (audio, scenes, anyone who wants one number)
  const cx = (box[0] + box[3]) * 0.5, cy = yRef, cz = (box[2] + box[5]) * 0.5;
  let tc = (cx * dX + cz * dZ - refS) * invUc; tc = tc < 0 ? 0 : tc > TAU_MAX ? TAU_MAX : tc;
  const fi = head - tc * RING_HZ + RLEN * 4, i0 = fi | 0, fr = fi - i0;
  const gc = ring[i0 & RMASK] + (ring[(i0 + 1) & RMASK] - ring[i0 & RMASK]) * fr;
  const u = spd * (BASE + amp * gc);
  W.x = dX * u; W.y = dY * u; W.z = dZ * u; W.speed = Math.abs(u);
  W.gust = Math.min(1, Math.max(gc / 1.1, W.gust * Math.exp(-dt * 3)));
  W.level = spd; W.dirX = dX; W.dirY = dY; W.dirZ = dZ;
  // ---- visible wind: a few streaks riding the gusts, more of them when it blows harder
  if (dt > 0 && spd > 0.8) streaks(world, dt, gc, cx, cy, cz);
}

function streaks(world, dt, gc, cx, cy, cz) {
  const rate = (spd * 1.1 + 0.5) * (0.25 + gc) * world.q.particleScale;
  streakCarry += rate * dt;
  if (streakCarry > 4) streakCarry = 4;
  const hx = (box[3] - box[0]) * 0.5 + 0.7, hy = (box[4] - box[1]) * 0.5 + 0.35, hz = (box[5] - box[2]) * 0.5 + 0.5;
  while (streakCarry >= 1) {
    streakCarry -= 1;
    // anywhere around the cloth, biased upwind so the streak crosses it
    const x = cx + (rand() * 2 - 1) * hx - dX * 0.6, y = cy + (rand() * 2 - 1) * hy, z = cz + (rand() * 2 - 1) * hz - dZ * 0.6;
    sample(x, y, z, tmp);
    const ws = Math.hypot(tmp[0], tmp[1], tmp[2]);
    // ride the gusts: streaks are born where the air is moving faster than the mean
    if (ws < spd * (0.85 + 0.25 * rand())) continue;
    spawn(world, PK.STREAK, x, y, z, tmp[0], tmp[1], tmp[2], 0.006 + 0.004 * rand(), 0.55 + 0.6 * rand(), 0);
  }
}
