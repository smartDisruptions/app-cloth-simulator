// The fire's own CPU receipt: per-frame stats.ms.fire on a throttled "old phone", frame by frame.
//   node tests/fire-perf.mjs [--throttle 4] [--quality low] [--scenes embers,unveil] [--frames 360] [--material cotton]
// Lights two fires near the bottom like perf.mjs --stress (plus a held torch), and reports p50/p95/max of
// the fire module alone, the idle cost before anything burns, and the worst frames with what was going on.
//   [--repeat 3]  run the identical (seeded, manually stepped) scenario on fresh pages and keep each
//                 frame's minimum: random descheduling on a shared machine drops out, real cost stays.
import { launch, open, build, advance, throttle, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4'));
const quality = arg('--quality', 'low');
const frames = Number(arg('--frames', '360'));
const material = arg('--material', '');
const repeat = Number(arg('--repeat', '1'));
const SCENES = arg('--scenes', 'embers,unveil,banner').split(',');

const url = build({ minify: true });
const browser = await launch();
console.log(`fire module · throttle ${rate}× · quality ${quality} · ${frames} frames after lighting${repeat > 1 ? ` · per-frame min of ${repeat} identical runs` : ''}`);
for (const scene of SCENES) {
  if (repeat > 1) {
    let best = null, bestIdle = null, info = null;
    for (let r = 0; r < repeat; r++) {
      const one = await runOnce(scene);
      best = best ? best.map((v, i) => Math.min(v, one.out[i])) : one.out;
      bestIdle = bestIdle ? bestIdle.map((v, i) => Math.min(v, one.idle[i])) : one.idle;
      info = one.info;
    }
    const s = summarize(best), si = summarize(bestIdle);
    const worst = best.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, 3);
    console.log(`${s.p95 <= 0.6 ? '✓' : '✗'} ${scene.padEnd(8)} fire ms ${JSON.stringify(s)}  idle ${JSON.stringify(si)}`);
    for (const [v, i] of worst) console.log(`     worst f${i}: ${v.toFixed(2)} ms  (${info[i]})`);
    continue;
  }
  const fireMs = await runOnce(scene);
  console.log(`   (context: sim ms ${JSON.stringify(summarize(fireMs.sim))}  weather ms ${JSON.stringify(summarize(fireMs.weather))})`);
  const s = summarize(fireMs.out), si = summarize(fireMs.idle);
  const worst = fireMs.out.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, 3);
  console.log(`${s.p95 <= 0.6 ? '✓' : '✗'} ${scene.padEnd(8)} fire ms ${JSON.stringify(s)}  idle ${JSON.stringify(si)}  end ${JSON.stringify(fireMs.end)}`);
  for (const [v, i] of worst) console.log(`     worst f${i}: ${v.toFixed(2)} ms  (${fireMs.info[i]})`);
  for (const e of fireMs.errors) console.log('   ', e.slice(0, 400));
}
await browser.close();

/** One seeded run: 60 idle frames, then two fires (a tap and a held torch) and `frames` frames of burning. */
async function runOnce(scene) {
  const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}${material ? '&material=' + material : ''}` });
  await advance(page, 30);
  await throttle(page, rate);
  // idle: nothing hot
  const idle = await page.evaluate((n) => { const C = window.__cloth, out = []; for (let i = 0; i < n; i++) { C.advance(1); out.push(C.world.stats.ms.fire); } return out; }, 60);
  const r = await clothRect(page);
  const res = await page.evaluate(([r, n]) => {
    // allocation-free while frames run, so the harness's own garbage never lands inside fire.update
    const C = window.__cloth, ms = new Float64Array(n), burn = new Int32Array(n), parts = new Int32Array(n), simMs = new Float64Array(n), weatherMs = new Float64Array(n);
    C.api.setTool('burn');
    const ax = r.x0 + r.w * 0.3, ay = r.y0 + r.h * 0.85, bx = r.x0 + r.w * 0.7, by = r.y0 + r.h * 0.85;
    C.input('down', ax, ay, 3); C.advance(1); C.input('up', ax, ay, 3);
    C.input('down', bx, by, 4);
    const s = C.world.stats;
    for (let i = 0; i < n; i++) {
      if (i === 40) C.input('up', bx, by, 4);
      C.advance(1);
      ms[i] = s.ms.fire; burn[i] = s.burning; parts[i] = s.particles; simMs[i] = s.ms.sim; weatherMs[i] = s.ms.weather;
    }
    const out = Array.from(ms), info = [];
    for (let i = 0; i < n; i++) info.push(`burning ${burn[i]} particles ${parts[i]} (sim ${simMs[i].toFixed(1)} weather ${weatherMs[i].toFixed(1)})`);
    return { out, info, sim: Array.from(simMs), weather: Array.from(weatherMs) };
  }, [r, frames]);
  res.idle = idle; res.errors = errors;
  res.end = await page.evaluate(() => { const s = window.__cloth.world.stats; return { burning: s.burning, charred: +s.charred.toFixed(2), particles: s.particles }; });
  await ctx.close();
  return res;
}
