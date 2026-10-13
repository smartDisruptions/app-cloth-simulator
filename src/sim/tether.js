// Long-range attachments (Kim, Chentanez & Müller 2012): each particle may not drift farther from its
// nearest ANCHOR than the geodesic rest distance between them (plus a little slack). One cheap
// unilateral pass per substep that does what a few dozen Gauss-Seidel iterations would: a hanging cloth
// stops stretching like rubber under its own weight, a gale can't pull a banner long, and a 6-substep
// phone cloth looks as inextensible as a 12-substep desktop one.
//
// Anchors are the pins AND the fingers (a grab's kinematic centre). That one idea gives honest tearing:
// while a finger stays within the cloth's reach, every tether is satisfiable and the cloth just swings,
// shears and drapes toward it; pulled beyond reach, the particles held by the finger and those held by
// the pins can't both be satisfied, the stretch collects on the boundary between them, and the cloth
// rips there, across the pull.
//
// The geodesics come from a multi-source Dijkstra over the INTACT threads, recomputed whenever anchors or
// topology change (never per frame otherwise), so a torn-off piece loses its tethers and falls, and a
// flap hanging from the far side of a slit gets the long way round as its length. Around a fresh crack the
// tethers let go for a moment (looseUntil) so the crack can open and hand its load to the threads at its tip.
const SLACK = 0.025;          // 2.5 % beyond the geodesic before a tether bites
const TIGHTEN = 0.6;          // m/s: a tether born slack (the cloth was stretched) tightens this fast
const WET_GIVE = 0.04;        // wet cotton is heavier AND stretchier: +4 % reach per unit of extra mass scale

export function createTetherState(n, m) {
  const cap = 2 * m + n + 8;
  return {
    on: false, N: 0,
    clock: null,                       // the solver's registers (k[12] = sim time); set by the owner
    list: new Int32Array(n), pin: new Int32Array(n), len2: new Float32Array(n),
    len: new Float32Array(n), goal: new Float32Array(n), relaxing: false,
    dist: new Float32Array(n), src: new Int32Array(n),
    looseUntil: new Float32Array(n),   // per particle: tether off until this sim time (crack zones)
    // Dial's bucket queue: buckets of width ~half an edge, entries (vertex, distance) in linked lists
    head: new Int32Array(BUCKETS), entV: new Int32Array(cap), entD: new Float32Array(cap), entNext: new Int32Array(cap),
  };
}
const BUCKETS = 8192;

/**
 * Recompute every particle's tether: its nearest anchor (pins, kinematic fingers) over intact threads.
 * Dijkstra with a bucket queue (Dial): thread lengths are nearly uniform, so it runs in about linear
 * time, and it stays exact (an entry that turns out stale is skipped and its vertex re-relaxed). If the
 * entry pool ever ran out, the missed relaxations could only leave a tether longer, never tighter. A tether is never born
 * tighter than the cloth is now (p = current positions): it starts at the current distance and tightens
 * toward its goal at TIGHTEN m/s, so re-anchoring after a release or a tear never yanks the cloth.
 */
export function buildTethers(T, cl, kin, slackAbs, p, width) {
  const n = cl.n, dist = T.dist, src = T.src, { vcStart, vcList, cA, cB, kind, alive, rest, pinned, alias } = cl;
  const head = T.head, eV = T.entV, eD = T.entD, eN = T.entNext, cap = eV.length, iw = 1 / width;
  dist.fill(Infinity); src.fill(-1); head.fill(-1);
  let ne = 0, anchors = 0, hi = 0;
  for (let i = 0; i < n; i++) if ((pinned[i] || kin[i]) && alias[i] < 0) {
    dist[i] = 0; src[i] = i; anchors++;
    eV[ne] = i; eD[ne] = 0; eN[ne] = head[0]; head[0] = ne++;
  }
  T.N = 0; T.on = anchors > 0;
  if (!anchors) return;
  for (let b = 0; b <= hi && b < BUCKETS; b++) {
    while (head[b] >= 0) {
      const e = head[b]; head[b] = eN[e];
      const v = eV[e], d = eD[e];
      if (d > dist[v]) continue;
      for (let k = vcStart[v]; k < vcStart[v + 1]; k++) {
        const j = vcList[k];
        if (!alive[j] || kind[j] === 2) continue;
        const u = cA[j] === v ? cB[j] : cA[j];
        const nd = d + rest[j];
        if (nd < dist[u] && ne < cap) {
          dist[u] = nd; src[u] = src[v];
          let nb = (nd * iw) | 0; if (nb >= BUCKETS) nb = BUCKETS - 1; if (nb < b) nb = b;
          if (nb > hi) hi = nb;
          eV[ne] = u; eD[ne] = nd; eN[ne] = head[nb]; head[nb] = ne++;
        }
      }
    }
  }
  let N = 0, relaxing = false;
  for (let i = 0; i < n; i++) {
    if (alias[i] >= 0 || pinned[i] || kin[i] || src[i] < 0) continue;
    const goal = dist[i] * (1 + SLACK) + slackAbs, o = i * 3, q = src[i] * 3;
    const dx = p[o] - p[q], dy = p[o + 1] - p[q + 1], dz = p[o + 2] - p[q + 2];
    const now = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const L = now > goal ? now : goal;
    if (L > goal) relaxing = true;
    T.list[N] = i; T.pin[N] = src[i]; T.goal[N] = goal; T.len[N] = L; T.len2[N] = L * L; N++;
  }
  T.N = N; T.relaxing = relaxing;
}

/** Per frame: slack tethers tighten toward their goals. */
export function tightenTethers(T, K) {
  if (!T.relaxing) return;
  const dt = K[0]; // K_DT
  const N = T.N, L = T.len, G = T.goal, L2 = T.len2, d = TIGHTEN * dt;
  let still = false;
  for (let k = 0; k < N; k++) {
    if (L[k] <= G[k]) continue;
    const l = L[k] - d > G[k] ? L[k] - d : G[k];
    L[k] = l; L2[k] = l * l;
    if (l > G[k]) still = true;
  }
  T.relaxing = still;
}

/**
 * One substep's tether pass: pull any particle that strayed too far back toward its anchor. Soaked
 * cloth (massScale > 1) is allowed a little more reach, so a tarp in the rain bellies as it fills.
 */
export function solveTethers(T, p, w, wet) {
  const N = T.N, L = T.list, P = T.pin, L2 = T.len2, loose = T.looseUntil, now = T.clock[12]; // K_TIME
  for (let k = 0; k < N; k++) {
    const i = L[k];
    if (w[i] === 0) continue;
    const o = i * 3, q = P[k] * 3;
    const dx = p[o] - p[q], dy = p[o + 1] - p[q + 1], dz = p[o + 2] - p[q + 2];
    const ms = wet[i], g = ms > 1 ? 1 + WET_GIVE * (ms < 4 ? ms - 1 : 3) : 1;
    const d2 = dx * dx + dy * dy + dz * dz, l2 = L2[k] * g * g;
    if (d2 <= l2 || loose[i] > now) continue;
    const s = Math.sqrt(l2 / d2);
    p[o] = p[q] + dx * s; p[o + 1] = p[q + 1] + dy * s; p[o + 2] = p[q + 2] + dz * s;
  }
}
