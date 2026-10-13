// The physics share of the 60 fps receipt: world.stats.ms.sim (sim.step + camera + projection) on EVERY
// frame, in the real page under CPU throttling (tests/perf.mjs samples it only every 30 frames).
//   node tests/physics-perf.mjs [--throttle 4] [--quality low] [--scenes noren,unveil] [--frames 240] [--stress] [--grab]
//                               [--page a.html,b.html] [--rounds 1]
// --stress: rain on, two burns and a slice halfway (as perf.mjs); --grab: a finger drags the cloth meanwhile.
// --page: prebuilt pages to compare (e.g. a baseline build), interleaved per round; --rounds: repeat and
// keep each page's best p50/p95 (a shared machine's preemption only ever adds time).
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { launch, open, build, advance, throttle, drag, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low'), frames = Number(arg('--frames', '240'));
const SCENES = arg('--scenes', 'noren,unveil').split(',');
const stress = process.argv.includes('--stress'), grab = process.argv.includes('--grab');

const pages = arg('--page', '') ? arg('--page').split(',').map((f) => pathToFileURL(resolve(f)).href) : [build({ minify: true })];
const rounds = Number(arg('--rounds', '1'));
const browser = await launch();
console.log(`physics · throttle ${rate}× · quality ${quality} · ${frames} frames${stress ? ' · stress' : ''}${grab ? ' · grab' : ''}`);
const best = {};
for (let round = 0; round < rounds; round++) for (const scene of SCENES) for (const url of pages) {
  const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}` });
  await advance(page, 60);
  await throttle(page, rate);
  const sim = [];
  const run = (n) => page.evaluate((n) => { const C = window.__cloth, out = []; for (let i = 0; i < n; i++) { C.advance(1); out.push(C.world.stats.ms.sim); } return out; }, n);
  for (let i = 0; i < frames / 2; i += 30) sim.push(...await run(30));
  if (stress) {
    const r = await clothRect(page);
    await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
    await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
    await drag(page, [[r.cx + r.w * 0.2, r.y0 + r.h * 0.85], [r.cx + r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
    await drag(page, [[r.x0 + 10, r.cy], [r.x1 - 10, r.cy + 10]], { tool: 'slice', framesPerStep: 1 });
  }
  if (grab) {
    const r = await clothRect(page);
    await page.evaluate(([x, y]) => { const C = window.__cloth; C.api.setTool('grab'); C.input('down', x, y, 7); }, [r.cx, r.y0 + r.h * 0.6]);
  }
  for (let i = 0; i < frames / 2; i += 30) {
    if (grab) await page.evaluate(([x, y]) => window.__cloth.input('move', x, y, 7), [(await clothRect(page)).cx + 40 * Math.sin(i / 20), 300 + 30 * Math.cos(i / 25)]);
    sim.push(...await run(30));
  }
  const st = await page.evaluate(() => { const s = window.__cloth.world.stats; return { verts: s.verts, links: `${s.constraintsAlive}/${s.constraints}`, substeps: s.substeps, tier: s.tier }; });
  const sum = summarize(sim), name = pages.length > 1 ? url.split('/').pop() : '';
  console.log(`${sum.p95 <= 3.5 ? '✓' : sum.p95 <= 5 ? '~' : '✗'} ${scene.padEnd(10)} ${name} sim ms ${JSON.stringify(sum)}  ${JSON.stringify(st)}`);
  for (const e of errors) console.log('   ', e.slice(0, 400));
  const key = `${scene} ${name}`, b = best[key] || (best[key] = { p50: Infinity, p95: Infinity, mean: Infinity });
  b.p50 = Math.min(b.p50, sum.p50); b.p95 = Math.min(b.p95, sum.p95); b.mean = Math.min(b.mean, sum.mean);
  await ctx.close();
}
if (rounds > 1) for (const k in best) console.log(`best of ${rounds}: ${k.padEnd(28)} p50 ${best[k].p50} · p95 ${best[k].p95} · mean ${best[k].mean} ms`);
await browser.close();
