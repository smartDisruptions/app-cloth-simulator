// The XPBD "small steps" core (Macklin et al. 2019): many substeps, ONE constraint pass each, so the
// Lagrange multipliers start at zero every substep and need no storage. Stiffness is a compliance
// (1/k, physical units), divided by h² per substep, so a material looks the same at every substep
// count and every cloth resolution.
//
// Speed: everything the hot loops touch lives in typed arrays, re-packed into SOLVE ORDER whenever the
// topology changes (compaction is a stable filter, so the order survives tearing), so the loops never
// branch on `alive` and walk memory forward. Order: constraints sorted by their BFS distance from the
// pins, so one Gauss-Seidel sweep carries the pins' authority all the way down a hanging cloth (that is
// what makes a 6-substep cloth look inextensible). Stretch, shear and bend are separate passes with
// per-pass constants, so there is no per-constraint compliance lookup on the hot path.
import { KIND_STRETCH, KIND_SHEAR, KIND_BEND } from './builder.js';
import { breakConstraint } from './topology.js';

export const GRAV = 9.81;
// The solver's "registers": doubles a frame or substep shares with the hot functions. Passing doubles as
// call arguments (or returning them) makes V8 box them on the heap (garbage every frame); a Float64Array
// slot doesn't.
export const K_DT = 0, K_H = 1, K_IH = 2, K_IH2 = 3, K_IHB2 = 4, K_GX = 5, K_GY = 6, K_GZ = 7, K_DAMP = 8,
  K_VMAX2 = 9, K_T = 10, K_TENSION = 11, K_TIME = 12;
const WEAK_CAP = 1024;     // fresh-rip weakening ring
const TEAR_CAP = 48;       // most threads that may snap in one frame (the rest wait a frame)
const WEAK_TIME = 0.14;    // seconds a fresh break weakens its neighbours

/** Allocate the solver's per-cloth state (once per cloth). */
export function createState(cl) {
  const m = cl.m, n = cl.n, t = cl.t;
  const S = {
    // stretch (kind 0), in solve order: endpoints, rest length, tear watch (len² that triggers the slow path), constraint id
    sN: 0, sA: new Int32Array(m), sB: new Int32Array(m), sRest: new Float32Array(m), sWatch: new Float32Array(m), sJ: new Int32Array(m),
    // shear (kind 1)
    hN: 0, hA: new Int32Array(m), hB: new Int32Array(m), hRest: new Float32Array(m), hJ: new Int32Array(m),
    // bends with a middle particle: a–m–c, rest offset of m from the a–c midpoint, compliance, id
    bN: 0, bA: new Int32Array(m), bM: new Int32Array(m), bC: new Int32Array(m), bH0: new Float32Array(m), bComp: new Float32Array(m), bJ: new Int32Array(m),
    // bends without a middle particle (a scene's raw bend constraint): a soft distance
    xN: 0, xA: new Int32Array(m), xB: new Int32Array(m), xRest: new Float32Array(m), xComp: new Float32Array(m), xJ: new Int32Array(m),
    // alive triangles, resolved to masters (normals, aero, picking): ids, pressure factor, piece
    tN: 0, tA: new Int32Array(t), tB: new Int32Array(t), tC: new Int32Array(t), tT: new Int32Array(t), tPress: new Float32Array(t), tPiece: new Uint8Array(t),
    tRing: new Float32Array(t),           // tubes: 0 at the mouth … 1 at the tail
    triN: new Float32Array(t * 3),        // per alive-triangle slot: (b−a)×(c−a) from the last normals pass (2·area·n̂)
    // per constraint id
    listPos: new Int32Array(m),           // position of j in its pass list
    thrBase: new Float32Array(m), thrEff: new Float32Array(m), dmg: new Float32Array(m), dmgT: new Float32Array(m),
    bendH0Rest: new Float32Array(m),      // per constraint id: the bend's rest offset (creases creep away from it)
    bendH0Cur: new Float32Array(m),       // per constraint id: the current (creased) rest offset, kept across re-ordering
    threadPrev: new Int32Array(m).fill(-1), threadNext: new Int32Array(m).fill(-1), // per stretch id: the thread's neighbouring segments
    side: new Int32Array(m * 4).fill(-1), // per stretch id: up to 4 PARALLEL segments beside it (where a rip's load goes next)
    // per vertex
    level: new Int32Array(n), queue: new Int32Array(n), count: new Int32Array(n + 3),
    kin: new Uint8Array(n),               // kinematic this frame (grab centre)
    anchorPrev: new Float32Array(cl.anchor),
    pinList: new Int32Array(n), pinN: 0,
    aliasList: new Int32Array(0),
    oldN: new Float32Array(n * 3),
    // the working state: doubles (V8 converts on every Float32 access; doubles run ~30 % faster).
    // Copied in from cloth.pos/prev/vel at the start of a step (so between-frame edits by anyone are
    // honoured) and out again at the end.
    P: new Float64Array(n * 3), Q: new Float64Array(n * 3), V: new Float64Array(n * 3), F: new Float64Array(n * 3), W: new Float64Array(n),
    aeroK: new Float32Array(n), windV: new Float32Array(n * 3),
    stamp: new Int32Array(n), stampN: 0,  // BFS visit marks (grab patches)
    // weakening ring (rips run): constraint id + expiry time
    weakJ: new Int32Array(WEAK_CAP), weakT: new Float32Array(WEAK_CAP), weakHead: 0, weakN: 0,
    // bookkeeping
    seenAlive: -1, seenTris: -1, orderDirty: true, dirty: false,
    tearsThisFrame: 0, maxLevel: 0,
    // per-pass compliance (set by applyMaterial): α (m/N) and switches
    aT: 0, aC: 0, aSh: 0, freeCompress: false, jam: 0.6, bendOn: true, bendB: 0, tearRatio: Infinity, dmgRate: 0, rip: 0, pinsDirty: false,
    // grabs (per pointer slot), see grab.js
    grab: null,
    // contacts, see collide.js
    contact: null,
    // set by the owner at attach
    meanEdge: 0.05, grabRadius: 0.06, hasTube: false, tether: null, tetherDirty: false, latticeReady: false,
    self: null, selfPushes: 0, tetherCool: 0,
    k: new Float64Array(16),            // registers (K_*)
    // diagnostics
    nanFixes: 0,
  };
  let k = 0; for (let i = 0; i < n; i++) if (cl.alias[i] >= 0) k++;
  S.aliasList = new Int32Array(k); k = 0;
  for (let i = 0; i < n; i++) if (cl.alias[i] >= 0) S.aliasList[k++] = i;
  return S;
}

/** BFS levels from the pins over alive stretch/shear links, then fill every pass list in level order. */
export function buildOrder(S, cl) {
  const { level, queue } = S, n = cl.n;
  for (let k = 0; k < S.bN; k++) S.bendH0Cur[S.bJ[k]] = S.bH0[k]; // keep creases
  level.fill(-1);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) if ((cl.pinned[i] || S.kin[i]) && cl.alias[i] < 0) { level[i] = 0; queue[qt++] = i; }
  if (!qt) { // no pins: start from the highest particle (the cloth settles from the top)
    let best = 0; for (let i = 1; i < n; i++) if (cl.alias[i] < 0 && cl.pos[i * 3 + 1] > cl.pos[best * 3 + 1]) best = i;
    level[best] = 0; queue[qt++] = best;
  }
  const { vcStart, vcList, cA, cB, kind, alive } = cl;
  let maxL = 0;
  while (qh < qt) {
    const v = queue[qh++], lv = level[v] + 1;
    for (let k = vcStart[v]; k < vcStart[v + 1]; k++) {
      const j = vcList[k];
      if (!alive[j] || kind[j] === KIND_BEND) continue;
      const u = cA[j] === v ? cB[j] : cA[j];
      if (level[u] < 0) { level[u] = lv; if (lv > maxL) maxL = lv; queue[qt++] = u; }
    }
  }
  for (let i = 0; i < n; i++) if (level[i] < 0) level[i] = maxL + 1;
  S.maxLevel = maxL + 1;
  fillLists(S, cl);
  S.orderDirty = false;
}

// Level of a constraint for the solve order: how far its nearer end is from a pin (bends: the middle).
function levelOf(S, cl, j) {
  const lv = S.level, a = cl.cA[j], b = cl.cB[j], m = cl.cMid[j];
  if (cl.kind[j] === KIND_BEND && m >= 0) return lv[m];
  return lv[a] < lv[b] ? lv[a] : lv[b];
}

// Does constraint j belong in the pass for `kindWanted`? Shear: only the diagonal the quad is
// triangulated along (it borders triangles) is solved; the other stays alive for topology but would just
// double the cost for the same shear stiffness.
function wanted(cl, j, kindWanted, withMid) {
  if (!cl.alive[j] || cl.kind[j] !== kindWanted) return false;
  if (kindWanted === KIND_BEND) return (cl.cMid[j] >= 0) === withMid;
  if (kindWanted === KIND_SHEAR) return cl.cTri[j * 2] >= 0;
  return true;
}

// Stable counting sort of the alive constraints of `kind` by level; calls emit(S, cl, j, slot).
// Runs at scene load and when anchors change (pins, fingers), never per frame.
function sortKind(S, cl, kindWanted, withMid, emit) {
  const count = S.count, L = S.maxLevel + 2;
  count.fill(0, 0, L + 1);
  for (let j = 0; j < cl.m; j++) if (wanted(cl, j, kindWanted, withMid)) count[levelOf(S, cl, j) + 1]++;
  for (let l = 1; l <= L; l++) count[l] += count[l - 1];
  for (let j = 0; j < cl.m; j++) if (wanted(cl, j, kindWanted, withMid)) emit(S, cl, j, count[levelOf(S, cl, j)]++);
  return count[L];
}

function emitStretch(S, cl, j, k) { S.sA[k] = cl.cA[j]; S.sB[k] = cl.cB[j]; S.sRest[k] = cl.rest[j]; S.sJ[k] = j; S.listPos[j] = k; const t = S.thrEff[j] * cl.rest[j]; S.sWatch[k] = t * t; }
function emitShear(S, cl, j, k) { S.hA[k] = cl.cA[j]; S.hB[k] = cl.cB[j]; S.hRest[k] = cl.rest[j]; S.hJ[k] = j; S.listPos[j] = k; }
function emitBend(S, cl, j, k) { S.bA[k] = cl.cA[j]; S.bM[k] = cl.cMid[j]; S.bC[k] = cl.cB[j]; S.bH0[k] = S.bendH0Cur[j]; S.bJ[k] = j; S.listPos[j] = k; }
function emitRaw(S, cl, j, k) { S.xA[k] = cl.cA[j]; S.xB[k] = cl.cB[j]; S.xRest[k] = cl.rest[j]; S.xJ[k] = j; S.listPos[j] = k; }

function fillLists(S, cl) {
  S.sN = sortKind(S, cl, KIND_STRETCH, false, emitStretch);
  S.hN = sortKind(S, cl, KIND_SHEAR, false, emitShear);
  S.bN = sortKind(S, cl, KIND_BEND, true, emitBend);
  S.xN = sortKind(S, cl, KIND_BEND, false, emitRaw);
  fillTris(S, cl);
  S.seenAlive = cl.constraintsAlive; S.seenTris = cl.trisAlive;
}

function fillTris(S, cl) {
  const { tri, triAlive, alias, piece } = cl, pieces = cl.pieces;
  let k = 0;
  for (let t = 0; t < cl.t; t++) {
    if (!triAlive[t]) continue;
    let a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
    const pa = a, pb = b, pc = c;
    if (alias[a] >= 0) a = alias[a]; if (alias[b] >= 0) b = alias[b]; if (alias[c] >= 0) c = alias[c];
    S.tA[k] = a; S.tB[k] = b; S.tC[k] = c; S.tT[k] = t;
    const pi = piece[pa], P = pieces[pi];
    S.tPiece[k] = pi;
    if (P && P.type === 'tube') {
      const ring = ((pa - P.start) / P.cols | 0) + ((pb - P.start) / P.cols | 0) + ((pc - P.start) / P.cols | 0);
      const tt = ring / (3 * Math.max(1, P.rows - 1));
      S.tPress[k] = 1 - 0.7 * tt;   // the open tail lets the air out: pressure falls toward it
      S.tRing[k] = tt;
    } else { S.tPress[k] = 0; S.tRing[k] = 0; }
    k++;
  }
  S.tN = k;
}

/** Drop dead entries from every pass list, keeping the order (stable filter). Cheap: O(list length). */
export function compact(S, cl) {
  const alive = cl.alive;
  let w = 0;
  for (let k = 0; k < S.sN; k++) {
    const j = S.sJ[k]; if (!alive[j]) continue;
    if (w !== k) { S.sA[w] = S.sA[k]; S.sB[w] = S.sB[k]; S.sRest[w] = S.sRest[k]; S.sWatch[w] = S.sWatch[k]; S.sJ[w] = j; }
    S.listPos[j] = w; w++;
  }
  S.sN = w; w = 0;
  for (let k = 0; k < S.hN; k++) {
    const j = S.hJ[k]; if (!alive[j]) continue;
    if (w !== k) { S.hA[w] = S.hA[k]; S.hB[w] = S.hB[k]; S.hRest[w] = S.hRest[k]; S.hJ[w] = j; }
    S.listPos[j] = w; w++;
  }
  S.hN = w; w = 0;
  for (let k = 0; k < S.bN; k++) {
    const j = S.bJ[k]; if (!alive[j]) continue;
    if (w !== k) { S.bA[w] = S.bA[k]; S.bM[w] = S.bM[k]; S.bC[w] = S.bC[k]; S.bH0[w] = S.bH0[k]; S.bComp[w] = S.bComp[k]; S.bJ[w] = j; }
    S.listPos[j] = w; w++;
  }
  S.bN = w; w = 0;
  for (let k = 0; k < S.xN; k++) {
    const j = S.xJ[k]; if (!alive[j]) continue;
    if (w !== k) { S.xA[w] = S.xA[k]; S.xB[w] = S.xB[k]; S.xRest[w] = S.xRest[k]; S.xComp[w] = S.xComp[k]; S.xJ[w] = j; }
    S.listPos[j] = w; w++;
  }
  S.xN = w;
  if (S.seenTris !== cl.trisAlive) {
    const triAlive = cl.triAlive;
    w = 0;
    for (let k = 0; k < S.tN; k++) {
      if (!triAlive[S.tT[k]]) continue;
      if (w !== k) {
        S.tA[w] = S.tA[k]; S.tB[w] = S.tB[k]; S.tC[w] = S.tC[k]; S.tT[w] = S.tT[k]; S.tPress[w] = S.tPress[k]; S.tPiece[w] = S.tPiece[k]; S.tRing[w] = S.tRing[k];
        S.triN[w * 3] = S.triN[k * 3]; S.triN[w * 3 + 1] = S.triN[k * 3 + 1]; S.triN[w * 3 + 2] = S.triN[k * 3 + 2];
      }
      w++;
    }
    S.tN = w;
  }
  S.seenAlive = cl.constraintsAlive; S.seenTris = cl.trisAlive; S.dirty = false;
}

/**
 * Threads: for each stretch segment, the segments that continue it in a straight line at either end
 * (in the rest shape). Tearing judges the strain along the thread, not one segment alone.
 */
export function initThreads(S, cl) {
  const P = cl.restPos, { cA, cB, kind, vcStart, vcList } = cl;
  for (let j = 0; j < cl.m; j++) {
    if (kind[j] !== KIND_STRETCH) continue;
    const a = cA[j], b = cB[j];
    let ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    for (let e = 0; e < 2; e++) {
      const v = e ? b : a, sgn = e ? 1 : -1; // at a, look backward along −u; at b, forward along +u
      let best = -1, bestDot = 0.85;
      for (let k = vcStart[v]; k < vcStart[v + 1]; k++) {
        const jj = vcList[k]; if (jj === j || kind[jj] !== KIND_STRETCH) continue;
        const o = cA[jj] === v ? cB[jj] : cA[jj];
        let wx = P[o * 3] - P[v * 3], wy = P[o * 3 + 1] - P[v * 3 + 1], wz = P[o * 3 + 2] - P[v * 3 + 2];
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
        const d = sgn * (wx * ux + wy * uy + wz * uz) / wl;
        if (d > bestDot) { bestDot = d; best = jj; }
      }
      if (e) S.threadNext[j] = best; else S.threadPrev[j] = best;
    }
    // the parallel threads beside this one: step sideways (⟂ u) from either end, then take the segment
    // that runs along u from there
    let ns = 0;
    for (let e = 0; e < 2 && ns < 4; e++) {
      const v = e ? b : a;
      for (let k = vcStart[v]; k < vcStart[v + 1] && ns < 4; k++) {
        const jj = vcList[k]; if (jj === j || kind[jj] !== KIND_STRETCH) continue;
        const o = cA[jj] === v ? cB[jj] : cA[jj];
        let wx = P[o * 3] - P[v * 3], wy = P[o * 3 + 1] - P[v * 3 + 1], wz = P[o * 3 + 2] - P[v * 3 + 2];
        const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
        if (Math.abs(wx * ux + wy * uy + wz * uz) / wl > 0.3) continue; // not sideways
        const sgn = e ? -1 : 1; // from a, the parallel runs along +u; from b, along −u
        for (let k2 = vcStart[o]; k2 < vcStart[o + 1]; k2++) {
          const j2 = vcList[k2]; if (j2 === jj || kind[j2] !== KIND_STRETCH) continue;
          const o2 = cA[j2] === o ? cB[j2] : cA[j2];
          const zx = P[o2 * 3] - P[o * 3], zy = P[o2 * 3 + 1] - P[o * 3 + 1], zz = P[o2 * 3 + 2] - P[o * 3 + 2];
          const zl = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
          if (sgn * (zx * ux + zy * uy + zz * uz) / zl < 0.85) continue;
          let dup = false; for (let q = 0; q < ns; q++) if (S.side[j * 4 + q] === j2) dup = true;
          if (!dup) S.side[j * 4 + ns++] = j2;
        }
      }
    }
  }
}

function strainOf(S, cl, j) {
  const p = S.P, a = cl.cA[j] * 3, b = cl.cB[j] * 3;
  const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) / cl.rest[j];
}

/** Material → per-pass compliance, per-bend compliance, tear thresholds (a fresh start for damage). */
export function applyMaterial(S, cl, mat) {
  S.aT = 1 / mat.stretchK;
  S.freeCompress = !(mat.compressK > 0);
  S.jam = mat.jam || 0.6;
  S.aC = S.freeCompress ? 1e9 : 1 / mat.compressK;
  S.aSh = 1 / mat.shearK;
  S.bendB = mat.bendLen * mat.bendLen * mat.bendLen * mat.density * GRAV; // N·m
  S.bendOn = S.bendB > 0;
  S.tearRatio = mat.tear;
  thresholds(S, cl);
  S.weakN = 0; S.weakHead = 0;
  // hold time: just over the threshold a thread lasts `tearTime`; 20 % over, ~60 % of that
  S.dmgRate = 1 / Math.max(0.005, mat.tearTime);
  S.rip = mat.rip || 0;
  refreshLists(S, cl);
}

/**
 * Tear thresholds per thread: the material's, times the scene's strength multiplier. Where the cloth is
 * fixed it is reinforced (a hem, a grommet, the pole sleeve): threads touching a pin are much stronger,
 * the next ring a little, so the load that funnels into a pin point doesn't rip it out by itself; a
 * finger pulling there rips the cloth a cell further in. Runs on material change and pin changes; it
 * resets damage and post-rip weakness.
 */
export function thresholds(S, cl) {
  const tear = S.tearRatio, pinned = cl.pinned, { vcStart, vcList, cA, cB } = cl;
  const nearPin = (v) => { if (pinned[v]) return 2; for (let k = vcStart[v]; k < vcStart[v + 1]; k++) { const j = vcList[k]; if (pinned[cA[j] === v ? cB[j] : cA[j]]) return 1; } return 0; };
  for (let j = 0; j < cl.m; j++) {
    let thr = cl.kind[j] === KIND_STRETCH && tear < 1e6 ? tear * Math.max(0.2, cl.strength[j]) : Infinity;
    if (thr < Infinity) {
      const r = Math.max(nearPin(cA[j]), nearPin(cB[j]));
      if (r === 2) thr = 1 + (thr - 1) * 2.2;
      else if (r === 1) thr = 1 + (thr - 1) * 1.4;
    }
    S.thrBase[j] = thr; S.thrEff[j] = thr; S.dmg[j] = 0; S.dmgT[j] = -1;
  }
  S.weakN = 0; S.weakHead = 0;
}

/**
 * After the pass lists were refilled (re-ordering keeps damage and weakness): per-bend compliance and
 * the tear watch of every listed thread from its current threshold.
 */
export function refreshLists(S, cl) {
  const B = S.bendB;
  // triangle bending (Kelager 2010): C = |x_m − (x_a + x_c)/2| − h0 ≈ Lθ/2, so k = 4B/L² with L the arm (rest_ac/2)
  for (let k = 0; k < S.bN; k++) { const r = cl.rest[S.bJ[k]]; S.bComp[k] = B > 0 ? (r * r) / (16 * B) : 1e9; }
  for (let k = 0; k < S.xN; k++) { const r = cl.rest[S.xJ[k]]; S.xComp[k] = B > 0 ? (r * r) / (16 * B) : 1e9; }
  for (let k = 0; k < S.sN; k++) { const t = S.thrEff[S.sJ[k]] * S.sRest[k]; S.sWatch[k] = t * t; }
}

/** Rest offsets of the bends' middle particles (curved rest shapes, e.g. a tube's rings, stay round). */
export function initBendRest(S, cl) {
  const P = cl.restPos;
  for (let j = 0; j < cl.m; j++) {
    const m = cl.cMid[j];
    if (cl.kind[j] !== KIND_BEND || m < 0) { S.bendH0Rest[j] = 0; continue; }
    const a = cl.cA[j] * 3, c = cl.cB[j] * 3, o = m * 3;
    const dx = P[o] - 0.5 * (P[a] + P[c]), dy = P[o + 1] - 0.5 * (P[a + 1] + P[c + 1]), dz = P[o + 2] - 0.5 * (P[a + 2] + P[c + 2]);
    S.bendH0Rest[j] = S.bendH0Cur[j] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

// ------------------------------------------------------------------------------------------ hot loops

/**
 * Predict: v += (g + f·w)·h, damped and clamped; prev = x; x += v·h. Skips kinematic particles (w = 0).
 * derive: first rebuild v from the last substep's motion (fuses the velocity pass into this one).
 */
export function predict(S, n, derive) {
  const w = S.W, p = S.P, q = S.Q, v = S.V, f = S.F, K = S.k;
  const gx = K[K_GX], gy = K[K_GY], gz = K[K_GZ], h = K[K_H], ih = K[K_IH], damp = K[K_DAMP], vmax2 = K[K_VMAX2];
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const wi = w[i];
    if (wi === 0) continue;
    let vx, vy, vz;
    if (derive) { vx = (p[o] - q[o]) * ih; vy = (p[o + 1] - q[o + 1]) * ih; vz = (p[o + 2] - q[o + 2]) * ih; }
    else { vx = v[o]; vy = v[o + 1]; vz = v[o + 2]; }
    vx = (vx + (gx + f[o] * wi) * h) * damp;
    vy = (vy + (gy + f[o + 1] * wi) * h) * damp;
    vz = (vz + (gz + f[o + 2] * wi) * h) * damp;
    const s2 = vx * vx + vy * vy + vz * vz;
    if (s2 > vmax2) { const k = Math.sqrt(vmax2 / s2); vx *= k; vy *= k; vz *= k; }
    v[o] = vx; v[o + 1] = vy; v[o + 2] = vz;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    q[o] = x; q[o + 1] = y; q[o + 2] = z;
    p[o] = x + vx * h; p[o + 1] = y + vy * h; p[o + 2] = z + vz * h;
  }
}

/** After the last substep: v = (x − prev)/h for every simulated particle. */
export function deriveVelocity(S, n) {
  const w = S.W, p = S.P, q = S.Q, v = S.V, ih = S.k[K_IH];
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    if (w[i] === 0) continue;
    v[o] = (p[o] - q[o]) * ih; v[o + 1] = (p[o + 1] - q[o + 1]) * ih; v[o + 2] = (p[o + 2] - q[o + 2]) * ih;
  }
}

/** Pins follow their anchors, interpolated across the frame's substeps (moving anchors don't jolt). */
export function pins(S, cl) {
  const L = S.pinList, N = S.pinN, p = S.P, q = S.Q, v = S.V, A = cl.anchor, A0 = S.anchorPrev, t = S.k[K_T], ih = S.k[K_IH];
  for (let k = 0; k < N; k++) {
    const o = L[k] * 3;
    const x = A0[o] + (A[o] - A0[o]) * t, y = A0[o + 1] + (A[o + 1] - A0[o + 1]) * t, z = A0[o + 2] + (A[o + 2] - A0[o + 2]) * t;
    q[o] = p[o]; q[o + 1] = p[o + 1]; q[o + 2] = p[o + 2];
    v[o] = (x - p[o]) * ih; v[o + 1] = (y - p[o + 1]) * ih; v[o + 2] = (z - p[o + 2]) * ih;
    p[o] = x; p[o + 1] = y; p[o + 2] = z;
  }
}

/**
 * Stretch pass. XPBD with λ starting at 0: Δλ = −C / (wa + wb + α/h²). Tension and compression get
 * different compliance (cloth buckles instead of acting like rubber). Tearing is judged once per frame
 * on the converged shape (tearPass), never here, where lengths still carry this substep's prediction.
 */
export function solveStretch(S, p, w) {
  const N = S.sN, A = S.sA, B = S.sB, R = S.sRest, ih2 = S.k[K_IH2];
  const aT = S.aT * ih2, aC = S.aC * ih2;
  for (let k = 0; k < N; k++) {
    const ia = A[k], ib = B[k];
    const a = ia * 3, b = ib * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz), C = len - R[k];
    const wa = w[ia], wb = w[ib];
    const s = C / (len * (wa + wb + (C > 0 ? aT : aC)) + 1e-12);
    const sa = s * wa, sb = s * wb;
    p[a] += dx * sa; p[a + 1] += dy * sa; p[a + 2] += dz * sa;
    p[b] -= dx * sb; p[b + 1] -= dy * sb; p[b + 2] -= dz * sb;
  }
}

/**
 * Stretch pass for free-compression materials (chainmail): rings slide freely together until they jam
 * at `jam` × rest, and nothing stretches. Two one-sided limits instead of a spring.
 */
export function solveStretchJam(S, p, w) {
  const N = S.sN, A = S.sA, B = S.sB, R = S.sRest, ih2 = S.k[K_IH2], aT = S.aT * ih2, jam = S.jam;
  for (let k = 0; k < N; k++) {
    const ia = A[k], ib = B[k];
    const a = ia * 3, b = ib * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz), r = R[k];
    let C = len - r;
    if (C < 0) { C = len - jam * r; if (C >= 0) continue; }
    const wa = w[ia], wb = w[ib];
    const s = C / (len * (wa + wb + aT) + 1e-12);
    const sa = s * wa, sb = s * wb;
    p[a] += dx * sa; p[a + 1] += dy * sa; p[a + 2] += dz * sa;
    p[b] -= dx * sb; p[b + 1] -= dy * sb; p[b + 2] -= dz * sb;
  }
}

/** Shear pass: the diagonals, one soft compliance. */
export function solveShear(S, p, w) {
  const N = S.hN, A = S.hA, B = S.hB, R = S.hRest, ih2 = S.k[K_IH2];
  const al = S.aSh * ih2;
  for (let k = 0; k < N; k++) {
    const ia = A[k], ib = B[k];
    const a = ia * 3, b = ib * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz), C = len - R[k];
    const wa = w[ia], wb = w[ib];
    const s = C / (len * (wa + wb + al) + 1e-12);
    const sa = s * wa, sb = s * wb;
    p[a] += dx * sa; p[a + 1] += dy * sa; p[a + 2] += dz * sa;
    p[b] -= dx * sb; p[b + 1] -= dy * sb; p[b + 2] -= dz * sb;
  }
}

/**
 * Bend pass (triangle bending, Kelager et al. 2010): the middle particle's distance from the midpoint
 * of its two neighbours, C = |x_m − (x_a + x_c)/2| − h0. First order in the bend angle (a real bending
 * energy, unlike skip-one springs that only wake up when the cloth is already folded).
 */
export function solveBend(S, p, w) {
  const N = S.bN, A = S.bA, M = S.bM, Cc = S.bC, H0 = S.bH0, K = S.bComp, ih2 = S.k[K_IHB2];
  for (let k = 0; k < N; k++) {
    const ia = A[k], im = M[k], ic = Cc[k];
    const a = ia * 3, m = im * 3, c = ic * 3;
    const dx = p[m] - 0.5 * (p[a] + p[c]), dy = p[m + 1] - 0.5 * (p[a + 1] + p[c + 1]), dz = p[m + 2] - 0.5 * (p[a + 2] + p[c + 2]);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz), C = len - H0[k];
    const wa = w[ia], wm = w[im], wc = w[ic];
    const s = C / (len * (wm + 0.25 * (wa + wc) + K[k] * ih2) + 1e-12);
    const sm = s * wm, sa = 0.5 * s * wa, sc = 0.5 * s * wc;
    p[m] -= dx * sm; p[m + 1] -= dy * sm; p[m + 2] -= dz * sm;
    p[a] += dx * sa; p[a + 1] += dy * sa; p[a + 2] += dz * sa;
    p[c] += dx * sc; p[c + 1] += dy * sc; p[c + 2] += dz * sc;
  }
}

/** Raw bend constraints a–c without a middle particle (only if a scene adds them): soft distances. */
export function solveRawBend(S, p, w) {
  const N = S.xN, A = S.xA, B = S.xB, R = S.xRest, K = S.xComp, ih2 = S.k[K_IHB2];
  for (let k = 0; k < N; k++) {
    const ia = A[k], ib = B[k];
    const a = ia * 3, b = ib * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz), C = len - R[k];
    if (C > 0) continue; // a skip-one spring only resists folding (compression)
    const wa = w[ia], wb = w[ib];
    const s = C / (len * (wa + wb + K[k] * ih2) + 1e-12);
    p[a] += dx * s * wa; p[a + 1] += dy * s * wa; p[a + 2] += dz * s * wa;
    p[b] -= dx * s * wb; p[b + 1] -= dy * s * wb; p[b + 2] -= dz * s * wb;
  }
}

// ------------------------------------------------------------------------------------------ tearing

/**
 * Once per frame, on the shape the substeps converged to: the most stretched thread (stats.tension),
 * and tearing. A thread over its threshold takes damage (faster the further over) and snaps when the
 * damage fills (the hold time, `tearTime`); a calm spell heals it; a violent overstretch (60 % past the
 * threshold) snaps at once. So gusts and jitter never tear and a sustained, hard pull always does. The
 * max strain goes to k[K_TENSION].
 */
export function tearPass(S, cl, world) {
  const dt = S.k[K_DT], p = S.P, N = S.sN, A = S.sA, B = S.sB, R = S.sRest, W2 = S.sWatch, alive = cl.alive;
  let mx = 1;
  for (let k = 0; k < N; k++) {
    const a = A[k] * 3, b = B[k] * 3;
    const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
    const d2 = dx * dx + dy * dy + dz * dz, r = R[k], q = d2 / (r * r);
    if (q > mx) mx = q;
    if (d2 <= W2[k]) continue;
    const j = S.sJ[k];
    if (!alive[j]) continue;
    // nonlocal: the strain ALONG THE THREAD (this segment weighted twice, plus the segments continuing
    // it). A lone overstretched segment between relaxed ones is a corner singularity, not a failing
    // thread; a band pulled by a finger is. A missing neighbour (a cut, the cloth's edge) counts as
    // this segment, so threads at a fresh rip's tip are judged on their own strain and the rip runs.
    const s = Math.sqrt(q), jp = S.threadPrev[j], jn = S.threadNext[j];
    const sp = jp >= 0 && alive[jp] ? strainOf(S, cl, jp) : s, sn = jn >= 0 && alive[jn] ? strainOf(S, cl, jn) : s;
    const thr = S.thrEff[j], over = (2 * s + sp + sn) * 0.25 / thr - 1;
    if (over <= 0) continue;
    // hold time: a thread must stay over its threshold this long to fail (gusts don't, pulls do); at a
    // fresh rip's tip (weakened) it fails four times faster, which is what makes the rip run
    const now = S.k[K_TIME];
    if (now - S.dmgT[j] > 0.05) S.dmg[j] = 0;
    S.dmgT[j] = now;
    S.dmg[j] += dt * S.dmgRate * (thr < S.thrBase[j] ? 4 : 1) * (1 + 3 * over);
    if ((over > 0.6 || S.dmg[j] >= 1) && S.tearsThisFrame < TEAR_CAP) {
      S.tearsThisFrame++;
      tear(S, j, world);
    }
  }
  S.k[K_TENSION] = Math.sqrt(mx);
}

/** Snap thread j: break it (events.tear) and weaken the threads around it for a moment, so it runs. */
export function tear(S, j, world) {
  const cl = world.cloth;
  breakConstraint(world, j, true);
  S.dirty = true;
  // the crack zone: two rings around the torn thread let go of their tethers for a moment, so the crack
  // can open and pass its load to the threads at its tip
  if (S.tether) {
    const T = S.tether, until = S.k[K_TIME] + 0.3, q = S.queue, st = S.stamp, stamp = ++S.stampN;
    let qh = 0, qt = 0;
    q[qt++] = cl.cA[j]; q[qt++] = cl.cB[j]; st[cl.cA[j]] = stamp; st[cl.cB[j]] = stamp;
    for (let ring = 0; ring < 2; ring++) {
      const end = qt;
      while (qh < end) {
        const u = q[qh++];
        for (let k = cl.vcStart[u]; k < cl.vcStart[u + 1]; k++) {
          const jj = cl.vcList[k]; if (cl.kind[jj] === KIND_BEND) continue;
          const o = cl.cA[jj] === u ? cl.cB[jj] : cl.cA[jj];
          if (st[o] !== stamp && qt < q.length) { st[o] = stamp; q[qt++] = o; }
        }
      }
    }
    for (let k = 0; k < qt; k++) T.looseUntil[q[k]] = until;
  }
  if (S.rip <= 0) return;
  // a torn thread's load jumps to the parallel threads beside it (the crack tip): they are weakened
  // and fail faster, so the rip runs ACROSS the pull, along the weave, as fabric really tears
  const f = 1 - S.rip, until = S.k[K_TIME] + WEAK_TIME;
  for (let e = 0; e < 4; e++) {
    const jj = S.side[j * 4 + e];
    if (jj < 0 || !cl.alive[jj]) continue;
    const t = Math.max(1.02, 1 + (S.thrBase[jj] - 1) * f);
    if (t >= S.thrEff[jj]) continue;
    S.thrEff[jj] = t;
    const pos = S.listPos[jj];
    if (pos < S.sN && S.sJ[pos] === jj) { const L = t * S.sRest[pos]; S.sWatch[pos] = L * L; }
    if (S.weakN < WEAK_CAP) {
      const slot = (S.weakHead + S.weakN) % WEAK_CAP;
      S.weakJ[slot] = jj; S.weakT[slot] = until; S.weakN++;
    }
  }
}

/** Restore the thresholds of threads whose post-rip weakness has worn off. */
export function expireWeak(S, cl) {
  while (S.weakN > 0 && S.weakT[S.weakHead] <= S.k[K_TIME]) {
    const jj = S.weakJ[S.weakHead];
    S.weakHead = (S.weakHead + 1) % WEAK_CAP; S.weakN--;
    S.thrEff[jj] = S.thrBase[jj];
    if (!cl.alive[jj]) continue;
    const pos = S.listPos[jj];
    if (pos < S.sN && S.sJ[pos] === jj) { const L = S.thrEff[jj] * S.sRest[pos]; S.sWatch[pos] = L * L; }
  }
}

// A crease sets only where the cloth is still: full rate at rest, none at CREEP_V (m/s) and faster; it relaxes at
// any speed. Folds made mid-air (a flick, a fall) used to set while they flew, so a flicked cotton cloth landed
// with its fold baked in and hung folded up on itself "like glue" (Josh, 2026-10-13). Crumpled on the floor, or
// pressed and held, it still creases as before.
const CREEP_V = 0.3, CREEP_IV2 = 1 / (CREEP_V * CREEP_V);

/**
 * Plasticity: a bend held well past its yield slowly sets (its rest offset creeps toward the fold), so
 * crumpled cotton, denim and foil keep their creases. Flattening a crease past the yield relaxes it.
 */
export function creep(S, cl, mat) {
  const rate = mat.crease * 2.5 * S.k[K_DT];
  if (!(rate > 0)) return;
  const p = S.P, v = S.V, rest = cl.rest, N = S.bN, A = S.bA, M = S.bM, Cc = S.bC, H0 = S.bH0, J = S.bJ, yf = mat.creaseYield;
  for (let k = 0; k < N; k++) {
    const a = A[k] * 3, m = M[k] * 3, c = Cc[k] * 3;
    const dx = p[m] - 0.5 * (p[a] + p[c]), dy = p[m + 1] - 0.5 * (p[a + 1] + p[c + 1]), dz = p[m + 2] - 0.5 * (p[a + 2] + p[c + 2]);
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz), arm = 0.5 * rest[J[k]], y = yf * arm, h0 = H0[k];
    const ex = d - h0;
    if (ex > y) {
      const s2 = (v[m] * v[m] + v[m + 1] * v[m + 1] + v[m + 2] * v[m + 2]) * CREEP_IV2;
      if (s2 < 1) { const t = h0 + (ex - y) * rate * (1 - Math.sqrt(s2)); H0[k] = t < 0.7 * arm ? t : 0.7 * arm; }
    } else if (ex < -y) { const t = h0 + (ex + y) * rate; H0[k] = t > 0 ? t : 0; }
  }
}
