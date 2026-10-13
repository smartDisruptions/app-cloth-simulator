// The cloth renderer's own CPU cost per frame, isolated from the rest of the frame. After a warm-up (and
// optional stress: fire, rain, a slice), each component runs in its own tight loop of N calls, with the GL
// queue drained first (getError round-trip) so SwiftShader's backlog is not billed to us. Reports the median
// per call (CDP throttling pauses the main thread in slices, so means carry multi-ms outliers).
//   node tests/cloth-render-perf.mjs [--throttle 4] [--quality low] [--scenes noren,unveil] [--n 60] [--stress]
import { launch, open, build, advance, throttle, drag, clothRect, summarize } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low'), N = Number(arg('--n', '60'));
const SCENES = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const stress = process.argv.includes('--stress');

const url = build({ minify: true });
const browser = await launch();
console.log(`cloth-render cpu · throttle ${rate}× · quality ${quality} · ${N} calls each${stress ? ' · stress' : ''}`);
for (const scene of SCENES) {
  const { page, ctx, errors } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}&nogov=1` });
  await advance(page, 30);
  if (stress) {
    const r = await clothRect(page);
    await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
    await drag(page, [[r.cx - r.w * 0.2, r.y0 + r.h * 0.85], [r.cx - r.w * 0.2 + 1, r.y0 + r.h * 0.85]], { tool: 'burn', framesPerStep: 1 });
    await drag(page, [[r.x0 + 10, r.cy], [r.x1 - 10, r.cy + 10]], { tool: 'slice', framesPerStep: 1 });
    await advance(page, 30);
  }
  if (rate > 1) await throttle(page, rate);
  const res = await page.evaluate((n) => {
    const C = window.__cloth, W = C.world, M = C.modules, gl = W.gl, now = () => performance.now();
    // performance.now() is coarsened to 0.1 ms here: time batches of 10 calls, report per-call averages
    const time = (fn) => { const out = []; for (let i = 0; i < n; i++) { gl.getError(); const t = now(); for (let k = 0; k < 10; k++) fn(); out.push((now() - t) / 10); } gl.getError(); return out; };
    C.advance(1);
    return {
      upload: time(() => M.clothR.upload(W)),
      shadow: time(() => M.shadow.render(W)),
      draw: time(() => M.clothR.draw(W)),
      emissive: time(() => M.clothR.drawEmissive(W)),
      frame: time(() => C.advance(1)).map((x) => x),
      verts: W.cloth.n, tris: W.cloth.trisAlive, calls: W.stats.drawCalls,
    };
  }, N);
  const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(3); };
  const total = p50(res.upload) + p50(res.shadow) + p50(res.draw) + p50(res.emissive);
  console.log(`${total <= 0.8 ? '✓' : total <= 1.2 ? '~' : '✗'} ${scene.padEnd(10)} cloth-render ${total.toFixed(2)} ms  (upload ${p50(res.upload)} · shadow ${p50(res.shadow)} · draw ${p50(res.draw)} · emissive ${p50(res.emissive)})  whole frame p50 ${p50(res.frame)}  verts ${res.verts} tris ${res.tris} calls ${res.calls}`);
  for (const e of errors) console.log('   ', e.slice(0, 400));
  await ctx.close();
}
await browser.close();
