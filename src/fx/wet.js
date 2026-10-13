// Wetness: water you can watch soak in, wick along the threads, run downhill, pool, drip and steam.
//
// Water is tracked in kilograms per master vertex, in two places:
//   A  absorbed: held in the fibres, up to cap = absorbency × the vertex's dry mass. Wicks along intact
//      stretch threads (capillary diffusion of saturation) and, once soaked, drains slowly downhill.
//   F  surface: beads, film and standing water. Soaks in at the material's rate; above a small pinned
//      film it RUNS toward the neighbour with the lower water surface (height + depth), so it streams
//      down a hanging cloth, collects in a sag, levels into a pool and spreads as the pool grows.
// Where surface water has nowhere lower to go it either holds (a pool on a flat interior) or leaves:
// over a hem, a torn edge or a steep fold it drips; through the weave of a pool it seeps and drips from
// below. Move the cloth fast and it throws its water. Heat boils it off as steam.
//
// Outputs (the contract): cloth.wet (0..1 how wet it LOOKS), cloth.massScale (1 + water ÷ dry mass,
// capped at 3× for the solver: soaked cotton weighs 2.5×, pooled 3×; the aurora film at most 2×), stats.wetness.
// Extra, for anyone who wants it: cloth.pool (m) — depth of standing water above the cloth surface at
// each vertex (0 = none). A renderer can draw a water skin at pos + (0, pool, 0).
import { PK } from '../core/world.js';
import { rand } from '../core/rng.js';
import { spawn } from '../render/particles.js';
import { SIM_MATERIALS } from '../sim/materials.js';

// Per material (ids from core/materials.js):
//   absorb  kg the fibres hold per kg of dry fabric (cotton soaked ≈ 2.5× its dry weight)
//   soak    1/s   how fast surface water sinks in            wick  m²/s  capillary spread along threads
//   drain   m/s   soaked fabric draining downhill           flow  m/s   surface water running down a slope
//   pin     kg/m² surface water that stays put (beads, film) before it runs
//   seep    1/s   standing water seeping through the weave   evap  × the base drying rate
//   film    kg/m² surface water at which a water-repellent surface looks fully wet
//   heavy   how much of the global mass cap this fabric may take on (light films tear under a full load)
const WET = {
  cotton:    { absorb: 1.5,  soak: 1.6,  wick: 0.0040, drain: 0.020, flow: 0.45, pin: 0.020, seep: 0.05, evap: 1.0, film: 0.030, heavy: 1.0 },
  silk:      { absorb: 1.2,  soak: 6.0,  wick: 0.0070, drain: 0.030, flow: 0.60, pin: 0.012, seep: 0.08, evap: 1.4, film: 0.020, heavy: 1.0 },
  denim:     { absorb: 1.0,  soak: 0.35, wick: 0.0018, drain: 0.010, flow: 0.40, pin: 0.030, seep: 0.02, evap: 0.7, film: 0.040, heavy: 1.0 },
  velvet:    { absorb: 2.4,  soak: 1.0,  wick: 0.0025, drain: 0.012, flow: 0.30, pin: 0.050, seep: 0.03, evap: 0.6, film: 0.050, heavy: 1.0 },
  chainmail: { absorb: 0.0,  soak: 0.0,  wick: 0,      drain: 0,     flow: 1.40, pin: 0.006, seep: 0.90, evap: 1.6, film: 0.012, heavy: 1.0 },
  aurora:    { absorb: 0.05, soak: 0.3,  wick: 0.0005, drain: 0.005, flow: 1.10, pin: 0.008, seep: 0.0,  evap: 1.2, film: 0.015, heavy: 0.5 },
};
export const WET_MATERIALS = WET;

const EVAP = 0.0028;      // kg/m²/s drying in still air at room temperature
const HEAT_EVAP = 0.09;   // kg/m²/s extra at heat 1 (fire boils water off as steam)
let LEVEL = 0.03;         // m of water-surface rise per kg/m² of standing water (pools read deep enough to see)
let MAXS = 3;             // massScale cap (physics: up to ~3× is fine; it lets wet cloth reach a little further so a tarp bellies)
const FLING_V = 3.2;      // m/s: faster than this, surface water flies off the cloth

let M = WET.cotton;
let n = 0, nE = 0;
let A = new Float32Array(0), F = new Float32Array(0), dA = new Float32Array(0), dF = new Float32Array(0);
let cap = new Float32Array(0), dry = new Float32Array(0), pinK = new Float32Array(0), filmK = new Float32Array(0), invArea = new Float32Array(0);
let H = new Float32Array(0), outF = new Float32Array(0), dripAcc = new Float32Array(0), steamAcc = new Float32Array(0);
// which face the surface water is on: +1 the front (the normal's side), −1 the back (a water-weighted mean)
let side = new Float32Array(0), dS = new Float32Array(0), Y = new Float32Array(0);   // Y: height against gravity
let deg0 = new Uint8Array(0), degA = new Uint8Array(0), lower = new Uint8Array(0), down = new Uint8Array(0), master = new Uint8Array(0);
let E = new Int32Array(0), eF = new Float32Array(0), invL = new Float32Array(0);
let aliases = new Int32Array(0);
let total = 0, idle = true, flowed = false;   // flowed: a flow pass has run since the cloth went wet
let dropMass = 0.003;     // kg of water in one DRIP (rain.js sets it so drips and raindrops balance)
let floorY = 0;
// what left the cloth this frame, for anyone curious (audio could use it)
export const flow = { drips: 0, steam: 0, flung: 0 };

/** rain.js: the water in one simulated raindrop; drips carry a couple of raindrops' worth. */
export function setDropMass(kg) { dropMass = Math.max(0.0004, kg * 1.8); }
/** Standing (surface) water at vertex v, kg. */
export function surfaceWater(v) { return v >= 0 && v < n ? F[v] : 0; }

export function init() {}

export function onScene(world) {
  const cl = world.cloth;
  n = cl.n;
  A = new Float32Array(n); F = new Float32Array(n); dA = new Float32Array(n); dF = new Float32Array(n);
  cap = new Float32Array(n); dry = new Float32Array(n); pinK = new Float32Array(n); filmK = new Float32Array(n); invArea = new Float32Array(n);
  H = new Float32Array(n); outF = new Float32Array(n); dripAcc = new Float32Array(n); steamAcc = new Float32Array(n);
  side = new Float32Array(n); dS = new Float32Array(n); Y = new Float32Array(n);
  deg0 = new Uint8Array(n); degA = new Uint8Array(n); lower = new Uint8Array(n); down = new Uint8Array(n); master = new Uint8Array(n);
  cl.pool = new Float32Array(n);
  let k = 0;
  for (let j = 0; j < cl.m; j++) if (cl.kind[j] === 0) k++;
  nE = k; E = new Int32Array(k); eF = new Float32Array(k); invL = new Float32Array(k);
  k = 0;
  for (let j = 0; j < cl.m; j++) if (cl.kind[j] === 0) {
    E[k] = j; invL[k] = 1 / Math.max(1e-4, cl.rest[j]); k++;
    deg0[cl.cA[j]]++; deg0[cl.cB[j]]++;
  }
  let na = 0; for (let i = 0; i < n; i++) if (cl.alias[i] >= 0) na++;
  aliases = new Int32Array(na); na = 0;
  for (let i = 0; i < n; i++) { if (cl.alias[i] >= 0) aliases[na++] = i; else master[i] = 1; }
  // a tube's seam vertices are welded: count the alias's threads on its master too
  for (let i = 0; i < n; i++) invArea[i] = cl.area[i] > 1e-9 ? 1 / cl.area[i] : 0;
  floorY = findFloor(world);
  total = 0; idle = true; flowed = false;
  cl.wet.fill(0); cl.massScale.fill(1);
  world.stats.wetness = 0;
  onMaterial(world);
}

function findFloor(world) {
  let y = -Infinity;
  const P = world.colliders.planes;
  for (let i = 0; i < P.length; i++) { const p = P[i]; if (p.ny > 0.7) { const h = -p.d / p.ny; if (h > y) y = h; } }
  return y > -Infinity ? y : 0;
}

export function onMaterial(world) {
  M = WET[world.materialId] || WET.cotton;
  const cl = world.cloth; if (!cl) return;
  const dens = (SIM_MATERIALS[world.materialId] || SIM_MATERIALS.cotton).density;
  for (let i = 0; i < n; i++) {
    const area = cl.area[i];
    const m0 = cl.mass0[i] > 0 ? cl.mass0[i] : Math.max(area, 1e-6) * dens;
    dry[i] = m0;
    cap[i] = M.absorb * m0;
    pinK[i] = M.pin * area;
    filmK[i] = M.film * area;
  }
  // a fabric that holds less now gives the rest up as surface water (it will run and drip)
  for (let i = 0; i < n; i++) if (A[i] > cap[i]) { F[i] += A[i] - cap[i]; A[i] = cap[i]; }
}

/** Surface water kg onto face s (+1 front, −1 back) of vertex i, keeping the water-weighted face. */
function addF(i, kg, s) {
  const f0 = F[i], f1 = f0 + kg;
  side[i] = f1 > 1e-12 ? (side[i] * f0 + s * kg) / f1 : s;
  F[i] = f1;
}

/**
 * Add `kg` of water to the cloth at master vertex v as surface water on face s (+1 the front — the side
 * the normal points to — or −1 the back): half there, half shared with its intact neighbours (a raindrop
 * splashes a little). Used by rain.js; anything else that wets may call it.
 */
export function deposit(world, v, kg, s = 1) {
  const cl = world.cloth; if (!cl || v < 0 || v >= n || !(kg > 0)) return;
  if (cl.alias[v] >= 0) v = cl.alias[v];
  const { vcStart, vcList, alive, kind, cA, cB } = cl;
  let cnt = 0;
  for (let q = vcStart[v]; q < vcStart[v + 1]; q++) { const j = vcList[q]; if (alive[j] && kind[j] === 0) cnt++; }
  if (cnt === 0) addF(v, kg, s);
  else {
    addF(v, kg * 0.5, s);
    const share = (kg * 0.5) / cnt;
    for (let q = vcStart[v]; q < vcStart[v + 1]; q++) {
      const j = vcList[q]; if (!alive[j] || kind[j] !== 0) continue;
      addF(cA[j] === v ? cB[j] : cA[j], share, s);
    }
  }
  total += kg; idle = false;
}

/** One whole step: the high and ultra tiers run it every frame, and the tests call it. */
export function update(world, dt) { flowStep(world, dt); settle(world, dt); }

/**
 * Passes 1–3: wicking, and where the surface water wants to run. On the low and mid tiers main.js runs
 * flowStep and settle on alternate frames, each at 30 Hz on a double step, so no frame carries the whole
 * update (in the rain it was the biggest spike on an old phone). Rain landing in between is fine: settle
 * only adds what flowed, and the flow never takes more than a vertex had.
 */
export function flowStep(world, dt) {
  const cl = world.cloth; if (!cl || dt <= 0 || idle) return;   // bone dry: nothing to do (near-zero cost)
  const { pos, alive, cA, cB } = cl;
  // "up" is against gravity (tilt the phone and the water runs to the new low side)
  const g = world.gravity, gm = Math.hypot(g[0], g[1], g[2]) || 1, ux = -g[0] / gm, uy = -g[1] / gm, uz = -g[2] / gm;

  // ---- pass 1 (vertices): water-surface heights, reset per-frame tallies
  for (let i = 0; i < n; i++) {
    const ex = F[i] - pinK[i];
    const o = i * 3, y = pos[o] * ux + pos[o + 1] * uy + pos[o + 2] * uz;
    Y[i] = y;
    H[i] = y + (ex > 0 ? ex * invArea[i] * LEVEL : 0);
    degA[i] = 0; lower[i] = 0; down[i] = 0; outF[i] = 0;
  }

  // ---- pass 2 (threads): wicking + drainage of absorbed water; how much surface water wants to run
  const wick = M.wick, drain = M.drain, flw = M.flow, absorbs = M.absorb > 0;
  for (let e = 0; e < nE; e++) {
    const j = E[e];
    if (!alive[j]) { eF[e] = 0; continue; }
    const a = cA[j], b = cB[j];
    degA[a]++; degA[b]++;
    const il = invL[e];
    if (absorbs) {
      const ca = cap[a], cb = cap[b];
      if (ca > 0 && cb > 0) {
        const sa = A[a] / ca, sb = A[b] / cb, sm = (sa + sb) * 0.5;
        const dy = (Y[a] - Y[b]) * il;                               // slope a→b (+ = a is higher)
        let f = (wick * il * il * (sa - sb) + drain * il * dy * sm * sm) * (ca < cb ? ca : cb) * dt;
        if (f > 0) { const lim = A[a] * 0.2; if (f > lim) f = lim; } else { const lim = -A[b] * 0.2; if (f < lim) f = lim; }
        dA[a] -= f; dA[b] += f;
      }
    }
    // On a nearly level thread (a pool) the flow is capped at half the transfer that would level the two
    // surfaces, so a pool settles instead of sloshing; down a real slope water just runs.
    const ha = H[a], hb = H[b], slope = (Y[a] - Y[b]) * il;
    if (slope > 0.3) down[a] = 1; else if (slope < -0.3) down[b] = 1;   // has somewhere clearly downhill to go
    if (ha > hb + 1e-5) {
      lower[a] = 1;
      const ex = F[a] - pinK[a];
      if (ex > 0) {
        let w = flw * (ha - hb) * il * il * ex * dt;
        if (slope < 0.35) { const eq = ((ha - hb) * 0.5) / (LEVEL * (invArea[a] + invArea[b]) + 1e-9); if (w > eq) w = eq; }
        eF[e] = w; outF[a] += w;
      } else eF[e] = 0;
    } else if (hb > ha + 1e-5) {
      lower[b] = 1;
      const ex = F[b] - pinK[b];
      if (ex > 0) {
        let w = flw * (hb - ha) * il * il * ex * dt;
        if (slope > -0.35) { const eq = ((hb - ha) * 0.5) / (LEVEL * (invArea[a] + invArea[b]) + 1e-9); if (w > eq) w = eq; }
        eF[e] = -w; outF[b] += w;
      } else eF[e] = 0;
    } else eF[e] = 0;
  }

  // ---- pass 3 (threads): move surface water, never more than a vertex has
  for (let e = 0; e < nE; e++) {
    const w = eF[e]; if (w === 0) continue;
    const j = E[e], a = cA[j], b = cB[j];
    if (w > 0) {
      const avail = F[a] - pinK[a], o = outF[a];
      const m = o > avail ? (w * avail) / o : w, ms = m * side[a];
      dF[a] -= m; dF[b] += m; dS[a] -= ms; dS[b] += ms;   // water keeps to its face as it runs
    } else {
      const avail = F[b] - pinK[b], o = outF[b];
      const m = o > avail ? (-w * avail) / o : -w, ms = m * side[b];
      dF[b] -= m; dF[a] += m; dS[b] -= ms; dS[a] += ms;
    }
  }

  flowed = true;
}

/** Pass 4 (vertices): soak, dry, drip, steam and fling, then publish the look and the weight. */
export function settle(world, dt) {
  const cl = world.cloth; if (!cl || dt <= 0) return;
  flow.drips = 0; flow.steam = 0; flow.flung = 0;
  if (idle || !flowed) return;                        // (until a flow pass has run, the hem flags are unset)
  const { pos, vel, normal, heat, wet, massScale, pool } = cl;
  const g = world.gravity, gm = Math.hypot(g[0], g[1], g[2]) || 1, ux = -g[0] / gm, uy = -g[1] / gm, uz = -g[2] / gm;
  const st = world.stats, q = world.q;
  const windF = 1 + 0.12 * (world.wind.speed || 0);
  const evap = EVAP * M.evap * windF;
  const soak = M.soak, seep = M.seep, maxS = 1 + (MAXS - 1) * M.heavy;
  const dripBudget0 = q.particles >= 2600 ? 10 : q.particles >= 1400 ? 6 : 4;
  const steamBudget0 = q.particles >= 2600 ? 6 : q.particles >= 1400 ? 4 : 2;
  let dripBudget = dripBudget0, steamBudget = steamBudget0, flingBudget = dripBudget0;
  let sumWet = 0, cnt = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    if (!master[i]) continue;
    let a = A[i] + dA[i], f = F[i] + dF[i];
    let sd = f > 1e-12 ? (side[i] * F[i] + dS[i]) / f : side[i];
    dA[i] = 0; dF[i] = 0; dS[i] = 0;
    if (a < 0) a = 0; if (f < 0) f = 0;
    const c = cap[i], o = i * 3, ny = normal[o] * ux + normal[o + 1] * uy + normal[o + 2] * uz;
    // surface water sinks into the fibres (slower as they fill)
    if (c > 0 && f > 0 && a < c) {
      let r = soak * dt * f * (1 - a / c);
      if (r > f) r = f; if (r > c - a) r = c - a;
      a += r; f -= r;
    }
    // soaked through: the excess seeps out on the face that looks down
    if (a > c) { const x = a - c, sdn = ny > 0 ? -1 : 1; sd = f + x > 1e-12 ? (sd * f + sdn * x) / (f + x) : sdn; f += x; a = c; }
    sd = sd > 1 ? 1 : sd < -1 ? -1 : sd;
    // drying: slow in air (faster in wind), fast where it's hot — that part leaves as steam
    const area = cl.area[i];
    const h = heat[i];
    let ev = evap * area * dt, eh = h > 0.04 ? HEAT_EVAP * h * area * dt : 0;
    let take = ev + eh;
    if (take > 0 && (a > 0 || f > 0)) {
      const fromF = take < f ? take : f; f -= fromF; take -= fromF;
      const fromA = take < a ? take : a; a -= fromA; take -= fromA;
      const got = ev + eh - take;
      if (eh > 0) steamAcc[i] += got * (eh / (ev + eh));
    }
    // where does the free surface water go? (nyw: how much the face it sits on looks up)
    const ex = f - pinK[i];
    if (ex > 0) {
      const nyw = sd >= 0 ? ny : -ny, steep = nyw < 0.5 && nyw > -0.2;
      const hem = degA[i] < deg0[i] || deg0[i] < 4;     // a torn edge, a hem, a corner
      if (nyw <= -0.2) { const s = ex * Math.min(1, 25 * dt); dripAcc[i] += s; f -= s; } // on the underside: it hangs, then falls
      else if (!lower[i]) {
        if (hem || steep) { dripAcc[i] += ex; f -= ex; }                       // nowhere to hold it: it falls
        else if (seep > 0) { const s = seep * ex * dt; dripAcc[i] += s; f -= s; } // a pool: seeps through
      } else if (hem && steep && !down[i]) { const s = ex * 12 * dt; dripAcc[i] += s; f -= s; } // a hanging hem drips all along
    }
    side[i] = sd;
    // shake it and the water flies
    const vx = vel[o], vy = vel[o + 1], vz = vel[o + 2], sp2 = vx * vx + vy * vy + vz * vz;
    if (sp2 > FLING_V * FLING_V && (f > pinK[i] || a > c * 0.85)) {
      const sp = Math.sqrt(sp2), k = Math.min(0.5, (sp - FLING_V) * 0.35 * dt * 8);
      const thrown = (f > pinK[i] ? (f - pinK[i]) * k : 0) + (a > c * 0.85 ? (a - c * 0.85) * k * 0.5 : 0);
      if (thrown > dropMass * 0.25) {
        if (f > pinK[i]) f -= Math.min(f - pinK[i], thrown); else a -= Math.min(a, thrown);
        flow.flung += thrown;
        if (flingBudget > 0 && rand() < 0.7) {
          flingBudget--;
          const jit = 0.25 + sp * 0.08;
          spawn(world, PK.SPLASH, pos[o], pos[o + 1], pos[o + 2], vx * 0.9 + (rand() - 0.5) * jit, vy * 0.9 + (rand() - 0.5) * jit, vz * 0.9 + (rand() - 0.5) * jit, 0.007 + rand() * 0.006, 0.35 + rand() * 0.3, 0);
        }
      }
    }
    // drips: one DRIP particle per dropMass collected at this vertex
    let d = dripAcc[i];
    if (d >= dropMass) {
      if (dripBudget > 0) {
        dripBudget--; d -= dropMass;
        const s = ny >= 0 ? -1 : 1;                           // leave from the underside
        const x = pos[o] + normal[o] * s * 0.006, y = pos[o + 1] + normal[o + 1] * s * 0.006 - 0.008, z = pos[o + 2] + normal[o + 2] * s * 0.006;
        const fall = Math.max(0.05, y - floorY);
        spawn(world, PK.DRIP, x, y, z, vx * 0.5 + (rand() - 0.5) * 0.06, Math.min(0, vy * 0.5), vz * 0.5 + (rand() - 0.5) * 0.06,
          0.011 + rand() * 0.006, Math.sqrt((2 * fall) / 9.81) + 1.5, floorY);
        world.events.drip.push(x, y, z, Math.cbrt(dropMass * 2.387e-4)); // the drop's radius in metres (3m / 4πρ)
        flow.drips++;
      }
      if (d > dropMass * 4) d = dropMass * 4;   // a backlog beyond this fell without a particle
    }
    dripAcc[i] = d;
    // steam: a puff per few grams boiled off
    let sa = steamAcc[i];
    if (sa >= dropMass * 0.15) {
      if (steamBudget > 0) {
        steamBudget--;
        const s = ny >= 0 ? 1 : -1;
        spawn(world, PK.STEAM, pos[o] + normal[o] * s * 0.02, pos[o + 1] + ny * s * 0.02 + 0.02, pos[o + 2] + normal[o + 2] * s * 0.02,
          (rand() - 0.5) * 0.25, 0.35 + rand() * 0.35, (rand() - 0.5) * 0.25, 0.05 + rand() * 0.05, 0.8 + rand() * 0.6, 0);
        world.events.steam.push(pos[o], pos[o + 1], pos[o + 2], sa);
        flow.steam += sa;
        sa = 0;
      } else if (sa > dropMass) sa = dropMass;
    }
    steamAcc[i] = sa;
    A[i] = a; F[i] = f;
    // the look and the weight
    const fl = filmK[i], fv = f < fl ? f : fl;
    const wv = c + fl > 0 ? (a + fv) / (c + fl) : 0;
    wet[i] = wv > 1 ? 1 : wv;
    // the weight: capped per fabric, and rising at most ×(1 + 4/s) so a raindrop never jolts a vertex
    let ms = 1 + (a + f) / dry[i];
    if (ms > maxS) ms = maxS;
    const prevS = massScale[i], up = prevS * (1 + 4 * dt);
    massScale[i] = ms > up ? up : ms;
    // standing water: only where it sits on a face that looks up (water under a curve hangs, it doesn't pool)
    const ex2 = f - pinK[i];
    pool[i] = ex2 > 0 && (sd >= 0 ? ny : -ny) > 0.3 ? ex2 * invArea[i] * LEVEL : 0;
    tot += a + f + d + sa;
    if (cl.vTri[i]) { sumWet += wet[i]; cnt++; }
  }
  for (let k = 0; k < aliases.length; k++) { const i = aliases[k], m = cl.alias[i]; wet[i] = wet[m]; pool[i] = pool[m]; massScale[i] = massScale[m]; }
  total = tot;
  st.wetness = cnt ? sumWet / cnt : 0;
  if (tot < 1e-7) {                                    // dried out: settle and go idle
    idle = true; flowed = false; total = 0;
    A.fill(0); F.fill(0); dripAcc.fill(0); steamAcc.fill(0);
    wet.fill(0); massScale.fill(1); pool.fill(0); st.wetness = 0;
  }
}

/** Tests only: override tuning constants, e.g. tune({ LEVEL: 0.05, MAXS: 12 }). Returns the current values. */
export function tune(o = {}) {
  if (o.LEVEL != null) LEVEL = o.LEVEL;
  if (o.MAXS != null) MAXS = o.MAXS;
  return { LEVEL, MAXS };
}
