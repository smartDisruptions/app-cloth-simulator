// Screenshots of every HUD state (owner: ui). Look at them: tests/out/ui-*.png.
//   node tests/ui-shots.mjs [names…]     (default: all)   names: first picker mats dye stats pins beat
//                                                          land land-picker land-dye small desk fatal
import { join } from 'node:path';
import { launch, build, advance, drag, clothRect, OUT } from './lib.mjs';
import { openUI, tapEl, sleep, settle, freeze } from './ui-lib.mjs';

const url = build();
const browser = await launch();
const want = process.argv.slice(2);
const RETURNING = () => { try { localStorage.setItem('cloth-sim:ui:v1', JSON.stringify({ seen: 1, compact: 0, taught: {} })); } catch (e) {} };
let failed = 0;

async function shot(name, fn) {
  if (want.length && !want.includes(name)) return;
  const t0 = Date.now();
  let page, ctx, errors = [];
  try {
    ({ page, ctx, errors } = await fn());
    await page.screenshot({ path: join(OUT, `ui-${name}.png`) });
  } catch (e) { errors.push(String(e && e.stack || e)); }
  console.log(`${errors.length ? '✗' : '✓'} ui-${name}.png  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  for (const e of errors) console.log('   ', e.slice(0, 500));
  if (errors.length) failed++;
  if (ctx) await ctx.close();
}

// First run: the hint and the ghost finger.
await shot('first', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=noren&quality=low' });
  await advance(o.page, 40);
  await sleep(700);
  return o;
});

// The scene picker, opened with a real tap on the title.
await shot('picker', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=koinobori&quality=low', init: RETURNING });
  await advance(o.page, 30);
  await tapEl(o.page, '.scene', 2);
  await sleep(600);
  return o;
});

// The material picker.
await shot('mats', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low&material=aurora', init: RETURNING });
  await advance(o.page, 30);
  await tapEl(o.page, '.mat', 2);
  await sleep(600);
  return o;
});

// Dye in hand: ink swatches, a few drops and a stroke.
await shot('dye', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=unveil&quality=low', init: RETURNING });
  await advance(o.page, 30);
  await tapEl(o.page, '.tool[data-tool="dye"]', 2);
  await tapEl(o.page, '.inkb[data-i="1"]', 2);
  const r = await clothRect(o.page);
  await drag(o.page, [[r.x0 + r.w * 0.3, r.cy], [r.x0 + r.w * 0.5, r.cy + 10], [r.x0 + r.w * 0.7, r.cy + 20]], { framesPerStep: 2 });
  await advance(o.page, 10);
  await sleep(250);
  return o;
});

// The receipt, after a burn so every system has work.
await shot('stats', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=embers&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await tapEl(o.page, '.tg[data-t="stats"]', 2);
  const r = await clothRect(o.page);
  await drag(o.page, [[r.cx, r.y0 + r.h * 0.85], [r.cx + 2, r.y0 + r.h * 0.85]], { framesPerStep: 6 });
  await advance(o.page, 120);
  return o;
});

// Pins: two user pins (tap, and carry-and-pin), with the Pin tool showing the scene's own pins.
await shot('pins', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=embers&quality=low&tool=pin', init: RETURNING });
  await advance(o.page, 30);
  const r = await clothRect(o.page);
  await drag(o.page, [[r.x0 + r.w * 0.3, r.y0 + r.h * 0.6]], { framesPerStep: 2 });
  await drag(o.page, [[r.x0 + r.w * 0.7, r.y0 + r.h * 0.9], [r.x0 + r.w * 0.8, r.y0 + r.h * 0.75], [r.x0 + r.w * 0.9, r.y0 + r.h * 0.6]], { framesPerStep: 3 });
  await advance(o.page, 30);
  return o;
});

// The katana beat: a fast long cut, caught mid-pulse.
await shot('beat', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low&tool=slice', init: RETURNING });
  await advance(o.page, 30);
  const r = await clothRect(o.page);
  await drag(o.page, [[r.x0 - 10, r.y0 + r.h * 0.3], [r.cx, r.cy], [r.x1 + 10, r.y0 + r.h * 0.7]], { framesPerStep: 1 });
  await advance(o.page, 6);
  await sleep(200);
  return o;
});

// Landscape: rails.
await shot('land', async () => {
  const o = await openUI(browser, url, { device: 'ui-l', query: 'scene=noren&quality=low', init: RETURNING });
  await advance(o.page, 30);
  await o.page.evaluate(() => window.__cloth.api.setToggle('rain', true));
  await advance(o.page, 20);
  await sleep(3400);   // let the title card finish
  return o;
});

await shot('land-first', async () => {
  const o = await openUI(browser, url, { device: 'ui-l', query: 'scene=banner&quality=low' });
  await advance(o.page, 30);
  await settle(o.page, 600);
  return o;
});

await shot('land-title', async () => {
  const o = await openUI(browser, url, { device: 'ui-l', query: 'scene=embers&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await o.page.keyboard.press(']');     // → Monsoon
  await advance(o.page, 6);
  await settle(o.page);
  await freeze(o.page, '.title, .cut', 1100);
  return o;
});

await shot('land-dye', async () => {
  const o = await openUI(browser, url, { device: 'ui-l', query: 'scene=monsoon&quality=low&stats=1', init: RETURNING });
  await advance(o.page, 30);
  await tapEl(o.page, '.tool[data-tool="dye"]', 30);
  await sleep(300);
  return o;
});

await shot('land-picker', async () => {
  const o = await openUI(browser, url, { device: 'ui-l', query: 'scene=embers&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await tapEl(o.page, '.scene', 2);
  await sleep(600);
  return o;
});

// A small, old phone (iPhone SE size).
await shot('small', async () => {
  const o = await openUI(browser, url, { device: 'ui-se', query: 'scene=koinobori&quality=low' });
  await advance(o.page, 30);
  await sleep(600);
  return o;
});

// Desktop.
await shot('desk', async () => {
  const o = await openUI(browser, url, { device: 'ui-d', query: 'scene=unveil&quality=low&stats=1', init: RETURNING });
  await advance(o.page, 60);
  await o.page.mouse.move(560, 300);
  await sleep(3400);
  return o;
});

// The title card after choosing a scene from the picker.
await shot('title', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=noren&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await sleep(3300);                 // let the boot title finish
  await tapEl(o.page, '.scene', 2); await sleep(450);
  await tapEl(o.page, '.card[data-id="embers"]', 4);
  await settle(o.page);
  await freeze(o.page, '.title, .cut', 1100);
  return o;
});

// A tool chosen for the first time teaches itself; the chrome dims while a finger holds the cloth.
await shot('caption', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await sleep(3300);
  await tapEl(o.page, '.tool[data-tool="slice"]', 2);
  await sleep(500);
  return o;
});
await shot('touching', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=noren&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await sleep(3300);
  const r = await clothRect(o.page);
  await o.page.evaluate(([x, y]) => { const C = window.__cloth; C.input('down', x, y, 5); C.advance(4); C.input('move', x + 40, y + 50, 5); C.advance(10); }, [r.cx, r.cy]);
  await settle(o.page, 1300);
  return o;
});

// Pulling hard: the hold ring warns before the cloth tears.
await shot('strain', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low&wind=0&material=aurora', init: RETURNING });
  await advance(o.page, 30);
  await sleep(3300);
  const r = await clothRect(o.page);
  const lvl = await o.page.evaluate(([x, y]) => {
    const C = window.__cloth; C.input('down', x, y, 7); C.advance(2);
    let best = 0;
    for (let k = 1; k <= 14; k++) { C.input('move', x + k * 9, y + k * 2, 7); C.advance(1); const cls = document.querySelectorAll('.ring.strain, .ring.taut').length; if (cls) { best = cls; break; } }
    return { tension: C.world.stats.tension, cls: [...document.querySelectorAll('.ring.on')].map((e) => e.className).join('|') };
  }, [r.x0 + r.w * 0.85, r.y0 + r.h * 0.5]);
  console.log('   strain', JSON.stringify(lvl));
  await settle(o.page, 250);
  return o;
});

// Keyboard focus ring (desktop), and reduced motion with the first-run hint.
await shot('focus', async () => {
  const o = await openUI(browser, url, { device: 'ui-d', query: 'scene=koinobori&quality=low', init: RETURNING });
  await advance(o.page, 20);
  await sleep(3300);
  for (let i = 0; i < 5; i++) await o.page.keyboard.press('Tab');
  await sleep(300);
  return o;
});
await shot('reduced', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=embers&quality=low', reducedMotion: 'reduce' });
  await advance(o.page, 30);
  await sleep(300);
  return o;
});

// A real phone's pixels (2×), to check hairlines and icons are crisp.
await shot('phone2x', async () => {
  const o = await openUI(browser, url, { device: 'phone', query: 'scene=koinobori&quality=low&material=chainmail', init: RETURNING });
  await advance(o.page, 30);
  await sleep(3300);
  return o;
});

// A tablet, portrait, with the receipt and dye.
await shot('tablet', async () => {
  const o = await openUI(browser, url, { device: 'ui-tab', query: 'scene=banner&quality=low&stats=1&tool=dye', init: RETURNING });
  await advance(o.page, 60);
  await sleep(3300);
  return o;
});

// The failure screen.
await shot('fatal', async () => {
  const o = await openUI(browser, url, { device: 'ui-p', query: 'scene=noren&quality=low', init: RETURNING });
  await o.page.evaluate(() => window.__cloth.modules.hud.fatal('This browser has WebGL turned off, so the cloth has nothing to draw with.'));
  await sleep(200);
  return o;
});

await browser.close();
process.exit(failed ? 1 : 0);
