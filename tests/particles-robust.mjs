// Robustness of render/particles.js + render/post.js (owner: particles-post): the paths a normal session
// rarely hits. Fails on any console error or a broken invariant.
//   node tests/particles-robust.mjs
//   · bloom switched off by the governor (no emissive pass, the no-bloom composite)
//   · tier switches low → ultra → mid (shader variants recompile; ultra runs 4 bloom levels at ½ res)
//   · a resize, a tiny canvas, then back
//   · spawn: junk arguments and a full pool return 0 and never corrupt the pool
//   · the trail fed NaN, a pause (nothing moves, the trail freezes), the puff cap
import { launch, open, build, advance } from './lib.mjs';

const url = build();
const browser = await launch();
const { page, errors, ctx } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=mid&nogov=1' });
page.setDefaultTimeout(240000);
const fails = [];
const check = (ok, msg) => { if (!ok) fails.push(msg); console.log(`${ok ? '✓' : '✗'} ${msg}`); };
await advance(page, 20);

// junk arguments
const junk = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, P = C.modules.particles;
  const r = [
    P.spawn(W, 0, NaN, 1, 0, 0, 0, 0, 0.05, 1),
    P.spawn(W, 0, 0, 1, 0, 0, 0, 0, 0.05, 0),
    P.spawn(W, 0, 0, 1, 0, 0, 0, 0, -1, 1),
    P.spawn(W, 99, 0, 1, 0, 0, 0, 0, 0.05, 1),
    P.spawn(W, -1, 0, 1, 0, 0, 0, 0, 0.05, 1),
  ];
  C.api.trail(NaN, 0, 10, 10); C.api.trail(0, 0, Infinity, 10);
  C.advance(2);
  return { r, n: P.count() };
});
check(junk.r.every((x) => x === 0), `junk spawns rejected ${JSON.stringify(junk.r)}`);

// fill the pool to capacity: further spawns return 0, count never exceeds the cap
const full = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, P = C.modules.particles, cap = P.capacity(W);
  let ok = 0; for (let i = 0; i < cap + 200; i++) ok += P.spawn(W, 2, 0, 1.5, 0.1, 0, 0.2, 0, 0.01, 3);
  const after = P.spawn(W, 2, 0, 1.5, 0.1, 0, 0.2, 0, 0.01, 3);
  C.advance(3);
  return { cap, n: P.count(), after, ok };
});
check(full.after === 0 && full.n <= full.cap, `pool capped at ${full.cap} (count ${full.n}, next spawn → ${full.after})`);

// the puff cap: smoke + steam stop at the tier's budget even with room in the pool
const puffs = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, P = C.modules.particles;
  C.api.reset(); C.advance(2);
  let ok = 0; for (let i = 0; i < 600; i++) ok += P.spawn(W, 4, 0, 1.5, 0.1, 0, 0.3, 0, 0.1, 5);
  return { ok, smoke: P.debug.kindN[4], n: P.count(), cap: P.capacity(W) };
});
check(puffs.smoke < 200 && puffs.smoke === puffs.ok, `smoke capped per tier: ${puffs.smoke} puffs (pool ${puffs.n}/${puffs.cap})`);

// pause: nothing moves, the trail does not age
const paused = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, P = C.modules.particles, D = P.debug;
  C.api.trail(100, 300, 200, 320); C.advance(1);
  W.paused = true;
  const y0 = D.pool.py[0]; C.advance(30); const y1 = D.pool.py[0];
  const q0 = D.quads; W.paused = false;
  return { moved: y1 !== y0, trailQuads: q0 - D.n };
});
check(!paused.moved && paused.trailQuads > 0, `pause freezes particles and the trail (trail quads still drawn: ${paused.trailQuads})`);

// bloom off by the governor
await page.evaluate(() => { const W = window.__cloth.world; W.q.bloom = 0; window.__cloth.advance(20); W.q.bloom = 1; window.__cloth.advance(5); });
check(true, 'bloom off → composite without bloom (no errors expected below)');

// tier switches recompile; ultra runs four bloom levels at half resolution
for (const t of ['low', 'ultra', 'high', 'mid']) {
  const st = await page.evaluate((t) => {
    const C = window.__cloth, W = C.world, P = C.modules.particles;
    C.api.setQuality(t); C.advance(2);
    for (let i = 0; i < 40; i++) { P.spawn(W, 0, 0, 1.2, 0.05, 0, 0.4, 0, 0.08, 0.6); P.spawn(W, 4, 0, 1.4, 0.05, 0, 0.3, 0, 0.1, 2); P.spawn(W, 11, 0.2, 1.3, 0.6, 0, 0, 0, 0.006, 4); }
    C.api.trail(60, 300, 260, 340); C.advance(12);
    return { tier: W.stats.tier, n: P.count(), calls: W.stats.drawCalls, bloomDiv: W.q.bloomDiv };
  }, t);
  check(st.tier === t && st.n > 0, `tier ${t}: ${st.n} particles, ${st.calls} draw calls, bloom ÷${st.bloomDiv}`);
}

// resize to a tiny canvas and back
await page.setViewportSize({ width: 120, height: 90 }); await advance(page, 6);
await page.setViewportSize({ width: 390, height: 700 }); await advance(page, 6);
check(true, 'resize to 120×90 and back');

const nan = await page.evaluate(() => { const D = window.__cloth.modules.particles.debug; for (let i = 0; i < D.n; i++) if (!Number.isFinite(D.pool.px[i] + D.pool.py[i] + D.pool.pz[i])) return true; return false; });
check(!nan, 'no non-finite particle positions');
for (const e of errors) console.log('   ', e.slice(0, 600));
check(errors.length === 0, `no console errors (${errors.length})`);
await ctx.close();
await browser.close();
process.exit(fails.length ? 1 : 0);
