// Per-frame JS cost on a throttled "old phone". This is the 60 fps receipt for the CPU side: a frame has
// 16.7 ms, and the GPU and the browser need their share, so the JS budget is ~8 ms at 4× throttle.
//   node tests/perf.mjs [--throttle 4] [--quality low|mid|high] [--scenes a,b] [--frames 240] [--stress]
// --stress lights fires, cuts and turns rain on halfway through, which is the worst realistic case.
import { launch, open, build, advance, throttle, drag, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4'));
const quality = arg('--quality', 'low');
const frames = Number(arg('--frames', '240'));
const SCENES = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const stress = process.argv.includes('--stress');
const device = arg('--device', 'phone');
const extra = arg('--q', '');   // extra query, e.g. --q norender=1 (CPU only, no GL)

const url = build({ minify: true });
const browser = await launch();
console.log(`throttle ${rate}× · quality ${quality} · ${frames} frames${stress ? ' · stress' : ''}`);
for (const scene of SCENES) {
  const { page, ctx, errors } = await open(browser, url, { device, query: `scene=${scene}&quality=${quality}${extra ? '&' + extra : ''}` });
  await advance(page, 30);
  await throttle(page, rate);
  const t = [];
  const parts = {};
  const step = async (n) => {
    for (let i = 0; i < n; i += 30) {
      const r = await page.evaluate((k) => window.__cloth.profile(k), Math.min(30, n - i));
      t.push(...r.total);
      for (const k in r) if (k !== 'total') (parts[k] = parts[k] || []).push(...r[k]);
    }
  };
  await step(frames / 2);
  if (stress) {
    const r = await clothRect(page);
    await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
    await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
    await drag(page, [[r.cx + r.w * 0.2, r.y0 + r.h * 0.85], [r.cx + r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
    await drag(page, [[r.x0 + 10, r.cy], [r.x1 - 10, r.cy + 10]], { tool: 'slice', framesPerStep: 1 });
  }
  await step(frames / 2);
  const st = await page.evaluate(() => { const s = window.__cloth.world.stats; return { verts: s.verts, links: s.constraintsAlive, substeps: s.substeps, particles: s.particles, burning: s.burning, calls: s.drawCalls, tier: s.tier }; });
  const breakdown = {};
  for (const k of ['sim', 'weather', 'fire', 'particles', 'render', 'audio', 'ui']) if (parts[k]) { const s2 = summarize(parts[k]); breakdown[k] = `${s2.mean}/${s2.p95}`; }
  const sum = summarize(t);
  const verdict = sum.p95 <= 8 ? '✓' : sum.p95 <= 12 ? '~' : '✗';
  console.log(`${verdict} ${scene.padEnd(10)} js ms ${JSON.stringify(sum)}  mean/p95 ${JSON.stringify(breakdown)}  ${JSON.stringify(st)}`);
  for (const e of errors) console.log('   ', e.slice(0, 400));
  await ctx.close();
}
await browser.close();
