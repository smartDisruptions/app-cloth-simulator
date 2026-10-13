// Builds cloth topology at scene load: particles, constraints, triangles, and the bookkeeping that keeps
// tearing honest (a broken edge kills its triangles, a dead quad drops its diagonals, a broken edge drops
// the bending constraints that spanned it). Scenes call grid()/tube() or the low-level calls, then
// finalize(world). Allocation happens here, once per scene; never per frame.
//
// Winding: triangles are counter-clockwise seen from the FRONT of the cloth, so a cross product of
// (b - a) × (c - a) points out of the front face (and gl_FrontFacing is true there).

export const KIND_STRETCH = 0, KIND_SHEAR = 1, KIND_BEND = 2;

export function createBuilder() {
  const P = [], UV = [], PIN = [], ALIAS = [], PIECE = [];
  const CA = [], CB = [], CK = [], CS = [];          // constraint a, b, kind, strength multiplier
  const BDEP = [];                                    // for bend constraints: [stretchAB, stretchBC]
  const BMID = [];                                    // for bend constraints: the middle particle b (master)
  const T = [], TQ = [];                               // triangles; per triangle its quad's two shear constraints
  const pieces = [];
  const edge = new Map();                              // master pair → stretch/shear constraint index
  let pieceIx = 0;

  const master = (i) => (ALIAS[i] >= 0 ? ALIAS[i] : i);
  const key = (a, b) => (a < b ? a * 1048576 + b : b * 1048576 + a);

  const api = {
    /** Add a particle. Returns its index. alias = index of the particle it is welded to (seams), else -1. */
    particle(x, y, z, u = 0, v = 0, pinned = false, alias = -1) {
      const i = PIN.length;
      P.push(x, y, z); UV.push(u, v); PIN.push(pinned ? 1 : 0); ALIAS.push(alias); PIECE.push(pieceIx);
      return i;
    },
    /** Add (or find) a constraint between two particles (aliases resolve to their master). */
    constraint(a, b, kind = KIND_STRETCH, strength = 1) {
      a = master(a); b = master(b);
      if (a === b) return -1;
      if (kind !== KIND_BEND) { const k = key(a, b), hit = edge.get(k); if (hit !== undefined) return hit; }
      const j = CK.length;
      CA.push(a); CB.push(b); CK.push(kind); CS.push(strength); BDEP.push(-1, -1); BMID.push(-1);
      if (kind !== KIND_BEND) edge.set(key(a, b), j);
      return j;
    },
    /** Bending constraint a–c through b; it breaks when a–b or b–c breaks. */
    bend(a, b, c, strength = 1) {
      const ab = edge.get(key(master(a), master(b))), bc = edge.get(key(master(b), master(c)));
      const j = api.constraint(a, c, KIND_BEND, strength);
      if (j >= 0) { BDEP[j * 2] = ab === undefined ? -1 : ab; BDEP[j * 2 + 1] = bc === undefined ? -1 : bc; BMID[j] = master(b); }
      return j;
    },
    /** Triangle (CCW from the front). q0/q1: the shear constraints of its quad, broken together. */
    triangle(a, b, c, q0 = -1, q1 = -1) { T.push(a, b, c); TQ.push(q0, q1); return T.length / 3 - 1; },

    /**
     * A rectangular sheet. Particle (col 0,row 0) sits at `origin`; `u` spans col 0 → cols-1 and `v` spans
     * row 0 → rows-1 (so with u = +x and v = −y the front faces +z). pin(c, r) → true pins that particle.
     * opts: { cols, rows, origin, u, v, uv: [u0, v0, u1, v1], pin, bend = true, strength(c, r) → multiplier, name }
     */
    grid(o) {
      const { cols, rows } = o;
      const [u0, v0, u1, v1] = o.uv || [0, 0, 1, 1];
      const start = PIN.length;
      const id = (c, r) => start + r * cols + c;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const s = c / (cols - 1), t = r / (rows - 1);
        api.particle(
          o.origin[0] + o.u[0] * s + o.v[0] * t, o.origin[1] + o.u[1] * s + o.v[1] * t, o.origin[2] + o.u[2] * s + o.v[2] * t,
          u0 + (u1 - u0) * s, v0 + (v1 - v0) * t, o.pin ? !!o.pin(c, r) : false,
        );
      }
      const str = o.strength || (() => 1);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (c < cols - 1) api.constraint(id(c, r), id(c + 1, r), KIND_STRETCH, str(c, r));
        if (r < rows - 1) api.constraint(id(c, r), id(c, r + 1), KIND_STRETCH, str(c, r));
      }
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
        const a = id(c, r), b = id(c + 1, r), cc = id(c, r + 1), d = id(c + 1, r + 1);
        const s1 = api.constraint(a, d, KIND_SHEAR, str(c, r)), s2 = api.constraint(b, cc, KIND_SHEAR, str(c, r));
        if ((c + r) % 2 === 0) { api.triangle(a, cc, b, s1, s2); api.triangle(b, cc, d, s1, s2); }
        else { api.triangle(a, cc, d, s1, s2); api.triangle(a, d, b, s1, s2); }
      }
      if (o.bend !== false) {
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 2; c++) api.bend(id(c, r), id(c + 1, r), id(c + 2, r));
        for (let r = 0; r < rows - 2; r++) for (let c = 0; c < cols; c++) api.bend(id(c, r), id(c, r + 1), id(c, r + 2));
      }
      const piece = { name: o.name || 'grid' + pieces.length, type: 'grid', index: pieceIx, start, count: cols * rows, cols, rows, uv: [u0, v0, u1, v1], id };
      pieces.push(piece); pieceIx++;
      return piece;
    },

    /**
     * A tube (windsock, sleeve). Ring r (0..rings-1) is centred at origin + axis × r/(rings-1), radius
     * radius(t) with t = r/(rings-1). Each ring has `segs` particles plus one seam particle welded to the
     * first (an alias) so the texture can wrap u 0 → 1. side: a unit vector ⟂ axis where seg 0 starts.
     * The front face is the OUTSIDE. pin(s, r) pins particles (aliases follow their master).
     * opts: { segs, rings, origin, axis, side, radius(t), uv, pin, bend = true, name }
     */
    tube(o) {
      const { segs, rings } = o;
      const [u0, v0, u1, v1] = o.uv || [0, 0, 1, 1];
      const ax = o.axis, len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
      const nx = ax[0] / len, ny = ax[1] / len, nz = ax[2] / len;
      let sx = o.side[0], sy = o.side[1], sz = o.side[2];
      const d = sx * nx + sy * ny + sz * nz; sx -= d * nx; sy -= d * ny; sz -= d * nz;
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const wx = ny * sz - nz * sy, wy = nz * sx - nx * sz, wz = nx * sy - ny * sx; // third basis vector
      const start = PIN.length, cols = segs + 1;
      const id = (s, r) => start + r * cols + s;
      for (let r = 0; r < rings; r++) {
        const t = r / (rings - 1), rad = o.radius(t);
        const cx = o.origin[0] + ax[0] * t, cy = o.origin[1] + ax[1] * t, cz = o.origin[2] + ax[2] * t;
        for (let s = 0; s <= segs; s++) {
          const a = (s / segs) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const alias = s === segs ? id(0, r) : -1;
          api.particle(cx + (sx * ca + wx * sa) * rad, cy + (sy * ca + wy * sa) * rad, cz + (sz * ca + wz * sa) * rad,
            u0 + (u1 - u0) * (s / segs), v0 + (v1 - v0) * t, alias < 0 && o.pin ? !!o.pin(s, r) : false, alias);
        }
      }
      for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
        api.constraint(id(s, r), id(s + 1, r), KIND_STRETCH);
        if (r < rings - 1) api.constraint(id(s, r), id(s, r + 1), KIND_STRETCH);
      }
      // decide winding so the outside is the front: test the first quad against the outward radial
      const pa = id(0, 0) * 3, pb = id(1, 0) * 3, pc = id(0, 1) * 3;
      const e1x = P[pc] - P[pa], e1y = P[pc + 1] - P[pa + 1], e1z = P[pc + 2] - P[pa + 2];
      const e2x = P[pb] - P[pa], e2y = P[pb + 1] - P[pa + 1], e2z = P[pb + 2] - P[pa + 2];
      const cxp = e1y * e2z - e1z * e2y, cyp = e1z * e2x - e1x * e2z, czp = e1x * e2y - e1y * e2x;
      const outward = cxp * sx + cyp * sy + czp * sz > 0; // (a, c, b) winding faces outward?
      for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segs; s++) {
        const a = id(s, r), b = id(s + 1, r), c = id(s, r + 1), dd = id(s + 1, r + 1);
        const q1 = api.constraint(a, dd, KIND_SHEAR), q2 = api.constraint(b, c, KIND_SHEAR);
        if (outward) { api.triangle(a, c, b, q1, q2); api.triangle(b, c, dd, q1, q2); }
        else { api.triangle(a, b, c, q1, q2); api.triangle(b, dd, c, q1, q2); }
      }
      if (o.bend !== false) {
        for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) api.bend(id(s, r), id((s + 1) % segs, r), id((s + 2) % segs, r));
        for (let r = 0; r < rings - 2; r++) for (let s = 0; s < segs; s++) api.bend(id(s, r), id(s, r + 1), id(s, r + 2));
      }
      const piece = { name: o.name || 'tube' + pieces.length, type: 'tube', index: pieceIx, start, count: cols * rings, cols, rows: rings, segs, uv: [u0, v0, u1, v1], id, restLen: len };
      pieces.push(piece); pieceIx++;
      return piece;
    },

    get count() { return PIN.length; },

    /** Allocate the typed arrays, compute rest lengths, areas and adjacency, and set world.cloth. */
    finalize(world) {
      const n = PIN.length, m = CK.length, t = T.length / 3;
      const cl = {
        n, m, t, pieces,
        pos: new Float32Array(P), prev: new Float32Array(P), vel: new Float32Array(n * 3),
        force: new Float32Array(n * 3),        // sim: per-frame external force accumulator (N)
        anchor: new Float32Array(P),           // pin targets (scenes animate them)
        uv: new Float32Array(UV), normal: new Float32Array(n * 3),
        pinned: new Uint8Array(PIN), grabbed: new Uint8Array(n),
        alias: new Int32Array(ALIAS), piece: new Uint8Array(PIECE),
        area: new Float32Array(n),             // rest area owned by each vertex (m²), masters only
        mass0: new Float32Array(n),            // sim: area × density
        massScale: new Float32Array(n).fill(1),// fx/wet.js: 1 dry … heavier when soaked
        invMass: new Float32Array(n),          // sim: 0 when pinned or grabbed
        heat: new Float32Array(n), fuel: new Float32Array(n).fill(1), char: new Float32Array(n), wet: new Float32Array(n),
        cA: new Uint32Array(CA), cB: new Uint32Array(CB), kind: new Uint8Array(CK), strength: new Float32Array(CS),
        rest: new Float32Array(m), alive: new Uint8Array(m).fill(1),
        bendDep: new Int32Array(BDEP),         // per constraint: the two stretch edges a bend spans (or -1)
        cMid: new Int32Array(BMID),            // per bend: its middle particle b (master; -1 for stretch/shear)
        restPos: new Float32Array(P),          // the positions the cloth was built in (rest shape)
        cBend: new Int32Array(m * 2).fill(-1), // per stretch/shear constraint: bends that die with it
        cTri: new Int32Array(m * 2).fill(-1),  // per constraint: the (up to 2) triangles it borders
        tri: n <= 65535 ? new Uint16Array(T) : new Uint32Array(T),
        triQuad: new Int32Array(TQ),           // per triangle: its quad's two shear constraints
        triAlive: new Uint8Array(t).fill(1),
        vTri: new Uint16Array(n),              // alive triangles touching each vertex (0 = invisible)
        vcStart: new Int32Array(n + 1), vcList: new Int32Array(m * 2), // vertex → constraints (CSR, masters)
        topoVersion: 0,
        solver: null,                          // sim/cloth.js: the solver's private state (physics only)
        constraintsAlive: m, trisAlive: t,
        bounds: { min: new Float32Array(3), max: new Float32Array(3) },
      };
      for (let j = 0; j < m; j++) {
        const a = CA[j] * 3, b = CB[j] * 3;
        cl.rest[j] = Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]);
        if (CK[j] === KIND_BEND) for (let s = 0; s < 2; s++) {
          const dep = BDEP[j * 2 + s]; if (dep < 0) continue;
          if (cl.cBend[dep * 2] < 0) cl.cBend[dep * 2] = j; else cl.cBend[dep * 2 + 1] = j;
        }
      }
      for (let k = 0; k < t; k++) {
        const ia = T[k * 3], ib = T[k * 3 + 1], ic = T[k * 3 + 2];
        const a = ia * 3, b = ib * 3, c = ic * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        for (const v of [ia, ib, ic]) { cl.area[master(v)] += area / 3; cl.vTri[v]++; }
        for (const [x, y] of [[ia, ib], [ib, ic], [ic, ia]]) {
          const j = edge.get(key(master(x), master(y)));
          if (j === undefined) continue;
          if (cl.cTri[j * 2] < 0) cl.cTri[j * 2] = k; else cl.cTri[j * 2 + 1] = k;
        }
      }
      const deg = new Int32Array(n);
      for (let j = 0; j < m; j++) { deg[CA[j]]++; deg[CB[j]]++; }
      for (let i = 0; i < n; i++) cl.vcStart[i + 1] = cl.vcStart[i] + deg[i];
      const fill = cl.vcStart.slice(0, n);
      for (let j = 0; j < m; j++) { cl.vcList[fill[CA[j]]++] = j; cl.vcList[fill[CB[j]]++] = j; }
      world.cloth = cl;
      world.screen = new Float32Array(n * 3);
      return cl;
    },
  };
  return api;
}
