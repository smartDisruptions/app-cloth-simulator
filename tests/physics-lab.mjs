// Physics lab: runs the real sim modules in Node (same V8 as Chrome, no browser, no GPU), so the solver
// can be measured and soaked quickly on a shared machine. Timings are unthrottled: multiply by ~4 for the
// "old phone" (CDP 4× throttle) the CONTRACT budget is written against, and confirm with tests/perf.mjs.
//
//   node tests/physics-lab.mjs [--scene noren] [--quality low] [--frames 600] [--material cotton]
//                              [--wind 1] [--hz 60] [--slowmo] [--soak] [--json]
//   --scene all      every scene        --soak   random grabs, slices, burns, wet weight and dt spikes
import { world } from '../src/core/world.js';
import { makeQ } from '../src/core/quality.js';
import { seed, rand } from '../src/core/rng.js';
import { updateCamera, projectAll, unproject } from '../src/core/camera.js';
import { clearEvents } from '../src/core/events.js';
import * as scenes from '../src/scenes/index.js';
import * as sim from '../src/sim/cloth.js';
import * as wind from '../src/fx/wind.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);
const quality = arg('--quality', 'low');
const frames = Number(arg('--frames', '600'));
const hz = Number(arg('--hz', '60'));
const soak = has('--soak');
const list = arg('--scene', 'noren');
const SCENES = list === 'all' ? scenes.SCENES.map((s) => s.id) : list.split(',');

function pct(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0; }

export function setup(sceneId, opts = {}) {
  seed(Number(opts.seed || 1));
  world.width = 390; world.height = 700;
  world.q = makeQ(opts.quality || quality);
  world.toggles.wind = opts.wind != null ? opts.wind : (scenes.sceneById(sceneId).defaults.wind ?? 1);
  world.materialId = opts.material || scenes.sceneById(sceneId).defaults.material || 'cotton';
  world.timeScale = opts.slowmo ? 0.22 : 1;
  for (const P of world.pointers) { P.active = false; P.particle = -1; }
  wind.init(world);
  scenes.load(world, sceneId);
  sim.onScene(world);
  wind.onScene(world);
  // settle the wind module's eased speed to this scene's level (as on a fresh page load), so a gale
  // from a previous scene in this process doesn't blow the next one
  for (let i = 0; i < 40; i++) wind.update(world, 0.25);
  updateCamera(world); projectAll(world);
}

export function frame(dt) {
  const t0 = performance.now();
  world.frame++;   // as main.js ticks it: half-rate work (self-collision, the wind lattice) keys off its parity
  wind.update(world, dt);
  const t1 = performance.now();
  sim.step(world, dt);
  updateCamera(world); projectAll(world);
  const t2 = performance.now();
  return t2 - t1;
}

function grabStart(slot, x, y) {
  const v = sim.pick(world, x, y, 44); if (v < 0) return false;
  const P = world.pointers[slot];
  P.active = true; P.particle = v; P.depth = world.screen[v * 3 + 2];
  unproject(world, x, y, P.depth, P.target);
  return true;
}

function maxStrain(cl) {
  let mx = 0;
  for (let j = 0; j < cl.m; j++) {
    if (!cl.alive[j] || cl.kind[j] !== 0) continue;
    const a = cl.cA[j] * 3, b = cl.cB[j] * 3, p = cl.pos;
    const l = Math.sqrt((p[b] - p[a]) ** 2 + (p[b + 1] - p[a + 1]) ** 2 + (p[b + 2] - p[a + 2]) ** 2) / cl.rest[j];
    if (l > mx) mx = l;
  }
  return mx;
}
function meanStrain(cl) {
  let s = 0, k = 0;
  for (let j = 0; j < cl.m; j++) {
    if (!cl.alive[j] || cl.kind[j] !== 0) continue;
    const a = cl.cA[j] * 3, b = cl.cB[j] * 3, p = cl.pos;
    s += Math.sqrt((p[b] - p[a]) ** 2 + (p[b + 1] - p[a + 1]) ** 2 + (p[b + 2] - p[a + 2]) ** 2) / cl.rest[j]; k++;
  }
  return k ? s / k : 1;
}
function finite(cl) { const p = cl.pos; for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false; return true; }

export function run(sceneId, opts = {}) {
  setup(sceneId, opts);
  const cl = world.cloth, ms = [];
  const dtBase = 1 / (opts.hz || hz);
  let tears = 0, cuts = 0, nanFrames = 0;
  const N = opts.frames || frames;
  for (let f = 0; f < N; f++) {
    let dt = dtBase * world.timeScale;
    if (opts.soak) {
      // wet weight swings, dt spikes, random grabs/slices, slow-mo pulses
      if (f % 97 === 0) for (let i = 0; i < cl.n; i++) cl.massScale[i] = 1 + 2 * rand();
      if (f % 211 === 50) dt = 1 / 20;
      const r = rand();
      if (r < 0.02) { const s = (rand() * 5) | 0; if (!world.pointers[s].active) grabStart(s, 60 + rand() * 270, 150 + rand() * 400); }
      else if (r < 0.03) { for (const P of world.pointers) { P.active = false; P.particle = -1; } }
      else if (r < 0.035) sim.slice(world, rand() * 390, rand() * 700, rand() * 390, rand() * 700);
      for (const P of world.pointers) if (P.active && P.particle >= 0) { P.target[0] += (rand() - 0.5) * 0.2; P.target[1] += (rand() - 0.4) * 0.15; P.target[2] += (rand() - 0.5) * 0.1; }
      if (f % 300 === 299) world.timeScale = world.timeScale === 1 ? 0.22 : 1;
    }
    ms.push(frame(dt));
    tears += world.events.tear.n; cuts += world.events.cut.n;
    clearEvents(world.events);
    if (!finite(cl)) nanFrames++;
  }
  const warm = ms.slice(Math.min(60, ms.length >> 2));
  return {
    scene: sceneId, quality: world.q.name, material: world.materialId, verts: cl.n, links: `${cl.constraintsAlive}/${cl.m}`, tris: `${cl.trisAlive}/${cl.t}`,
    substeps: world.stats.substeps, simMs: { p50: +pct(warm, 0.5).toFixed(3), p95: +pct(warm, 0.95).toFixed(3), max: +pct(warm, 1).toFixed(3) },
    strain: { max: +maxStrain(cl).toFixed(4), mean: +meanStrain(cl).toFixed(4), stat: +world.stats.tension.toFixed(4) },
    kinetic: +world.stats.kinetic.toFixed(3), flutter: +world.stats.flutter.toFixed(3), tears, cuts, nanFrames,
    bounds: [...cl.bounds.min, ...cl.bounds.max].map((x) => +x.toFixed(2)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const s of SCENES) {
    const r = run(s, { material: arg('--material', null), wind: has('--wind') ? Number(arg('--wind')) : null, soak, slowmo: has('--slowmo') });
    console.log(has('--json') ? JSON.stringify(r) : `${r.scene.padEnd(10)} ${r.quality} ${r.material.padEnd(9)} v${r.verts} c${r.links} sub${r.substeps}  sim ms p50 ${r.simMs.p50} p95 ${r.simMs.p95} max ${r.simMs.max}  strain max ${r.strain.max} mean ${r.strain.mean}  kin ${r.kinetic} flut ${r.flutter}  tears ${r.tears} cuts ${r.cuts} nan ${r.nanFrames}  bounds ${r.bounds.join(',')}`);
  }
}
