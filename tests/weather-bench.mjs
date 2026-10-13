// Headless CPU bench for the weather modules (no browser, no GL): runs the real scene, physics, fire,
// particles and weather modules in main.js's frame order, and times each weather update per frame.
// On a loaded machine wall-clock spikes are other processes, so it reports the median and the best of
// several repeats. Multiply by the throttle (4×) to estimate an old phone.
//   node tests/weather-bench.mjs [--scene monsoon] [--quality low] [--frames 600] [--reps 3] [--dye] [--fire] [--wind 2]
import { world } from '../src/core/world.js';
import { makeQ } from '../src/core/quality.js';
import { clearEvents } from '../src/core/events.js';
import { updateCamera, projectAll } from '../src/core/camera.js';
import { seed } from '../src/core/rng.js';
import * as scenes from '../src/scenes/index.js';
import * as sim from '../src/sim/cloth.js';
import * as particles from '../src/render/particles.js';
import * as wind from '../src/fx/wind.js';
import * as rain from '../src/fx/rain.js';
import * as wet from '../src/fx/wet.js';
import * as dye from '../src/fx/dye.js';
import * as fire from '../src/fx/fire.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'monsoon'), quality = arg('--quality', 'low');
const frames = Number(arg('--frames', '600')), reps = Number(arg('--reps', '3'));

function setup() {
  seed(1);
  world.q = makeQ(quality); world.q.auto = false;
  world.width = 360; world.height = 740; world.pxWidth = 720; world.pxHeight = 1480;
  world.glx = null; world.gl = null;
  const s = scenes.sceneById(scene);
  world.toggles.wind = arg('--wind', null) != null ? Number(arg('--wind')) : s.defaults.wind;
  world.toggles.rain = true;
  world.time = 0; world.realTime = 0;
  scenes.load(world, s.id);
  for (const m of [sim, wind, rain, wet, dye, fire, particles]) if (m.onScene) m.onScene(world);
  updateCamera(world); projectAll(world);
}
for (const m of [wind, rain, wet, dye, fire]) if (m.init) m.init(world);   // (particles.init needs GL: skipped)
const MODS = ['wind', 'rain', 'wet', 'dye', 'late'];
function run() {
  setup();
  // preallocated, so the harness itself never triggers a GC that would be billed to a module
  const t = { wind: new Float64Array(frames), rain: new Float64Array(frames), wet: new Float64Array(frames), dye: new Float64Array(frames), late: new Float64Array(frames), all: new Float64Array(frames) };
  // CPU time of this process (ms), not wall time: on a shared, loaded machine, time spent descheduled
  // would otherwise land in whichever module happened to be running (--wall to use wall time instead)
  const wall = process.argv.includes('--wall');
  const dt = 1 / 60, now = wall ? () => performance.now() : () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  for (let f = 0; f < frames; f++) {
    if (f === 30 && process.argv.includes('--dye')) for (let k = 0; k < 8; k++) dye.drop(world, ((k + 1) * 97) % world.cloth.n, k % 4);
    if (f === 30 && process.argv.includes('--fire')) fire.ignite(world, (world.cloth.n * 0.8) | 0, 1);
    world.time += dt; world.realTime += dt; world.dt = dt; world.frame++;
    scenes.update(world, dt);
    let a = now(); wind.update(world, dt); let b = now(); t.wind[f] = b - a;
    a = b; rain.update(world, dt); b = now(); t.rain[f] = b - a;
    a = b; wet.update(world, dt); b = now(); t.wet[f] = b - a;
    a = b; dye.update(world, dt); b = now(); t.dye[f] = b - a;
    fire.update(world, dt);
    sim.step(world, dt); updateCamera(world); projectAll(world);
    particles.update(world, dt);
    a = now(); rain.late(world, dt); b = now(); t.late[f] = b - a;
    t.all[f] = t.wind[f] + t.rain[f] + t.wet[f] + t.dye[f];
    clearEvents(world.events);
  }
  return t;
}
const q = (arr, p) => { const s = Array.from(arr.slice(frames / 6)).sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (arr) => { const s = arr.slice(frames / 6); return s.reduce((x, y) => x + y, 0) / s.length; };
let best = null;
for (let r = 0; r < reps; r++) {
  const t = run();
  const row = {};
  for (const k of [...MODS, 'all']) row[k] = { mean: mean(t[k]), p50: q(t[k], 0.5), p95: q(t[k], 0.95) };
  if (!best) best = row; else for (const k in row) for (const s in row[k]) best[k][s] = Math.min(best[k][s], row[k][s]);
}
const f3 = (x) => +x.toFixed(3);
// what world.wind.sample costs the modules that call it (physics per triangle, particles per particle)
if (process.argv.includes('--samples')) {
  setup();
  const real = world.wind.sample; let calls = 0;
  world.wind.sample = (x, y, z, o) => { calls++; return real(x, y, z, o); };
  for (let f = 0; f < 120; f++) { wind.update(world, 1 / 60); rain.update(world, 1 / 60); sim.step(world, 1 / 60); particles.update(world, 1 / 60); rain.late(world, 1 / 60); clearEvents(world.events); }
  calls = 0;
  for (let f = 0; f < 60; f++) { wind.update(world, 1 / 60); rain.update(world, 1 / 60); sim.step(world, 1 / 60); particles.update(world, 1 / 60); rain.late(world, 1 / 60); clearEvents(world.events); }
  world.wind.sample = real;
  const perFrame = calls / 60, p = world.cloth.pos, n = world.cloth.n, o = new Float32Array(3);
  let acc = 0; const W = world.wind;
  for (let r = 0; r < 200; r++) for (let i = 0; i < n; i++) { W.sample(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], o); acc += o[0]; }
  let best = Infinity;
  for (let k = 0; k < 5; k++) { const t0 = performance.now(); for (let r = 0; r < 200; r++) for (let i = 0; i < n; i++) { W.sample(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], o); acc += o[0]; } best = Math.min(best, performance.now() - t0); }
  const ns = (best * 1e6) / (200 * n);
  console.log(`wind.sample: ${perFrame.toFixed(0)} calls/frame here, ${ns.toFixed(1)} ns each (wall, best of 5) → ${(perFrame * ns / 1e6).toFixed(3)} ms/frame, ×4 → ${(4 * perFrame * ns / 1e6).toFixed(3)} ms  (${acc > 0 ? '' : ''})`);
}
console.log(`${scene} · ${quality} · ${frames} frames · best of ${reps} (${process.argv.includes("--wall") ? "wall" : "CPU"} ms, unthrottled; ×4 ≈ old phone)  verts ${world.cloth.n}  wet ${world.stats.wetness.toFixed(2)}  particles ${particles.count()}`);
for (const k of [...MODS, 'all']) console.log(`  ${k.padEnd(5)} mean ${f3(best[k].mean)}  p50 ${f3(best[k].p50)}  p95 ${f3(best[k].p95)}   ×4 → mean ${f3(best[k].mean * 4)} p95 ${f3(best[k].p95 * 4)}`);
