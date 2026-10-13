// Aerodynamics. Per triangle: drag along the relative wind, thin-plate LIFT (linear in the angle of
// attack, which is what makes a flag flutter and snap instead of just leaning), and a little skin
// friction. The wind field is sampled sparsely: at most 4×4×4 calls to world.wind.sample per frame on a
// lattice around the cloth, trilinearly spread to the particles, so the cost doesn't grow with the
// cloth or with how expensive the weather agent's wind is.
//
// Forces are computed once per frame and made unconditionally stable with a semi-implicit factor
// 1/(1 + λ·dt) (λ = the force's sensitivity to the particle's own speed, per unit mass): air can bring
// light silk up to the wind's speed in a gale but never past it, so nothing explodes.
//
// Tubes (the koinobori): wind flowing into the open mouth stops inside the body and becomes pressure
// (stagnation pressure ½ρu², u = the wind along the mouth's axis). It pushes every wall triangle out
// along its normal, strongest at the mouth and falling toward the open tail where the air escapes.
// No wind, no pressure: the carp hangs limp. A gust fills it.
// And it swims: a bluff body in a stream sheds vortices from alternate sides at the Strouhal frequency
// f = St·U/D (St ≈ 0.2), each pushing the body sideways, and the push travels down the body at about
// 0.6·U with the vortices. That travelling lateral wave (wavelength ≈ 3 mouth diameters, growing toward
// the free tail) is what makes a real carp streamer undulate; here it is, as a force.

import { K_DT } from './solver.js';

const HALF_RHO = 0.6;          // ½ ρ_air (kg/m³)
const SKIN = 0.035;            // skin-friction coefficient along the surface
const CP = 0.6;                // fraction of the stagnation pressure that builds up inside a tube
const ST = 0.2;                // Strouhal number of a bluff body
const CV = 0.16;               // vortex-shedding lateral force coefficient (of ½ρU²)
const LMAX = 4, CELL = 0.6;    // lattice: at most 4 samples per axis, ~0.6 m apart
const lat = new Float32Array(LMAX * LMAX * LMAX * 3);
const tmp = new Float32Array(3);
const pieceP = new Float32Array(256);
// per tube piece: shedding phase, wave number, dynamic pressure, lateral basis (e1, e2)
const piecePhase = new Float64Array(256), pieceK = new Float32Array(256), pieceQ = new Float32Array(256);
const pieceE = new Float32Array(256 * 6);
// the lattice frame: ox, oy, oz (origin) · sx, sy, sz (spacing) · nx, ny, nz (counts). A typed array, because a
// module-level `let` holding a double makes V8 box a new heap number on every write.
const LT = new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);

/** Sample world.wind on the lattice around the cloth's last bounds. */
function sampleLattice(world, cl) {
  const b = cl.bounds, wind = world.wind, M = 0.2;
  let x0 = b.min[0] - M, y0 = b.min[1] - M, z0 = b.min[2] - M, x1 = b.max[0] + M, y1 = b.max[1] + M, z1 = b.max[2] + M;
  // keep the lattice on the stage: a scrap blown far away must not stretch it thin over the cloth
  const rig = world.cameraRig;
  if (rig) {
    const t = rig.target, r = 1.5 * Math.max(rig.width || 2, rig.height || 2);
    if (x0 < t[0] - r) x0 = t[0] - r; if (x1 > t[0] + r) x1 = t[0] + r;
    if (y0 < t[1] - r) y0 = t[1] - r; if (y1 > t[1] + r) y1 = t[1] + r;
    if (z0 < t[2] - r) z0 = t[2] - r; if (z1 > t[2] + r) z1 = t[2] + r;
  }
  if (!(x1 > x0 && y1 > y0 && z1 > z0) || x1 - x0 > 1e4 || y1 - y0 > 1e4 || z1 - z0 > 1e4) { // first frame or degenerate
    x0 = y0 = z0 = -2; x1 = y1 = z1 = 4;
  }
  const nx = Math.min(LMAX, Math.max(2, Math.round((x1 - x0) / CELL) + 1));
  const ny = Math.min(LMAX, Math.max(2, Math.round((y1 - y0) / CELL) + 1));
  const nz = Math.min(LMAX, Math.max(2, Math.round((z1 - z0) / CELL) + 1));
  const sx = (x1 - x0) / (nx - 1), sy = (y1 - y0) / (ny - 1), sz = (z1 - z0) / (nz - 1);
  LT[0] = x0; LT[1] = y0; LT[2] = z0; LT[3] = sx; LT[4] = sy; LT[5] = sz; LT[6] = nx; LT[7] = ny; LT[8] = nz;
  for (let k = 0, o = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, o += 3) {
    tmp[0] = tmp[1] = tmp[2] = 0;
    wind.sample(x0 + i * sx, y0 + j * sy, z0 + k * sz, tmp);
    // a broken wind sample must never reach the solver
    lat[o] = tmp[0] === tmp[0] && Math.abs(tmp[0]) < 200 ? tmp[0] : 0;
    lat[o + 1] = tmp[1] === tmp[1] && Math.abs(tmp[1]) < 200 ? tmp[1] : 0;
    lat[o + 2] = tmp[2] === tmp[2] && Math.abs(tmp[2]) < 200 ? tmp[2] : 0;
  }
}

/** Trilinear wind at (x, y, z) from the lattice into out[o..o+2]. */
function windAt(x, y, z, out, o) {
  const ox = LT[0], oy = LT[1], oz = LT[2], sx = LT[3], sy = LT[4], sz = LT[5], nx = LT[6], ny = LT[7], nz = LT[8];
  let fx = (x - ox) / sx, fy = (y - oy) / sy, fz = (z - oz) / sz;
  fx = fx < 0 ? 0 : fx > nx - 1.001 ? nx - 1.001 : fx;
  fy = fy < 0 ? 0 : fy > ny - 1.001 ? ny - 1.001 : fy;
  fz = fz < 0 ? 0 : fz > nz - 1.001 ? nz - 1.001 : fz;
  const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
  const sxs = 3, sys = nx * 3, szs = nx * ny * 3;
  const b = k * szs + j * sys + i * sxs;
  for (let c = 0; c < 3; c++) {
    const p = b + c;
    const c00 = lat[p] + (lat[p + sxs] - lat[p]) * tx;
    const c10 = lat[p + sys] + (lat[p + sys + sxs] - lat[p + sys]) * tx;
    const c01 = lat[p + szs] + (lat[p + szs + sxs] - lat[p + szs]) * tx;
    const c11 = lat[p + szs + sys] + (lat[p + szs + sys + sxs] - lat[p + szs + sys]) * tx;
    const c0 = c00 + (c10 - c00) * ty, c1 = c01 + (c11 - c01) * ty;
    out[o + c] = c0 + (c1 - c0) * tz;
  }
}

/** Inflation pressure for each tube piece (Pa), from the wind along its mouth's axis. */
function tubePressure(world, cl, S) {
  const dt = S.k[K_DT];
  const P = S.P, pieces = cl.pieces, alias = cl.alias;
  let any = false;
  for (let pi = 0; pi < pieces.length && pi < 256; pi++) {
    const T = pieces[pi]; pieceP[pi] = 0; pieceQ[pi] = 0;
    if (T.type !== 'tube' || T.rows < 3) continue;
    const segs = T.cols - 1, r2 = Math.min(2, T.rows - 1);
    let mx = 0, my = 0, mz = 0, ax = 0, ay = 0, az = 0;
    for (let s = 0; s < segs; s++) {
      let i = T.start + s; if (alias[i] >= 0) i = alias[i];
      let k = T.start + r2 * T.cols + s; if (alias[k] >= 0) k = alias[k];
      mx += P[i * 3]; my += P[i * 3 + 1]; mz += P[i * 3 + 2];
      ax += P[k * 3]; ay += P[k * 3 + 1]; az += P[k * 3 + 2];
    }
    mx /= segs; my /= segs; mz /= segs; ax = ax / segs - mx; ay = ay / segs - my; az = az / segs - mz;
    const al = Math.sqrt(ax * ax + ay * ay + az * az); if (al < 1e-6) continue;
    tmp[0] = tmp[1] = tmp[2] = 0;
    world.wind.sample(mx, my, mz, tmp);
    const u = (tmp[0] * ax + tmp[1] * ay + tmp[2] * az) / al;   // wind flowing INTO the mouth
    if (!(u > 0 && u < 200)) continue;
    pieceP[pi] = HALF_RHO * CP * u * u; any = true;
    // vortex shedding: mouth diameter from ring 0, Strouhal frequency, convected wave
    let rr = 0;
    for (let s = 0; s < segs; s++) { let i = T.start + s; if (alias[i] >= 0) i = alias[i]; const dx = P[i * 3] - mx, dy = P[i * 3 + 1] - my, dz = P[i * 3 + 2] - mz; rr += Math.sqrt(dx * dx + dy * dy + dz * dz); }
    const D = Math.max(0.05, 2 * rr / segs), f = ST * u / D;
    piecePhase[pi] = (piecePhase[pi] + 6.283185307 * f * dt) % 6283.185307;
    const len = T.restLen || 1;
    pieceK[pi] = 6.283185307 * f / (0.6 * u) * len;          // phase lag per unit of body fraction
    pieceQ[pi] = HALF_RHO * u * u * CV;
    // lateral basis: e1 ⟂ axis and gravity (side to side), e2 ⟂ both (up and down)
    const ix = ax / al, iy = ay / al, iz = az / al;
    let e1x = iy * 0 - iz * 1, e1y = iz * 0 - ix * 0, e1z = ix * 1 - iy * 0; // axis × up
    let el = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z);
    if (el < 1e-3) { e1x = 1; e1y = 0; e1z = 0; el = 1; }
    e1x /= el; e1y /= el; e1z /= el;
    const e2x = e1y * iz - e1z * iy, e2y = e1z * ix - e1x * iz, e2z = e1x * iy - e1y * ix;
    const o = pi * 6;
    pieceE[o] = e1x; pieceE[o + 1] = e1y; pieceE[o + 2] = e1z; pieceE[o + 3] = e2x; pieceE[o + 4] = e2y; pieceE[o + 5] = e2z;
  }
  return any;
}

/**
 * This frame's air force on every particle into S.F (N), already stabilised.
 * Needs: S.W (inverse masses) for this frame, S.triN from the last normals pass, cl.bounds.
 */
export function aero(world, cl, S, mat) {
  const dt = S.k[K_DT];
  const f = S.F, K = S.aeroK, Wv = S.windV, v = S.V, w = S.W, p = S.P, n = cl.n, alias = cl.alias;
  f.fill(0);
  const Cd = mat.drag, Cl = mat.lift;
  if (!(Cd > 0 || Cl > 0)) return;
  K.fill(0);
  // the wind field evolves over tenths of a second: sample it every other frame (each sample() call
  // boxes its arguments in V8 unless it gets inlined, so fewer calls is also less garbage). Odd frames:
  // the low tier's self-collision runs on even ones, so the two never stack
  if ((world.frame & 1) === 1 || !S.latticeReady) { sampleLattice(world, cl); S.latticeReady = true; }
  // per-particle wind: trilinear from the lattice, unrolled
  const ox = LT[0], oy = LT[1], oz = LT[2], sx = LT[3], sy = LT[4], sz = LT[5], nx = LT[6], ny = LT[7];
  const nz = LT[8], isx = 1 / sx, isy = 1 / sy, isz = 1 / sz, hx = nx - 1.001, hy = ny - 1.001, hz = nz - 1.001;
  const SY = nx * 3, SZ = nx * ny * 3;
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    if (alias[i] >= 0) continue;
    let fx = (p[o] - ox) * isx, fy = (p[o + 1] - oy) * isy, fz = (p[o + 2] - oz) * isz;
    fx = fx < 0 ? 0 : fx > hx ? hx : fx; fy = fy < 0 ? 0 : fy > hy ? hy : fy; fz = fz < 0 ? 0 : fz > hz ? hz : fz;
    const ix = fx | 0, iy = fy | 0, iz = fz | 0, tx = fx - ix, ty = fy - iy, tz = fz - iz, ux = 1 - tx, uy = 1 - ty, uz = 1 - tz;
    const b = iz * SZ + iy * SY + ix * 3;
    const a00 = ux * uy * uz, a10 = tx * uy * uz, a01 = ux * ty * uz, a11 = tx * ty * uz;
    const b00 = ux * uy * tz, b10 = tx * uy * tz, b01 = ux * ty * tz, b11 = tx * ty * tz;
    const c0 = b, c1 = b + 3, c2 = b + SY, c3 = b + SY + 3, c4 = b + SZ, c5 = b + SZ + 3, c6 = b + SZ + SY, c7 = b + SZ + SY + 3;
    Wv[o] = a00 * lat[c0] + a10 * lat[c1] + a01 * lat[c2] + a11 * lat[c3] + b00 * lat[c4] + b10 * lat[c5] + b01 * lat[c6] + b11 * lat[c7];
    Wv[o + 1] = a00 * lat[c0 + 1] + a10 * lat[c1 + 1] + a01 * lat[c2 + 1] + a11 * lat[c3 + 1] + b00 * lat[c4 + 1] + b10 * lat[c5 + 1] + b01 * lat[c6 + 1] + b11 * lat[c7 + 1];
    Wv[o + 2] = a00 * lat[c0 + 2] + a10 * lat[c1 + 2] + a01 * lat[c2 + 2] + a11 * lat[c3 + 2] + b00 * lat[c4 + 2] + b10 * lat[c5 + 2] + b01 * lat[c6 + 2] + b11 * lat[c7 + 2];
  }
  const N = S.tN, A = S.tA, B = S.tB, C = S.tC, TN = S.triN;
  const third = 1 / 3, q0 = HALF_RHO * 0.5 * third, cdS = Cl - SKIN, clS = Cl + SKIN;
  for (let k = 0; k < N; k++) {
    const ia = A[k], ib = B[k], ic = C[k], a = ia * 3, b = ib * 3, c = ic * 3, t = k * 3;
    const nx0 = TN[t], ny0 = TN[t + 1], nz0 = TN[t + 2];
    const a2 = nx0 * nx0 + ny0 * ny0 + nz0 * nz0;
    if (a2 < 1e-14) continue;
    const A2 = Math.sqrt(a2), inv = 1 / A2;
    const qx = nx0 * inv, qy = ny0 * inv, qz = nz0 * inv;
    const rx = (Wv[a] + Wv[b] + Wv[c] - v[a] - v[b] - v[c]) * third;
    const ry = (Wv[a + 1] + Wv[b + 1] + Wv[c + 1] - v[a + 1] - v[b + 1] - v[c + 1]) * third;
    const rz = (Wv[a + 2] + Wv[b + 2] + Wv[c + 2] - v[a + 2] - v[b + 2] - v[c + 2]) * third;
    const v2 = rx * rx + ry * ry + rz * rz;
    if (v2 < 1e-8) continue;
    const vm = Math.sqrt(v2), vn = rx * qx + ry * qy + rz * qz, avn = vn < 0 ? -vn : vn;
    const q = q0 * A2;                                         // ½ρ · area, a third to each corner
    // drag along n̂ (pressure), lift ⟂ the flow (thin plate: ∝ sinα·cosα), skin friction along the surface
    const cn = q * (Cd * avn + cdS * vm) * vn;
    const cr = q * (SKIN * vm - Cl * vn * vn / vm);
    const Fx = cn * qx + cr * rx, Fy = cn * qy + cr * ry, Fz = cn * qz + cr * rz;
    f[a] += Fx; f[a + 1] += Fy; f[a + 2] += Fz;
    f[b] += Fx; f[b + 1] += Fy; f[b + 2] += Fz;
    f[c] += Fx; f[c + 1] += Fy; f[c + 2] += Fz;
    const kk = q * (Cd * avn + clS * vm);
    K[ia] += kk; K[ib] += kk; K[ic] += kk;
  }
  // semi-implicit: a particle's air force can at most carry it to the wind's speed in one frame
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const k = K[i] * w[i] * dt;
    if (k <= 0) continue;
    const s = 1 / (1 + k);
    f[o] *= s; f[o + 1] *= s; f[o + 2] *= s;
  }
  // tubes: inflation pressure along the outward normal (front = outside for tubes)
  if (S.hasTube && tubePressure(world, cl, S)) {
    const PR = S.tPress, PC = S.tPiece, RG = S.tRing;
    for (let k = 0; k < N; k++) {
      const pr = PR[k]; if (pr <= 0) continue;
      const pc = PC[k], P = pieceP[pc] * pr; if (P <= 0) continue;
      const s = P * 0.5 * third; // triN = 2·area·n̂ → area·n̂ = triN/2, a third to each corner
      let Fx = TN[k * 3] * s, Fy = TN[k * 3 + 1] * s, Fz = TN[k * 3 + 2] * s;
      // the shed vortices' travelling side push (elliptical: mostly side to side, some up and down)
      const tr = RG[k], ph = piecePhase[pc] - pieceK[pc] * tr;
      const amp = pieceQ[pc] * (0.2 + 0.8 * tr) * 0.5 * Math.sqrt(TN[k * 3] * TN[k * 3] + TN[k * 3 + 1] * TN[k * 3 + 1] + TN[k * 3 + 2] * TN[k * 3 + 2]) * third;
      const s1 = Math.sin(ph) * amp, s2 = Math.sin(ph + 1.3) * amp * 0.45, eo = pc * 6;
      Fx += pieceE[eo] * s1 + pieceE[eo + 3] * s2; Fy += pieceE[eo + 1] * s1 + pieceE[eo + 4] * s2; Fz += pieceE[eo + 2] * s1 + pieceE[eo + 5] * s2;
      const a = A[k] * 3, b = B[k] * 3, c = C[k] * 3;
      f[a] += Fx; f[a + 1] += Fy; f[a + 2] += Fz;
      f[b] += Fx; f[b + 1] += Fy; f[b + 2] += Fz;
      f[c] += Fx; f[c + 1] += Fy; f[c + 2] += Fz;
    }
  }
}

/** Wind at a point from this frame's lattice (for other sim parts, e.g. diagnostics). */
export function windSample(x, y, z, out) { windAt(x, y, z, out, 0); return out; }
