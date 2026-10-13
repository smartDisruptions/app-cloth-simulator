// Microbenchmark: fire.update alone on a big burning state (physics frozen), at 4× throttle.
//   node tests/fire-bench.mjs [--q "scene=embers&quality=low"] [--warm 220] [--calls 120]
import { launch, open, build, advance, throttle, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const q = arg('--q', 'scene=embers&quality=low');
const warm = Number(arg('--warm', '220')), calls = Number(arg('--calls', '120'));
const url = build({ minify: true });
const browser = await launch();
const { page, ctx } = await open(browser, url, { device: 'phone', query: q });
await advance(page, 30);
const r = await clothRect(page);
await page.evaluate(([r, warm]) => {
  const C = window.__cloth; C.api.setTool('burn');
  C.input('down', r.x0 + r.w * 0.3, r.y0 + r.h * 0.85, 3); C.advance(1); C.input('up', 0, 0, 3);
  C.input('down', r.x0 + r.w * 0.7, r.y0 + r.h * 0.85, 4); C.advance(40); C.input('up', 0, 0, 4);
  C.advance(warm);
}, [r, warm]);
await throttle(page, 4);
const res = await page.evaluate((calls) => {
  const C = window.__cloth, W = C.world, f = C.modules.fire, t = new Float64Array(calls);
  f.debugFlags.prof = true; f.prof.fill(0);
  for (let i = 0; i < calls; i++) { const t0 = performance.now(); f.update(W, 1 / 60); t[i] = performance.now() - t0; W.events.burnout.clear(); W.events.ignite.clear(); W.events.steam.clear(); }
  f.debugFlags.prof = false;
  const p = Array.from(f.prof, (v) => +(v / Math.max(1, f.prof[4])).toFixed(3));
  return { t: Array.from(t), d: f.debug(), burning: W.stats.burning, phases: { setupRadiant: p[0], spread: p[1], react: p[2], light: p[3] } };
}, calls);
console.log('fire.update alone, 4× throttle:', JSON.stringify(summarize(res.t)), 'burning', res.burning);
console.log('   mean ms per phase:', JSON.stringify(res.phases), JSON.stringify(res.d));
await ctx.close(); await browser.close();
