// The live engine in the real page: nothing before the first gesture; the gesture starts a running context;
// the bank arrives (from the worker, or idle time); gestures start voices; mute and a hidden page suspend the
// context and coming back resumes it; no console errors.   node tests/audio-live.mjs [--scene banner]
import { build, open, advance, drag, clothRect } from './lib.mjs';
import { launch } from './audio-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'banner');
const url = build();
const browser = await launch();
const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: `scene=${scene}&quality=low` });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? '✓' : '✗'} ${what}`); if (!ok) fails.push(what); };
const dbg = () => page.evaluate(() => window.__cloth.modules.audio.debug());

await advance(page, 30);
check((await dbg()) === null, 'no AudioContext and no audio work before the first gesture');
const r = await clothRect(page);
// the first touch unlocks: a REAL tap (the UI unlocks audio from DOM pointer events, as browsers require;
// the __cloth.input test hook deliberately doesn't count as a user gesture)
await page.touchscreen.tap(r.cx, r.cy);
await advance(page, 4);
let d = await dbg();
check(d && d.state === 'running', `the first gesture starts the context (state ${d && d.state}, ${d && d.sampleRate} Hz, tier ${d && d.tier})`);
const t0 = Date.now();
for (let i = 0; i < 60 && !d.bankDone; i++) { await page.waitForTimeout(250); d = await dbg(); }
check(d.bankDone, `the bank is ready ${((Date.now() - t0) / 1000).toFixed(1)} s after the first touch (${d.worker ? `synthesised in a worker; ${d.genMs} ms on the main thread` : `no worker: ${d.genMs} ms in idle slices`})`);
// gestures make sound
const p0 = d.played;
await drag(page, [[r.cx, r.cy], [r.cx + 60, r.cy + 40], [r.cx + 120, r.cy - 30]], { tool: 'grab', framesPerStep: 4 });
await page.waitForTimeout(50);
await drag(page, [[r.x0 - 5, r.cy], [r.cx, r.cy + 10], [r.x1 + 5, r.cy + 20]], { tool: 'slice', framesPerStep: 2 });
await page.waitForTimeout(50);
await drag(page, [[r.cx, r.y0 + r.h * 0.7]], { tool: 'pin' });
d = await dbg();
check(d.played - p0 >= 3, `grab, slice and pin start voices (${d.played - p0} started, ${d.stolen} stolen, ${d.paramCalls} param calls so far)`);
// red-hot chainmail: it never burns, so its sound is a sizzle and ticking rings, driven by cloth.heat
const hot = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, A = C.modules.audio;
  C.api.setMaterial('chainmail'); C.advance(2);
  const p0 = A.debug().played, seen = new Set();
  for (let i = 0; i < 90; i++) { W.cloth.heat.fill(0.9); C.advance(1); const t = A.debug().textures; if (t) seen.add(t); }
  W.cloth.heat.fill(0); C.api.setMaterial('silk'); C.advance(2);
  return { textures: [...seen].join(', '), ticks: A.debug().played - p0 };
});
check(/steam/.test(hot.textures), `red-hot chainmail sizzles (textures heard: ${hot.textures || 'none'}; ${hot.ticks} voices)`);
// mute → suspended; unmute → running
await page.evaluate(() => { window.__cloth.api.setToggle('sound', false); window.__cloth.advance(60); });
await page.waitForTimeout(300);
d = await dbg();
check(d.state === 'suspended', `sound off: the context is suspended after a moment (${d.state})`);
await page.evaluate(() => { window.__cloth.api.setToggle('sound', true); window.__cloth.advance(2); });
await page.waitForTimeout(300);
d = await dbg();
check(d.state === 'running', `sound on: the context runs again (${d.state})`);
// hidden page → suspended; visible → running
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await page.waitForTimeout(300);
d = await dbg();
check(d.state === 'suspended', `page hidden: suspended (${d.state})`);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); window.__cloth.advance(2); });
await page.waitForTimeout(300);
d = await dbg();
check(d.state === 'running', `page visible again: running (${d.state})`);
for (const e of errors) { console.log('   ', e.slice(0, 300)); fails.push(e); }
await ctx.close();
await browser.close();
console.log(fails.length ? `✗ ${fails.length} problem(s)` : '✓ live engine behaves');
process.exit(fails.length ? 1 : 0);
