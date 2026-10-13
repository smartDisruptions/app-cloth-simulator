// Grabs: a finger pinches a small patch of fabric, not a single particle. The touched particle is
// kinematic; its neighbours within a radius (walked over intact threads, so a patch never reaches across
// a cut) are pulled toward their places around it with a weighted falloff. The patch chases the finger
// with a speed limit and a short smoothing, so jitter and frame hitches can't teleport it (and tear the
// cloth by accident); a hard, sustained pull still rips. On release the patch keeps its velocity: a fling.
// Cloth that can't tear (chainmail) slips out of the fingers instead of stretching like rubber when pulled
// beyond its reach. Up to MAX_POINTERS grabs at once, one patch per pointer slot.
import { K_H, K_T, K_IH, K_TENSION } from './solver.js';

const CAP = 40;              // particles per patch
const PULL = 420;            // 1/s: how hard the patch rim follows (× falloff), independent of substeps
const VMAX = 9;              // m/s: the fastest the patch may chase the finger (real time)
const SMOOTH = 0.012;        // s: finger smoothing time constant

export function createGrabState(slots) {
  return {
    v: new Int32Array(slots).fill(-1), n: new Int32Array(slots),
    idx: new Int32Array(slots * CAP), rate: new Float32Array(slots * CAP), kSub: new Float32Array(slots * CAP),
    off: new Float32Array(slots * CAP * 3),
    from: new Float32Array(slots * 3), cur: new Float32Array(slots * 3), hold: new Float32Array(slots * 3),
    marked: new Int32Array(slots * (CAP + 1)), markedN: 0,
    slipped: new Int32Array(slots).fill(-1), // the particle a slot lost its grip on (until the finger lets go)
  };
}

/** Walk the intact threads from v, gathering particles within radius R (Euclidean, now). */
function startPatch(G, s, v, P, cl, S) {
  const p = S.P, R = S.grabRadius, R2 = R * R, base = s * CAP;
  const { vcStart, vcList, cA, cB, kind, alive, alias } = cl;
  const stamp = ++S.stampN, st = S.stamp, q = S.queue;
  let qh = 0, qt = 0, n = 0;
  st[v] = stamp; q[qt++] = v;
  const vx = p[v * 3], vy = p[v * 3 + 1], vz = p[v * 3 + 2];
  while (qh < qt && n < CAP) {
    const u = q[qh++];
    const o = u * 3, dx = p[o] - vx, dy = p[o + 1] - vy, dz = p[o + 2] - vz, d2 = dx * dx + dy * dy + dz * dz;
    if (u !== v) {
      const t = 1 - d2 / R2; // falloff 1 → 0 at the rim
      G.idx[base + n] = u; G.rate[base + n] = PULL * (0.15 + 0.85 * t);
      G.off[(base + n) * 3] = dx; G.off[(base + n) * 3 + 1] = dy; G.off[(base + n) * 3 + 2] = dz;
      n++;
    }
    for (let k = vcStart[u]; k < vcStart[u + 1]; k++) {
      const j = vcList[k];
      if (!alive[j] || kind[j] === 2) continue;
      const w = cA[j] === u ? cB[j] : cA[j];
      if (st[w] === stamp || alias[w] >= 0) continue;
      st[w] = stamp;
      const ow = w * 3, ex = p[ow] - vx, ey = p[ow + 1] - vy, ez = p[ow + 2] - vz;
      if (ex * ex + ey * ey + ez * ez <= R2 && qt < q.length) q[qt++] = w;
    }
  }
  G.n[s] = n; G.v[s] = v;
  // keep the touch offset: the fabric under the finger stays under the finger (no snap)
  const so = s * 3;
  G.hold[so] = vx - P.target[0]; G.hold[so + 1] = vy - P.target[1]; G.hold[so + 2] = vz - P.target[2];
  G.cur[so] = vx; G.cur[so + 1] = vy; G.cur[so + 2] = vz;
  G.from[so] = vx; G.from[so + 1] = vy; G.from[so + 2] = vz;
}

/**
 * Once per frame: start/end patches from world.pointers, move each patch's goal toward its finger
 * (smoothed, speed-limited in REAL time so slow-mo still feels direct), mark kinematic particles.
 */
export function grabFrame(world, cl, S) {
  const h = S.k[K_H];
  const G = S.grab, ptr = world.pointers, kin = S.kin, grabbed = cl.grabbed;
  for (let k = 0; k < G.markedN; k++) { const i = G.marked[k]; kin[i] = 0; grabbed[i] = 0; }
  G.markedN = 0;
  const fdt = world.frameDt > 0 ? world.frameDt : 1 / 60;
  const follow = 1 - Math.exp(-fdt / SMOOTH), maxStep = VMAX * fdt;
  // slip: cloth that can't tear lets go a little past taut (tearable cloth tears first: its instant-tear
  // limit already bounds how far it can be stretched)
  const slipping = S.tearRatio === Infinity && S.k[K_TENSION] > 1.35;
  for (let s = 0; s < G.v.length; s++) {
    const P = s < ptr.length ? ptr[s] : null;
    let v = P && P.active ? P.particle : -1;
    if (v !== G.slipped[s]) G.slipped[s] = -1;       // a new grab (or none): the grip is fresh
    if (slipping && v >= 0 && G.v[s] === v && G.slipped[s] < 0) {
      G.slipped[s] = v;
      // the rings slid out of the fingers: tell audio (it jingles the drop)
      const o = v * 3, vx = cl.vel[o], vy = cl.vel[o + 1], vz = cl.vel[o + 2];
      world.events.release.push(cl.pos[o], cl.pos[o + 1], cl.pos[o + 2], Math.sqrt(vx * vx + vy * vy + vz * vz));
    }
    if (G.slipped[s] >= 0) v = -1;
    if (v < 0 || v >= cl.n || cl.alias[v] >= 0) { if (G.v[s] >= 0) S.tetherDirty = true; G.v[s] = -1; continue; } // released: velocities stay → fling (and the anchor goes)
    if (G.v[s] !== v) { startPatch(G, s, v, P, cl, S); S.tetherDirty = true; } // the finger becomes a tether anchor
    const so = s * 3, t = P.target;
    if (!(t[0] === t[0] && t[1] === t[1] && t[2] === t[2])) continue; // a broken target holds still
    G.from[so] = G.cur[so]; G.from[so + 1] = G.cur[so + 1]; G.from[so + 2] = G.cur[so + 2];
    let dx = (t[0] + G.hold[so] - G.cur[so]) * follow, dy = (t[1] + G.hold[so + 1] - G.cur[so + 1]) * follow, dz = (t[2] + G.hold[so + 2] - G.cur[so + 2]) * follow;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxStep * maxStep) { const k = maxStep / Math.sqrt(d2); dx *= k; dy *= k; dz *= k; }
    G.cur[so] += dx; G.cur[so + 1] += dy; G.cur[so + 2] += dz;
    if (!cl.pinned[v]) { kin[v] = 1; }
    grabbed[v] = 1; if (G.markedN < G.marked.length) G.marked[G.markedN++] = v;
    const base = s * CAP;
    for (let k = 0; k < G.n[s]; k++) {
      const i = G.idx[base + k];
      G.kSub[base + k] = 1 - Math.exp(-G.rate[base + k] * h);
      grabbed[i] = 1; if (G.markedN < G.marked.length) G.marked[G.markedN++] = i;
    }
  }
}

/** Every substep (after predict and pins): the patch centre moves along its path, the rim follows. */
export function grabSub(world, cl, S) {
  const t = S.k[K_T], ih = S.k[K_IH];
  const G = S.grab, p = S.P, q = S.Q, vel = S.V, w = S.W, kin = S.kin;
  for (let s = 0; s < G.v.length; s++) {
    const v = G.v[s]; if (v < 0) continue;
    const so = s * 3;
    const x = G.from[so] + (G.cur[so] - G.from[so]) * t, y = G.from[so + 1] + (G.cur[so + 1] - G.from[so + 1]) * t, z = G.from[so + 2] + (G.cur[so + 2] - G.from[so + 2]) * t;
    if (kin[v]) {
      const o = v * 3;
      q[o] = p[o]; q[o + 1] = p[o + 1]; q[o + 2] = p[o + 2];
      vel[o] = (x - p[o]) * ih; vel[o + 1] = (y - p[o + 1]) * ih; vel[o + 2] = (z - p[o + 2]) * ih;
      p[o] = x; p[o + 1] = y; p[o + 2] = z;
    }
    const base = s * CAP;
    for (let k = 0; k < G.n[s]; k++) {
      const i = G.idx[base + k]; if (w[i] === 0) continue;
      const o = i * 3, f = G.kSub[base + k], fo = (base + k) * 3;
      p[o] += (x + G.off[fo] - p[o]) * f;
      p[o + 1] += (y + G.off[fo + 1] - p[o + 1]) * f;
      p[o + 2] += (z + G.off[fo + 2] - p[o + 2]) * f;
    }
  }
}
