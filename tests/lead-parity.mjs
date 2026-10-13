// Are the half-rate jobs stacked on the same frames? Splits per-frame JS cost by frame parity under the
// perf.mjs stress case (fires, a cut, rain) on a throttled CPU.
//   node tests/lead-parity.mjs [--scene unveil] [--throttle 4] [--quality low] [--frames 240]
import { launch, open, build, advance, throttle, drag, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'unveil'), rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low');
const frames = Number(arg('--frames', '240'));

const url = build({ minify: true });
const browser = await launch();
const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}` });
await advance(page, 30);
await throttle(page, rate);
const rows = [];
const run = async (n) => {
  for (let i = 0; i < n; i += 30) {
    rows.push(...await page.evaluate((k) => {
      const C = window.__cloth, out = [];
      for (let j = 0; j < k; j++) {
        const r = C.profile(1), f = C.world.frame; // the frame number the tick ran as
        out.push({ f, total: r.total[0], sim: r.sim[0], weather: r.weather[0], render: r.render[0] });
      }
      return out;
    }, Math.min(30, n - i)));
  }
};
await run(frames / 2);
const r = await clothRect(page);
await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
await drag(page, [[r.cx + r.w * 0.2, r.y0 + r.h * 0.85], [r.cx + r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
await drag(page, [[r.x0 + 10, r.cy], [r.x1 - 10, r.cy + 10]], { tool: 'slice', framesPerStep: 1 });
const stressFrom = rows.length;
await run(frames / 2);
for (const [label, set] of [['calm', rows.slice(0, stressFrom)], ['stress', rows.slice(stressFrom)]]) {
  for (const par of [0, 1]) {
    const s = set.filter((x) => (x.f & 1) === par);
    const m = (k) => (s.reduce((a, x) => a + x[k], 0) / (s.length || 1)).toFixed(2);
    console.log(`${label.padEnd(6)} ${par ? 'odd ' : 'even'}  total ${JSON.stringify(summarize(s.map((x) => x.total)))}  mean sim ${m('sim')} weather ${m('weather')} render ${m('render')}`);
  }
  console.log(`${label.padEnd(6)} all   total ${JSON.stringify(summarize(set.map((x) => x.total)))}`);
}
for (const e of errors) console.log('   ', e.slice(0, 300));
await ctx.close();
await browser.close();
