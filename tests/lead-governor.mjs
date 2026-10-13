// The governor in a LIVE run (requestAnimationFrame, not manual frames): throttle the CPU and watch the
// quality knobs and fps settle.   node tests/lead-governor.mjs [--throttle 6] [--scene unveil] [--sec 14]
import { launch, build, DEVICES, throttle } from './lib.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '6')), scene = arg('--scene', 'unveil'), sec = Number(arg('--sec', '14'));
const url = build({ minify: true });
const browser = await launch();
const d = DEVICES.phone;
const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: true, isMobile: true });
await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
const page = await ctx.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await throttle(page, rate);
await page.goto(`${url}?scene=${scene}`);
await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
const snap = () => page.evaluate(() => { const W = window.__cloth.world, q = W.q, s = W.stats; return { fps: +s.fps.toFixed(1), js: +s.jsMs.toFixed(1), tier: q.name, sub: q.substeps, dpr: +W.dpr.toFixed(2), dprScale: +q.dprScale.toFixed(2), pScale: +q.particleScale.toFixed(2), bloom: q.bloom, shadow: q.shadowRes, res: +q.clothRes.toFixed(2), verts: s.verts }; });
console.log(`live · throttle ${rate}× · ${scene} · boot tier ${(await snap()).tier}`);
for (let i = 1; i <= sec; i++) {
  await page.waitForTimeout(1000);
  if (i === 4) await page.evaluate(() => { const C = window.__cloth; C.api.setToggle('rain', true); const s = C.world.screen, n = C.world.cloth.n; let v = 0; for (let k = 0; k < n; k++) if (s[k*3+2] > 0 && C.world.cloth.vTri[k]) { v = k; } C.api.ignite(s[v*3], s[v*3+1]); });
  console.log(`${String(i).padStart(3)} s  ${JSON.stringify(await snap())}`);
}
console.log(errors.length ? errors : 'no page errors');
await browser.close();
