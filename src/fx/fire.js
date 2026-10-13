// Fire 火. Combustion on the cloth graph. Owner: the fire agent.
//
// Per master vertex (cloth.heat / fuel / char; aliases are synced by physics):
//   heat  the temperature: 0 cold · ~0.25 scorching · `ign` catches (material) · ~0.5 a flaming band (black
//         char under the flames) · ~0.95 the ember edge as the fuel runs out · 1 white-hot. Render glows
//         from ~0.5 up. Chainmail: the steel's temperature (0.5 dull red … 1 yellow-white).
//   fuel  1 intact → 0 burnt through. Holes are cut at the renderer's resolution: a quad is removed only
//         when all four of its corners are spent, threads left with no cloth on either side are cut, and
//         a vertex left with no cloth at all goes through sim.killVertex. So a hole grows smoothly behind
//         the burning front instead of popping out in 2×2-cell chunks, and the cloth comes apart in shreds.
//   char  monotonic darkening: brown scorch ahead of the front (pre-heat) → black once it burns.
//
// Heat moves three ways:
//   1. Flame spread. A flaming vertex heats its thread neighbours (alive stretch/shear constraints only,
//      so heat never jumps a tear or a cut) at a rate set by a front SPEED in m/s for that direction:
//      fast up the plume, slow across it, slower down it. The plume leans with world.wind and follows
//      −gravity (tilt the phone and the fire climbs the new "up"). Speeds are in m/s, so a fire spreads
//      alike at every quality tier's cloth resolution. A glowing spent edge keeps pushing, gently.
//   2. Conduction. Conservative diffusion along the same threads: negligible for fabric, real for chainmail.
//   3. Radiant/convective pre-heating. Flames deposit power into a coarse grid fitted to the fire, splatted
//      with a plume-shaped kernel, so cloth folded above a fire (or the next noren panel) warms with no
//      thread between them. It only acts on cloth no flame already touches.
// Water (cloth.wet, weather's) pins the temperature near boiling until weather has boiled it off (weather
// makes that steam). Fire's own steam is the discrete moments: a flame drowned, a soaked tap fizzling,
// rain falling into flames (rain cools burning cloth by how much it faces the sky). Chainmail never burns:
// it takes heat, diffuses it, glows red → orange → yellow-white and cools slowly (a torch is a forge).
//
// Cost: only an active list of hot vertices is touched, walking a compact thread adjacency built once per
// scene. Nothing runs when nothing is hot. The only O(n) pass (radiant sampling) visits each vertex once
// per 1/20 s while flames exist, spread over the frames in between, inside the fire's bounding box.
import { PK } from '../core/world.js';
import { rand } from '../core/rng.js';
import { noise3 } from '../core/noise.js';
import { spawn, capacity, count } from '../render/particles.js';
import { killVertex, breakConstraint } from '../sim/cloth.js';
import { FIRE } from './fire-materials.js';

// ---- states ----
const S_IDLE = 0, S_HEAT = 1, S_SMOULDER = 2, S_FLAME = 3, S_DEAD = 4;

// ---- tuning ----
const T_CHAR = 0.24;       // scorching (char) starts above this temperature
const T_BOIL = 0.2;        // wet cloth is pinned near here until it has dried
const Q_SPENT = 0.1;       // a quad is cut out when all four corners' fuel is below this
const T_PUSH = 1.0;        // flame gas temperature: a flame pushes its neighbours toward this
const RAIN_COOL = 1.6;     // heat/s full rain takes from a sky-facing flame (drowns a fresh one)
const TORCH_RATE = 2.4;    // heat/s at the centre of the burn tool (× material torch)
const TORCH_SIGMA = 0.045; // burn tool radius, m (gaussian)
const DIAG_W = 0.4;        // shear (diagonal) threads carry this much of the flame push
const EMBER_PUSH = 0.6;    // a glowing spent edge pushes like a flame this strong
const RAD_CELL = 0.16;     // radiant grid cell, m (coarser when a fire spans more than the grid)
const RAD_GAIN = 15;       // heat/s per m² of nearby flame (only on cloth no flame is already touching)
const RAD_PERIOD = 1 / 20; // radiant pass rate
const LIGHT_MAX = 1.15;    // fire-light intensity of a big fire (before flicker), for glsl pointLight's 1/(1+d²)
const LIGHT_W0 = 0.1;      // m² of flame for ~63 % of LIGHT_MAX
const LIGHT_CAP = 2.0;     // hard ceiling with flicker and a tap's flare, so ember edges and char still read
const LIGHT_OFF = 0.3;     // m: the light stands this far off the burning cloth, on the side the camera sees
const FLAME_N = 210;       // flame tongues alive for a big fire (A_REF m² of flame) at tier mid; the count
const A_REF = 0.8;         // grows like (area / A_REF)^0.4, so a fresh little flame still has body
const ROT = 4;             // rare emission (sparks, embers, smoke, ash) is checked on 1 vertex in ROT per frame

// Emission rates per m² of burning cloth per second at tier mid (scaled by tier and the governor).
const R_SPARK = 26, R_EMBER = 55, R_SMOKE = 26, R_ASH = 14, R_STEAM = 900;
// Per-kind rate caps (per second at tier mid) and bursts: hard bounds on fire's share of the pool.
//                 FLAME SPARK EMBER ASH  SMOKE STEAM   (indexed by PK, which numbers these 0..5)
const CAP_RATE = [720, 240, 70, 60, 30, 60];
const CAP_BURST = [70, 70, 24, 24, 8, 18];

// ---- per-scene state (sized in onScene) ----
let cl = null, n = 0;
let state = new Uint8Array(0), inAct = new Uint8Array(0);
let flame = new Float32Array(0), ignJ = new Float32Array(0), rateJ = new Float32Array(0), emAcc = new Float32Array(0);
let pushed = new Uint32Array(0), seen = new Uint32Array(0);
let twin = new Int32Array(0);                 // master → its seam alias (visibility), or -1
let active = new Int32Array(0), nActive = 0;
// thread adjacency (stretch + shear, masters): neighbour, constraint, 1/rest length, push weight
let nStart = new Int32Array(1), nV = new Int32Array(0), nC = new Int32Array(0), nIR = new Float32Array(0), nW = new Float32Array(0);
let totalArea = 1, burntArea = 0, frameNo = 1, seenGen = 1;
let M = FIRE.cotton, kappa = 0.6, kappaS = 0.6;

// ---- per-frame scratch ----
let Ux = 0, Uy = 1, Uz = 0;                   // up (−gravity)
let Px = 0, Py = 1, Pz = 0, fan = 1;          // plume direction (up + wind), and wind fanning
let wx = 0, wy = 0, wz = 0;                   // mean wind
let tierScale = 1, emitScale = 1, poolFull = false, crowded = false, sizeBoost = 1;
const tokens = new Float32Array(6);
let burning = 0, flameArea = 0, lastFlameArea = 0, lastNewFire = -9;
// Accumulators live in a typed array: closure-level `let` doubles would box a HeapNumber on every +=.
// [0..4] light: weight, x, y, z, heat-weighted · [5..8] steam: weight, x, y, z · [9..11] the burning
// cloth's camera-facing normal (weighted like the light)
const acc = new Float64Array(12);
let radAcc = 0;
const ring = new Int32Array(96), ringW = new Float32Array(96);

// ---- fire light (smoothed) and the plume for updraft(): [0..2] root, [3] radius m, [4] strength 0..1, [5..7] axis ----
let lx = 0, ly = 0, lz = 0, lI = 0, lWarm = 0.5, flare = 0, haveLight = false, freshLight = false;
const lnrm = new Float64Array([0, 0, 1]); // the smoothed, camera-facing normal of the burning cloth
const plume = new Float64Array(8);
const UPDRAFT = 2.2; // m/s up the core of a big fire's plume

// ---- radiant grid: a dense grid fitted to the fire's bounds. A = flame power per cell (m² of full
// flame), B = A splatted with a plume-shaped 3×3×3 kernel. Rebuilt each RAD_PERIOD; the vertex scan that
// reads it is spread over the frames in between, so no frame carries the whole pass. ----
const G_MAX = 24, G_CELLS = G_MAX * G_MAX * G_MAX;
const gA = new Float32Array(G_CELLS), gB = new Float32Array(G_CELLS), gList = new Int32Array(G_CELLS);
const kern = new Float32Array(27);
// [0..2] grid origin (m), [3] cell size (m), [4] 1/cell, [5] heating gain per unit B (per visit)
const gF = new Float64Array(6);
let gN = 0, gnx = 0, gny = 0, gnz = 0, gReady = false, scanPos = 0, scanLeft = 0;

/** Test switches (tests/fire-*.mjs): noLight keeps fireCol at 0 so cloth and particles can be judged alone. */
export const debugFlags = { noLight: false, prof: false };
/** Cumulative counts since the scene loaded (tests): events [ignite, burnout, steam], particles spawned per kind 0..5. */
const evCount = new Uint32Array(3), spawned = new Uint32Array(6);
/** With debugFlags.prof: accumulated ms in [setup+radiant, spread, react, steam+light], and the call count. */
export const prof = new Float64Array(5);

export function init() {}

/** A new cloth: size the per-vertex arrays, build the thread adjacency and reset everything. */
export function onScene(world) {
  cl = world.cloth; n = cl.n;
  state = new Uint8Array(n); inAct = new Uint8Array(n);
  flame = new Float32Array(n); ignJ = new Float32Array(n); rateJ = new Float32Array(n); emAcc = new Float32Array(n);
  pushed = new Uint32Array(n); seen = new Uint32Array(n);
  twin = new Int32Array(n).fill(-1);
  active = new Int32Array(n); nActive = 0;
  totalArea = 0; burntArea = 0; frameNo = 1; seenGen = 1;
  const { vcStart, vcList, kind, cA, cB, rest, alias } = cl;
  let deg = 0;
  for (let i = 0; i < n; i++) for (let e = vcStart[i]; e < vcStart[i + 1]; e++) if (kind[vcList[e]] !== 2) deg++;
  nStart = new Int32Array(n + 1); nV = new Int32Array(deg); nC = new Int32Array(deg); nIR = new Float32Array(deg); nW = new Float32Array(deg);
  deg = 0;
  for (let i = 0; i < n; i++) {
    nStart[i] = deg;
    for (let e = vcStart[i]; e < vcStart[i + 1]; e++) {
      const j = vcList[e]; if (kind[j] === 2) continue;
      nV[deg] = cA[j] === i ? cB[j] : cA[j]; nC[deg] = j; nIR[deg] = 1 / Math.max(1e-4, rest[j]); nW[deg] = kind[j] === 1 ? DIAG_W : 1;
      deg++;
    }
  }
  nStart[n] = deg;
  // Fuel density and ignition point vary across the cloth in blotches (spatially coherent noise),
  // so fronts finger and holes open organically. noise3 is deterministic and leaves the RNG alone.
  const p = cl.pos;
  for (let i = 0; i < n; i++) {
    const m = alias[i];
    if (m >= 0) { twin[m] = i; continue; }
    totalArea += cl.area[i];
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const coarse = noise3(x * 5.3 + 11.7, y * 5.3 + 3.1, z * 5.3 + 7.9);
    const fine = noise3(x * 17.1 + 1.3, y * 17.1 + 9.4, z * 17.1 + 4.2);
    // a coarse cell stands for more cloth, so it takes longer to burn through: this keeps the burning
    // band at least about a cell wide on every tier, so slow fronts (sideways, on a flat tarp) keep going
    let hsum = 0, hk = 0;
    for (let e = nStart[i]; e < nStart[i + 1]; e++) if (nW[e] === 1) { hsum += 1 / nIR[e]; hk++; }
    const cellMul = hk ? Math.max(1, hsum / hk / 0.06) : 1;
    rateJ[i] = (1 + 0.38 * coarse + 0.14 * fine) / cellMul;
    ignJ[i] = 0.03 * noise3(x * 7.7 + 5.5, y * 7.7 + 2.2, z * 7.7 + 8.8);
  }
  if (totalArea <= 0) totalArea = 1;
  onMaterial(world);
  warm(world);
  lI = 0; flare = 0; haveLight = false; radAcc = 0; lastFlameArea = 0; lastNewFire = -9; plume[4] = 0;
  gReady = false; scanPos = 0; scanLeft = 0;
  evCount.fill(0); spawned.fill(0); acc.fill(0);
  const L = world.lights; L.fireCol[0] = L.fireCol[1] = L.fireCol[2] = 0;
  world.stats.burning = 0; world.stats.charred = 0;
}

/**
 * Once per page, at the first scene load: a three-frame dry run of a one-vertex fire (no particles, no
 * events, no topology change), then a clean reset. V8 compiles the fire's hot functions here instead of
 * on the first tap, where a compile hitch would cost frames at the very moment the user is watching.
 */
let warmed = false;
function warm(world) {
  if (warmed) return;
  warmed = true;
  let v = -1;
  for (let i = n >> 1; i < n; i++) if (cl.alias[i] < 0 && nStart[i + 1] - nStart[i] >= 4) { v = i; break; }
  if (v < 0) return;
  const keep = M;
  M = FIRE.cotton; kappa = Math.log(T_PUSH / (T_PUSH - M.ign)); kappaS = 0;
  env(world);
  lastNewFire = Infinity; // newFire() stays quiet
  state[v] = S_FLAME; flame[v] = 1; cl.heat[v] = 0.6; addActive(v);
  for (let f = 0; f < 3; f++) {
    frameNo++; poolFull = true; // no particles
    radiantBuild(1 / 30); radiantScan(n); spread(1 / 60); react(world, 1 / 60); light(world, 1 / 60);
  }
  gather(v, 0.05); cellAt(v);
  // reset everything the dry run touched (the cloth is fresh at scene load: heat 0, fuel 1, char 0)
  cl.heat.fill(0); cl.fuel.fill(1); cl.char.fill(0);
  state.fill(0); flame.fill(0); inAct.fill(0); emAcc.fill(0); pushed.fill(0); nActive = 0; frameNo = 1;
  M = keep; onMaterial(world);
}

/** The material changed: new burning rules. A fire on cloth turned to chainmail goes out (hot metal stays hot). */
export function onMaterial(world) {
  M = FIRE[world.materialId] || FIRE.cotton;
  // time for a flame to lift a cold neighbour to ignition is kappa / (v / r): v is then the front speed
  kappa = M.glowOnly ? 0 : Math.log(T_PUSH / (T_PUSH - M.ign));
  kappaS = M.smoulderT > 0 ? Math.log((M.smoulderHeat + 0.08) / (M.smoulderHeat + 0.08 - M.smoulderT)) : 0;
  if (!cl || !M.glowOnly) return;
  for (let k = 0; k < nActive; k++) { const i = active[k]; if (state[i] === S_FLAME || state[i] === S_SMOULDER) state[i] = S_HEAT; }
}

// ------------------------------------------------------------------------------------------- helpers
function addActive(i) { if (!inAct[i]) { inAct[i] = 1; active[nActive++] = i; } }
const visible = (v) => cl.vTri[v] > 0 || (twin[v] >= 0 && cl.vTri[twin[v]] > 0);
/** Wet cloth can't get hotter than this (boiling) until it has dried. */
function wetCap(w) {
  if (w <= 0.02) return 1;
  if (w >= 0.3) return T_BOIL;
  const d = 1 - (w - 0.02) / 0.28;
  return T_BOIL + (1 - T_BOIL) * d * d;
}

/** Spawn through the per-kind token bucket. Stops for the frame once the pool is full (never retries). */
function emit(world, k, x, y, z, vx, vy, vz, s, l, aux) {
  if (poolFull || tokens[k] < 1) return 0;
  tokens[k] -= 1;
  if (!spawn(world, k, x, y, z, vx, vy, vz, s, l, aux)) { poolFull = true; return 0; }
  spawned[k]++;
  return 1;
}
/** Spawn outside the buckets (the tools' own feedback: a tap's flare, the lighter flame, forge sparks). */
function put(world, k, x, y, z, vx, vy, vz, s, l, aux) {
  if (poolFull) return 0;
  if (!spawn(world, k, x, y, z, vx, vy, vz, s, l, aux)) { poolFull = true; return 0; }
  spawned[k]++;
  return 1;
}
/** A count from an expected value (deterministic via rand). */
function draws(expected) { let k = expected | 0; if (rand() < expected - k) k++; return k; }

/** Up, wind, plume direction and the tier's emission scale. */
function env(world) {
  const g = world.gravity, gl = Math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
  if (gl > 1e-6) { Ux = -g[0] / gl; Uy = -g[1] / gl; Uz = -g[2] / gl; } else { Ux = 0; Uy = 1; Uz = 0; }
  const W = world.wind; wx = W.x; wy = W.y; wz = W.z;
  // the hot plume rises at ~1.2 m/s and leans with the wind; a strong wind also fans the flames
  const bx = Ux * 1.2 + wx * 0.2, by = Uy * 1.2 + wy * 0.2, bz = Uz * 1.2 + wz * 0.2;
  const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
  Px = bx / bl; Py = by / bl; Pz = bz / bl;
  const ws = Math.sqrt(wx * wx + wy * wy + wz * wz);
  fan = 1 + 0.07 * (ws < 10 ? ws : 10);
  const q = world.q;
  tierScale = (q.particles * q.particleScale) / 1400;
  emitScale = tierScale < 0.15 ? 0.15 : tierScale > 1.6 ? 1.6 : tierScale;
  // fewer particles at low tiers are drawn a little bigger so the fire keeps its body
  sizeBoost = 1 + 0.35 * (tierScale < 1 ? 1 - tierScale : 0);
  poolFull = false;
  crowded = count() > capacity(world) * 0.85;
}

// ------------------------------------------------------------------------------------------- update
/** Advance the fire by dt simulated seconds. */
export function update(world, dt) {
  const c = world.cloth;
  if (!c) return;
  if (c !== cl) onScene(world);
  const st = world.stats;
  if (dt <= 0) return;
  if (nActive === 0 && lI < 1e-3 && flare < 1e-3) {
    if (haveLight) { haveLight = false; plume[4] = 0; const L = world.lights; L.fireCol[0] = L.fireCol[1] = L.fireCol[2] = 0; }
    st.burning = 0; st.charred = burntArea / totalArea;
    return;
  }
  const pr = debugFlags.prof;
  let t0 = pr ? performance.now() : 0;
  frameNo++;
  env(world);
  for (let k = 0; k < 6; k++) { const b = CAP_BURST[k] * (tierScale > 0.4 ? tierScale : 0.4), t = tokens[k] + CAP_RATE[k] * tierScale * dt; tokens[k] = t < b ? t : b; }
  if (lastFlameArea > 0.0004 && !M.glowOnly) {
    radAcc += dt;
    if (radAcc >= RAD_PERIOD) { radiantBuild(radAcc); radAcc = 0; }
    radiantScan(Math.ceil((n * dt) / RAD_PERIOD) + 1); // this frame's share of the vertices
  } else { radAcc = 0; gReady = false; }
  if (pr) { const t1 = performance.now(); prof[0] += t1 - t0; t0 = t1; }
  spread(dt);
  if (pr) { const t1 = performance.now(); prof[1] += t1 - t0; t0 = t1; }
  react(world, dt);
  if (pr) { const t1 = performance.now(); prof[2] += t1 - t0; t0 = t1; }
  steamEvent(world);
  light(world, dt);
  if (pr) { prof[3] += performance.now() - t0; prof[4]++; }
  lastFlameArea = flameArea;
  st.burning = burning;
  st.charred = burntArea / totalArea;
}

// ---- 1 + 2: flame spread and conduction along intact threads ----
function spread(dt) {
  const { heat, pos, alive, fuel } = cl;
  const vUp = M.vUp * Math.pow(fan, 0.7), vSide = M.vSide * fan, vDown = M.vDown;
  const kUp = kappa * (vUp - vSide), kSide = kappa * vSide, kDown = kappa * (vDown - vSide);
  // conduction matters for metal; in fabric it is negligible, and skipping it lets cooling-only vertices
  // skip their neighbour walk entirely
  const cdt = M.glowOnly || M.cond >= 0.001 ? M.cond * dt : 0, vSm = (M.vSmoulder || 0) * kappaS, smT = (M.smoulderHeat || 0) + 0.08;
  const nA = nActive, fno = frameNo;
  for (let k = 0; k < nA; k++) {
    const i = active[k], si = state[i];
    if (si === S_DEAD) continue;
    const Ti = heat[i];
    // flames push; so does a glowing spent edge (fuel gone, still hot), more gently, so a front keeps
    // creeping where the cloth is coarse
    const fl = si === S_FLAME ? flame[i] : fuel[i] <= 0 && Ti > 0.55 ? (EMBER_PUSH * (Ti - 0.55)) / 0.4 : 0;
    const sm = si === S_SMOULDER, ember = fl > 0 && si !== S_FLAME;
    if (fl === 0 && !sm && (cdt === 0 || Ti < 0.02)) continue;
    const o = i * 3, px = pos[o], py = pos[o + 1], pz = pos[o + 2];
    const fdt = fl * dt;
    for (let e = nStart[i], e1 = nStart[i + 1]; e < e1; e++) {
      if (!alive[nC[e]]) continue;
      const nb = nV[e], sn = state[nb];
      if (sn === S_DEAD) continue;
      let Tn = heat[nb];
      const ir = nIR[e];
      // (an ember edge only heats unburnt cloth: two spent neighbours must not keep each other hot)
      if (sn !== S_FLAME && (fl > 0 || sm) && !(ember && fuel[nb] <= 0)) {
        // direction to the neighbour against the plume (threads stay near rest length: no sqrt)
        const q = nb * 3;
        let cs = ((pos[q] - px) * Px + (pos[q + 1] - py) * Py + (pos[q + 2] - pz) * Pz) * ir;
        cs = cs > 1 ? 1 : cs < -1 ? -1 : cs;
        let f, target;
        if (sm) {
          // smoulder (velvet): slow, nearly isotropic, only into unburnt cloth
          if (fuel[nb] <= 0 || sn === S_SMOULDER) f = 0;
          else f = vSm * (1 + 0.6 * cs) * ir * dt;
          target = smT;
        } else {
          // a narrow plume cone: straight up gets vUp, 45° gets a quarter of it
          const c2 = cs * cs;
          f = (kSide + (cs >= 0 ? kUp * c2 * c2 : -kDown * cs)) * ir * nW[e] * fdt;
          target = T_PUSH;
        }
        if (f > 0 && Tn < target) {
          if (f > 0.5) f = 0.5;
          Tn += (target - Tn) * f; heat[nb] = Tn; pushed[nb] = fno;
        }
      }
      if (cdt > 0 && Tn < Ti) {
        // conduction: conservative exchange (a flaming source is re-heated by combustion in react())
        let g = cdt * ir * ir; if (g > 0.22) g = 0.22;
        const x = (heat[i] - Tn) * g;
        heat[i] -= x; Tn += x; heat[nb] = Tn;
      }
      if (!inAct[nb] && Tn > 0.004) addActive(nb);
    }
  }
}

// ---- 3: radiant/convective pre-heating through a coarse grid ----
/** Rebuild the grid from this frame's flames (every RAD_PERIOD). dt = the period it stands for. */
function radiantBuild(dt) {
  const { pos, area } = cl;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, any = false;
  for (let k = 0; k < nActive; k++) {
    const i = active[k];
    if (state[i] !== S_FLAME) continue;
    const o = i * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    any = true;
  }
  gReady = false;
  if (!any) return;
  // cells of RAD_CELL, coarser if the fire (or its flying scraps) spans more than the grid
  let ext = x1 - x0; if (y1 - y0 > ext) ext = y1 - y0; if (z1 - z0 > ext) ext = z1 - z0;
  const cell = Math.max(RAD_CELL, ext / (G_MAX - 4)), inv = 1 / cell;
  const ox = x0 - 2 * cell, oy = y0 - 2 * cell, oz = z0 - 2 * cell;
  gnx = Math.min(G_MAX, ((x1 - ox) * inv | 0) + 3); gny = Math.min(G_MAX, ((y1 - oy) * inv | 0) + 3); gnz = Math.min(G_MAX, ((z1 - oz) * inv | 0) + 3);
  const used = gnx * gny * gnz, sxy = gnx * gny;
  gA.fill(0, 0, used); gB.fill(0, 0, used); gN = 0;
  // A: flame power per cell
  for (let k = 0; k < nActive; k++) {
    const i = active[k];
    if (state[i] !== S_FLAME) continue;
    const o = i * 3;
    const c = ((pos[o] - ox) * inv | 0) + gnx * (((pos[o + 1] - oy) * inv | 0) + gny * ((pos[o + 2] - oz) * inv | 0));
    if (gA[c] === 0) gList[gN++] = c;
    gA[c] += flame[i] * area[i];
  }
  // B: splat with a plume-shaped 3×3×3 kernel (strong above along the plume, weaker beside and below)
  for (let dz = -1, m = 0; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++, m++) {
    const d2 = dx * dx + dy * dy + dz * dz;
    if (!d2) { kern[m] = 1; continue; }
    const cs = (dx * Px + dy * Py + dz * Pz) / Math.sqrt(d2);
    const a = 0.42 + 0.58 * (cs > 0 ? cs : 0);
    kern[m] = (a * a) / d2;
  }
  for (let k = 0; k < gN; k++) {
    const c = gList[k], v = gA[c];
    const iz = (c / sxy) | 0, r = c - iz * sxy, iy = (r / gnx) | 0, ix = r - iy * gnx;
    // every flame cell is ≥ 2 cells inside the grid, so its 27 neighbours are in range
    for (let dz = -1, m = 0; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) {
      const row = ix - 1 + gnx * (iy + dy + gny * (iz + dz));
      gB[row] += v * kern[m++]; gB[row + 1] += v * kern[m++]; gB[row + 2] += v * kern[m++];
    }
  }
  gF[0] = ox; gF[1] = oy; gF[2] = oz; gF[3] = cell; gF[4] = inv;
  // irradiance, not power per cell: a coarser cell holds more flame, so scale back by its area
  gF[5] = RAD_GAIN * dt * (RAD_CELL * inv) * (RAD_CELL * inv);
  gReady = true;
  scanLeft = n; // every vertex gets one visit before the next rebuild
}

/**
 * Sample the grid at a share of the vertices (all of them once per RAD_PERIOD, spread over its frames).
 * Cloth a flame already touches (pushed last frame) is left to the flame: radiant heat is for what threads
 * can't reach (a fold above the fire, the next noren panel), so it doesn't speed up the sheet's own front
 * and can be strong.
 */
function radiantScan(count) {
  if (!gReady || scanLeft <= 0) return;
  const { pos, heat, alias, fuel } = cl;
  const ox = gF[0], oy = gF[1], oz = gF[2], inv = gF[4], gain = gF[5], recent = frameNo - 1;
  if (count > scanLeft) count = scanLeft;
  scanLeft -= count;
  let i = scanPos;
  for (let s = 0; s < count; s++, i++) {
    if (i >= n) i = 0;
    const o = i * 3;
    const fx = (pos[o] - ox) * inv, fy = (pos[o + 1] - oy) * inv, fz = (pos[o + 2] - oz) * inv;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= gnx || fy >= gny || fz >= gnz) continue;
    if (alias[i] >= 0 || state[i] >= S_FLAME || fuel[i] <= 0 || pushed[i] >= recent) continue;
    const p = gB[(fx | 0) + gnx * ((fy | 0) + gny * (fz | 0))];
    if (p <= 0) continue;
    const T = heat[i], g = p * gain, add = (1 - T) * (g < 0.3 ? g : 0.3);
    if (add < 2e-4) continue;
    heat[i] = T + add;
    addActive(i);
  }
  scanPos = i >= n ? 0 : i;
}

// ---- per-vertex combustion, emission, burn-through ----
function react(world, dt) {
  const { heat, fuel, char, wet, pos, normal, area } = cl;
  const glowOnly = !!M.glowOnly, ign0 = M.ign, cam = world.camera.pos, fno = frameNo;
  // flame tongues per m² of flame per second: the fire-wide count grows like area^0.4
  const fA = lastFlameArea > 0.002 ? lastFlameArea : 0.002;
  const dens = (emitScale * FLAME_N * Math.pow(fA / A_REF, 0.4)) / (0.42 * fA);
  const fSize = M.flameSize * sizeBoost * (0.7 + 0.45 * Math.min(1, Math.sqrt(fA / 0.25)));
  const rdt = dt * ROT * emitScale, rot = fno & (ROT - 1), tNow = world.time, rainI = world.rain.intensity;
  let nBurn = 0, fArea = 0, aW = 0, aX = 0, aY = 0, aZ = 0, aH = 0, aNx = 0, aNy = 0, aNz = 0; // locals: no boxing
  const cx = cam[0], cy = cam[1], cz = cam[2];
  acc[5] = acc[6] = acc[7] = acc[8] = 0;
  for (let k = 0; k < nActive;) {
    const i = active[k];
    let s = state[i];
    if (s === S_DEAD || !visible(i)) {
      if (s !== S_DEAD) retire(world, i, fuel[i] < Q_SPENT);
      inAct[i] = 0; active[k] = active[--nActive]; continue;
    }
    const o = i * 3, a = area[i], w = wet[i], rare = ((i & (ROT - 1)) === rot) && !crowded;
    let T = heat[i];
    const cap = wetCap(w);

    if (glowOnly) {
      // ---- chainmail: heat, conduction, radiative cooling, glow, forge sparks. Wet steel quenches fast;
      // the steam of that is weather's (it evaporates wherever heat meets water) ----
      T -= dt * (M.coolLin * T + M.coolRad * T * T * T * T + 1.6 * w * T);
      if (T > 0.68 && char[i] < 0.22) char[i] = Math.min(0.22, char[i] + dt * 0.04 * (T - 0.6)); // temper oxide
      if (T < 0) T = 0; else if (T > 1) T = 1;
      heat[i] = T;
      if (T > 0.4) {
        const gg = (T - 0.4) / 0.6, gw = 3 * gg * gg * a; // glowing steel is a bright little lamp
        aW += gw; aX += pos[o] * gw; aY += pos[o + 1] * gw; aZ += pos[o + 2] * gw; aH += T * gw;
        const sg = normal[o] * (cx - pos[o]) + normal[o + 1] * (cy - pos[o + 1]) + normal[o + 2] * (cz - pos[o + 2]) >= 0 ? gw : -gw;
        aNx += normal[o] * sg; aNy += normal[o + 1] * sg; aNz += normal[o + 2] * sg;
        if (T > 0.86 && rare && rand() < rdt * 140 * a * M.spark * (T - 0.86)) spark(world, pos[o], pos[o + 1], pos[o + 2], 0.7, 0.25);
      }
      if (T < 0.004) { heat[i] = 0; state[i] = S_IDLE; inAct[i] = 0; active[k] = active[--nActive]; continue; }
      k++; continue;
    }

    const ign = ign0 + ignJ[i], fu0 = fuel[i];
    let fu = fu0;
    // rain falls on whichever face looks at the sky: a tarp catches it all, a hanging sheet hardly any
    let rq = 0;
    if (rainI > 0.02) { const nu = normal[o] * Ux + normal[o + 1] * Uy + normal[o + 2] * Uz; rq = rainI * (nu < 0 ? -nu : nu); }
    // water: quench a flame, smother a smoulder (a burst of steam: the moment it dies)
    if ((s === S_FLAME && cap < ign) || (s === S_SMOULDER && cap < M.smoulderT)) {
      steamAt(i, 0.25 * flame[i] + 0.1, a);
      s = S_HEAT;
    }
    if (s === S_FLAME) {
      // ---- flaming ----
      const tf = fu > 0.35 ? 1 : 0.22 + 0.78 * (fu / 0.35);
      let f = flame[i];
      f += (tf - f) * Math.min(1, dt * (tf > f ? 7 : 3));
      flame[i] = f;
      // under the flame the cloth is black char barely glowing; it glows hot only as its fuel runs out,
      // the ember edge the hole recedes behind
      const sp = 1 - fu, Tt = M.flameLo + (M.flameHi - M.flameLo) * sp * sp * sp;
      T += (Tt - T) * Math.min(1, dt * 6);
      // rain falling into the flames hisses and cools them directly (the soaking arrives via cloth.wet);
      // full rain on a sky-facing flame drowns it
      const rs = 1 - 0.5 * rq;
      if (rq > 0.01) { T -= dt * RAIN_COOL * rq; steamAt(i, dt * 6 * rq * f, a); }
      fu -= (dt * rateJ[i] * (0.3 + 0.7 * f) * fan * rs) / M.burnTime;
      char[i] = char[i] + dt * 3 > 1 ? 1 : char[i] + dt * 3;
      nBurn++; fArea += f * a;
      const lw = f * a * M.light;
      aW += lw; aX += pos[o] * lw; aY += pos[o + 1] * lw; aZ += pos[o + 2] * lw; aH += T * lw;
      const sg = normal[o] * (cx - pos[o]) + normal[o + 1] * (cy - pos[o + 1]) + normal[o + 2] * (cz - pos[o + 2]) >= 0 ? lw : -lw;
      aNx += normal[o] * sg; aNy += normal[o + 1] * sg; aNz += normal[o + 2] * sg;
      // flame tongues: emission rides a smooth noise field that drifts up the plume, so flames come in
      // licking clusters rather than an even glow (mean 1); a per-vertex accumulator keeps each stream
      // steady without a rand() per vertex
      const tg = 1 + 0.9 * noise3(pos[o] * 6.5 + 3.3, (pos[o + 1] - tNow * 0.55) * 4.5, pos[o + 2] * 6.5 - tNow * 0.35);
      let ea = emAcc[i] + M.flame * f * a * dt * dens * tg * rs;
      if (ea >= 1) { const kf = ea | 0; ea -= kf; flames(world, i, kf, f, fSize * (0.75 + 0.25 * tg), cam, normal); }
      emAcc[i] = ea;
      if (rare) emitRare(world, i, f, fu, a, rdt, cam, normal);
      if (fu <= 0) { fu = 0; burnout(world, i); s = S_HEAT; }
      // drowned by the rain: cooled well below what this flame burns at (velvet flames burn below their
      // ignition point, so the test is against the flame's own temperature, and only under rain)
      else if (rq > 0.01 && T < (ign < Tt ? ign : Tt) - 0.06) { steamAt(i, 0.25 * f + 0.1, a); s = S_HEAT; }
    } else if (s === S_SMOULDER) {
      // ---- smouldering (velvet): a glowing char front that eats fuel slowly and may burst into flame ----
      T += (M.smoulderHeat - T) * Math.min(1, dt * 2.5);
      if (rq > 0.01) { T -= dt * RAIN_COOL * rq; if (T < M.smoulderT) { steamAt(i, 0.1, a); s = S_HEAT; } }
      fu -= (dt * rateJ[i]) / M.smoulderTime;
      char[i] = char[i] + dt * 1.6 > 1 ? 1 : char[i] + dt * 1.6;
      nBurn++;
      const lw = 0.25 * a * M.light;
      aW += lw; aX += pos[o] * lw; aY += pos[o + 1] * lw; aZ += pos[o + 2] * lw; aH += 0.3 * lw;
      const sg = normal[o] * (cx - pos[o]) + normal[o + 1] * (cy - pos[o + 1]) + normal[o + 2] * (cz - pos[o + 2]) >= 0 ? lw : -lw;
      aNx += normal[o] * sg; aNy += normal[o + 1] * sg; aNz += normal[o + 2] * sg;
      if (rare) {
        if (rand() < R_SMOKE * 2.2 * M.smoke * a * rdt) smoke(world, i, 0.9, M.smokeDark, normal, cam);
        if (rand() < R_EMBER * 0.5 * M.ember * a * rdt) ember(world, pos[o], pos[o + 1], pos[o + 2], 0.5);
      }
      // deep char bursts into flame now and then; held hard in a flame (a torch, a fire below) it catches
      if (fu > 0.15 && ((char[i] > 0.8 && rand() < dt * M.flareUp * fan) || (char[i] > 0.5 && T >= ign + 0.02))) {
        T = Math.max(T, ign + 0.06); s = S_FLAME; flame[i] = 0.3; emAcc[i] = rand(); newFire(world, i, 0.25);
      }
      if (fu <= 0) { fu = 0; burnout(world, i); s = S_HEAT; }
    } else {
      // ---- hot but not burning: cools (unless a flame is on it), scorches, may catch ----
      let f = flame[i];
      if (f > 0) { f -= dt * 4; flame[i] = f > 0 ? f : 0; }
      if (pushed[i] !== fno) T -= dt * T * (M.cool + 1.5 * w);
      if (rq > 0.01) T -= dt * T * 2 * rq; // rain on hot cloth
      if (T > T_CHAR && fu > 0) {
        const cmax = M.charCap, cr = (dt * M.charRate * (T - T_CHAR)) / (ign - T_CHAR);
        if (char[i] < cmax) char[i] = char[i] + cr > cmax ? cmax : char[i] + cr;
        if (rare && T > 0.3 && char[i] > 0.25 && rand() < R_SMOKE * 1.4 * M.smoke * a * rdt * (T - 0.3)) smoke(world, i, 0.5, M.smokeDark * 0.6, normal, cam);
      }
      if (fu > 0 && T >= ign && cap > ign) {
        s = S_FLAME; flame[i] = 0.12; emAcc[i] = rand(); T = Math.max(T, ign);
        newFire(world, i, 0.5);
      } else if (fu > 0 && M.smoulderT > 0 && T >= M.smoulderT && cap > M.smoulderT) {
        s = S_SMOULDER;
      } else if (fu <= 0 && T > 0.5) {
        // a spent ember edge: glowing, shedding a few embers as it cools
        const lw = 0.12 * (T - 0.5) * a * M.light;
        aW += lw; aX += pos[o] * lw; aY += pos[o + 1] * lw; aZ += pos[o + 2] * lw; aH += 0.2 * lw;
        if (rare && rand() < R_EMBER * 0.4 * M.ember * a * rdt) ember(world, pos[o], pos[o + 1], pos[o + 2], 0.4);
      }
    }
    if (T > cap) T = cap; // pinned near boiling while wet: weather evaporates it (and makes the steam)
    if (T < 0) T = 0; else if (T > 1) T = 1;
    heat[i] = T; fuel[i] = fu; state[i] = s;
    // burn-through: when this vertex's fuel crosses the line, cut out every quad around it whose four
    // corners are now all spent (a quad can only complete when its last corner crosses)
    if (fu < Q_SPENT && fu0 >= Q_SPENT) {
      cutSpent(world, i);
      if (state[i] === S_DEAD || !visible(i)) { if (state[i] !== S_DEAD) retire(world, i, true); inAct[i] = 0; active[k] = active[--nActive]; continue; }
    }
    if (s <= S_HEAT && T < 0.004 && flame[i] <= 0) {
      heat[i] = 0; state[i] = fu > 0 ? S_IDLE : S_HEAT;
      inAct[i] = 0; active[k] = active[--nActive]; continue;
    }
    k++;
  }
  burning = nBurn; flameArea = fArea;
  acc[0] = aW; acc[1] = aX; acc[2] = aY; acc[3] = aZ; acc[4] = aH; acc[9] = aNx; acc[10] = aNy; acc[11] = aNz;
}

/** A vertex left with no cloth: drop it (fire-made orphans also lose their dangling threads). */
function retire(world, i, burnt) {
  if (burnt) {
    killVertex(world, i);
    if (cl.fuel[i] > 0) { burntArea += cl.area[i]; cl.fuel[i] = 0; }
  }
  state[i] = S_DEAD; flame[i] = 0; cl.heat[i] = 0;
}

/** Fuel ran out at vertex i: burn-through. */
function burnout(world, i) {
  const o = i * 3, p = cl.pos;
  burntArea += cl.area[i];
  flame[i] *= 0.5;
  world.events.burnout.push(p[o], p[o + 1], p[o + 2], 0); evCount[1]++;
  if (crowded) return;
  const k = draws((1.4 + 2.2 * rand()) * M.spark * Math.min(1.5, emitScale * 1.2));
  for (let s = 0; s < k; s++) spark(world, p[o], p[o + 1], p[o + 2], 1, 1);
  if (rand() < 0.6 * M.ember) ember(world, p[o], p[o + 1], p[o + 2], 1);
  if (M.drip > 0 && rand() < 0.7 * M.drip) drip(world, p[o], p[o + 1], p[o + 2]);
}

/** Cut out every quad around spent vertex i whose four corners are all spent. */
function cutSpent(world, i) {
  const { vcStart, vcList, kind, alive, cTri, triAlive, triQuad, cA, cB, fuel, tri } = cl;
  for (let e = vcStart[i]; e < vcStart[i + 1]; e++) {
    const j = vcList[e];
    if (kind[j] !== 0 || !alive[j]) continue; // stretch threads reach every triangle at i
    for (let s = 0; s < 2; s++) {
      const t = cTri[j * 2 + s];
      if (t < 0 || !triAlive[t]) continue;
      const q0 = triQuad[t * 2], q1 = triQuad[t * 2 + 1];
      if (q0 >= 0 && q1 >= 0) {
        const a = cA[q0], b = cB[q0], c = cA[q1], d = cB[q1];
        if (fuel[a] < Q_SPENT && fuel[b] < Q_SPENT && fuel[c] < Q_SPENT && fuel[d] < Q_SPENT) {
          ashFrom(world, a, b, c, d);
          breakConstraint(world, q0, false); breakConstraint(world, q1, false);
          ghosts(world, a); ghosts(world, b); ghosts(world, c); ghosts(world, d);
        }
      } else {
        // a lone triangle (no quad bookkeeping): cut the thread when its three corners are spent
        let ok = true;
        for (let c3 = 0; c3 < 3; c3++) { let v = tri[t * 3 + c3]; if (cl.alias[v] >= 0) v = cl.alias[v]; if (fuel[v] >= Q_SPENT) ok = false; }
        if (ok) { breakConstraint(world, j, false); ghosts(world, cA[j]); ghosts(world, cB[j]); }
      }
    }
  }
}

/** Threads at v with cloth on neither side are cut; a spent vertex left with no cloth is removed. */
function ghosts(world, v) {
  const { vcStart, vcList, kind, alive, cTri, triAlive } = cl;
  for (let e = vcStart[v]; e < vcStart[v + 1]; e++) {
    const j = vcList[e];
    if (kind[j] !== 0 || !alive[j]) continue;
    const t0 = cTri[j * 2], t1 = cTri[j * 2 + 1];
    if ((t0 < 0 || !triAlive[t0]) && (t1 < 0 || !triAlive[t1])) breakConstraint(world, j, false);
  }
  if (state[v] !== S_DEAD && !visible(v) && cl.fuel[v] < Q_SPENT) retire(world, v, true);
}

/** A new, separate fire started (torch catch, radiant jump, flare-up): tell audio, rate-limited. */
function newFire(world, i, strength) {
  if (world.time - lastNewFire < 0.35) return;
  const alive = cl.alive;
  for (let e = nStart[i]; e < nStart[i + 1]; e++) if (alive[nC[e]] && state[nV[e]] === S_FLAME) return; // part of a front
  lastNewFire = world.time;
  const o = i * 3, p = cl.pos;
  world.events.ignite.push(p[o], p[o + 1], p[o + 2], strength); evCount[0]++;
}

// ------------------------------------------------------------------------------------------- emission
/** k flame tongues from burning vertex i: on the face toward the viewer mostly, rising along the plume. */
function flames(world, i, k, f, fSize, cam, nrm) {
  const p = cl.pos, o = i * 3, x = p[o], y = p[o + 1], z = p[o + 2];
  const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2];
  const face = nx * (cam[0] - x) + ny * (cam[1] - y) + nz * (cam[2] - z) >= 0 ? 1 : -1;
  const spread = Math.sqrt(cl.area[i]) * 0.55;
  for (; k > 0; k--) {
    const side = rand() < 0.78 ? face : -face, off = 0.004 + rand() * 0.016;
    const jx = (rand() - 0.5) * spread, jy = (rand() - 0.5) * spread, jz = (rand() - 0.5) * spread;
    const up = 0.32 + rand() * 0.55;
    const sz = (0.034 + rand() * 0.04) * fSize * (0.55 + 0.45 * f);
    if (!emit(world, PK.FLAME, x + nx * off * side + jx, y + ny * off * side + jy, z + nz * off * side + jz,
      Px * up + wx * 0.14 + nx * side * 0.05, Py * up + wy * 0.14 + ny * side * 0.05, Pz * up + wz * 0.14 + nz * side * 0.05,
      sz, (0.26 + rand() * 0.3) * (0.8 + 0.4 * f), M.warmth * (0.75 + 0.25 * f))) return;
  }
}

/** Sparks, embers, smoke, ash and drips from a burning vertex (checked on 1 frame in ROT, rates × ROT). */
function emitRare(world, i, f, fu, a, rdt, cam, nrm) {
  const p = cl.pos, o = i * 3, x = p[o], y = p[o + 1], z = p[o + 2];
  if (rand() < R_SPARK * M.spark * f * a * rdt * fan) spark(world, x, y, z, 0.6, 0.6);
  // glowing flakes lift off the thinning, charred edge
  if (rand() < R_EMBER * M.ember * a * rdt * (fu < 0.5 ? 1.4 - fu : 0.25)) ember(world, x, y, z, 0.8);
  // smoke: heavier as the flame dies and the char smoulders
  if (rand() < R_SMOKE * M.smoke * a * rdt * (1.5 - f)) smoke(world, i, 0.6 + 0.4 * f, M.smokeDark, nrm, cam);
  if (fu < 0.3 && rand() < R_ASH * M.ash * a * rdt) ash(world, x, y, z, 0.6);
  if (M.drip > 0 && rand() < 6 * M.drip * a * rdt * f) drip(world, x, y, z);
}

function spark(world, x, y, z, energy, upBias) {
  // a hot fleck flung off: mostly upward, fast, short-lived; streaks along its velocity
  let dx = rand() * 2 - 1, dy = rand() * 2 - 1, dz = rand() * 2 - 1;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const sp = (0.9 + rand() * 2.6) * energy;
  dx = (dx / l) * sp + Ux * upBias * 1.2 + wx * 0.25; dy = (dy / l) * sp + Uy * upBias * 1.2 + wy * 0.25; dz = (dz / l) * sp + Uz * upBias * 1.2 + wz * 0.25;
  return emit(world, PK.SPARK, x, y, z, dx, dy, dz, 0.006 + rand() * 0.007, 0.35 + rand() * 0.75, 0);
}
function ember(world, x, y, z, lift) {
  const u = (0.25 + rand() * 0.7) * lift;
  return emit(world, PK.EMBER, x + (rand() - 0.5) * 0.02, y + (rand() - 0.5) * 0.02, z + (rand() - 0.5) * 0.02,
    Ux * u + (rand() - 0.5) * 0.35 + wx * 0.2, Uy * u + (rand() - 0.5) * 0.2 + wy * 0.2, Uz * u + (rand() - 0.5) * 0.35 + wz * 0.2,
    (0.007 + rand() * 0.011) * sizeBoost, 1.4 + rand() * 2.2, 0);
}
function smoke(world, i, strength, dark, nrm, cam) {
  const p = cl.pos, o = i * 3;
  const nx = nrm[o], ny = nrm[o + 1], nz = nrm[o + 2];
  const face = nx * (cam[0] - p[o]) + ny * (cam[1] - p[o + 1]) + nz * (cam[2] - p[o + 2]) >= 0 ? 0.03 : -0.03;
  const u = 0.18 + rand() * 0.3;
  const sz = (0.07 + rand() * 0.07) * (0.6 + 0.4 * strength) * (0.75 + 0.5 * Math.min(1, tierScale));
  return emit(world, PK.SMOKE, p[o] + nx * face, p[o + 1] + ny * face + 0.03, p[o + 2] + nz * face,
    Ux * u + wx * 0.12, Uy * u + wy * 0.12, Uz * u + wz * 0.12, sz, 1.8 + rand() * 1.4, dark);
}
function ash(world, x, y, z, lift) {
  const u = (0.1 + rand() * 0.45) * lift;
  return emit(world, PK.ASH, x, y, z, Ux * u + (rand() - 0.5) * 0.3, Uy * u + (rand() - 0.5) * 0.15, Uz * u + (rand() - 0.5) * 0.3,
    0.009 + rand() * 0.014, 2.5 + rand() * 2.5, 0);
}
function drip(world, x, y, z) {
  // aurora film melts: a burning droplet falls away
  return emit(world, PK.SPARK, x, y, z, (rand() - 0.5) * 0.15, -0.2 - rand() * 0.3, (rand() - 0.5) * 0.15, 0.011 + rand() * 0.006, 0.6 + rand() * 0.5, 0);
}
function ashFrom(world, a, b, c, d) {
  if (crowded || M.ash <= 0) return;
  const p = cl.pos, k = draws(0.9 * M.ash * emitScale);
  for (let s = 0; s < k; s++) {
    const u = rand(), v = rand();
    const x = (p[a * 3] + p[b * 3] + p[c * 3] + p[d * 3]) * 0.25 + (u - 0.5) * 0.03;
    const y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1] + p[d * 3 + 1]) * 0.25 + (v - 0.5) * 0.03;
    const z = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2] + p[d * 3 + 2]) * 0.25;
    ash(world, x, y, z, 1);
  }
}

// ------------------------------------------------------------------------------------------- steam
function steamAt(i, amount, a) {
  if (amount <= 0) return;
  const p = cl.pos, o = i * 3, w = amount * a;
  acc[5] += w; acc[6] += p[o] * w; acc[7] += p[o + 1] * w; acc[8] += p[o + 2] * w;
}
function steamEvent(world) {
  const sw = acc[5];
  if (sw <= 1e-7) return;
  const x = acc[6] / sw, y = acc[7] / sw, z = acc[8] / sw;
  const amount = Math.min(1, sw * 120);
  world.events.steam.push(x, y, z, amount); evCount[2]++;
  // puffs where it hisses
  let k = draws(Math.min(6, R_STEAM * sw * emitScale));
  for (; k > 0; k--) {
    const u = 0.4 + rand() * 0.6;
    if (!emit(world, PK.STEAM, x + (rand() - 0.5) * 0.12, y + (rand() - 0.5) * 0.08, z + (rand() - 0.5) * 0.12,
      Ux * u + wx * 0.1 + (rand() - 0.5) * 0.2, Uy * u + wy * 0.1, Uz * u + wz * 0.1 + (rand() - 0.5) * 0.2,
      0.05 + rand() * 0.06, 0.6 + rand() * 0.6, 0)) break;
  }
}

// ------------------------------------------------------------------------------------------- light
function light(world, dt) {
  const L = world.lights, accW = acc[0];
  if (accW > 1e-7) {
    const tx = acc[1] / accW, ty = acc[2] / accW, tz = acc[3] / accW;
    if (!haveLight) { lx = tx; ly = ty; lz = tz; haveLight = true; freshLight = true; }
    const kk = Math.min(1, dt * 8);
    lx += (tx - lx) * kk; ly += (ty - ly) * kk; lz += (tz - lz) * kk;
    // colour temperature: bigger and hotter fires burn yellower; embers and smoulder burn red
    const hot = acc[4] / accW;
    const tw = M.warmth * 0.55 + 0.25 * Math.min(1, Math.sqrt(accW / 0.12)) + 0.3 * (hot - 0.6);
    lWarm += (tw - lWarm) * Math.min(1, dt * 3);
  }
  const target = M.light * LIGHT_MAX * (1 - Math.exp(-accW / LIGHT_W0));
  lI += (target - lI) * Math.min(1, dt * (target > lI ? 9 : 1.6));
  if (flare > 0) flare = Math.max(0, flare - dt * 3.2);
  // the plume for updraft(): rooted at the fire's centroid, as wide as the fire, as strong as its light
  plume[0] = lx; plume[1] = ly; plume[2] = lz;
  plume[3] = 0.12 + 0.55 * Math.min(1, Math.sqrt(accW / 0.5));
  plume[4] = haveLight ? (lI / (LIGHT_MAX * (M.light || 1))) * (M.glowOnly ? 0.5 : 1) : 0;
  plume[5] = Px; plume[6] = Py; plume[7] = Pz;
  const I0 = lI + flare * 0.9;
  if (I0 < 1e-3 || !haveLight || debugFlags.noLight) { L.fireCol[0] = L.fireCol[1] = L.fireCol[2] = 0; if (I0 < 1e-3) lI = 0; return; }
  // smooth flicker (value noise, not per-frame white noise); big fires sway slower
  const t = world.time, rate = 1 / (1 + 1.6 * Math.sqrt(accW));
  const fl = 1 + 0.17 * noise3(t * 7.3 * rate, 0.37, 1.3) + 0.08 * noise3(t * 17.9 * rate, 2.1, 4.7);
  let I = I0 * (fl > 0.55 ? fl : 0.55);
  if (I > LIGHT_CAP) I = LIGHT_CAP; // a ceiling, so ember edges and char still read under a big fire
  let wm = lWarm + flare * 0.5; wm = wm < 0 ? 0 : wm > 1 ? 1 : wm;
  // deep orange-red (0) → amber → white-gold (1), linear
  L.fireCol[0] = I;
  L.fireCol[1] = I * (0.26 + 0.42 * wm);
  L.fireCol[2] = I * (0.05 + 0.33 * wm * wm);
  // The light stands LIGHT_OFF off the burning cloth along its average normal, on the side the camera
  // sees (the flame-weighted, camera-facing normal, smoothed), a little above the front: the visible face
  // is fire-lit evenly instead of a hot spot right on the cloth.
  const cam = world.camera.pos;
  let tx = acc[9], ty = acc[10], tz = acc[11], tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-9 * (accW + 1e-9) || tl === 0) { tx = cam[0] - lx; ty = cam[1] - ly; tz = cam[2] - lz; tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1; }
  tx /= tl; ty /= tl; tz /= tl;
  const kn = freshLight ? 1 : Math.min(1, dt * 4); // a new fire takes its own side at once
  freshLight = false;
  let nx = lnrm[0] + (tx - lnrm[0]) * kn, ny = lnrm[1] + (ty - lnrm[1]) * kn, nz = lnrm[2] + (tz - lnrm[2]) * kn;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  lnrm[0] = nx; lnrm[1] = ny; lnrm[2] = nz;
  const h = 0.04 + 0.12 * Math.min(1, Math.sqrt(accW / 0.2));
  const jx = 0.025 * noise3(t * 3.1, 7.7, 0.4), jy = 0.03 * noise3(t * 4.3, 1.9, 5.1);
  L.firePos[0] = lx + nx * LIGHT_OFF + Ux * h + jx;
  L.firePos[1] = ly + ny * LIGHT_OFF + Uy * h + jy;
  L.firePos[2] = lz + nz * LIGHT_OFF + Uz * h;
}

/**
 * The fire's buoyant plume as a velocity field: ADDS m/s to out at (x, y, z). Rooted at the burn
 * front's centroid, leaning with the wind, strongest just above the flames and fading with height and
 * distance from its axis. Zero (one compare) when nothing burns. Meant for wind.sample (CONTRACT
 * REQUEST): burning silk then lifts and billows on its own heat, and smoke and embers ride the column.
 */
export function updraft(x, y, z, out) {
  const s = plume[4];
  if (s < 0.01) return out;
  const ax = plume[5], ay = plume[6], az = plume[7];
  const dx = x - plume[0], dy = y - plume[1], dz = z - plume[2];
  const h = dx * ax + dy * ay + dz * az;           // height along the plume axis
  if (h < -0.08 || h > 2.5) return out;
  const rx = dx - ax * h, ry = dy - ay * h, rz = dz - az * h;
  const R = plume[3] * (1 + 0.35 * (h > 0 ? h : 0)); // the column widens as it rises
  const r2 = (rx * rx + ry * ry + rz * rz) / (R * R);
  if (r2 > 4) return out;
  const along = h < 0.12 ? (h + 0.08) / 0.2 : 1 / (1 + 0.8 * (h - 0.12));
  const v = UPDRAFT * s * along * Math.exp(-r2);
  out[0] += ax * v; out[1] += ay * v; out[2] += az * v;
  return out;
}

// ------------------------------------------------------------------------------------------- tools
/** The local thread length at v (shortest rest length), so tools cover the same spot at every tier. */
function cellAt(v) {
  let ir = 0;
  for (let e = nStart[v]; e < nStart[v + 1]; e++) if (nIR[e] > ir) ir = nIR[e];
  return ir > 0 ? 1 / ir : 0.05;
}

/** Collect master vertices within ~2R of v along intact threads, with gaussian weights (radius R). */
function gather(v, R) {
  const { pos, alive } = cl;
  seenGen++;
  let m = 0;
  ring[m] = v; ringW[m++] = 1; seen[v] = seenGen;
  const ox = pos[v * 3], oy = pos[v * 3 + 1], oz = pos[v * 3 + 2], s2 = R * R;
  for (let h = 0; h < m && m < 96; h++) {
    const u = ring[h];
    if (h > 0 && ringW[h] < 0.2) continue; // don't expand past the edge
    for (let e = nStart[u]; e < nStart[u + 1] && m < 96; e++) {
      if (!alive[nC[e]]) continue;
      const nb = nV[e];
      if (seen[nb] === seenGen) continue;
      seen[nb] = seenGen;
      const dx = pos[nb * 3] - ox, dy = pos[nb * 3 + 1] - oy, dz = pos[nb * 3 + 2] - oz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > s2 * 4) continue;
      ring[m] = nb; ringW[m++] = Math.exp(-d2 / s2);
    }
  }
  return m;
}

/** Tap with the burn tool: light a small cluster at vertex v with a flare. Returns true if it caught. */
export function ignite(world, v, strength = 1) {
  const c = world.cloth; if (!c || v < 0 || v >= c.n) return false;
  if (c !== cl) onScene(world);
  if (cl.alias[v] >= 0) v = cl.alias[v];
  if (state[v] === S_DEAD || cl.fuel[v] <= 0 || !visible(v)) return false;
  env(world);
  const { heat, fuel, wet, pos } = cl;
  const m = gather(v, Math.max(0.04 + 0.025 * strength, 0.8 * cellAt(v)));
  let caught = 0, fizz = 0;
  for (let h = 0; h < m; h++) {
    const u = ring[h], wt = ringW[h];
    if (state[u] === S_DEAD || fuel[u] <= 0) continue;
    if (M.glowOnly) { heat[u] = Math.min(1, heat[u] + 0.5 * strength * wt); caught++; addActive(u); continue; }
    const cap = wetCap(wet[u]), ign = M.ign + ignJ[u], smoulders = M.smoulderT > 0 && strength < 1.5;
    if (cap <= (smoulders ? M.smoulderT : ign)) { heat[u] = Math.max(heat[u], cap); fizz += wt; addActive(u); continue; }
    // velvet: a tap lights a smoulder (just above its smoulder point), not a flame
    const T = smoulders ? Math.min(cap, M.smoulderHeat + 0.06 * wt)
      : Math.min(cap, (ign + 0.04) * (0.35 + 0.65 * wt) + 0.12 * wt * strength);
    if (T > heat[u]) heat[u] = T;
    if (state[u] === S_FLAME || state[u] === S_SMOULDER) caught++;
    else if (smoulders && heat[u] >= M.smoulderT) { state[u] = S_SMOULDER; caught++; }
    else if (heat[u] >= ign) { state[u] = S_FLAME; flame[u] = Math.max(flame[u], 0.55 * wt); emAcc[u] = rand(); caught++; }
    addActive(u);
  }
  const o = v * 3, x = pos[o], y = pos[o + 1], z = pos[o + 2];
  if (fizz > 0 && !caught) {
    // wet: a hiss and a puff of steam, no fire
    world.events.steam.push(x, y, z, 0.6); evCount[2]++;
    for (let k = 0; k < 4; k++) {
      const u = 0.4 + rand() * 0.5;
      if (!put(world, PK.STEAM, x + (rand() - 0.5) * 0.05, y, z + (rand() - 0.5) * 0.05, Ux * u, Uy * u, Uz * u, 0.05 + rand() * 0.04, 0.6 + rand() * 0.5, 0)) break;
    }
    return false;
  }
  world.events.ignite.push(x, y, z, strength); evCount[0]++;
  lastNewFire = world.time;
  flare = Math.min(1.5, flare + (M.glowOnly ? 0.45 : 0.9) * strength);
  if (!haveLight) { lx = x; ly = y; lz = z; haveLight = true; freshLight = true; lWarm = M.warmth; }
  // the flare: a burst of flame, a spray of sparks, a few embers
  const nb = M.glowOnly ? 0 : draws((7 + 6 * strength) * Math.min(1.4, emitScale + 0.3) * (M.flame > 0.5 ? 1 : 0.6));
  for (let k = 0; k < nb; k++) {
    const up = 0.6 + rand() * 1.1, sx = (rand() - 0.5) * 0.5, sz = (rand() - 0.5) * 0.5;
    if (!put(world, PK.FLAME, x + (rand() - 0.5) * 0.04, y + (rand() - 0.5) * 0.03, z + (rand() - 0.5) * 0.04,
      Ux * up + sx, Uy * up, Uz * up + sz, (0.05 + rand() * 0.06) * M.flameSize * sizeBoost, 0.3 + rand() * 0.3, Math.min(1, M.warmth + 0.3))) break;
  }
  const ns = draws((8 + 8 * strength) * M.spark * Math.min(1.4, emitScale + 0.3));
  for (let k = 0; k < ns; k++) {
    let dx = rand() * 2 - 1, dy = rand() * 2 - 1, dz = rand() * 2 - 1; const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; const sp = 1.2 + rand() * 2.8;
    if (!put(world, PK.SPARK, x, y, z, (dx / l) * sp + Ux * 0.8, (dy / l) * sp + Uy * 0.8, (dz / l) * sp + Uz * 0.8, 0.006 + rand() * 0.007, 0.35 + rand() * 0.6, 0)) break;
  }
  if (!M.glowOnly) for (let k = 0; k < 3; k++) if (!put(world, PK.EMBER, x, y, z, (rand() - 0.5) * 0.4, 0.5 + rand() * 0.6, (rand() - 0.5) * 0.4, 0.01 * sizeBoost, 1.5 + rand() * 1.5, 0)) break;
  return true;
}

/** Hold the burn tool at vertex v for dt (real) seconds: a lighter flame that catches within a beat. */
export function torch(world, v, dt) {
  const c = world.cloth; if (!c || v < 0 || v >= c.n) return;
  if (c !== cl) onScene(world);
  const sdt = world.paused ? 0 : dt * world.timeScale; // in step with the simulation (slow-mo, pause)
  if (sdt <= 0) return;
  if (cl.alias[v] >= 0) v = cl.alias[v];
  if (state[v] === S_DEAD || !visible(v)) return;
  env(world);
  const { heat, fuel, pos } = cl;
  const m = gather(v, Math.max(TORCH_SIGMA, 0.75 * cellAt(v)));
  const rate = TORCH_RATE * M.torch * sdt;
  for (let h = 0; h < m; h++) {
    const u = ring[h];
    if (state[u] === S_DEAD) continue;
    const T = heat[u];
    if (M.glowOnly) heat[u] = Math.min(1, T + (1 - T) * rate * 0.55 * ringW[h]);
    else if (fuel[u] > 0 && state[u] !== S_FLAME) heat[u] = Math.min(1, T + (T_PUSH - T) * Math.min(0.5, rate * ringW[h]));
    pushed[u] = frameNo + 1; // held in the flame: doesn't cool this frame
    addActive(u);
  }
  // the lighter's own small flame, in front of the cloth (bypasses the buckets: it's the tool's feedback)
  const o = v * 3, cam = world.camera.pos, nr = cl.normal;
  const face = nr[o] * (cam[0] - pos[o]) + nr[o + 1] * (cam[1] - pos[o + 1]) + nr[o + 2] * (cam[2] - pos[o + 2]) >= 0 ? 1 : -1;
  const x = pos[o] + nr[o] * 0.02 * face, y = pos[o + 1] + nr[o + 1] * 0.02 * face, z = pos[o + 2] + nr[o + 2] * 0.02 * face;
  const kf = draws(sdt * 70 * Math.min(1.3, emitScale + 0.3));
  for (let k = 0; k < kf; k++) {
    const up = 0.45 + rand() * 0.45;
    if (!put(world, PK.FLAME, x + (rand() - 0.5) * 0.012, y - 0.01, z + (rand() - 0.5) * 0.012, Ux * up + wx * 0.1, Uy * up, Uz * up + wz * 0.1,
      (0.022 + rand() * 0.016) * sizeBoost, 0.18 + rand() * 0.14, 0.85)) break;
  }
  if (M.glowOnly) {
    // a forge: sparks fly harder the hotter the steel gets
    const ks = draws(sdt * (14 + 90 * heat[v] * heat[v]) * M.spark * Math.min(1.3, emitScale + 0.3));
    for (let k = 0; k < ks; k++) {
      let dx = rand() * 2 - 1, dy = rand() * 2 - 1, dz = rand() * 2 - 1; const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1; const sp = (0.9 + rand() * 2.4) * (0.6 + heat[v]);
      if (!put(world, PK.SPARK, x, y, z, (dx / l) * sp + Ux * 0.4, (dy / l) * sp + Uy * 0.4, (dz / l) * sp + Uz * 0.4, 0.005 + rand() * 0.006, 0.3 + rand() * 0.6, 0)) break;
    }
    flare = Math.max(flare, 0.12);
    if (!haveLight) { lx = pos[o]; ly = pos[o + 1]; lz = pos[o + 2]; haveLight = true; freshLight = true; }
  }
}

/** Test access to the per-vertex state (0 idle · 1 hot · 2 smoulder · 3 flame · 4 dead). Not used by the frame. */
export function _state() { return { state, flame, n }; }

/** Numbers for tests and the receipt (not part of the frame). */
export function debug() {
  let flaming = 0, smoulder = 0, dead = 0;
  for (let k = 0; k < nActive; k++) { const s = state[active[k]]; if (s === S_FLAME) flaming++; else if (s === S_SMOULDER) smoulder++; }
  for (let i = 0; i < n; i++) if (state[i] === S_DEAD) dead++;
  return { active: nActive, flaming, smoulder, dead, flameArea: lastFlameArea, light: lI, flare, burnt: burntArea / totalArea,
    events: { ignite: evCount[0], burnout: evCount[1], steam: evCount[2] }, spawned: Array.from(spawned) };
}
