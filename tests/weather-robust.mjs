// Headless robustness sweep for the weather modules (no browser): every scene × every material, rain on,
// a gale, a fire and an ink drop; fails on any non-finite or out-of-range state.
//   node tests/weather-robust.mjs [--seconds 15] [--quality low] [--scenes a,b] [--materials a,b]
import { world } from '../src/core/world.js';
import { makeQ } from '../src/core/quality.js';
import { clearEvents } from '../src/core/events.js';
import { updateCamera, projectAll } from '../src/core/camera.js';
import { seed } from '../src/core/rng.js';
import { MATERIAL_IDS } from '../src/core/materials.js';
import * as scenes from '../src/scenes/index.js';
import * as sim from '../src/sim/cloth.js';
import * as particles from '../src/render/particles.js';
import * as wind from '../src/fx/wind.js';
import * as rain from '../src/fx/rain.js';
import * as wet from '../src/fx/wet.js';
import * as dye from '../src/fx/dye.js';
import * as fire from '../src/fx/fire.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const secs = Number(arg('--seconds', '15')), quality = arg('--quality', 'low');
const SC = arg('--scenes', scenes.SCENES.map((s) => s.id).join(',')).split(',');
const MATS = arg('--materials', MATERIAL_IDS.join(',')).split(',');
world.q = makeQ(quality); world.q.auto = false;
world.width = 390; world.height = 700; world.pxWidth = 390; world.pxHeight = 700;
for (const m of [wind, rain, wet, dye, fire]) if (m.init) m.init(world);
let bad = 0;
for (const sc of SC) for (const mat of MATS) {
  seed(1);
  world.materialId = mat; world.toggles.wind = 2; world.toggles.rain = true; world.time = 0;
  scenes.load(world, sc);
  for (const m of [sim, wind, rain, wet, dye, fire, particles]) if (m.onScene) m.onScene(world);
  updateCamera(world); projectAll(world);
  const cl = world.cloth, dt = 1 / 60;
  let drips = 0, hits = 0, steam = 0, problem = '';
  for (let f = 0; f < secs * 60 && !problem; f++) {
    world.time += dt; world.realTime += dt; world.frame++;
    if (f === 120) dye.drop(world, (cl.n * 0.4) | 0, f % 4);
    if (f === 180) fire.ignite(world, (cl.n * 0.7) | 0, 1);
    scenes.update(world, dt); wind.update(world, dt); rain.update(world, dt);
    // as main.js runs it: the low and mid tiers alternate the two halves of the water update at 30 Hz
    if (world.q.name !== 'low' && world.q.name !== 'mid') wet.update(world, dt);
    else if ((world.frame & 1) === 0) wet.flowStep(world, 2 * dt); else wet.settle(world, 2 * dt);
    dye.update(world, dt); fire.update(world, dt);
    sim.step(world, dt); updateCamera(world); projectAll(world); particles.update(world, dt); rain.late(world, dt);
    drips += world.events.drip.n; hits += world.events.rainHit.n; steam += world.events.steam.n;
    clearEvents(world.events);
    if (f % 30 === 0) for (let i = 0; i < cl.n; i++) {
      const p = cl.pos[i * 3] + cl.pos[i * 3 + 1] + cl.pos[i * 3 + 2];
      if (!Number.isFinite(p)) { problem = `non-finite pos at v${i}`; break; }
      if (!(cl.wet[i] >= 0 && cl.wet[i] <= 1)) { problem = `wet out of range ${cl.wet[i]} at v${i}`; break; }
      if (!(cl.massScale[i] >= 1 && cl.massScale[i] <= 20)) { problem = `massScale ${cl.massScale[i]} at v${i}`; break; }
      if (!Number.isFinite(cl.pool[i])) { problem = `pool ${cl.pool[i]} at v${i}`; break; }
    }
    if (!Number.isFinite(world.wind.x + world.wind.speed + world.wind.gust + world.rain.intensity + world.stats.wetness)) problem = 'non-finite wind/rain/stats';
  }
  const torn = cl.m - cl.constraintsAlive;
  if (problem) bad++;
  console.log(`${problem ? '✗' : '✓'} ${sc.padEnd(10)} ${mat.padEnd(10)} wet ${world.stats.wetness.toFixed(2)}  hits ${String(hits).padStart(4)}  drips ${String(drips).padStart(3)}  steam ${String(steam).padStart(3)}  torn ${torn}${problem ? '  ← ' + problem : ''}`);
}
process.exit(bad ? 1 : 0);
