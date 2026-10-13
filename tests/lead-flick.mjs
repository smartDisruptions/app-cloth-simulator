// Josh (2026-10-13): "When I grab a cloth and flick it quickly, sometimes when it falls back down, it
// sticks to itself like glue." Replays fast flicks in the real page (drawing off), lets the cloth fall back
// in still air, and checks it comes free: after the flick and 8 s of settling, how far the cloth sits from
// where an untouched run of the same scene hangs (mean and worst vertex), and how many self-contact pairs
// are still pushing. A cloth that falls back free hangs within a few cm of the untouched one.
//   node tests/lead-flick.mjs [--scenes noren,banner,embers] [--quality low] [--materials cotton,silk] [--settle 474] [--q extra=1]
import { launch, open, build, advance, drag, clothRect, SEEN } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCENES = arg('--scenes', 'noren,banner,embers').split(',');
const MATS = arg('--materials', 'cotton,silk').split(',');
const quality = arg('--quality', 'low');
const extra = arg('--q', '');
const settle = Number(arg('--settle', '474'));   // frames after the flick
// flicks: where the finger lands (fraction of the cloth's screen box) and where it ends, in 5 fast steps
const FLICKS = [
  { name: 'up', from: [0.5, 0.85], to: [0.5, -0.6] },
  { name: 'up-left', from: [0.7, 0.8], to: [-0.4, -0.4] },
  { name: 'up-right', from: [0.3, 0.8], to: [1.4, -0.4] },
  { name: 'over', from: [0.5, 0.6], to: [0.55, -0.9] },
];
const url = build({ minify: true });
const browser = await launch();
let failed = 0;

const snap = (page) => page.evaluate(() => Array.from(window.__cloth.world.cloth.pos));
for (const scene of SCENES) for (const mat of MATS) {
  const q = `scene=${scene}&quality=${quality}&material=${mat}&wind=0&norender=1&nogov=1${extra ? '&' + extra : ''}`;
  // the untouched reference: same boot, same frames
  let ref;
  {
    const { page, ctx } = await open(browser, url, { device: 'shot', query: q, init: SEEN });
    await advance(page, 120 + 7 + settle);   // = the flick run: 120, the drag (down, 5 moves, up), then the settle
    ref = await snap(page);
    await ctx.close();
  }
  for (const f of FLICKS) {
    const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: q, init: SEEN });
    await advance(page, 120);
    const r = await clothRect(page);
    const P = (u) => [r.x0 + r.w * u[0], r.y0 + r.h * u[1]];
    const a = P(f.from), b = P(f.to), pts = [];
    for (let k = 0; k <= 5; k++) pts.push([a[0] + (b[0] - a[0]) * k / 5, a[1] + (b[1] - a[1]) * k / 5]);
    await drag(page, pts, { tool: 'grab', framesPerStep: 1 });
    await advance(page, settle);
    const res = await page.evaluate((ref) => {
      const W = window.__cloth.world, cl = W.cloth, p = cl.pos;
      let sum = 0, worst = 0, k = 0;
      for (let i = 0; i < cl.n; i++) {
        if (!cl.vTri[i] || cl.alias[i] >= 0) continue;
        const d = Math.hypot(p[i * 3] - ref[i * 3], p[i * 3 + 1] - ref[i * 3 + 1], p[i * 3 + 2] - ref[i * 3 + 2]);
        sum += d; k++; if (d > worst) worst = d;
      }
      return { mean: sum / k, worst, pairs: cl.solver.selfPushes, kinetic: W.stats.kinetic, torn: cl.constraintsAlive < cl.m };
    }, ref);
    const bad = res.mean > 0.05;
    if (bad) failed++;
    console.log(`${bad ? '✗' : '✓'} ${scene.padEnd(7)} ${mat.padEnd(7)} ${f.name.padEnd(8)} off the free hang: mean ${(res.mean * 100).toFixed(1).padStart(5)} cm, worst ${(res.worst * 100).toFixed(1).padStart(5)} cm · self pairs pushing ${String(res.pairs).padStart(3)} · moving ${(res.kinetic * 1000).toFixed(1)} mm/s${res.torn ? ' · torn' : ''}`);
    for (const e of errors) console.log('   ', e.slice(0, 300));
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
