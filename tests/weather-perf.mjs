// Weather's own CPU receipt: per-frame world.stats.ms.weather over a run, at a CPU throttle.
//   node tests/weather-perf.mjs [--scene monsoon] [--quality low] [--throttle 4] [--frames 360] [--dye] [--fire]
// Prints mean / p95 / max of the weather slice (wind + rain + wet + dye updates) and the worst frames.
import { launch, open, build, advance, throttle, drag, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'monsoon'), quality = arg('--quality', 'low'), rate = Number(arg('--throttle', '4')), frames = Number(arg('--frames', '360'));
const url = build({ minify: true });
const browser = await launch();
const { page, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}&rain=1` });
await advance(page, 30);
const r = await clothRect(page);
if (process.argv.includes('--fire')) await drag(page, [[r.cx, r.y0 + r.h * 0.8], [r.cx + 1, r.y0 + r.h * 0.8]], { tool: 'burn', framesPerStep: 5 });
if (process.argv.includes('--dye')) for (let k = 0; k < 6; k++) {
  await page.evaluate((k) => window.__cloth.api.setDye(k % 4), k);
  await drag(page, [[r.x0 + r.w * (0.2 + 0.12 * k), r.y0 + r.h * (0.3 + 0.08 * (k % 3))]], { tool: 'dye', framesPerStep: 1 });
}
await throttle(page, rate);
const res = await page.evaluate((n) => {
  const C = window.__cloth, W = C.world, out = [];
  for (let i = 0; i < n; i++) { const js = C.advance(1)[0]; out.push([W.stats.ms.weather, js, W.stats.particles, W.rain.intensity]); }
  return out;
}, frames);
const w = res.map((x) => x[0]), js = res.map((x) => x[1]);
const half = Math.floor(res.length / 3), w2 = w.slice(half), js2 = js.slice(half);
console.log(`${scene} · ${quality} · ${rate}× · ${frames} frames`);
console.log("weather ms", JSON.stringify(summarize(w)), " frame js", JSON.stringify(summarize(js)));
console.log("after warm-up (last 2/3): weather ms", JSON.stringify(summarize(w2)), " frame js", JSON.stringify(summarize(js2)));
const worst = res.map((x, i) => [i, ...x]).sort((a, b) => b[1] - a[1]).slice(0, 6);
console.log('worst weather frames [frame, weatherMs, jsMs, particles, rain]:', JSON.stringify(worst.map((x) => x.map((v) => +(+v).toFixed(2)))));
for (const e of errors) console.log('   ', e.slice(0, 400));
await browser.close();
