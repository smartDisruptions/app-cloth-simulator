// CPU profile of a throttled, stressed run: self time by function, top N.
//   node tests/lead-profile.mjs [--scene koinobori] [--quality low] [--throttle 4] [--frames 300] [--top 30] [--norender]
import { launch, open, build, advance, throttle, drag, clothRect } from './lib.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'koinobori'), quality = arg('--quality', 'low'), rate = Number(arg('--throttle', '4'));
const frames = Number(arg('--frames', '300')), top = Number(arg('--top', '30'));
const url = build({ minify: false });
const browser = await launch();
const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}&nogov=1${arg('--q', '') ? '&' + arg('--q', '') : ''}` });
await advance(page, 60);
const r = await clothRect(page);
await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
await advance(page, 60);
const cdp = await throttle(page, rate);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const t = [];
for (let i = 0; i < frames; i += 30) t.push(...await advance(page, 30));
const { profile } = await cdp.send('Profiler.stop');
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas; let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]); const d = dt[i] || 0; total += d;
  const cf = n.callFrame; const key = `${cf.functionName || '(anon)'}  ${cf.url.split('/').pop()}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + d);
}
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
const fr = t.length;
console.log(`${scene} · ${quality} · ${rate}× · ${fr} frames · mean js ${(t.reduce((a, b) => a + b, 0) / fr).toFixed(2)} ms · profile ${(total / 1000).toFixed(0)} ms`);
for (const [k, v] of rows) console.log(`${(v / 1000 / fr).toFixed(3).padStart(7)} ms/frame  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
for (const e of errors) console.log('  ', e.slice(0, 200));
await ctx.close(); await browser.close();
