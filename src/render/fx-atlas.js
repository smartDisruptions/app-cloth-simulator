// The particle sprite atlas: 4×4 cells of 128 px in one 512² RGBA texture, painted once at init in plain JS.
// No canvas, no text glyphs, no images and no randomness: every shape comes from a fixed integer hash, so
// every device paints the identical atlas.
//
// Channels, in every cell:
//   R  coverage / density (the fragment shader erodes it for smoke)
//   G  shading, or temperature for the glowing kinds (the shader maps it through a blackbody ramp)
//   B  a secondary mask: rim, core line, specular highlight, flame base, light from below
// Orientation: v → 1 is the sprite's "forward" end. particles.js points it along the motion for streaks
// and up for flames and puffs, so a flame's tip, a raindrop's head and a smoke puff's lit top sit at v = 1.

export const CELL = {
  DISC: 0, FLAME_A: 1, FLAME_B: 2, SMOKE_A: 3, SMOKE_B: 4, SMOKE_C: 5, EMBER: 6, ASH: 7,
  PETAL: 8, DROP: 9, STREAK: 10, RING: 11, FIBER_A: 12, FIBER_B: 13, BEAM: 14, BOKEH: 15,
};
export const ATLAS_SIZE = 512;
const CS = 128; // cell size, px
const GRID = 4;

// ---------------------------------------------------------------- deterministic noise
function hash(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// a 256² lattice of hash values, so value noise is four table reads instead of four hashes (boot time)
const LAT = new Float32Array(65536);
for (let i = 0; i < 65536; i++) LAT[i] = hash(i & 255, i >> 8, 977);
/** Value noise in [0, 1]; s picks a different region of the lattice. */
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const x0 = (ix + s * 61) & 255, x1 = (x0 + 1) & 255, yy = (iy + s * 37) & 255, y0 = yy << 8, y1 = ((yy + 1) & 255) << 8;
  const a = LAT[y0 + x0], b = LAT[y0 + x1], c = LAT[y1 + x0], d = LAT[y1 + x1];
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, s, oct = 4) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let o = 0; o < oct; o++) { v += a * vnoise(x * f, y * f, s + o * 31); n += a; a *= 0.5; f *= 2.03; }
  return v / n;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- cell painters
// Each painter fills `f` (CS×CS×3 floats, rows of v, columns of u) with R, G, B in 0..1.
// X = u·2 − 1 runs across the sprite, t = v runs from its back (0) to its forward end (1).
// Mipmaps average every channel, so a shading channel (G) must stay at a sensible value OUTSIDE the
// shape too: if it fell to 0 there, a sprite seen small (a high mip) would shade itself dark.

function eachPixel(f, fn) {
  for (let y = 0; y < CS; y++) {
    const v = (y + 0.5) / CS;
    for (let x = 0; x < CS; x++) {
      const u = (x + 0.5) / CS, o = (y * CS + x) * 3;
      fn(u, v, o);
    }
  }
}

/** Soft round glow with a hot core: sparks, motes, splash droplets, the trail's head glint. */
function paintDisc(f) {
  const e = Math.exp(-3.4);
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, r2 = X * X + Y * Y;
    f[o] = Math.max(0, (Math.exp(-3.4 * r2) - e) / (1 - e));
    f[o + 1] = 0.6 + 0.4 * Math.exp(-r2 * 6); // broad: a speck seen small (high mip) must not darken
    f[o + 2] = Math.exp(-r2 * 30);
  });
}

/**
 * A flame tongue: a teardrop that is widest a third of the way up, with noise-licked edges, a ragged tip
 * that breaks into pockets, a hot core low in the body (G = temperature) and a base mask (B) for the
 * thin blue skirt real flames have where the fuel meets the air.
 */
function paintFlame(f, seed, { bend = 0, fork = 0, width = 0.9 } = {}) {
  const A = 0.38, B = 1.25; // width profile t^A (1−t)^B: widest low, a long licking taper to the tip
  const peak = Math.pow(A / (A + B), A) * Math.pow(B / (A + B), B);
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, tt = (v - 0.03) / 0.93;
    f[o] = f[o + 1] = f[o + 2] = 0;
    if (tt <= 0 || tt >= 1) return;
    const lick = fbm(u * 2.2 + seed * 0.37, v * 2.6 - seed * 0.11, seed, 4) - 0.5;
    const hw = (width * Math.pow(tt, A) * Math.pow(1 - tt, B)) / peak;
    const xc = bend * tt * tt + lick * 0.55 * tt * tt;
    let q = Math.abs(X - xc) / Math.max(hw, 1e-3);
    if (fork > 0) {
      // two tips: the upper part splits into a pair of narrower lobes
      const sp = fork * smooth(0.45, 0.95, tt);
      const q2 = Math.min(Math.abs(X - xc - sp), Math.abs(X - xc + sp)) / Math.max(hw * (1 - 0.45 * smooth(0.45, 0.95, tt)), 1e-3);
      q = Math.min(q, q2 + 0.25 * smooth(0.5, 0.8, tt) * (1 - smooth(0.85, 1, tt)));
    }
    if (q >= 1) return;
    const body = smooth(1.0, 0.3, q);
    // the tip thins out raggedly: noise eats the upper third, never a hole in the body
    const pocket = fbm(u * 3.6 + seed, v * 4.4 - seed * 0.7, seed + 7, 3);
    const top = tt < 0.62 ? 1 : smooth(0.0, 0.3, pocket + 0.12 - (tt - 0.62) * 0.9);
    const grain = 0.84 + 0.32 * (fbm(u * 7 + seed, v * 9, seed + 3, 3) - 0.5);
    const dens = body * smooth(0.0, 0.1, tt) * top * grain;
    const core = Math.exp(-((tt - 0.26) * (tt - 0.26)) / 0.07);
    f[o] = clamp01(dens * 1.15);
    f[o + 1] = clamp01((1 - Math.pow(q, 1.7)) * (0.28 + 0.72 * core) * (1 - 0.35 * smooth(0.6, 1, tt)));
    f[o + 2] = clamp01(smooth(0.3, 0.02, tt) * (1 - q * q));
  });
}

/**
 * A billowing puff: a soft union of blobs, broken up with fbm, then lit by marching through its own density
 * toward +v (G: light from above, the key) and toward −v (B: light from below, the fire).
 */
function paintSmoke(f, seed, wispy) {
  // a cluster of round billows (soft-edged discs, not gaussians, so each lobe reads), then cauliflower
  // detail: noise cuts into the boundary so the silhouette is lumpy, and modulates the inside
  const blobs = [];
  const nb = wispy ? 6 : 9;
  for (let b = 0; b < nb; b++) {
    const ang = hash(b, 1, seed) * Math.PI * 2, dist = (wispy ? 0.1 : 0.05) + 0.32 * Math.sqrt(hash(b, 2, seed));
    const r = 0.21 + (wispy ? 0.16 : 0.2) * hash(b, 3, seed);
    blobs.push(Math.cos(ang) * dist, Math.sin(ang) * dist * (wispy ? 0.7 : 0.92), r);
  }
  const dens = new Float32Array(CS * CS);
  let hi = 0;
  for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
    const u = (x + 0.5) / CS, v = (y + 0.5) / CS, X = u * 2 - 1, Y = v * 2 - 1;
    let field = 0;
    for (let b = 0; b < blobs.length; b += 3) {
      const dx = X - blobs[b], dy = Y - blobs[b + 1], rr = blobs[b + 2];
      const q = Math.sqrt(dx * dx + dy * dy) / rr;
      field = Math.max(field, 1 - q * q * 0.8) + 0.18 * Math.max(0, 1 - q);
    }
    const n = fbm(u * 5.5 + seed * 0.3, v * 5.5 - seed * 0.2, seed, 5);
    let d;
    if (wispy) {
      const w = fbm(u * 3.4 + seed, v * 1.5, seed + 2, 5);
      d = smooth(0.32, 0.85, field * 0.65 + w * 0.7 - 0.25) * (0.55 + 0.45 * n);
    } else {
      d = smooth(0.18, 0.62, field * (0.72 + 0.56 * (n - 0.5) * 1.6)) * (0.62 + 0.38 * n);
    }
    // fade out well inside the quad: the sprite is drawn at ±0.94 of the cell, and a puff that still
    // had density there would show the quad's straight edge
    const r = Math.sqrt(X * X + Y * Y);
    d *= smooth(0.88, 0.62, r);
    dens[y * CS + x] = d;
    if (d > hi) hi = d;
  }
  for (let i = 0; i < dens.length; i++) dens[i] /= hi || 1;
  // self-shadowing: march toward the light through the puff's own density. Tuned so the far side of a
  // dense puff keeps about a third of the light (smoke is never black inside, it scatters).
  const sigma = wispy ? 1.5 : 2.4, step = 2 / CS;
  for (let x = 0; x < CS; x++) {
    let acc = 0;
    for (let y = CS - 1; y >= 0; y--) { // light from +v (above): accumulate from the forward edge back
      const o = (y * CS + x) * 3, d = dens[y * CS + x];
      f[o] = d;
      f[o + 1] = 0.22 + 0.78 * Math.exp(-sigma * acc);
      acc += d * step;
    }
    acc = 0;
    for (let y = 0; y < CS; y++) {
      const o = (y * CS + x) * 3, d = dens[y * CS + x];
      f[o + 2] = 0.18 + 0.82 * Math.exp(-sigma * acc);
      acc += d * step;
    }
  }
}

/** An irregular flake (embers glow in the middle; ash is lacy with bright, curled edges). */
function paintFlake(f, seed, ash) {
  const N = 7, rad = [];
  for (let k = 0; k < N; k++) rad.push(0.5 + 0.38 * hash(k, 5, seed));
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, r = Math.sqrt(X * X + Y * Y);
    let a = Math.atan2(Y, X) / (Math.PI * 2); if (a < 0) a += 1;
    const s = a * N, i0 = Math.floor(s) % N, i1 = (i0 + 1) % N, fr = s - Math.floor(s);
    const re = rad[i0] + (rad[i1] - rad[i0]) * fr + 0.05 * (fbm(u * 6, v * 6, seed + 9, 2) - 0.5);
    const dd = re - r;
    const n = fbm(u * 5 + seed, v * 5, seed, 3);
    let cov = smooth(-0.02, 0.05, dd);
    if (ash) cov *= 0.35 + 0.65 * smooth(0.3, 0.42, n + 0.12 * smooth(0.0, 0.2, dd));
    f[o] = clamp01(cov * (0.85 + 0.3 * (n - 0.5)));
    const rim = 1 - smooth(0.0, 0.16, dd);
    f[o + 1] = ash ? clamp01(0.3 + 0.7 * rim + 0.2 * (n - 0.5)) : clamp01(0.4 + 0.6 * smooth(0.0, 0.42, dd));
    f[o + 2] = clamp01(rim * cov);
  });
}

/** A sakura petal: notched tip at v = 1, narrow base, faint veins, a bright rim for sheen. */
function paintPetal(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, tt = (v - 0.06) / 0.88;
    f[o] = f[o + 2] = 0;
    f[o + 1] = 0.66 + 0.34 * Math.pow(clamp01(tt), 0.7);
    if (tt <= 0 || tt >= 1) return;
    const hw = 0.8 * Math.pow(Math.sin(Math.PI * Math.pow(tt, 0.8)), 0.62) * (0.55 + 0.45 * tt);
    let dd = hw - Math.abs(X);
    // the notch: a V cut into the middle of the outer edge
    const nd = Math.abs(X) * 1.6 - (tt - 0.8) * 2.2;
    if (tt > 0.8) dd = Math.min(dd, nd * 0.5);
    dd = Math.min(dd, (1 - tt) * 0.9);
    if (dd <= -0.03) return;
    const cov = smooth(-0.02, 0.05, dd);
    const phi = Math.atan2(X, tt + 0.15);
    const vein = Math.pow(Math.abs(Math.sin(phi * 7.5)), 14) * smooth(0.1, 0.5, tt) * 0.12;
    f[o] = cov;
    f[o + 1] = clamp01(0.66 + 0.34 * Math.pow(tt, 0.7) - vein);
    f[o + 2] = clamp01((1 - smooth(0.0, 0.14, dd)) * cov);
  });
}

/** A glossy water drop: dark refracting rim, a caustic at the leading (lower) end, a specular glint behind. */
function paintDrop(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, r = Math.sqrt(X * X + Y * Y);
    const cov = smooth(0.84, 0.78, r);
    const caustic = Math.exp(-(X * X) / 0.12 - ((Y - 0.42) * (Y - 0.42)) / 0.03);
    f[o] = cov;
    f[o + 1] = clamp01(0.32 + 0.45 * Math.max(0, 1 - r * r) + 0.6 * caustic);
    const hx = X + 0.26, hy = Y + 0.36;
    f[o + 2] = clamp01((Math.exp(-(hx * hx + hy * hy) / 0.012) + 0.35 * Math.exp(-((X - 0.2) * (X - 0.2) + (Y - 0.05) * (Y - 0.05)) / 0.004)) * cov);
  });
}

/** A thin streak, tapered at both ends, with a brighter head (rain, wind lines). B is the hairline core. */
function paintStreak(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1;
    const taper = smooth(0.0, 0.42, v) * smooth(1.0, 0.82, v);
    f[o] = Math.exp(-X * X * 5) * taper * (1 - Math.pow(Math.abs(X), 8));
    f[o + 1] = 0.35 + 0.65 * smooth(0.25, 0.95, v);
    f[o + 2] = Math.exp(-X * X * 14) * taper;
  });
}

/** The crown ring of a splash, seen flat on the ground: a thin ring with a faint crown of spikes. */
function paintRing(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, r = Math.sqrt(X * X + Y * Y), a = Math.atan2(Y, X);
    const crown = 0.65 + 0.35 * Math.pow(Math.abs(Math.sin(a * 6.5 + 0.4)), 3);
    const ring = Math.exp(-((r - 0.74) * (r - 0.74)) / 0.0045) * crown;
    const fill = 0.1 * smooth(0.76, 0.5, r);
    f[o] = clamp01((ring + fill) * smooth(0.98, 0.9, r));
    f[o + 1] = 1;
    f[o + 2] = clamp01(ring * 0.9);
  });
}

/** A loose thread: distance to a polyline, thinning and fraying at the ends. */
function paintFiber(f, seed, pts) {
  // pts: control points in X,Y (−1..1); Catmull-Rom through them, sampled densely
  const P = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let s = 0; s < 16; s++) {
      const t = s / 16, t2 = t * t, t3 = t2 * t;
      const cx = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const cy = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      P.push(cx, cy);
    }
  }
  const last = pts[pts.length - 1]; P.push(last[0], last[1]);
  const segs = P.length / 2 - 1;
  // distance field by stamping: each segment only tests the pixels in its own (padded) box
  const best = new Float32Array(CS * CS).fill(1e9), bestT = new Float32Array(CS * CS);
  const pad = 0.16, toPx = (X) => ((X + 1) * 0.5 * CS) | 0;
  for (let k = 0; k < segs; k++) {
    const ax = P[k * 2], ay = P[k * 2 + 1], bx = P[k * 2 + 2], by = P[k * 2 + 3];
    const ex = bx - ax, ey = by - ay, ee = ex * ex + ey * ey || 1;
    const x0 = Math.max(0, toPx(Math.min(ax, bx) - pad)), x1 = Math.min(CS - 1, toPx(Math.max(ax, bx) + pad));
    const y0 = Math.max(0, toPx(Math.min(ay, by) - pad)), y1 = Math.min(CS - 1, toPx(Math.max(ay, by) + pad));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const X = ((x + 0.5) / CS) * 2 - 1, Y = ((y + 0.5) / CS) * 2 - 1;
      let t = ((X - ax) * ex + (Y - ay) * ey) / ee; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = X - ax - ex * t, dy = Y - ay - ey * t, d2 = dx * dx + dy * dy, i = y * CS + x;
      if (d2 < best[i]) { best[i] = d2; bestT[i] = (k + t) / segs; }
    }
  }
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, i = o / 3;
    const d = Math.sqrt(best[i]), bt = bestT[i];
    const w = 0.085 * (0.35 + 0.65 * Math.sin(Math.PI * clamp01(bt * 1.05)));
    const fray = bt > 0.82 ? 0.6 + 0.4 * vnoise(X * 40, Y * 40, seed) : 1;
    f[o] = d > 0.15 ? 0 : clamp01(smooth(w + 0.035, w - 0.015, d) * fray);
    f[o + 1] = clamp01(0.75 + 0.25 * Math.sin(bt * 23 + seed));
    f[o + 2] = 0;
  });
}

/** The katana trail's cross-section: a wide glow (G) around a hairline core (B), constant along v. */
function paintBeam(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, edge = 1 - Math.pow(Math.abs(X), 10);
    const glow = Math.exp(-X * X * 4.2) * edge, core = Math.exp(-X * X * 70);
    f[o] = Math.max(glow, core);
    f[o + 1] = glow;
    f[o + 2] = core;
  });
}

/** A lens bokeh disc: flat, soft-edged, with the slightly brighter rim real lenses give. */
function paintBokeh(f) {
  eachPixel(f, (u, v, o) => {
    const X = u * 2 - 1, Y = v * 2 - 1, r = Math.sqrt(X * X + Y * Y);
    const cov = smooth(0.86, 0.74, r);
    f[o] = cov;
    f[o + 1] = 0.8 + 0.2 * smooth(0.45, 0.78, r);
    f[o + 2] = smooth(0.55, 0.78, r) * cov;
  });
}

/** RGBA8 atlas data, ATLAS_SIZE², row 0 = v 0. `times` (optional, tests) collects ms per cell. */
export function makeAtlas(times) {
  const out = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  const f = new Float32Array(CS * CS * 3);
  let t0 = times ? performance.now() : 0;
  const put = (cell) => {
    if (times) { const t1 = performance.now(); times[cell] = t1 - t0; t0 = t1; }
    const cx = (cell % GRID) * CS, cy = Math.floor(cell / GRID) * CS;
    for (let y = 0; y < CS; y++) for (let x = 0; x < CS; x++) {
      // keep a clean 2 px border so mipmaps never bleed one sprite into the next
      const edge = x < 2 || y < 2 || x >= CS - 2 || y >= CS - 2;
      const i = (y * CS + x) * 3, o = ((cy + y) * ATLAS_SIZE + cx + x) * 4;
      out[o] = edge ? 0 : Math.round(clamp01(f[i]) * 255);
      out[o + 1] = Math.round(clamp01(f[i + 1]) * 255);
      out[o + 2] = edge ? 0 : Math.round(clamp01(f[i + 2]) * 255);
      out[o + 3] = 255;
    }
    f.fill(0);
  };
  paintDisc(f); put(CELL.DISC);
  paintFlame(f, 11, { bend: 0.12, width: 0.78 }); put(CELL.FLAME_A);
  paintFlame(f, 23, { bend: -0.16, fork: 0.26, width: 0.7 }); put(CELL.FLAME_B);
  paintSmoke(f, 5, false); put(CELL.SMOKE_A);
  paintSmoke(f, 17, false); put(CELL.SMOKE_B);
  paintSmoke(f, 29, true); put(CELL.SMOKE_C);
  paintFlake(f, 41, false); put(CELL.EMBER);
  paintFlake(f, 43, true); put(CELL.ASH);
  paintPetal(f); put(CELL.PETAL);
  paintDrop(f); put(CELL.DROP);
  paintStreak(f); put(CELL.STREAK);
  paintRing(f); put(CELL.RING);
  paintFiber(f, 3, [[-0.78, -0.55], [-0.3, 0.1], [0.25, 0.35], [0.72, 0.6]]); put(CELL.FIBER_A);
  paintFiber(f, 9, [[-0.7, 0.62], [-0.2, 0.05], [0.12, 0.3], [0.38, -0.35], [0.76, -0.6]]); put(CELL.FIBER_B);
  paintBeam(f); put(CELL.BEAM);
  paintBokeh(f); put(CELL.BOKEH);
  return out;
}
