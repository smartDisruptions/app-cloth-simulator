// Who allocates per frame? Sampling heap profile over a stressed run (bytes by allocating function).
//   node tests/lead-alloc.mjs [--scene koinobori] [--frames 300]
import { launch, open, build, advance, drag, clothRect } from './lib.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'koinobori'), frames = Number(arg('--frames', '300'));
const url = build({ minify: false });
const browser = await launch();
const { page, ctx } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=low&nogov=1` });
await advance(page, 60);
const r = await clothRect(page);
await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
await advance(page, 120);
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 128, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
await page.evaluate((n) => window.__cloth.advance(n), frames);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
const by = new Map(); let total = 0;
(function walk(n, stack) {
  const cf = n.callFrame, key = `${cf.functionName || '(anon)'} :${cf.lineNumber + 1}`;
  const self = n.selfSize || 0; total += self;
  if (self) by.set(key, (by.get(key) || 0) + self);
  for (const c of n.children || []) walk(c, stack);
})(profile.head, []);
const F = (await import('node:fs')).readFileSync(url.replace('file://', ''), 'utf8').split('\n');
const modOf = (line) => { for (let i = line - 1; i >= 0; i--) if (/^\s*\/\/ src\//.test(F[i])) return F[i].trim().replace('// ', ''); return '?'; };
console.log(`${scene}: ${(total / frames).toFixed(0)} B/frame sampled over ${frames} frames`);
for (const [k, v] of [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
  const line = Number(k.split(':').pop());
  console.log(`${(v / frames).toFixed(0).padStart(7)} B/frame  ${k.padEnd(40)} ${line > 1 ? modOf(line) : ''}`);
}
await ctx.close(); await browser.close();
