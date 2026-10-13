// Approximate self-collision: particles keep a minimum distance from particles of OTHER layers (a
// different piece, or the same piece folded over: far apart in the rest shape). It is a particle-level
// approximation (triangles can still graze between particles), cheap enough for a phone, and it is what
// keeps the noren's panels sliding over each other, a sheet's folds lying on top of each other, and the
// carp's walls from passing through each other when it collapses.
//
// Two halves, like the collider contacts: once per frame a spatial hash finds the pairs that are, or could
// come, within reach this frame (findSelfPairs); every substep those pairs are held apart as one-sided
// distance constraints (solveSelfPairs). Solved inside the substeps, a layer resting on another is held
// up against each substep's gravity, so a crumpled sheet lies still. (Until 2026-10-13 one push per frame
// ran after the velocities: the top layer fell a frame's worth, got shoved back and traded the impulse with
// the layer below, so a sheet lying on the floor churned and popped forever.)
const HX = 73856093, HY = 19349663, HZ = 83492791, BIAS = 1 << 20; // linear hash: neighbours = base ± axis step
const REACH = 1.5;   // pairs are gathered out to 1.5 × the contact distance: room for this frame's approach

export function createSelfState(n) {
  let size = 64; while (size < 2 * n) size <<= 1;
  const cap = n * 8;
  return {
    size, mask: size - 1, head: new Int32Array(size), next: new Int32Array(n), list: new Int32Array(n), base: new Int32Array(n), N: 0,
    pA: new Int32Array(cap), pB: new Int32Array(cap), pR: new Float32Array(cap), pN: 0, cap,
  };
}

/**
 * Once per frame: gather pairs of particles from different layers within REACH × r of each other, each with
 * its contact distance: r, or 90 % of the pair's rest gap when the rest shape already sets them closer than r
 * (the noren's panels either side of a 14 mm slit: pushed out to r, they fought their pins every frame and
 * the curtain never stopped trembling). Cells are 2·REACH·r wide, so a particle's search sphere touches at
 * most two cells per axis: 8 buckets per particle. Returns the pair count.
 */
export function findSelfPairs(X, cl, p, r) {
  const { head, next, list, base, mask, pA, pB, pR, cap } = X, alias = cl.alias, vTri = cl.vTri, R = cl.restPos, piece = cl.piece;
  const reach = REACH * r, inv = 0.5 / reach, reach2 = reach * reach, r2 = r * r, rest2 = 6.25 * r2; // rest distance under 2.5 r: neighbours in the weave, never collide
  const slack = reach - r;
  head.fill(-1);
  let N = 0;
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    if (alias[i] >= 0 || !vTri[i]) continue;
    const ix = (p[o] * inv + BIAS) | 0, iy = (p[o + 1] * inv + BIAS) | 0, iz = (p[o + 2] * inv + BIAS) | 0; // floor (biased positive)
    const b = (Math.imul(ix, HX) + Math.imul(iy, HY) + Math.imul(iz, HZ)) | 0;
    next[i] = head[b & mask]; head[b & mask] = i; base[N] = b; list[N++] = i;
  }
  X.N = N;
  let P = 0;
  for (let k = 0; k < N && P < cap; k++) {
    const i = list[k], o = i * 3, b = base[k];
    const x = p[o], y = p[o + 1], z = p[o + 2], pi = piece[i];
    // which neighbour cell per axis the sphere can reach: the side of the cell the particle sits in
    const fx = x * inv + BIAS, fy = y * inv + BIAS, fz = z * inv + BIAS;
    const sx = fx - (fx | 0) < 0.5 ? -HX : HX, sy = fy - (fy | 0) < 0.5 ? -HY : HY, sz = fz - (fz | 0) < 0.5 ? -HZ : HZ;
    for (let c = 0; c < 8; c++) {
      let j = head[(b + (c & 1 ? sx : 0) + (c & 2 ? sy : 0) + (c & 4 ? sz : 0)) & mask];
      while (j >= 0) {
        if (j > i) {
          const jo = j * 3;
          const ex = p[jo] - x, ey = p[jo + 1] - y, ez = p[jo + 2] - z, d2 = ex * ex + ey * ey + ez * ez;
          if (d2 < reach2) {
            const qx = R[jo] - R[o], qy = R[jo + 1] - R[o + 1], qz = R[jo + 2] - R[o + 2], q2 = qx * qx + qy * qy + qz * qz;
            if (pi !== piece[j] || q2 > rest2) {
              const rr = q2 < r2 ? 0.9 * Math.sqrt(q2) : r, lim = rr + slack;
              if (d2 < lim * lim && P < cap) { pA[P] = i; pB[P] = j; pR[P] = rr; P++; }
            }
          }
        }
        j = next[j];
      }
    }
  }
  X.pN = P;
  return P;
}

/**
 * Every substep: push this frame's pairs apart to their contact distance (a one-sided distance constraint,
 * so they never pull). w: inverse masses (0 = kinematic: pushes, isn't pushed). Returns the pairs pushed.
 */
export function solveSelfPairs(X, p, w) {
  const N = X.pN, A = X.pA, B = X.pB, Rr = X.pR;
  let pushes = 0;
  for (let k = 0; k < N; k++) {
    const i = A[k], j = B[k], o = i * 3, jo = j * 3, rr = Rr[k];
    const ex = p[jo] - p[o], ey = p[jo + 1] - p[o + 1], ez = p[jo + 2] - p[o + 2], d2 = ex * ex + ey * ey + ez * ez;
    if (d2 >= rr * rr || d2 < 1e-14) continue;
    const wi = w[i], wj = w[j], ws = wi + wj;
    if (ws === 0) continue;
    const d = Math.sqrt(d2), s = (rr - d) / (d * ws);
    p[o] -= ex * s * wi; p[o + 1] -= ey * s * wi; p[o + 2] -= ez * s * wi;
    p[jo] += ex * s * wj; p[jo + 1] += ey * s * wj; p[jo + 2] += ez * s * wj;
    pushes++;
  }
  return pushes;
}
