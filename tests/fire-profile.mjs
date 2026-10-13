// CPU profile of fire.update on a big burning state: self time by function (unminified build).
//   node tests/fire-profile.mjs [--q "scene=embers&quality=low"] [--warm 200] [--calls 600]
import { launch, open, build, advance, clothRect } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const q = arg('--q', 'scene=embers&quality=low');
const warm = Number(arg('--warm', '200')), calls = Number(arg('--calls', '600'));
const url = build();
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
// snapshot the burning state so every pass starts from the same fire
await page.evaluate(() => {
  const C = window.__cloth, c = C.world.cloth;
  window.__snap = { heat: c.heat.slice(), fuel: c.fuel.slice(), char: c.char.slice(), alive: c.alive.slice(), triAlive: c.triAlive.slice(), vTri: c.vTri.slice() };
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
await cdp.send('Profiler.start');
const ms = await page.evaluate((calls) => {
  const C = window.__cloth, W = C.world, f = C.modules.fire;
  const t0 = performance.now();
  for (let i = 0; i < calls; i++) { f.update(W, 1 / 60); W.events.burnout.clear(); W.events.ignite.clear(); W.events.steam.clear(); }
  return (performance.now() - t0) / calls;
}, calls);
const { profile } = await cdp.send('Profiler.stop');
const self = new Map(), total = profile.samples.length;
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const counts = new Map();
for (const s of profile.samples) counts.set(s, (counts.get(s) || 0) + 1);
for (const [id, c] of counts) { const n = byId.get(id); const name = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber + 1}`; self.set(name, (self.get(name) || 0) + c); }
console.log(`fire.update ${ms.toFixed(3)} ms/call unthrottled (mean of ${calls}); self time:`);
for (const [name, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`  ${(100 * c / total).toFixed(1).padStart(5)}%  ${name}`);
await ctx.close(); await browser.close();
