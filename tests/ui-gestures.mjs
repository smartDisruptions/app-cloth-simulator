// Gestures and controls, with assertions (owner: ui).   node tests/ui-gestures.mjs
// Drives window.__cloth.input() and real touch / mouse / keyboard events (CDP multi-touch for the pinch,
// synthetic DeviceOrientationEvents for tilt), and checks what reached world.api.
import { launch, build, advance, clothRect } from './lib.mjs';
import { openUI, tapEl, touch, sleep } from './ui-lib.mjs';

const url = build();
const browser = await launch();
let fails = 0, passes = 0;
const ok = (cond, what, extra = '') => { if (cond) passes++; else fails++; console.log(`${cond ? '✓' : '✗'} ${what}${extra ? '  ' + extra : ''}`); };
const RETURNING = () => { try { localStorage.setItem('cloth-sim:ui:v1', JSON.stringify({ seen: 1, compact: 0, taught: {} })); } catch (e) {} };

// ---------------------------------------------------------------- first run, grabs, pinch, slice beat
{
  const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-p', query: 'scene=noren&quality=low' });
  await advance(page, 20);
  ok(await page.evaluate(() => document.querySelector('.hint').classList.contains('on')), 'first-run hint shows');
  const r = await clothRect(page);

  // two fingers, two patches
  const two = await page.evaluate(([a, b]) => {
    const C = window.__cloth; C.input('down', a[0], a[1], 11); C.input('down', b[0], b[1], 12); C.advance(2);
    C.input('move', a[0] - 30, a[1] + 40, 11); C.input('move', b[0] + 30, b[1] + 40, 12); C.advance(3);
    const p = C.world.pointers.filter((P) => P.active).map((P) => P.particle);
    C.input('up', a[0] - 30, a[1] + 40, 11); C.input('up', b[0] + 30, b[1] + 40, 12); C.advance(1);
    return { p, after: C.world.pointers.filter((P) => P.active).length };
  }, [[r.x0 + r.w * 0.2, r.cy], [r.x0 + r.w * 0.8, r.cy]]);
  ok(two.p.length === 2 && two.p[0] >= 0 && two.p[1] >= 0 && two.p[0] !== two.p[1], 'multi-touch: each finger grabs its own patch', JSON.stringify(two));
  ok(two.after === 0, 'release frees both pointers');
  ok(await page.evaluate(() => !document.querySelector('.hint').classList.contains('on')), 'hint fades after the first touch');
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('cloth-sim:ui:v1') || '{}').seen === 1), 'hint is remembered in localStorage');

  // walk a finger in from empty space: it catches the cloth
  const latch = await page.evaluate(([x, y0, y1]) => {
    const C = window.__cloth; C.input('down', x, y0, 21); C.advance(1);
    const before = C.world.pointers.find((P) => P.id === 21).particle;
    for (let y = y0; y <= y1; y += 30) { C.input('move', x, y, 21); C.advance(1); }
    const after = C.world.pointers.find((P) => P.id === 21).particle;
    C.input('up', x, y1, 21); C.advance(1);
    return { before, after };
  }, [r.cx, r.y0 - 70, r.cy]);
  ok(latch.before < 0 && latch.after >= 0, 'a finger from empty space catches the cloth as it passes', JSON.stringify(latch));

  // pinch on empty space (above the cloth): zoom
  const pinch = await page.evaluate(([cx, y]) => {
    const C = window.__cloth, m0 = C.world.cameraRig.zoom;
    C.input('down', cx - 20, y, 31); C.input('down', cx + 20, y, 32); C.advance(1);
    for (let k = 1; k <= 6; k++) { C.input('move', cx - 20 - k * 12, y, 31); C.input('move', cx + 20 + k * 12, y, 32); C.advance(2); }
    C.advance(30);
    const m1 = C.world.cameraRig.zoom, grabbed = C.world.pointers.some((P) => P.active && P.particle >= 0);
    C.input('up', 0, 0, 31); C.input('up', 0, 0, 32); C.advance(1);
    return { m0, m1, grabbed, zoom: C.modules.input.zoomLevel() };
  }, [r.cx, Math.max(10, r.y0 - 60)]);
  ok(pinch.m1 < pinch.m0 * 0.8 && !pinch.grabbed, 'two fingers on empty space pinch-zoom, never grab', JSON.stringify(pinch));

  // the katana beat
  const beat = await page.evaluate(([x0, x1, y]) => {
    const C = window.__cloth, W = C.world; C.api.setTool('slice');
    const before = W.stats.constraintsAlive;
    C.input('down', x0, y, 41); C.advance(1);
    C.input('move', (x0 + x1) / 2, y + 10, 41); C.advance(1);
    C.input('move', x1, y + 20, 41); C.advance(1);
    const pulse = W.slowmoPulse, cls = document.getElementById('ui').classList.contains('beat');
    C.input('up', x1, y + 20, 41); C.advance(2);
    return { pulse, cls, cut: before - W.stats.constraintsAlive, scale: W.timeScale };
  }, [r.x0 - 20, r.x1 + 20, r.cy]);
  ok(beat.cut > 0 && beat.pulse > 0.4 && beat.cls, 'a long fast cut slices, sets slowmoPulse and runs the letterbox', JSON.stringify(beat));
  const slow = await page.evaluate(([x, y]) => {
    const C = window.__cloth, W = C.world; C.api.reset(); C.advance(40);
    C.input('down', x, y, 42); for (let k = 1; k <= 8; k++) { C.input('move', x + k * 3, y, 42); C.advance(2); }
    const pulse = W.slowmoPulse; C.input('up', x + 24, y, 42); C.advance(1); return pulse;
  }, [r.cx - 12, r.cy]);
  ok(slow === 0, 'a short slow cut does not trigger the beat', String(slow));
  ok(errors.length === 0, 'no console errors (portrait)', errors.join(' | ').slice(0, 300));
  await ctx.close();
}

// ---------------------------------------------------------------- burn, pin, dye, keyboard, HUD taps
{
  const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-p', query: 'scene=embers&quality=low', init: RETURNING });
  await advance(page, 30);
  const r = await clothRect(page);

  // burn: hold heats past ignition
  const heat = await page.evaluate(([x, y]) => {
    const C = window.__cloth; C.api.setTool('burn');
    C.input('down', x, y, 51); C.advance(30);
    const h = Math.max(...C.world.cloth.heat); C.input('up', x, y, 51); C.advance(1); return h;
  }, [r.cx, r.y0 + r.h * 0.7]);
  ok(heat > 0.45, 'burn: tap lights, hold keeps the torch on', heat.toFixed(2));
  await page.evaluate(() => { window.__cloth.api.reset(); window.__cloth.advance(20); });

  // pin: tap pins, marker shows; tap again frees
  const pin = await page.evaluate(([x, y]) => {
    const C = window.__cloth, W = C.world; C.api.setTool('pin'); C.advance(1);
    const count = () => { let n = 0; for (let i = 0; i < W.cloth.n; i++) n += W.cloth.pinned[i]; return n; };
    const n0 = count();
    C.input('down', x, y, 61); C.advance(2); C.input('up', x, y, 61); C.advance(2);
    const n1 = count(), markers = document.querySelectorAll('.pin.on.user').length;
    C.input('down', x, y, 62); C.advance(2); C.input('up', x, y, 62); C.advance(2);
    const n2 = count(), markers2 = document.querySelectorAll('.pin.on.user').length;
    return { n0, n1, n2, markers, markers2, anchors: document.querySelectorAll('.pin.on.anchor').length };
  }, [r.cx, r.y0 + r.h * 0.6]);
  ok(pin.n1 === pin.n0 + 1 && pin.markers === 1, 'pin: a tap pins and a marker appears', JSON.stringify(pin));
  ok(pin.n2 === pin.n0 && pin.markers2 === 0, 'pin: tapping the pin frees it');
  ok(pin.anchors > 0, 'pin tool shows the scene’s own pins');

  // pin: carry a point and let go: pinned where it was released
  const carry = await page.evaluate(([x, y]) => {
    const C = window.__cloth, W = C.world;
    C.input('down', x, y, 63); C.advance(2);
    const v = W.pointers.find((P) => P.id === 63).particle;
    for (let k = 1; k <= 10; k++) { C.input('move', x + k * 3, y - k * 2, 63); C.advance(2); }
    C.advance(4);
    C.input('up', x + 30, y - 20, 63); C.advance(3);
    const s = W.screen;
    return { v, pinned: W.cloth.pinned[v], sx: s[v * 3], sy: s[v * 3 + 1] };
  }, [r.x0 + r.w * 0.3, r.y0 + r.h * 0.75]);
  ok(carry.v >= 0 && carry.pinned === 1 && Math.hypot(carry.sx - (r.x0 + r.w * 0.3 + 30), carry.sy - (r.y0 + r.h * 0.75 - 20)) < 30,
    'pin: press, drag and let go pins the point where it was let go', JSON.stringify(carry));

  // dye: a tap drops once, a drag drops along the stroke
  const dye = await page.evaluate(([x, y]) => {
    const C = window.__cloth, api = C.api, orig = api.dye; let n = 0;
    api.dye = (a, b) => { n++; return orig(a, b); };
    api.setTool('dye');
    C.input('down', x, y, 71); C.advance(1); C.input('up', x, y, 71); C.advance(1);
    const tap = n; n = 0;
    C.input('down', x - 60, y, 72); for (let k = 1; k <= 12; k++) { C.input('move', x - 60 + k * 10, y, 72); C.advance(1); } C.input('up', x + 60, y, 72);
    api.dye = orig; return { tap, stroke: n };
  }, [r.cx, r.cy]);
  ok(dye.tap === 1 && dye.stroke >= 7 && dye.stroke <= 9, 'dye: tap drops once, a 120 px drag drops every 16 px', JSON.stringify(dye));

  // keyboard
  const keys = {};
  await page.keyboard.press('2'); keys.two = await page.evaluate(() => window.__cloth.world.tool);
  await page.keyboard.press('5'); keys.five = await page.evaluate(() => window.__cloth.world.tool);
  await page.keyboard.press('s'); keys.s = await page.evaluate(() => window.__cloth.world.toggles.stats);
  await page.keyboard.press('Space'); keys.space = await page.evaluate(() => window.__cloth.world.toggles.slowmo);
  const w0 = await page.evaluate(() => window.__cloth.world.toggles.wind);   // the scene's own level (Embers starts still)
  await page.keyboard.press('w'); keys.w = await page.evaluate(() => window.__cloth.world.toggles.wind);
  await page.keyboard.press(']'); keys.next = await page.evaluate(() => window.__cloth.world.sceneId);
  ok(keys.two === 'slice' && keys.five === 'dye' && keys.s === true && keys.space === true && keys.w === (w0 + 1) % 3 && keys.next === 'monsoon', 'keyboard: 1–5, S, Space, W, ]', JSON.stringify(keys));

  // real taps on the HUD
  await tapEl(page, '.tool[data-tool="burn"]'); const tTool = await page.evaluate(() => window.__cloth.world.tool);
  await tapEl(page, '.tg[data-t="rain"]'); const tRain = await page.evaluate(() => window.__cloth.world.toggles.rain);
  await tapEl(page, '.scene'); await sleep(450);
  const open = await page.evaluate(() => document.querySelector('.sheet-scene').classList.contains('open'));
  await tapEl(page, '.card[data-id="unveil"]'); await sleep(100);
  const sc = await page.evaluate(() => [window.__cloth.world.sceneId, document.querySelector('.sheet-scene').classList.contains('open')]);
  await tapEl(page, '.mat'); await sleep(450);
  await tapEl(page, '.matb[data-m="chainmail"]');
  const mat = await page.evaluate(() => window.__cloth.world.materialId);
  ok(tTool === 'burn' && tRain === false && open && sc[0] === 'unveil' && !sc[1] && mat === 'chainmail', 'real taps: tool, toggle, scene card, material', JSON.stringify({ tTool, tRain, open, sc, mat }));
  const aria = await page.evaluate(() => [...document.querySelectorAll('#ui button')].filter((b) => !b.getAttribute('aria-label') && !b.textContent.trim()).length);
  ok(aria === 0, 'every icon button has a label');
  const small = await page.evaluate(() => [...document.querySelectorAll('#ui button')].filter((b) => { if (b.closest('.sheet:not(.open)') || b.closest('[hidden]')) return false; const r = b.getBoundingClientRect(); return r.width && (r.width < 43.5 || r.height < 43.5) && !b.matches('.rc-tier, .rc-copy'); }).map((b) => b.className));   // the receipt's two instrument buttons draw small but hit 44 px via ::before
  ok(small.length === 0, 'touch targets are at least 44 px', JSON.stringify(small));
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
  ok(scroll, 'no horizontal page scroll');

  // a real touch on the cloth reaches the tools (pin)
  await page.evaluate(() => { window.__cloth.api.setScene('embers'); window.__cloth.api.setTool('pin'); window.__cloth.advance(20); });
  const r2 = await clothRect(page);
  const p0 = await page.evaluate(() => { let n = 0; const c = window.__cloth.world.cloth; for (let i = 0; i < c.n; i++) n += c.pinned[i]; return n; });
  await page.touchscreen.tap(r2.cx, r2.y0 + r2.h * 0.6);
  await advance(page, 3);
  const p1 = await page.evaluate(() => { let n = 0; const c = window.__cloth.world.cloth; for (let i = 0; i < c.n; i++) n += c.pinned[i]; return n; });
  ok(p1 === p0 + 1, 'a real touch on the cloth pins it', `${p0} → ${p1}`);

  // two real fingers over CDP pinch-zoom
  const cdp = await page.context().newCDPSession(page);
  const m0 = await page.evaluate(() => { window.__cloth.api.setTool('grab'); return window.__cloth.world.cameraRig.zoom; });
  const y = Math.max(130, r2.y0 - 50), cx = r2.cx;
  await touch(cdp, 'touchStart', [[cx - 30, y, 1], [cx + 30, y, 2]]); await advance(page, 1);
  for (let k = 1; k <= 5; k++) { await touch(cdp, 'touchMove', [[cx - 30 + k * 4, y, 1], [cx + 30 - k * 4, y, 2]]); await advance(page, 1); }
  await touch(cdp, 'touchEnd', []); await advance(page, 30);
  const m1 = await page.evaluate(() => window.__cloth.world.cameraRig.zoom);
  ok(m1 > m0 * 1.1, 'a real two-finger pinch zooms out', `${m0.toFixed(2)} → ${m1.toFixed(2)}`);
  ok(errors.length === 0, 'no console errors (tools)', errors.join(' | ').slice(0, 300));
  await ctx.close();
}

// ---------------------------------------------------------------- tilt
{
  const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low', init: RETURNING });
  await advance(page, 10);
  await tapEl(page, '.tg[data-t="tilt"]', 1);
  const fire = (beta, gamma) => page.evaluate(([b, g]) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g })), [beta, gamma]);
  // real gravity, not "however it was held": upright hangs, flat falls into the scene (Josh, 2026-10-13)
  const down = () => page.evaluate(() => -window.__cloth.world.gravity[1]);
  const into = () => page.evaluate(() => { const W = window.__cloth.world, g = W.gravity, F = W.camera.fwd; return g[0] * F[0] + g[2] * F[2]; });
  const leftward = () => page.evaluate(() => { const W = window.__cloth.world, g = W.gravity, R = W.camera.right; return g[0] * R[0] + g[1] * R[1] + g[2] * R[2]; });
  await fire(0, 0); await advance(page, 30);                   // switched on lying flat on a table
  const g0 = await page.evaluate(() => { const W = window.__cloth.world; return [...W.gravity].concat([W.toggles.tilt]); });
  const flatInto = await into(), flatDown = await down();
  await fire(90, 0); await advance(page, 40);                  // pick it up and hold it upright
  const upDown = await down(), upInto = await into();
  const off = await page.evaluate(() => [...window.__cloth.world.cameraRig.uiOffset].map((v) => +v.toFixed(3)));
  await advance(page, 420);                                    // hold it there: the parallax settles back
  const offRest = await page.evaluate(() => Math.hypot(...window.__cloth.world.cameraRig.uiOffset));
  await fire(55, -89.9); await advance(page, 40);              // upright, rolled 35° to the left
  const left = await leftward();
  ok(g0[3] === true && flatInto > 9 && Math.abs(flatDown) < 1, 'tilt on lying flat: gravity points into the scene', JSON.stringify([flatInto.toFixed(2), flatDown.toFixed(2)]));
  ok(upDown > 9.6 && Math.abs(upInto) < 0.6, 'held upright: the cloth hangs straight down', JSON.stringify([upDown.toFixed(2), upInto.toFixed(2)]));
  ok(left < -4.5, 'rolled left: gravity pulls left on screen', left.toFixed(2));
  ok(Math.hypot(...off) > 0.01 && offRest < 0.01, 'moving the phone adds parallax, holding still lets it settle', JSON.stringify([off, +offRest.toFixed(4)]));
  await tapEl(page, '.tg[data-t="tilt"]', 90);
  const g1 = await page.evaluate(() => [...window.__cloth.world.gravity].map((v) => +v.toFixed(2)));
  const off1 = await page.evaluate(() => Math.hypot(...window.__cloth.world.cameraRig.uiOffset));
  ok(g1[0] === 0 && g1[1] === -9.81 && off1 < 0.02, 'tilt off: gravity and camera come back', JSON.stringify([g1, off1]));
  ok(errors.length === 0, 'no console errors (tilt)', errors.join(' | ').slice(0, 300));
  await ctx.close();
}
{
  // a device that never reports orientation: the toggle switches itself off with a note
  const { page, ctx } = await openUI(browser, url, { device: 'ui-p', query: 'scene=banner&quality=low', init: RETURNING });
  await advance(page, 5);
  await tapEl(page, '.tg[data-t="tilt"]', 1);
  await advance(page, 110);
  const s = await page.evaluate(() => ({ on: window.__cloth.world.toggles.tilt, na: document.querySelector('.tg[data-t="tilt"]').classList.contains('na'), note: document.querySelector('.cap-top').textContent }));
  ok(!s.on && s.na && /tilt readings/.test(s.note), 'no sensor: tilt turns itself off and says so', JSON.stringify(s));
  await ctx.close();
}

// ---------------------------------------------------------------- desktop: mouse and wheel
{
  const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-d', query: 'scene=noren&quality=low', init: RETURNING });
  await advance(page, 20);
  const r = await clothRect(page);
  await page.mouse.move(r.cx, r.cy); await page.mouse.down(); await advance(page, 2);
  const g = await page.evaluate(() => window.__cloth.world.pointers[0].particle);
  await page.mouse.move(r.cx + 60, r.cy + 40, { steps: 4 }); await advance(page, 2); await page.mouse.up(); await advance(page, 2);
  ok(g >= 0, 'mouse grabs the cloth', String(g));
  const m0 = await page.evaluate(() => window.__cloth.world.cameraRig.zoom);
  await page.mouse.wheel(0, -400); await advance(page, 40);
  const m1 = await page.evaluate(() => window.__cloth.world.cameraRig.zoom);
  ok(m1 < m0 * 0.9, 'the mouse wheel zooms in', `${m0.toFixed(2)} → ${m1.toFixed(2)}`);
  const cur = await page.evaluate(() => { window.__cloth.api.setTool('slice'); return getComputedStyle(document.getElementById('gl')).cursor.slice(0, 22); });
  ok(/url\(/.test(cur), 'each tool has its own cursor', cur);
  ok(errors.length === 0, 'no console errors (desktop)', errors.join(' | ').slice(0, 300));
  await ctx.close();
}

await browser.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
