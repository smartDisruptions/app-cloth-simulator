// The UI's own receipt (owner: ui): per-frame cost of hud.update + input.update on a throttled "old
// phone", in the busiest UI state (receipt on, pin markers showing, two fingers down with rings), and
// the JS heap they allocate per frame (V8 sampling heap profiler; the budget is zero).
//   node tests/ui-perf.mjs [--throttle 4] [--frames 600]
import { launch, build, advance, throttle, clothRect, summarize } from './lib.mjs';
import { openUI } from './ui-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), N = Number(arg('--frames', '600'));
const url = build();
const browser = await launch();
const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-p', query: 'scene=embers&quality=low&stats=1&tool=pin',
  init: () => { try { localStorage.setItem('cloth-sim:ui:v1', JSON.stringify({ seen: 1, compact: 1, taught: {} })); } catch (e) {} } });
await advance(page, 30);
const r = await clothRect(page);
// three user pins, then two fingers holding the cloth (rings), pin tool so the scene's pins show too
await page.evaluate(([r]) => {
  const C = window.__cloth;
  for (const [fx, fy] of [[0.25, 0.5], [0.5, 0.6], [0.75, 0.5]]) { C.input('down', r.x0 + r.w * fx, r.y0 + r.h * fy, 90); C.advance(1); C.input('up', r.x0 + r.w * fx, r.y0 + r.h * fy, 90); C.advance(1); }
  C.api.setTool('grab');
  C.input('down', r.x0 + r.w * 0.3, r.y0 + r.h * 0.8, 91); C.input('down', r.x0 + r.w * 0.7, r.y0 + r.h * 0.8, 92);
  C.advance(2);
  C.api.setTool('pin');
  C.advance(30);
}, [r]);
const state = await page.evaluate(() => ({ pins: document.querySelectorAll('.pin.on').length, rings: document.querySelectorAll('.ring.on').length, stats: window.__cloth.world.toggles.stats }));
await throttle(page, rate);

// time each update in place, as the frame calls them (hud after render, input first), N times
const t = await page.evaluate((N) => {
  const C = window.__cloth, W = C.world, hud = C.modules.hud, input = C.modules.input;
  const out = { hud: [], input: [], frame: [] };
  for (let i = 0; i < N; i++) {
    const t0 = performance.now(); input.update(W, 1 / 60); const t1 = performance.now();
    hud.update(W, 1 / 60); const t2 = performance.now();
    out.input.push(t1 - t0); out.hud.push(t2 - t1);
    if (i % 60 === 0) { const f = C.advance(1); out.frame.push(f[0]); }
  }
  return out;
}, N);

// allocations: sample the heap while only the UI updates run
const cdp = await page.context().newCDPSession(page);
await cdp.send('HeapProfiler.enable');
// warm up long enough for the optimising compiler (old phones get there too, a few seconds in)
await page.evaluate(() => { const C = window.__cloth, W = C.world, h = C.modules.hud.update, i = C.modules.input.update; for (let k = 0; k < 3000; k++) { i(W, 1 / 60); h(W, 1 / 60); } });
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64 });
await page.evaluate((N) => { const C = window.__cloth, W = C.world, h = C.modules.hud.update, i = C.modules.input.update; for (let k = 0; k < N; k++) { i(W, 1 / 60); h(W, 1 / 60); } }, N);
const { profile } = await cdp.send('HeapProfiler.stopSampling');
// attribute each sampled allocation to the UI only if its stack runs through hud/input.update (page code)
const pageUrl = page.url().split('?')[0];
const byFn = {};
let total = 0, ui = 0;
(function walk(n, inUI, stack) {
  const f = n.callFrame, name = f.functionName || '(anon)';
  const here = inUI || (f.url.split('?')[0] === pageUrl && name === 'update');
  const st = stack.concat(name);
  if (n.selfSize) {
    total += n.selfSize;
    if (here) { ui += n.selfSize; const k = st.slice(-3).join(' › '); byFn[k] = (byFn[k] || 0) + n.selfSize; }
  }
  for (const c of n.children || []) walk(c, here, st);
})(profile.head, false, []);
const top = Object.entries(byFn).sort((a, b) => b[1] - a[1]).slice(0, 6);

const H = summarize(t.hud), I = summarize(t.input);
console.log(`throttle ${rate}× · ${N} calls · state ${JSON.stringify(state)}`);
console.log(`${H.p95 + I.p95 <= 0.5 ? '✓' : '✗'} hud.update   ms ${JSON.stringify(H)}`);
console.log(`  input.update ms ${JSON.stringify(I)}`);
console.log(`  (a whole frame here, for scale: ${JSON.stringify(summarize(t.frame))})`);
console.log(`${ui < 1024 ? '✓' : '✗'} JS heap allocated inside hud/input.update over ${N} frames: ${ui} bytes (${(ui / N).toFixed(2)} B/frame; first-time number strings only). Harness + V8 noise: ${total - ui} bytes`);
for (const [k, v] of top) console.log(`    ${v} B  ${k}`);
for (const e of errors) console.log('   ', e.slice(0, 300));
await ctx.close();
await browser.close();
