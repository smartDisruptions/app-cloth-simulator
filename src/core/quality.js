// Quality tiers and the governor that holds 60 fps.
//
// A tier is a set of knobs every module reads from world.q. The governor watches real frame times and
// JS cost; when frames run long it turns down the cheapest knob first: render scale (GPU-bound) or
// substeps and particle budget (CPU-bound). Cloth resolution only changes at the next scene load
// (main.js reloads the scene when the governor asks for it, at most once per scene).

export const TIERS = {
  //           cloth res   substeps  particle cap  bloom   shadow map  dye map  max dpr   raindrops
  low:   { name: 'low',   clothRes: 0.55, substeps: 6,  particles: 700,  bloom: 1, bloomDiv: 4, shadowRes: 128, dyeRes: 64,  dprCap: 1.25, rain: 140 },
  mid:   { name: 'mid',   clothRes: 0.75, substeps: 8,  particles: 1400, bloom: 1, bloomDiv: 4, shadowRes: 256, dyeRes: 128, dprCap: 1.6,  rain: 260 },
  high:  { name: 'high',  clothRes: 1.0,  substeps: 10, particles: 2600, bloom: 1, bloomDiv: 4, shadowRes: 512, dyeRes: 128, dprCap: 2.0,  rain: 420 },
  ultra: { name: 'ultra', clothRes: 1.3,  substeps: 12, particles: 4000, bloom: 1, bloomDiv: 2, shadowRes: 512, dyeRes: 256, dprCap: 2.0,  rain: 650 },
};
export const ORDER = ['low', 'mid', 'high', 'ultra'];

/** Build the live knobs object for a tier. dprScale and particleScale are the governor's dials. */
export function makeQ(name) {
  const t = TIERS[name] || TIERS.mid;
  return { ...t, dprScale: 1, particleScale: 1, auto: true, rebuild: false, minSubsteps: 4 };
}

/** First guess before calibration: from the device class. */
export function guessTier() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (!coarse) return cores >= 8 ? 'ultra' : 'high';
  if (cores >= 8 && mem >= 6) return 'high';
  if (cores >= 6) return 'mid';
  return 'low';
}

/**
 * Pick a tier from a physics micro-benchmark: `nsPerSolve` is the measured cost of one constraint
 * solve (ns). Each tier must fit its cloth in ~4 ms of physics per frame on this device.
 * `constraintsAt1` = constraints of the heaviest scene at clothRes 1.0.
 */
export function tierFromBenchmark(nsPerSolve, constraintsAt1 = 9000, startTier = 'ultra') {
  let best = 'low';
  for (const name of ORDER) {
    const t = TIERS[name];
    const solves = constraintsAt1 * t.clothRes * t.clothRes * t.substeps;
    const ms = (solves * nsPerSolve) / 1e6;
    if (ms <= 4.0) best = name;
    if (name === startTier) break;
  }
  return best;
}

const WIN = 90;
const frameMs = new Float32Array(WIN);
const jsMs = new Float32Array(WIN);
// counters live in a typed array (a module-level double would allocate on every write)
const G = new Float64Array(7);
const K_IX = 0, FILLED = 1, LAST = 2, UPS = 3, WIN0 = 4, HOLD = 5, BUILT = 6;
const REBUILD_WINDOW = 8000; // ms after a scene build in which a coarser cloth may rebuild it live
G[WIN0] = -1;

/** A new scene: forget the window, and ignore the first 1.2 s (shader compiles and JIT warm-up run long). */
export function resetGovernor() {
  G[K_IX] = 0; G[FILLED] = 0; G[WIN0] = -1;
  G[BUILT] = typeof performance !== 'undefined' ? performance.now() : 0;
  G[HOLD] = G[BUILT] + 1200;
}

// One rung down the CPU ladder (substeps → particles → a coarser cloth). A coarser cloth rebuilds the scene
// live only in its first seconds; later it waits for the next reset or scene change, so it never undoes a
// burn or a cut someone just made. False at the bottom.
function cutCPU(q, now) {
  if (q.substeps > q.minSubsteps) { q.substeps--; return true; }
  if (q.particleScale > 0.4) { q.particleScale = Math.max(0.4, q.particleScale * 0.7); return true; }
  if (!q.rebuild && q.clothRes > 0.4) {
    q.clothRes = Math.max(0.4, q.clothRes * 0.8);
    if (now - G[BUILT] < REBUILD_WINDOW) q.rebuild = true;
    return true;
  }
  return false;
}
// One rung down the GPU ladder (render scale → bloom → shadow map → particles). False at the bottom.
function cutGPU(q) {
  if (q.dprScale > 0.6) { q.dprScale = Math.max(0.6, q.dprScale - 0.15); return true; }
  if (q.bloom) { q.bloom = 0; return true; }
  if (q.shadowRes > 64) { q.shadowRes >>= 1; return true; }
  if (q.particleScale > 0.4) { q.particleScale = Math.max(0.4, q.particleScale * 0.7); return true; }
  return false;
}

/**
 * Feed one frame (real frame ms, JS ms, the rAF timestamp). Returns true when it changed a knob (main.js
 * then resizes). It judges a window of up to 90 frames, or 1 s with at least 12 (a slow phone must not wait
 * 20 s to be helped). Long frames are frames over 19 ms (60 Hz jitter isn't counted; 120 Hz screens are fine).
 * CPU-bound (JS eats over half a 60 fps frame) cuts CPU knobs; GPU-bound (most of the frame is spent
 * outside JS) cuts GPU knobs; both, both. Far over budget, it takes up to three rungs at once.
 */
export function governor(world, frame, js, now) {
  const q = world.q;
  if (!q.auto || now < G[HOLD]) return false;
  if (G[WIN0] < 0) G[WIN0] = now;
  const k = G[K_IX] | 0;
  frameMs[k] = frame; jsMs[k] = js; G[K_IX] = (k + 1) % WIN; if (G[FILLED] < WIN) G[FILLED]++;
  const n = G[FILLED] | 0;
  if (n < WIN && !(now - G[WIN0] >= 1000 && n >= 12)) return false;
  if (now - G[LAST] < 700) return false;
  let slow = 0, jsSum = 0, fSum = 0;
  for (let i = 0; i < n; i++) { const j = (k - i + WIN) % WIN; if (frameMs[j] > 19) slow++; jsSum += jsMs[j]; fSum += frameMs[j]; }
  const slowFrac = slow / n, jsAvg = jsSum / n, fAvg = fSum / n;
  let changed = false;
  if (slowFrac > 0.2) {
    const steps = fAvg > 50 ? 3 : fAvg > 28 ? 2 : 1;      // ≤ 20 fps: take big steps
    const cpu = jsAvg > 9, gpu = fAvg > jsAvg * 1.6 + 6;
    for (let s = 0; s < steps; s++) {
      if (cpu && cutCPU(q, now)) changed = true;
      if ((gpu || !cpu) && cutGPU(q)) changed = true;
    }
  } else if (slowFrac < 0.02 && jsAvg < 5 && G[UPS] < 2 && now - G[LAST] > 10000 && fAvg < 17.5) {
    if (q.dprScale < 1) { q.dprScale = Math.min(1, q.dprScale + 0.1); changed = true; G[UPS]++; }
  }
  G[FILLED] = 0; G[WIN0] = now;                           // a fresh window either way
  if (changed) G[LAST] = now;
  return changed;
}
