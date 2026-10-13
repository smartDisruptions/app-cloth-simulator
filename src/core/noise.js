// Noise for shaders (one tileable texture, built once at boot) and for JS (wind, flicker).
// Shaders sample the texture instead of hashing in ALU: cheaper on old GPUs and safe at mediump.
import { rand, seed } from './rng.js';

/** Tileable value noise: lattice of `period` cells over the texture, smooth-interpolated. */
function valueLayer(size, period, lattice) {
  const out = new Float32Array(size * size);
  for (let i = 0; i < period * period; i++) lattice[i] = rand();
  const cell = size / period;
  for (let y = 0; y < size; y++) {
    const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    const y0 = (iy % period) * period, y1 = ((iy + 1) % period) * period;
    for (let x = 0; x < size; x++) {
      const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const x0 = ix % period, x1 = (ix + 1) % period;
      const a = lattice[y0 + x0], b = lattice[y0 + x1], c = lattice[y1 + x0], d = lattice[y1 + x1];
      out[y * size + x] = (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
    }
  }
  return out;
}

function fbm(size, periods, weights) {
  const lattice = new Float32Array(256 * 256);
  const acc = new Float32Array(size * size);
  let wsum = 0;
  for (let o = 0; o < periods.length; o++) {
    const layer = valueLayer(size, periods[o], lattice);
    for (let i = 0; i < acc.length; i++) acc[i] += layer[i] * weights[o];
    wsum += weights[o];
  }
  for (let i = 0; i < acc.length; i++) acc[i] /= wsum;
  // stretch contrast around 0.5 so the full byte range is used
  let lo = 1, hi = 0;
  for (let i = 0; i < acc.length; i++) { if (acc[i] < lo) lo = acc[i]; if (acc[i] > hi) hi = acc[i]; }
  for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] - lo) / (hi - lo || 1);
  return acc;
}

/**
 * RGBA8 data, size×size, tileable in both axes.
 *   r: fbm value noise (periods 4..64)      g: an independent fbm (periods 8..128)
 *   b: fibres — fine noise stretched along x (thread-like streaks)    a: white noise
 */
export function makeNoiseData(size = 256) {
  seed(7331);
  const r = fbm(size, [4, 8, 16, 32, 64], [1, 0.5, 0.25, 0.125, 0.0625]);
  const g = fbm(size, [8, 16, 32, 64, 128], [1, 0.6, 0.35, 0.2, 0.1]);
  const lattice = new Float32Array(256 * 256);
  // fibres: average a fine layer along x
  const fine = valueLayer(size, 128, lattice);
  const b = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let s = 0; for (let k = -6; k <= 6; k++) s += fine[y * size + ((x + k + size) % size)];
    b[y * size + x] = s / 13;
  }
  let lo = 1, hi = 0; for (let i = 0; i < b.length; i++) { if (b[i] < lo) lo = b[i]; if (b[i] > hi) hi = b[i]; }
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = (r[i] * 255) | 0;
    out[i * 4 + 1] = (g[i] * 255) | 0;
    out[i * 4 + 2] = (((b[i] - lo) / (hi - lo || 1)) * 255) | 0;
    out[i * 4 + 3] = (rand() * 255) | 0;
  }
  return out;
}

// ---- JS value noise (wind, flicker). Allocation-free after module load. ----
const P = new Uint8Array(512);
const V = new Float32Array(256);
(() => { seed(4242); const p = new Uint8Array(256); for (let i = 0; i < 256; i++) { p[i] = i; V[i] = rand() * 2 - 1; } for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; seed(1); })();
const fade = (t) => t * t * (3 - 2 * t);

/** Smooth value noise in [-1, 1]. */
export function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const X = ix & 255, Y = iy & 255, Z = iz & 255;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const a = P[X] + Y, aa = P[a] + Z, ab = P[a + 1] + Z, b = P[X + 1] + Y, ba = P[b] + Z, bb = P[b + 1] + Z;
  const x1 = V[P[aa]] + (V[P[ba]] - V[P[aa]]) * u, x2 = V[P[ab]] + (V[P[bb]] - V[P[ab]]) * u;
  const x3 = V[P[aa + 1]] + (V[P[ba + 1]] - V[P[aa + 1]]) * u, x4 = V[P[ab + 1]] + (V[P[bb + 1]] - V[P[ab + 1]]) * u;
  const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
  return y1 + (y2 - y1) * w;
}

/** Two-octave noise in about [-1, 1]. */
export function fbm3(x, y, z) { return noise3(x, y, z) * 0.67 + noise3(x * 2.03 + 17.1, y * 2.03, z * 2.03) * 0.33; }
