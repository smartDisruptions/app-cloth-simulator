// Does the cloth come to rest when nothing moves it? Runs a scene in still air (wind 0) for every material,
// in main.js's frame order, and prints how fast the cloth is still moving: the RMS and peak vertex speed
// over the last seconds, and how far the cloth's centre drifted. A cloth at rest reads ~0 mm/s.
// The air is switched off (the material's drag and lift are zeroed for the run): "still" wind is a faint
// 0.15 m/s breeze on purpose, and light silk sways in it. --breeze keeps that air on.
//   node tests/lead-still.mjs [--scenes noren,embers] [--materials a,b] [--seconds 20] [--quality low] [--breeze]
//   node tests/lead-still.mjs --scenes unveil --pull     (pull the sheet off the moon first, then watch it lie)
import { world } from '../src/core/world.js';
import { makeQ } from '../src/core/quality.js';
import { seed } from '../src/core/rng.js';
import { updateCamera, projectAll } from '../src/core/camera.js';
import { clearEvents } from '../src/core/events.js';
import { MATERIAL_IDS } from '../src/core/materials.js';
import * as scenes from '../src/scenes/index.js';
import * as sim from '../src/sim/cloth.js';
import * as wind from '../src/fx/wind.js';
import { SIM_MATERIALS } from '../src/sim/materials.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SC = arg('--scenes', 'noren,embers').split(',');
const MATS = arg('--materials', MATERIAL_IDS.join(',')).split(',');
const secs = Number(arg('--seconds', '20'));
const quality = arg('--quality', 'low');
const pull = process.argv.includes('--pull');
const trace = process.argv.includes('--trace');
const breeze = process.argv.includes('--breeze');
if (!breeze) for (const k in SIM_MATERIALS) { SIM_MATERIALS[k].drag = 0; SIM_MATERIALS[k].lift = 0; }
const dt = 1 / 60;

function frame() {
  world.frame++; world.time += dt; world.realTime += dt; world.dt = dt; world.frameDt = dt;
  scenes.update(world, dt); wind.update(world, dt);
  sim.step(world, dt);
  updateCamera(world); projectAll(world);
  clearEvents(world.events);
}

function speeds(cl) {
  let s2 = 0, peak = 0, k = 0, pv = -1;
  for (let i = 0; i < cl.n; i++) {
    if (!cl.vTri[i] || cl.alias[i] >= 0) continue;
    const vx = cl.vel[i * 3], vy = cl.vel[i * 3 + 1], vz = cl.vel[i * 3 + 2], v2 = vx * vx + vy * vy + vz * vz;
    s2 += v2; k++; if (v2 > peak) { peak = v2; pv = i; }
  }
  return { rms: Math.sqrt(s2 / (k || 1)), peak: Math.sqrt(peak), pv };
}
function centre(cl) {
  let x = 0, y = 0, z = 0, k = 0;
  for (let i = 0; i < cl.n; i++) { if (!cl.vTri[i]) continue; x += cl.pos[i * 3]; y += cl.pos[i * 3 + 1]; z += cl.pos[i * 3 + 2]; k++; }
  return [x / k, y / k, z / k];
}

world.width = 390; world.height = 700; world.pxWidth = 390; world.pxHeight = 700;
for (const sc of SC) for (const mat of MATS) {
  seed(1);
  world.q = makeQ(quality); world.q.auto = false;
  world.toggles.wind = 0; world.toggles.rain = false; world.materialId = mat; world.timeScale = 1;
  world.time = 0; world.frame = 0;
  for (const P of world.pointers) { P.active = false; P.particle = -1; }
  wind.init(world);
  scenes.load(world, sc);
  sim.onScene(world); wind.onScene(world);
  updateCamera(world); projectAll(world);
  const cl = world.cloth;
  if (pull) {
    // unpin everything and give the sheet a tug down and forward: it slides off the moon onto the floor
    for (let i = 0; i < cl.n; i++) if (cl.pinned[i]) sim.togglePin(world, i);
    world.gravity[0] = 0;
    for (let i = 0; i < cl.n; i++) { cl.vel[i * 3 + 2] += 2.5; }
  }
  const settle = Math.round(secs * 0.6 / dt), watch = Math.round(secs * 0.4 / dt);
  for (let f = 0; f < settle; f++) {
    frame();
    if (trace && f % 60 === 59) { const s = speeds(cl); console.log(`  t ${((f + 1) * dt).toFixed(0)}s rms ${(s.rms * 1000).toFixed(1)} mm/s peak ${(s.peak * 1000).toFixed(0)} mm/s @v${s.pv}`); }
  }
  const c0 = centre(cl);
  let rms = 0, peak = 0, pv = -1;
  for (let f = 0; f < watch; f++) {
    frame();
    const s = speeds(cl); rms += s.rms; if (s.peak > peak) { peak = s.peak; pv = s.pv; }
    if (trace && f % 60 === 59) console.log(`  t ${((settle + f + 1) * dt).toFixed(0)}s rms ${(s.rms * 1000).toFixed(1)} mm/s peak ${(s.peak * 1000).toFixed(0)} mm/s @v${s.pv}`);
  }
  let ylo = 1e9, yhi = -1e9; for (let i = 0; i < cl.n; i++) { if (!cl.vTri[i]) continue; const y = cl.pos[i * 3 + 1]; if (y < ylo) ylo = y; if (y > yhi) yhi = y; }
  const c1 = centre(cl), drift = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
  rms /= watch;
  const bad = rms > (breeze ? 0.02 : 0.005) || drift > 0.01;
  console.log(`${bad ? '✗' : '✓'} ${sc.padEnd(8)} ${mat.padEnd(10)} rms ${(rms * 1000).toFixed(1).padStart(6)} mm/s  peak ${(peak * 1000).toFixed(0).padStart(5)} mm/s @v${pv}  drift ${(drift * 1000).toFixed(1)} mm over ${(watch * dt).toFixed(0)} s  wind ${world.wind.speed.toFixed(2)} m/s  y ${ylo.toFixed(3)}…${yhi.toFixed(3)} m`);
}
