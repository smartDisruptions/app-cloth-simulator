// Approximate self-collision: particles keep a minimum distance from particles of OTHER layers (a
// different piece, or the same piece folded over: far apart in the rest shape). Once per frame, on a
// spatial hash with cells one contact radius wide. It is a particle-level approximation (triangles can
// still graze between particles), cheap enough for a phone, and it is what keeps the noren's panels
// sliding over each other, a sheet's folds lying on top of each other, and the carp's walls from
// passing through each other when it collapses.
const HX = 73856093, HY = 19349663, HZ = 83492791, BIAS = 1 << 20; // linear hash: neighbours = base ± axis step

export function createSelfState(n) {
  let size = 64; while (size < 2 * n) size <<= 1;
  return { size, mask: size - 1, head: new Int32Array(size), next: new Int32Array(n), list: new Int32Array(n), base: new Int32Array(n), N: 0 };
}

/**
 * Push apart particles of different layers closer than r (m), in the working positions p, and remove
 * the pair's approaching velocity (v): an inelastic contact that separates without bouncing (it runs
 * after the frame's velocities are known, so the push itself never turns into speed). w: inverse
 * masses (0 = kinematic: pushes, isn't pushed). Cells are 2r wide, so a particle's contact sphere
 * touches at most two cells per axis: 8 buckets per particle. Returns how many pairs were pushed.
 */
export function selfCollide(X, cl, p, v, w, r) {
  const { head, next, list, base, mask } = X, alias = cl.alias, vTri = cl.vTri, R = cl.restPos, piece = cl.piece;
  const inv = 0.5 / r, r2 = r * r, rest2 = 6.25 * r2; // rest distance under 2.5 r: neighbours in the weave, never collide
  head.fill(-1);
  let N = 0;
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    if (alias[i] >= 0 || !vTri[i]) continue;
    const ix = (p[o] * inv + BIAS) | 0, iy = (p[o + 1] * inv + BIAS) | 0, iz = (p[o + 2] * inv + BIAS) | 0; // floor (biased positive)
    const b = (Math.imul(ix, HX) + Math.imul(iy, HY) + Math.imul(iz, HZ)) | 0;
    next[i] = head[b & mask]; head[b & mask] = i; base[N] = b; list[N++] = i;
  }
  X.N = N;
  let pushes = 0;
  for (let k = 0; k < N; k++) {
    const i = list[k], o = i * 3, b = base[k];
    const x = p[o], y = p[o + 1], z = p[o + 2], pi = piece[i], wi = w[i];
    // which neighbour cell per axis the sphere can reach: the side of the cell the particle sits in
    const fx = x * inv + BIAS, fy = y * inv + BIAS, fz = z * inv + BIAS;
    const sx = fx - (fx | 0) < 0.5 ? -HX : HX, sy = fy - (fy | 0) < 0.5 ? -HY : HY, sz = fz - (fz | 0) < 0.5 ? -HZ : HZ;
    for (let c = 0; c < 8; c++) {
      let j = head[(b + (c & 1 ? sx : 0) + (c & 2 ? sy : 0) + (c & 4 ? sz : 0)) & mask];
      while (j >= 0) {
        if (j > i) {
          const jo = j * 3;
          const ex = p[jo] - x, ey = p[jo + 1] - y, ez = p[jo + 2] - z, d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < r2 && d2 > 1e-14) {
            const qx = R[jo] - R[o], qy = R[jo + 1] - R[o + 1], qz = R[jo + 2] - R[o + 2];
            if (pi !== piece[j] || qx * qx + qy * qy + qz * qz > rest2) {
              const wj = w[j], ws = wi + wj;
              if (ws > 0) {
                const d = Math.sqrt(d2), s = (r - d) / (d * ws);
                p[o] -= ex * s * wi; p[o + 1] -= ey * s * wi; p[o + 2] -= ez * s * wi;
                p[jo] += ex * s * wj; p[jo + 1] += ey * s * wj; p[jo + 2] += ez * s * wj;
                const id = 1 / d, nx = ex * id, ny = ey * id, nz = ez * id;
                const vn = (v[jo] - v[o]) * nx + (v[jo + 1] - v[o + 1]) * ny + (v[jo + 2] - v[o + 2]) * nz;
                if (vn < 0) {
                  const a = -vn / ws;
                  v[o] -= nx * a * wi; v[o + 1] -= ny * a * wi; v[o + 2] -= nz * a * wi;
                  v[jo] += nx * a * wj; v[jo + 1] += ny * a * wj; v[jo + 2] += nz * a * wj;
                }
                pushes++;
              }
            }
          }
        }
        j = next[j];
      }
    }
  }
  return pushes;
}
