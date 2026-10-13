// What audio costs the frame on a throttled "old phone" (budget: ≤ 0.3 ms of update() per frame at low, 4×).
// 1) Real frames: grab, fling, slice, burn and rain in the app; stats.ms.audio per frame (the page's timer is
//    100 µs coarse here, so the mean is the honest number and the p95 comes in 0.1 ms steps).
// 2) Stress: audio.update() called in bulk with a heavy event load on every call (tears, cuts, slices,
//    burnouts, rain hits, a grab, a drip), timed together for µs precision.
//   node tests/audio-perf.mjs [--throttle 4] [--quality low] [--scenes embers,banner,monsoon]
import { build, open, advance, throttle, clothRect, summarize } from './lib.mjs';
import { launch } from './audio-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low');
const SCENES = arg('--scenes', 'embers,banner,monsoon').split(',');

const url = build({ minify: true });
const browser = await launch();
console.log(`audio cost · throttle ${rate}× · quality ${quality} · budget 0.3 ms/frame`);
let worst = 0;
for (const scene of SCENES) {
  const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}` });
  await advance(page, 20);
  const r = await clothRect(page);
  await page.evaluate(() => window.__cloth.api.audioUnlock());
  // let idle time build the bank, as the first second after the first touch would
  const t0 = Date.now();
  let warm = null;
  for (let i = 0; i < 240 && !(warm && warm.bankDone); i++) { await page.waitForTimeout(250); warm = await page.evaluate(() => window.__cloth.modules.audio.debug()); }
  const warmS = ((Date.now() - t0) / 1000).toFixed(1), calls0 = warm.paramCalls;
  const cdp = await throttle(page, rate);
  const ms = [];
  const run = async (fn, a) => { ms.push(...await page.evaluate(fn, a)); await page.waitForTimeout(5); }; // the gap lets idle callbacks re-arm voices
  const A = 'window.__cloth';
  await run(() => { const C = window.__cloth, out = []; for (let i = 0; i < 40; i++) { C.advance(1); out.push(C.world.stats.ms.audio); } return out; });
  // grab and swing, fling
  await run(([r]) => { const C = window.__cloth, out = []; C.api.setTool('grab'); C.input('down', r.cx, r.cy, 1);
    for (let i = 0; i < 40; i++) { C.input('move', r.cx + Math.sin(i * 0.3) * 70, r.cy + Math.cos(i * 0.2) * 35, 1); C.advance(1); out.push(C.world.stats.ms.audio); }
    for (let i = 0; i < 4; i++) { C.input('move', r.cx + 80 + i * 50, r.cy - i * 30, 1); C.advance(1); out.push(C.world.stats.ms.audio); }
    C.input('up', r.cx + 280, r.cy - 120, 1); C.advance(1); out.push(C.world.stats.ms.audio); return out; }, [r]);
  // slice twice
  for (let k = 0; k < 2; k++) await run(([r, k]) => { const C = window.__cloth, out = []; C.api.setTool('slice'); const y = r.y0 + r.h * (0.3 + 0.3 * k);
    C.input('down', r.x0 - 10, y, 2); for (let i = 1; i <= 6; i++) { C.input('move', r.x0 - 10 + (r.w + 20) * (i / 6), y + i * 6, 2); C.advance(1); out.push(C.world.stats.ms.audio); }
    C.input('up', r.x1 + 10, y + 40, 2); for (let i = 0; i < 25; i++) { C.advance(1); out.push(C.world.stats.ms.audio); } return out; }, [r, k]);
  // burn, rain
  await run(([r]) => { const C = window.__cloth, out = []; C.api.setTool('burn'); C.input('down', r.cx, r.y0 + r.h * 0.8, 3);
    for (let i = 0; i < 20; i++) { C.advance(1); out.push(C.world.stats.ms.audio); } C.input('up', r.cx, r.y0 + r.h * 0.8, 3); C.api.setToggle('rain', true);
    for (let i = 0; i < 40; i++) { C.advance(1); out.push(C.world.stats.ms.audio); } return out; }, [r]);
  for (let k = 0; k < 4; k++) await run(() => { const C = window.__cloth, out = []; for (let i = 0; i < 30; i++) { C.advance(1); out.push(C.world.stats.ms.audio); } return out; });
  const real = summarize(ms);
  const after = await page.evaluate(() => window.__cloth.modules.audio.debug());
  const perFrame = +((after.paramCalls - calls0) / ms.length).toFixed(2);
  // stress: bulk-timed update() with a heavy event load on every call
  const stress = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, ev = W.events, A = C.modules.audio, N = 240;
    const before = A.debug().played;
    let t = 0;
    for (let i = 0; i < N; i++) {
      for (let k = 0; k < 24; k++) ev.tear.push(0.1 * k - 1, 1.5, 0, k);
      for (let k = 0; k < 12; k++) ev.cut.push(0, 1.5, 0, k);
      if (i % 3 === 0) ev.slice.push(0, 1.5, 0, 12);
      for (let k = 0; k < 6; k++) ev.burnout.push(0.2, 1, 0, 0);
      for (let k = 0; k < 6; k++) ev.rainHit.push(0.1 * k - 0.3, 1, 0, 0.7);
      if (i % 5 === 0) { ev.grab.push(0, 1.5, 0, 0); ev.drip.push(0, 1, 0, 0.008); ev.steam.push(0, 1, 0, 0.5); }
      const s = performance.now();
      A.update(W, 1 / 60);
      t += performance.now() - s;
      for (const k in ev) ev[k].clear();
    }
    return { usPerCall: +((t / N) * 1000).toFixed(1), played: A.debug().played - before, calls: N };
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const verdict = real.mean <= 0.3 && stress.usPerCall <= 300 ? '✓' : '✗';
  worst = Math.max(worst, real.mean, stress.usPerCall / 1000);
  console.log(`${verdict} ${scene.padEnd(8)} real frames (${ms.length}) audio ms ${JSON.stringify(real)} · ${perFrame} Web Audio calls/frame · ${after.played - warm.played} voices · stress ${stress.usPerCall} µs/update · bank ready ${warmS} s after the first touch (${warm.worker ? `worker, ${warm.genMs} ms of main thread` : `no worker: ${warm.genMs} ms in idle slices`})`);
  for (const e of errors) console.log('   ', e.slice(0, 300));
  await ctx.close();
}
await browser.close();
process.exit(worst <= 0.3 ? 0 : 1);
