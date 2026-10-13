// Who allocates during fire.update? V8's sampling heap profiler, attributed to functions.
//   node tests/fire-alloc.mjs [--q "scene=embers&quality=low"] [--calls 3000]
// The frame loop must allocate nothing (CONTRACT hard rule 2); this shows any leak by call site.
import { launch, open, build, advance, clothRect } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const q = arg('--q', 'scene=embers&quality=low'), calls = Number(arg('--calls', '3000'));
const url = build();
const browser = await launch();
const { page, ctx } = await open(browser, url, { device: 'phone', query: q });
await advance(page, 30);
const r = await clothRect(page);
await page.evaluate((r) => {
  const C = window.__cloth; C.api.setTool('burn');
  C.input('down', r.x0 + r.w * 0.3, r.y0 + r.h * 0.85, 3); C.advance(1); C.input('up', 0, 0, 3);
  C.input('down', r.x0 + r.w * 0.7, r.y0 + r.h * 0.85, 4); C.advance(40); C.input('up', 0, 0, 4);
  C.advance(150);
}, r);
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64 });
await page.evaluate((calls) => {
  const C = window.__cloth, W = C.world, f = C.modules.fire;
  for (let i = 0; i < calls; i++) { f.update(W, 1 / 60); W.events.burnout.clear(); W.events.ignite.clear(); W.events.steam.clear(); }
}, calls);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const by = new Map();
(function walk(node, path) {
  const fn = `${node.callFrame.functionName || '(anon)'}:${node.callFrame.lineNumber + 1}`;
  // builtins (Math.min, …) are attributed with their caller, which is the line to fix
  const name = node.callFrame.lineNumber < 0 && path ? `${fn} ← ${path}` : fn;
  const self = node.selfSize || 0;
  if (self) by.set(name, (by.get(name) || 0) + self);
  for (const c of node.children || []) walk(c, fn);
})(profile.head, '');
const total = [...by.values()].reduce((a, b) => a + b, 0);
console.log(`sampled allocation during ${calls} fire.update calls: ${(total / 1024).toFixed(1)} KB (${(total / calls).toFixed(1)} B/call)`);
for (const [name, b] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${(b / 1024).toFixed(1).padStart(8)} KB  ${name}`);
await ctx.close(); await browser.close();
