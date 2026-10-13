// Weather scenarios, end to end: screenshots at chosen moments plus the numbers behind them.
//   node tests/weather-shots.mjs monsoon|embers|dye|gale|noren-rain|tilt [--quality low] [--device shot]
// Screenshots land in tests/out/weather-<scenario>-<t>s.png. One browser, one page, short runs.
import { launch, open, build, advance, drag, clothRect, OUT } from './lib.mjs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scenario = process.argv[2] || 'monsoon';
const quality = arg('--quality', 'low');
const device = arg('--device', 'shot');

const url = build();
const browser = await launch();

// count events across frames: wrap each ring's clear() so it adds this frame's n to a running total
const COUNT = `(() => { const ev = window.__cloth.world.events; for (const k of ['drip','rainHit','rainLand','steam','splash','dye','ignite','burnout']) { const r = ev[k]; if (r.__wrapped) continue; r.__wrapped = 1; r.total = 0; const c = r.clear.bind(r); r.clear = function () { this.total += this.n; c(); }; } })()`;
const sample = (page) => page.evaluate(() => {
  const W = window.__cloth.world, cl = W.cloth, ev = W.events;
  let maxMS = 1, maxPool = 0, sumPool = 0, minY = 1e9, maxWet = 0;
  for (let i = 0; i < cl.n; i++) {
    if (cl.massScale[i] > maxMS) maxMS = cl.massScale[i];
    if (cl.pool && cl.pool[i] > maxPool) maxPool = cl.pool[i];
    if (cl.pool) sumPool += cl.pool[i];
    if (cl.vTri[i] && cl.pos[i * 3 + 1] < minY) minY = cl.pos[i * 3 + 1];
    if (cl.wet[i] > maxWet) maxWet = cl.wet[i];
  }
  const s = W.stats;
  return {
    t: +W.time.toFixed(2), rain: +W.rain.intensity.toFixed(2), wind: +W.wind.speed.toFixed(2), gust: +W.wind.gust.toFixed(2),
    wet: +s.wetness.toFixed(3), maxWet: +maxWet.toFixed(2), maxMS: +maxMS.toFixed(2), maxPool: +(maxPool * 100).toFixed(1) + 'cm', poolSum: +sumPool.toFixed(2),
    minY: +minY.toFixed(3), burning: s.burning, particles: s.particles,
    drips: ev.drip.total, hits: ev.rainHit.total, lands: ev.rainLand.total, steam: ev.steam.total, splash: ev.splash.total,
    weatherMs: +s.ms.weather.toFixed(3), torn: s.constraints - s.constraintsAlive,
  };
});
async function shot(page, name) { const p = join(OUT, `weather-${name}.png`); await page.screenshot({ path: p, timeout: 180000 }); return p; }
async function runTo(page, t, log = true) {
  const now = await page.evaluate(() => window.__cloth.world.time);
  const frames = Math.max(0, Math.round((t - now) * 60));
  for (let i = 0; i < frames; i += 60) await advance(page, Math.min(60, frames - i));
  if (log) console.log(JSON.stringify(await sample(page)));
}

const q = { koi: 'scene=koinobori&rain=1', 'unveil-rain': 'scene=unveil&rain=1', monsoon: 'scene=monsoon', embers: 'scene=embers', 'embers-drive': 'scene=embers', 'embers-prewet': 'scene=embers', dye: 'scene=noren', gale: 'scene=banner&wind=2', 'noren-rain': 'scene=noren&rain=1', tilt: 'scene=monsoon' }[scenario];
const { page, errors } = await open(browser, url, { device, query: `${q}&quality=${quality}` });
await page.evaluate(COUNT);
// the wind blowing INTO the cloth's face (from the camera side), so rain drives onto it
if (scenario === 'embers-drive' || scenario === 'embers-prewet') await page.evaluate(() => { window.__cloth.world.scene.windDir = [0.3, 0, -1]; });

if (scenario === 'monsoon') {
  for (const t of [1, 3, 6, 10, 15, 20]) { await runTo(page, t); if ([3, 10, 20].includes(t)) console.log('  →', await shot(page, `monsoon-${t}s`)); }
  // poke the pool from below: grab the middle of the tarp and lift it
  const r = await clothRect(page);
  await drag(page, [[r.cx, r.cy], [r.cx, r.cy - 30], [r.cx, r.cy - 70], [r.cx, r.cy - 90]], { tool: 'grab', framesPerStep: 10 });
  console.log('  after poke'); await runTo(page, 22);
  console.log('  →', await shot(page, 'monsoon-poked'));
  await page.evaluate(() => window.__cloth.api.setToggle('rain', false));
  await runTo(page, 30); console.log('  →', await shot(page, 'monsoon-after-rain'));
} else if (scenario === 'embers-prewet') {
  await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
  for (const t of [2, 4, 6]) await runTo(page, t);
  const r = await clothRect(page);
  await drag(page, [[r.cx, r.y0 + r.h * 0.82], [r.cx + 1, r.y0 + r.h * 0.82]], { tool: 'burn', framesPerStep: 20 });
  console.log('  lit');
  for (const t of [7, 8, 9, 10, 12]) { await runTo(page, t); if (t === 9) console.log('  →', await shot(page, 'embers-prewet-9s')); }
} else if (scenario === 'embers' || scenario === 'embers-drive') {
  await runTo(page, 0.5);
  const r = await clothRect(page);
  await drag(page, [[r.cx, r.y0 + r.h * 0.82], [r.cx + 1, r.y0 + r.h * 0.82]], { tool: 'burn', framesPerStep: 20 });
  await drag(page, [[r.cx - r.w * 0.25, r.y0 + r.h * 0.8], [r.cx - r.w * 0.25 + 1, r.y0 + r.h * 0.8]], { tool: 'burn', framesPerStep: 20 });
  for (const t of [1.5, 2.5]) await runTo(page, t);
  console.log('  →', await shot(page, 'embers-burning'));
  await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
  console.log('  rain on');
  for (const t of [3.5, 4.5, 5.5, 6.5, 8, 10, 13]) { await runTo(page, t); if (t === 5.5 || t === 13) console.log('  →', await shot(page, `embers-rain-${t}s`)); }
} else if (scenario === 'dye') {
  await runTo(page, 1);
  const r = await clothRect(page);
  const drops = [[0.42, 0.25, 1], [0.58, 0.32, 2], [0.5, 0.42, 1], [0.15, 0.6, 2], [0.85, 0.55, 3], [0.3, 0.3, 0]];
  for (const [fx, fy, c] of drops) {
    await page.evaluate((c) => window.__cloth.api.setDye(c), c);
    await drag(page, [[r.x0 + r.w * fx, r.y0 + r.h * fy]], { tool: 'dye', framesPerStep: 3 });
  }
  await runTo(page, 1.6); console.log('  →', await shot(page, 'dye-fresh'));
  await runTo(page, 5); console.log('  →', await shot(page, 'dye-5s'));
  // now rain on the cloth and drop again: wet cloth spreads ink faster
  await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
  await runTo(page, 14);
  for (const [fx, fy, c] of [[0.22, 0.75, 1], [0.7, 0.78, 2]]) {
    await page.evaluate((c) => window.__cloth.api.setDye(c), c);
    await drag(page, [[r.x0 + r.w * fx, r.y0 + r.h * fy]], { tool: 'dye', framesPerStep: 3 });
  }
  await runTo(page, 18); console.log('  →', await shot(page, 'dye-wet'));
} else if (scenario === 'gale') {
  for (const t of [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6]) { await runTo(page, t); if ([2, 4, 6].includes(t)) console.log('  →', await shot(page, `gale-${t}s`)); }
  await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
  await runTo(page, 9); console.log('  →', await shot(page, 'gale-rain'));
} else if (scenario === 'koi' || scenario === 'unveil-rain') {
  await runTo(page, 2);
  const r = await clothRect(page);
  await page.evaluate(() => window.__cloth.api.setDye(1));
  await drag(page, [[r.cx, r.cy]], { tool: 'dye', framesPerStep: 3 });
  for (const t of [4, 8, 12]) { await runTo(page, t); if (t !== 4) console.log('  →', await shot(page, `${scenario}-${t}s`)); }
} else if (scenario === 'noren-rain') {
  for (const t of [2, 5, 9, 14]) { await runTo(page, t); if ([5, 14].includes(t)) console.log('  →', await shot(page, `noren-rain-${t}s`)); }
}
for (const e of errors) console.log('   ', e.slice(0, 500));
await browser.close();
process.exit(errors.length ? 1 : 0);
