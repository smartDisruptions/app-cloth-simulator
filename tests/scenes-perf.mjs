// The scenes + environment share of the CPU budget: per scene, JS ms for scenes.update (ms.scene) and for
// the whole render submission with the environment's passes on vs off (the difference is env.draw +
// env.drawEmissive). A tiny viewport keeps SwiftShader's fill out of the way, so GL backpressure doesn't pollute
// the JS numbers. Owned by the scenes agent.
//   node tests/scenes-perf.mjs [--throttle 4] [--quality low] [--frames 120] [--scenes noren,banner]
import { launch, open, build, advance, throttle, summarize, DEVICES } from './lib.mjs';
// note: stats.ms holds the last frame only, so frames are run one by one inside the page and summed there

DEVICES.tiny = { viewport: { width: 180, height: 370 }, deviceScaleFactor: 1, touch: true };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low'), frames = Number(arg('--frames', '120'));
const SCENES = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const url = build({ minify: true });
const browser = await launch();
console.log(`throttle ${rate}× · quality ${quality} · ${frames} frames per run · tiny viewport`);
const run = async (page, envOn) => {
  await page.evaluate((on) => Object.assign(window.__cloth.modules.env.debug, { sky: on, mirror: on, props: on, emissive: on }), envOn);
  const t = [], acc = { scene: 0, render: 0 };
  for (let i = 0; i < frames; i += 20) {
    const r = await page.evaluate((n) => {
      const C = window.__cloth, o = { t: [], scene: 0, render: 0 };
      for (let k = 0; k < n; k++) { o.t.push(C.advance(1)[0]); o.scene += C.world.stats.ms.scene; o.render += C.world.stats.ms.render; }
      const gl = C.world.gl, px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return o;
    }, Math.min(20, frames - i));
    t.push(...r.t); acc.scene += r.scene; acc.render += r.render;
  }
  const calls = await page.evaluate(() => window.__cloth.world.stats.drawCalls);
  return { frame: summarize(t), scene: +(acc.scene / frames).toFixed(3), render: +(acc.render / frames).toFixed(3), calls };
};
for (const scene of SCENES) {
  const { page, ctx, errors } = await open(browser, url, { device: 'tiny', query: `scene=${scene}&quality=${quality}&nogov` });
  await advance(page, 20);
  await throttle(page, rate);
  const on = await run(page, true), off = await run(page, false);
  // direct: the env module's own JS + GL submission per frame, timed between GPU syncs (no backpressure)
  const direct = await page.evaluate(() => {
    const C = window.__cloth, w = C.world, env = C.modules.env, gl = w.gl, px = new Uint8Array(4);
    Object.assign(env.debug, { sky: true, mirror: true, props: true, emissive: true });
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const best = [];
    for (let rep = 0; rep < 5; rep++) {
      sync(); let t0 = performance.now();
      for (let k = 0; k < 30; k++) { env.draw(w); env.drawEmissive(w); }
      best.push((performance.now() - t0) / 30); sync();
    }
    best.sort((a, b) => a - b);
    return +best[2].toFixed(3);
  });
  on.direct = direct;
  console.log(`${scene.padEnd(10)} scene.update ${on.scene} ms · env draw+emissive ${on.direct} ms (direct, median of 5×30) · render ${on.render} with env / ${off.render} without · frame p95 ${on.frame.p95} ms · ${on.calls} draw calls (${on.calls - off.calls} env)`);
  for (const e of errors) console.log('   ', e.slice(0, 400));
  await ctx.close();
}
await browser.close();
