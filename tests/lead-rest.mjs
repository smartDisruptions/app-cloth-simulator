// The two reports from Josh's first play (2026-10-13), replayed in the real page at the low tier:
//   1. denim on the Noren or Embers with the wind off "moves on its own"
//   2. on the Unveiling, the sheet pulled off the moon "moves on its own" once it's on the ground
// Drawing is off (norender=1: the same physics and frame order, far quicker headless). Each case prints
// the cloth's mean vertex speed (stats.kinetic) over the last 5 s; at rest it reads ~0.
//   node tests/lead-rest.mjs [--quality low]
import { launch, open, build, advance, drag, clothRect, SEEN } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const quality = arg('--quality', 'low');
const url = build({ minify: true });
const browser = await launch();
let failed = 0;

async function watch(page, frames) {
  return page.evaluate((n) => {
    const C = window.__cloth; let sum = 0, peak = 0;
    for (let i = 0; i < n; i++) { C.advance(1); const k = C.world.stats.kinetic; sum += k; if (k > peak) peak = k; }
    return { mean: sum / n, peak };
  }, frames);
}
function report(label, r, limit) {
  const ok = r.mean < limit;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(44)} mean speed ${(r.mean * 1000).toFixed(1).padStart(6)} mm/s  peak ${(r.peak * 1000).toFixed(1).padStart(6)} mm/s`);
}

for (const scene of ['noren', 'embers']) for (const mat of ['denim', 'cotton']) {
  const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: `scene=${scene}&quality=${quality}&material=${mat}&wind=0&norender=1`, init: SEEN });
  await advance(page, 600);
  report(`${scene} · ${mat} · wind off`, await watch(page, 300), 0.01);
  for (const e of errors) console.log('   ', e.slice(0, 300));
  await ctx.close();
}

for (const mat of ['silk', 'cotton', 'velvet']) {
  const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: `scene=unveil&quality=${quality}&material=${mat}&norender=1`, init: SEEN });
  await advance(page, 240);   // the sheet settles over the moon
  const r = await clothRect(page);
  // grab the top of the sheet and drag it off the moon, sideways and down, then let go
  const pts = [];
  for (let k = 0; k <= 24; k++) pts.push([r.cx + (k / 24) * r.w * 1.6, r.y0 + r.h * 0.15 + (k / 24) * r.h * 1.1]);
  await drag(page, pts, { tool: 'grab', framesPerStep: 2 });
  await advance(page, 900);   // it falls and settles on the floor
  const low = await page.evaluate(() => { const W = window.__cloth.world, cl = W.cloth; let hi = -1e9; for (let i = 0; i < cl.n; i++) if (cl.vTri[i]) hi = Math.max(hi, cl.pos[i * 3 + 1]); return hi; });
  report(`unveil · ${mat} · on the floor (top ${low.toFixed(2)} m)`, await watch(page, 300), 0.01);
  for (const e of errors) console.log('   ', e.slice(0, 300));
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
