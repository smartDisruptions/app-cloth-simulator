// Contacts with the scene's spheres, capsules and planes: thickness, Coulomb friction (static and
// kinetic, position-based, Macklin et al. 2014), and no tunnelling. Candidate pairs are found once per
// frame (only particles that could reach a collider within this frame's travel), then resolved every
// substep, so a scene with a floor and a moon costs almost nothing while nothing is near them.
//
// Curved colliders get an extra margin equal to the chord sag of one cloth cell over their radius: the
// flat triangles between particles would otherwise cut into a sphere even with every particle outside.
import { K_DT } from './solver.js';

const SPH = 0, CAP = 1, PLN = 2;
const curv = new Float32Array(64);   // per sphere/capsule: inflated radius this frame

export function createContactState(n) {
  const cap = n * 3 + 16;
  return { I: new Int32Array(cap), K: new Int32Array(cap), N: 0, cap };
}

/** Pairs (particle, collider) that may touch this frame. */
export function findContacts(world, cl, S, mat) {
  const dt = S.k[K_DT];
  const CS = S.contact, col = world.colliders, sp = col.spheres, ca = col.capsules, pl = col.planes;
  CS.N = 0;
  if (!sp.length && !ca.length && !pl.length) return;
  const th = mat.thickness, edge = S.meanEdge * 0.5;
  for (let s = 0; s < sp.length && s < 32; s++) { const r = sp[s].r; curv[s] = r + th + (r > edge ? r - Math.sqrt(r * r - edge * edge) : 0); }
  for (let s = 0; s < ca.length && s < 32; s++) { const r = ca[s].r; curv[32 + s] = r + th + (r > edge ? r - Math.sqrt(r * r - edge * edge) : 0); }
  const p = S.P, v = S.V, w = S.W, n = cl.n, I = CS.I, K = CS.K, cap = CS.cap;
  const slack = 0.5 * 9.81 * dt * dt + 0.025;
  let N = 0;
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    if (w[i] === 0) continue;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    const sp2 = v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2];
    const reach = Math.sqrt(sp2) * dt * 1.5 + slack;
    for (let s = 0; s < pl.length; s++) {
      const P = pl[s];
      if (P.nx * x + P.ny * y + P.nz * z + P.d - th < reach && N < cap) { I[N] = i; K[N++] = (PLN << 16) | s; }
    }
    for (let s = 0; s < sp.length && s < 32; s++) {
      const Q = sp[s], dx = x - Q.x, dy = y - Q.y, dz = z - Q.z, R = curv[s] + reach;
      if (dx * dx + dy * dy + dz * dz < R * R && N < cap) { I[N] = i; K[N++] = (SPH << 16) | s; }
    }
    for (let s = 0; s < ca.length && s < 32; s++) {
      const C = ca[s], ex = C.bx - C.ax, ey = C.by - C.ay, ez = C.bz - C.az, ee = ex * ex + ey * ey + ez * ez || 1;
      let t = ((x - C.ax) * ex + (y - C.ay) * ey + (z - C.az) * ez) / ee; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - C.ax - ex * t, dy = y - C.ay - ey * t, dz = z - C.az - ez * t, R = curv[32 + s] + reach;
      if (dx * dx + dy * dy + dz * dz < R * R && N < cap) { I[N] = i; K[N++] = (CAP << 16) | s; }
    }
  }
  CS.N = N;
}

/** Push candidates out of their colliders and apply friction. Once per substep, after the constraints. */
export function resolveContacts(world, cl, S, mat) {
  const CS = S.contact, N = CS.N; if (!N) return;
  const col = world.colliders, sp = col.spheres, ca = col.capsules, pl = col.planes;
  const p = S.P, q = S.Q, I = CS.I, K = CS.K, th = mat.thickness, mu0 = mat.friction;
  for (let k = 0; k < N; k++) {
    const i = I[k], code = K[k], type = code >> 16, s = code & 0xffff, o = i * 3;
    let nx, ny, nz, depth, mu;
    if (type === PLN) {
      const P = pl[s]; if (!P) continue;
      const d = P.nx * p[o] + P.ny * p[o + 1] + P.nz * p[o + 2] + P.d - th;
      if (d >= 0) continue;
      nx = P.nx; ny = P.ny; nz = P.nz; depth = -d; mu = P.friction == null ? mu0 : P.friction;
    } else if (type === SPH) {
      const Q = sp[s]; if (!Q) continue;
      const dx = p[o] - Q.x, dy = p[o + 1] - Q.y, dz = p[o + 2] - Q.z, d2 = dx * dx + dy * dy + dz * dz, R = curv[s];
      if (d2 >= R * R || d2 < 1e-14) continue;
      const d = Math.sqrt(d2), inv = 1 / d;
      nx = dx * inv; ny = dy * inv; nz = dz * inv; depth = R - d; mu = Q.friction == null ? mu0 : Q.friction;
    } else {
      const C = ca[s]; if (!C) continue;
      const ex = C.bx - C.ax, ey = C.by - C.ay, ez = C.bz - C.az, ee = ex * ex + ey * ey + ez * ez || 1;
      let t = ((p[o] - C.ax) * ex + (p[o + 1] - C.ay) * ey + (p[o + 2] - C.az) * ez) / ee; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = p[o] - C.ax - ex * t, dy = p[o + 1] - C.ay - ey * t, dz = p[o + 2] - C.az - ez * t, d2 = dx * dx + dy * dy + dz * dz, R = curv[32 + s];
      if (d2 >= R * R || d2 < 1e-14) continue;
      const d = Math.sqrt(d2), inv = 1 / d;
      nx = dx * inv; ny = dy * inv; nz = dz * inv; depth = R - d; mu = C.friction == null ? mu0 : C.friction;
    }
    p[o] += nx * depth; p[o + 1] += ny * depth; p[o + 2] += nz * depth;
    // Coulomb friction on this substep's sliding: stick below μs·depth, else lose μk·depth of it
    const mx = p[o] - q[o], my = p[o + 1] - q[o + 1], mz = p[o + 2] - q[o + 2];
    const mn = mx * nx + my * ny + mz * nz;
    const tx = mx - mn * nx, ty = my - mn * ny, tz = mz - mn * nz, t2 = tx * tx + ty * ty + tz * tz;
    const lim = mu * depth;
    if (t2 <= 1.6 * lim * lim) { p[o] -= tx; p[o + 1] -= ty; p[o + 2] -= tz; }
    else { const f = lim / Math.sqrt(t2); p[o] -= tx * f; p[o + 1] -= ty * f; p[o + 2] -= tz * f; }
  }
}
