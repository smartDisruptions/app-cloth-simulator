// Does the Monsoon tarp fill the same when the water update runs whole every frame and when its two halves
// take turns (the low and mid tiers)? Node only, no browser.     node tests/lead-pool.mjs [--seconds 20]
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

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const secs = Number(arg('--seconds', '20'));
world.q = makeQ('low'); world.q.auto = false;
world.width = 390; world.height = 700; world.pxWidth = 390; world.pxHeight = 700;
for (const m of [wind, rain, wet]) if (m.init) m.init(world);

function run(split) {
  seed(1);
  world.materialId = 'cotton'; world.toggles.rain = true; world.time = 0; world.frame = 0;
  scenes.load(world, 'monsoon');
  for (const m of [sim, wind, rain, wet, particles]) if (m.onScene) m.onScene(world);
  updateCamera(world); projectAll(world);
  const cl = world.cloth, dt = 1 / 60;
  let accF = 0, accS = 0;
  for (let f = 0; f < secs * 60; f++) {
    world.time += dt; world.realTime += dt; world.frame++;
    scenes.update(world, dt); wind.update(world, dt); rain.update(world, dt);
    accF += dt; accS += dt;
    if (!split) { wet.update(world, accF); accF = accS = 0; }
    else if ((world.frame & 1) === 0) { wet.flowStep(world, accF); accF = 0; } else { wet.settle(world, accS); accS = 0; }
    sim.step(world, dt); updateCamera(world); projectAll(world); particles.update(world, dt); rain.late(world, dt);
    clearEvents(world.events);
  }
  let deep = 0, over2 = 0, wetSum = 0;
  for (let i = 0; i < cl.n; i++) { const p = cl.pool[i]; if (p > deep) deep = p; if (p > 0.002) over2++; wetSum += cl.wet[i]; }
  return `deepest ${(deep * 1000).toFixed(0)} mm · ${over2}/${cl.n} vertices under 2+ mm · mean wetness ${(wetSum / cl.n).toFixed(2)} · stats.wetness ${world.stats.wetness.toFixed(2)}`;
}
console.log(`whole every frame  ${run(false)}`);
console.log(`halves alternating ${run(true)}`);
