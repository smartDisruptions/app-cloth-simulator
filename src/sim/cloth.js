// Cloth physics: XPBD "small steps" (Macklin et al. 2019). See solver.js for the core and tearing,
// tether.js for long-range attachments, aero.js for the air, grab.js for the fingers, collide.js for
// contacts, topology.js for tearing's bookkeeping.
//
// A frame: copy in → grabs (fingers are anchors) → re-order / re-tether if anchors or topology changed →
// masses (wet weight) → air forces → contact candidates → N substeps of [predict → pins → grabs →
// stretch → shear → bend (half rate) → tethers → contacts] → velocities → guard → copy out → tearing
// (on the converged shape) → creases → normals → aliases → stats. N targets a fixed substep
// (1/(60·q.substeps) s), so a 120 Hz screen runs half as many per frame and the cost per second stays
// put; q.substeps caps it when frames run long.
import { SIM_MATERIALS } from './materials.js';
import { KIND_STRETCH, createBuilder } from './builder.js';
import { MAX_POINTERS } from '../core/world.js';
import { rand } from '../core/rng.js';
import { breakConstraint as breakC, killVertex as killV } from './topology.js';
import {
  createState, buildOrder, compact, applyMaterial, thresholds, refreshLists, initBendRest, initThreads, expireWeak, creep, tearPass,
  K_DT, K_H, K_IH, K_IH2, K_IHB2, K_GX, K_GY, K_GZ, K_DAMP, K_VMAX2, K_T, K_TENSION, K_TIME,
  predict, deriveVelocity, pins, solveStretch, solveStretchJam, solveShear, solveBend, solveRawBend,
} from './solver.js';
import { aero } from './aero.js';
import { createGrabState, grabFrame, grabSub } from './grab.js';
import { createContactState, findContacts, resolveContacts } from './collide.js';
import { createTetherState, buildTethers, solveTethers, tightenTethers } from './tether.js';
import { createSelfState, selfCollide } from './selfcollide.js';

const VMAX = 25;          // m/s: no particle ever moves faster (a last line against explosions)
const SLICE_KICK = 0.45;  // m/s along the blade
const SLICE_PART = 0.25;  // m/s: the two sides of a cut spring apart
const STAGE = 25;         // m from the camera target: scraps blown beyond it are retired
const SELF = true;        // approximate self-collision (selfcollide.js)
let mat = SIM_MATERIALS.cotton;
const sdir = new Float32Array(3);

export function init() {}

/** A new cloth exists (world.cloth). Build the solver state, apply the current material. */
export function onScene(world) {
  const cl = world.cloth; if (!cl) return;
  attach(cl);
  onMaterial(world);
  computeNormals(cl);
  imperfect(cl);
  computeNormals(cl);
  syncAliases(cl);
  cl.solver.oldN.set(cl.normal);
  const st = world.stats;
  st.kinetic = 0; st.flutter = 0; st.tension = 1;
  cl.solver.k[K_DT] = 1 / 60; cl.solver.k[K_TENSION] = 1;
  stats(world, cl, cl.solver, 0);
}

function attach(cl) {
  const S = createState(cl);
  S.grab = createGrabState(MAX_POINTERS);
  S.contact = createContactState(cl.n);
  initBendRest(S, cl);
  initThreads(S, cl);
  S.thrBase.fill(Infinity); S.thrEff.fill(Infinity);
  buildOrder(S, cl);
  let sum = 0, k = 0;
  for (let j = 0; j < cl.m; j++) if (cl.kind[j] === KIND_STRETCH) { sum += cl.rest[j]; k++; }
  S.meanEdge = k ? sum / k : 0.05;
  S.grabRadius = Math.max(0.055, 1.6 * S.meanEdge);
  S.hasTube = cl.pieces.some((P) => P.type === 'tube');
  S.tether = createTetherState(cl.n, cl.m);
  S.tether.clock = S.k;
  S.self = createSelfState(cl.n);
  buildTethers(S.tether, cl, S.kin, 0.04 * S.meanEdge, cl.pos, 0.5 * S.meanEdge);
  cl.solver = S;
  return S;
}

/**
 * Real cloth is never perfectly flat: a sub-millimetre, deterministic ripple along the normals lets a
 * sheet buckle into folds the way fabric does, instead of deforming inside its own plane (a perfectly
 * planar banner in still air would otherwise have to droop by stretching).
 */
function imperfect(cl) {
  const p = cl.pos, q = cl.prev, N = cl.normal, amp = Math.min(0.0015, 0.04 * cl.solver.meanEdge);
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    if (cl.pinned[i] || cl.alias[i] >= 0) continue;
    const r = (rand() - 0.5) * 2 * amp;
    p[o] += N[o] * r; p[o + 1] += N[o + 1] * r; p[o + 2] += N[o + 2] * r;
    q[o] = p[o]; q[o + 1] = p[o + 1]; q[o + 2] = p[o + 2];
  }
}

/** world.materialId changed (or a new scene): masses, compliances, tear thresholds. */
export function onMaterial(world) {
  mat = SIM_MATERIALS[world.materialId] || SIM_MATERIALS.cotton;
  const cl = world.cloth; if (!cl) return;
  for (let i = 0; i < cl.n; i++) cl.mass0[i] = Math.max(cl.area[i], 1e-6) * mat.density;
  if (cl.solver) applyMaterial(cl.solver, cl, mat);
}

/** The current material's physics parameters (other modules may read: e.g. thickness). */
export function material() { return mat; }

/** Inverse masses for this frame (wet weight, pins, the grab centres) and the pin list. */
function refreshMass(S, cl) {
  const W = S.W, w32 = cl.invMass, { pinned, alias, mass0, massScale } = cl, kin = S.kin, L = S.pinList;
  let np = 0;
  for (let i = 0; i < cl.n; i++) {
    let wi = 0;
    if (alias[i] >= 0) wi = 0;
    else if (pinned[i]) L[np++] = i;
    else if (!kin[i]) { const ms = massScale[i]; wi = 1 / (mass0[i] * (ms > 0.05 && ms < 50 ? ms : 1)); }
    W[i] = wi; w32[i] = wi;
  }
  S.pinN = np;
}

/** Advance the cloth by dt simulated seconds. Reads gravity, wind, colliders, pointers, anchors. */
export function step(world, dt) {
  const cl = world.cloth; if (!cl) return;
  const S = cl.solver || attach(cl);
  if (!(dt > 0)) return;
  const maxSub = Math.max(1, world.q ? world.q.substeps | 0 : 8);
  let sub = Math.ceil(dt * 60 * maxSub - 1e-3);
  sub = sub < 1 ? 1 : sub > maxSub ? maxSub : sub;
  const h = dt / sub, ih = 1 / h, K = S.k;
  K[K_DT] = dt; K[K_H] = h; K[K_IH] = ih; K[K_IH2] = ih * ih;
  S.tearsThisFrame = 0;
  if (S.seenAlive !== cl.constraintsAlive || S.seenTris !== cl.trisAlive) { compact(S, cl); S.tetherDirty = true; }
  expireWeak(S, cl);
  // copy in: anyone may have nudged the cloth between frames (a slice's kick, a pin, an impulse)
  const p = S.P, q = S.Q, v = S.V, f = S.F, w = S.W, n = cl.n;
  p.set(cl.pos); q.set(cl.prev); v.set(cl.vel);
  grabFrame(world, cl, S); // fingers are anchors: a grab starting or ending re-orders and re-tethers
  if (S.pinsDirty) { thresholds(S, cl); S.pinsDirty = false; }
  if (S.orderDirty) { buildOrder(S, cl); refreshLists(S, cl); S.tetherDirty = true; }
  // re-tether when anchors or threads changed, at most every other frame while a rip runs or fire eats
  // the cloth (in between, stale tethers are simply skipped: they are born slack, so nothing yanks)
  if (S.tetherDirty && S.tetherCool <= 0) { buildTethers(S.tether, cl, S.kin, 0.04 * S.meanEdge, p, 0.5 * S.meanEdge); S.tetherDirty = false; S.tetherCool = 2; }
  S.tetherCool--;
  tightenTethers(S.tether, K);
  refreshMass(S, cl);
  aero(world, cl, S, mat);
  findContacts(world, cl, S, mat);

  const g = world.gravity;
  K[K_GX] = g[0] === g[0] ? g[0] : 0; K[K_GY] = g[1] === g[1] ? g[1] : -9.81; K[K_GZ] = g[2] === g[2] ? g[2] : 0;
  K[K_DAMP] = Math.exp(-mat.damping * h); K[K_VMAX2] = VMAX * VMAX;
  let grabbing = false;
  for (let k = 0; k < S.grab.v.length; k++) if (S.grab.v[k] >= 0) grabbing = true;
  const tethers = S.tether.on;
  let bendDue = 0;
  for (let s = 0; s < sub; s++) {
    K[K_T] = (s + 1) / sub;
    predict(S, n, s > 0);
    if (S.pinN) pins(S, cl);
    if (grabbing) grabSub(world, cl, S);
    if (S.freeCompress) solveStretchJam(S, p, w); else solveStretch(S, p, w);
    solveShear(S, p, w);
    // bending is soft: solve it at half rate with the matching step (XPBD stays consistent: α/(2h)²)
    if (S.bendOn && (++bendDue === 2 || s === sub - 1)) {
      const hb = h * bendDue;
      K[K_IHB2] = 1 / (hb * hb);
      solveBend(S, p, w); if (S.xN) solveRawBend(S, p, w);
      bendDue = 0;
    }
    if (tethers && !S.tetherDirty) solveTethers(S.tether, p, w, cl.massScale);
    resolveContacts(world, cl, S, mat);
    K[K_TIME] += h;
    if (S.dirty) { compact(S, cl); S.tetherDirty = true; } // topology changed mid-frame: tethers wait for the next frame
  }
  deriveVelocity(S, n);
  // layers of cloth keep apart (approximate self-collision; every tier can afford it once a frame)
  // self-collision every frame, or every other frame on the low tier (old phones)
  if (SELF && (!world.q || world.q.name !== 'low' || (world.frame & 1) === 0)) S.selfPushes = selfCollide(S.self, cl, p, v, w, Math.max(0.006, Math.min(0.45 * S.meanEdge, 0.04)));
  guard(world, cl, S);
  // copy out: the world sees the new state (Float32 for GL and everyone else)
  cl.pos.set(p); cl.prev.set(q); cl.vel.set(v); cl.force.set(f);
  tearPass(S, cl, world);
  if (S.dirty) { compact(S, cl); S.tetherDirty = true; }
  if (mat.crease > 0) creep(S, cl, mat);
  S.oldN.set(cl.normal);
  computeNormals(cl);
  syncAliases(cl);
  stats(world, cl, S, sub);
  S.anchorPrev.set(cl.anchor);
}

/**
 * Last line of defence: a particle that went non-finite is put back where it can't hurt. A scrap that
 * left the stage (blown away in a gale) is retired: its threads go, so it stops costing anything and
 * stops stretching everyone's bounds.
 */
function guard(world, cl, S) {
  const p = S.P, q = S.Q, v = S.V, alias = cl.alias, vTri = cl.vTri, t = world.cameraRig ? world.cameraRig.target : null;
  const R2 = STAGE * STAGE, tx = t ? t[0] : 0, ty = t ? t[1] : 0, tz = t ? t[2] : 0;
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    if (alias[i] >= 0) continue;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    if (x === x && y === y && z === z && x < 1e4 && x > -1e4 && y < 1e4 && y > -1e4 && z < 1e4 && z > -1e4) {
      if (vTri[i] && (x - tx) * (x - tx) + (y - ty) * (y - ty) + (z - tz) * (z - tz) > R2 && !cl.pinned[i]) killV(world, i);
      continue;
    }
    const src = cl.pinned[i] ? cl.anchor : cl.restPos;
    for (let a = 0; a < 3; a++) {
      const b = q[o + a];
      p[o + a] = b === b && b < 1e4 && b > -1e4 ? b : src[o + a];
      q[o + a] = p[o + a]; v[o + a] = 0;
    }
    S.nanFixes++;
  }
}

function stats(world, cl, S, sub) {
  const dt = S.k[K_DT];
  const st = world.stats, v = cl.vel, b = cl.bounds, p = cl.pos, N = cl.normal, N0 = S.oldN, vTri = cl.vTri, alias = cl.alias;
  let ke = 0, cnt = 0, fl = 0;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    if (alias[i] >= 0 || !vTri[i]) continue;
    const x = p[o], y = p[o + 1], z = p[o + 2];
    cnt++;
    ke += Math.sqrt(v[o] * v[o] + v[o + 1] * v[o + 1] + v[o + 2] * v[o + 2]);
    const dx = N[o] - N0[o], dy = N[o + 1] - N0[o + 1], dz = N[o + 2] - N0[o + 2];
    fl += dx * dx + dy * dy + dz * dz;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (cnt) { b.min[0] = x0; b.min[1] = y0; b.min[2] = z0; b.max[0] = x1; b.max[1] = y1; b.max[2] = z1; }
  const kinetic = cnt ? ke / cnt : 0;
  // flutter: RMS angular speed of the surface normals (rad/s): 0 hanging still, ~2–6 in a breeze,
  // 10–30 for a flag snapping in a gale. A clean flapping signal for audio.
  const rate = cnt && dt > 0 ? Math.sqrt(fl / cnt) / dt : 0;
  st.flutter = st.flutter * 0.75 + rate * 0.25;
  st.kinetic = kinetic; st.substeps = sub; st.tension = S.k[K_TENSION];
  st.verts = cl.n; st.constraints = cl.m; st.constraintsAlive = cl.constraintsAlive; st.tris = cl.t; st.trisAlive = cl.trisAlive;
}

/** Area-weighted vertex normals over alive triangles (aliases share their master's normal). */
export function computeNormals(cl) {
  const S = cl.solver, N = cl.normal, p = cl.pos;
  N.fill(0);
  if (S) {
    if (S.seenAlive !== cl.constraintsAlive || S.seenTris !== cl.trisAlive) compact(S, cl);
    const A = S.tA, B = S.tB, C = S.tC, TN = S.triN;
    for (let k = 0; k < S.tN; k++) {
      const a = A[k] * 3, b = B[k] * 3, c = C[k] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      TN[k * 3] = nx; TN[k * 3 + 1] = ny; TN[k * 3 + 2] = nz;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
      N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
      N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
  } else {
    const { tri, triAlive, alias } = cl;
    for (let t = 0; t < cl.t; t++) {
      if (!triAlive[t]) continue;
      let ia = tri[t * 3], ib = tri[t * 3 + 1], ic = tri[t * 3 + 2];
      if (alias[ia] >= 0) ia = alias[ia]; if (alias[ib] >= 0) ib = alias[ib]; if (alias[ic] >= 0) ic = alias[ic];
      const a = ia * 3, b = ib * 3, c = ic * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      N[a] += nx; N[a + 1] += ny; N[a + 2] += nz; N[b] += nx; N[b + 1] += ny; N[b + 2] += nz; N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
    }
  }
  for (let i = 0, o = 0; i < cl.n; i++, o += 3) {
    const x = N[o], y = N[o + 1], z = N[o + 2], l2 = x * x + y * y + z * z;
    if (l2 > 1e-24) { const k = 1 / Math.sqrt(l2); N[o] = x * k; N[o + 1] = y * k; N[o + 2] = z * k; }
    else { N[o] = 0; N[o + 1] = 0; N[o + 2] = 1; }
  }
}

/** Copy every per-vertex field from each seam master to its alias. Runs at the end of every step. */
export function syncAliases(cl) {
  const L = cl.solver ? cl.solver.aliasList : null;
  const n = L ? L.length : cl.n;
  const { pos, prev, vel, normal, heat, fuel, char, wet, alias } = cl;
  for (let k = 0; k < n; k++) {
    const i = L ? L[k] : k, m = alias[i];
    if (m < 0) continue;
    const o = i * 3, mo = m * 3;
    pos[o] = pos[mo]; pos[o + 1] = pos[mo + 1]; pos[o + 2] = pos[mo + 2];
    prev[o] = prev[mo]; prev[o + 1] = prev[mo + 1]; prev[o + 2] = prev[mo + 2];
    vel[o] = vel[mo]; vel[o + 1] = vel[mo + 1]; vel[o + 2] = vel[mo + 2];
    normal[o] = normal[mo]; normal[o + 1] = normal[mo + 1]; normal[o + 2] = normal[mo + 2];
    heat[i] = heat[m]; fuel[i] = fuel[m]; char[i] = char[m]; wet[i] = wet[m];
  }
}

/** Break constraint j (and what depends on it). emitTear: push a tear event. Safe on a dead one. */
export function breakConstraint(world, j, emitTear) { breakC(world, j, emitTear); }

/** Break every constraint at vertex v (fire burnt it through). v should be a master. */
export function killVertex(world, v) { killV(world, v); }

/**
 * The cloth under a screen point (css px): the front-most alive triangle that contains the point, and its
 * corner nearest the finger. Off the cloth's surface, the nearest visible vertex within `radius`,
 * preferring the front layer. Returns the MASTER index, or -1. Uses world.screen (what the user saw).
 */
export function pick(world, x, y, radius = 40) {
  const cl = world.cloth; if (!cl) return -1;
  const s = world.screen; if (!s || s.length < cl.n * 3) return -1;
  const S = cl.solver;
  if (S && (S.seenAlive !== cl.constraintsAlive || S.seenTris !== cl.trisAlive)) compact(S, cl);
  const tri = cl.tri;
  let best = -1, bestZ = Infinity;
  const NT = S ? S.tN : cl.t;
  for (let k = 0; k < NT; k++) {
    const t = S ? S.tT[k] : k;
    if (!S && !cl.triAlive[t]) continue;
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ax = s[a], ay = s[a + 1], bx = s[b], by = s[b + 1], cx = s[c], cy = s[c + 1];
    if ((x < ax && x < bx && x < cx) || (x > ax && x > bx && x > cx) || (y < ay && y < by && y < cy) || (y > ay && y > by && y > cy)) continue;
    const az = s[a + 2], bz = s[b + 2], cz = s[c + 2];
    if (az <= 0 || bz <= 0 || cz <= 0) continue;
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (d > -1e-9 && d < 1e-9) continue;
    const l0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    const l1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
    const z = 1 / (l0 / az + l1 / bz + l2 / cz); // perspective-correct view depth
    if (z < bestZ) {
      bestZ = z;
      // the corner nearest the finger
      const da = (ax - x) * (ax - x) + (ay - y) * (ay - y), db = (bx - x) * (bx - x) + (by - y) * (by - y), dc = (cx - x) * (cx - x) + (cy - y) * (cy - y);
      best = da <= db && da <= dc ? tri[t * 3] : db <= dc ? tri[t * 3 + 1] : tri[t * 3 + 2];
    }
  }
  if (best < 0) {
    const r2 = radius * radius;
    let minDepth = Infinity;
    for (let i = 0; i < cl.n; i++) {
      if (!cl.vTri[i]) continue;
      const o = i * 3, dz = s[o + 2]; if (dz <= 0) continue;
      const dx = s[o] - x, dy = s[o + 1] - y;
      if (dx * dx + dy * dy <= r2 && dz < minDepth) minDepth = dz;
    }
    if (minDepth === Infinity) return -1;
    let bestD2 = Infinity;
    for (let i = 0; i < cl.n; i++) {
      if (!cl.vTri[i]) continue;
      const o = i * 3, dz = s[o + 2]; if (dz <= 0 || dz > minDepth + 0.12) continue;
      const dx = s[o] - x, dy = s[o + 1] - y, d2 = dx * dx + dy * dy;
      if (d2 <= r2 && d2 < bestD2) { bestD2 = d2; best = i; }
    }
  }
  return best >= 0 && cl.alias[best] >= 0 ? cl.alias[best] : best;
}

// Does the screen segment a–b (vertex screen coords) cross the swipe (x0,y0)→(x1,y1)?
function crosses(s, a, b, x0, y0, rx, ry, minX, maxX, minY, maxY) {
  if (s[a + 2] <= 0 || s[b + 2] <= 0) return false;
  const ax = s[a], ay = s[a + 1], bx = s[b], by = s[b + 1];
  if ((ax < minX && bx < minX) || (ax > maxX && bx > maxX) || (ay < minY && by < minY) || (ay > maxY && by > maxY)) return false;
  const qx = bx - ax, qy = by - ay, den = rx * qy - ry * qx;
  if (den > -1e-9 && den < 1e-9) return false;
  const t = ((ax - x0) * qy - (ay - y0) * qx) / den, u = ((ax - x0) * ry - (ay - y0) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * The katana: cut every thread (stretch and shear, every layer) whose screen projection crosses the
 * swipe segment (css px). One events.cut per cut thread, one events.slice for the segment. The blade
 * drags the cloth a little along the swipe and the two lips spring apart. Returns the threads cut.
 */
export function slice(world, x0, y0, x1, y1) {
  const cl = world.cloth; if (!cl) return 0;
  const s = world.screen; if (!s || s.length < cl.n * 3) return 0;
  const S = cl.solver || attach(cl);
  if (S.seenAlive !== cl.constraintsAlive || S.seenTris !== cl.trisAlive) compact(S, cl);
  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const rx = x1 - x0, ry = y1 - y0;
  // blade direction in the world, from the camera basis (screen y points down)
  const cam = world.camera, R = cam.right, U = cam.up;
  sdir[0] = R[0] * rx - U[0] * ry; sdir[1] = R[1] * rx - U[1] * ry; sdir[2] = R[2] * rx - U[2] * ry;
  const sl = Math.sqrt(sdir[0] * sdir[0] + sdir[1] * sdir[1] + sdir[2] * sdir[2]);
  if (sl > 1e-9) { sdir[0] /= sl; sdir[1] /= sl; sdir[2] /= sl; }
  let count = 0, cx = 0, cy = 0, cz = 0;
  const p = cl.pos, vel = cl.vel, alive = cl.alive, w = cl.invMass;
  for (let pass = 0; pass < 2; pass++) {
    const N = pass ? S.hN : S.sN, LA = pass ? S.hA : S.sA, LB = pass ? S.hB : S.sB, LJ = pass ? S.hJ : S.sJ;
    for (let k = 0; k < N; k++) {
      const j = LJ[k]; if (!alive[j]) continue;
      const ia = LA[k], ib = LB[k];
      // screen positions: a master's own projection (aliases sit on top of their masters)
      if (!crosses(s, ia * 3, ib * 3, x0, y0, rx, ry, minX, maxX, minY, maxY)) continue;
      const a = ia * 3, b = ib * 3;
      const mx = (p[a] + p[b]) * 0.5, my = (p[a + 1] + p[b + 1]) * 0.5, mz = (p[a + 2] + p[b + 2]) * 0.5;
      cx += mx; cy += my; cz += mz;
      world.events.cut.push(mx, my, mz, j);
      breakC(world, j, false);
      count++;
      let ex = p[b] - p[a], ey = p[b + 1] - p[a + 1], ez = p[b + 2] - p[a + 2];
      const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1; ex /= el; ey /= el; ez /= el;
      if (w[ia] > 0) { vel[a] += sdir[0] * SLICE_KICK - ex * SLICE_PART; vel[a + 1] += sdir[1] * SLICE_KICK - ey * SLICE_PART; vel[a + 2] += sdir[2] * SLICE_KICK - ez * SLICE_PART; }
      if (w[ib] > 0) { vel[b] += sdir[0] * SLICE_KICK + ex * SLICE_PART; vel[b + 1] += sdir[1] * SLICE_KICK + ey * SLICE_PART; vel[b + 2] += sdir[2] * SLICE_KICK + ez * SLICE_PART; }
    }
  }
  if (count) { world.events.slice.push(cx / count, cy / count, cz / count, count); S.dirty = true; }
  return count;
}

/** Pin or unpin vertex v where it is now. Returns the new state (1 pinned). */
export function togglePin(world, v) {
  const cl = world.cloth; if (!cl || v < 0 || v >= cl.n) return 0;
  if (cl.alias[v] >= 0) v = cl.alias[v];
  cl.pinned[v] ^= 1;
  const o = v * 3, S = cl.solver;
  cl.anchor[o] = cl.pos[o]; cl.anchor[o + 1] = cl.pos[o + 1]; cl.anchor[o + 2] = cl.pos[o + 2];
  if (S) { S.anchorPrev[o] = cl.pos[o]; S.anchorPrev[o + 1] = cl.pos[o + 1]; S.anchorPrev[o + 2] = cl.pos[o + 2]; S.orderDirty = true; S.pinsDirty = true; }
  cl.vel[o] = cl.vel[o + 1] = cl.vel[o + 2] = 0;
  world.events.pin.push(cl.pos[o], cl.pos[o + 1], cl.pos[o + 2], cl.pinned[v]);
  return cl.pinned[v];
}

/**
 * Micro-benchmark for the quality governor: ns per constraint per substep on this device, timing the
 * REAL solver (a whole step: air, contacts, every pass, normals, stats) on a throwaway 32×32 sheet
 * hanging from its top edge in a breeze. ~30–120 ms. Leaves no state behind.
 */
export function benchmark() {
  const fake = {
    cloth: null, screen: null,
    events: { tear: { push() {} }, cut: { push() {} }, slice: { push() {} }, pin: { push() {} } },
    gravity: new Float32Array([0, -9.81, 0]),
    wind: { x: 2, y: 0, z: 0.4, sample(x, y, z, out) { out[0] = 2 + Math.sin(y * 3 + x); out[1] = 0; out[2] = 0.4; return out; } },
    colliders: { spheres: [], capsules: [], planes: [{ nx: 0, ny: 1, nz: 0, d: 0 }] },
    pointers: [], q: { substeps: 8 }, frameDt: 1 / 60,
    stats: { kinetic: 0, flutter: 0, tension: 1, substeps: 0, verts: 0, constraints: 0, constraintsAlive: 0, tris: 0, trisAlive: 0 },
  };
  const b = createBuilder();
  b.grid({ cols: 32, rows: 32, origin: [-0.8, 2, 0], u: [1.6, 0, 0], v: [0, -1.6, 0], pin: (c, r) => r === 0 });
  const cl = b.finalize(fake);
  const saved = mat;
  mat = SIM_MATERIALS.cotton;
  attach(cl); applyMaterial(cl.solver, cl, mat);
  for (let i = 0; i < cl.n; i++) cl.mass0[i] = Math.max(cl.area[i], 1e-6) * mat.density;
  computeNormals(cl);
  for (let k = 0; k < 8; k++) step(fake, 1 / 60);   // warm-up: let the JIT settle
  const frames = 6, t0 = performance.now();
  for (let k = 0; k < frames; k++) step(fake, 1 / 60);
  const ms = performance.now() - t0;
  mat = saved;
  return (ms * 1e6) / (frames * 8 * cl.m);
}
