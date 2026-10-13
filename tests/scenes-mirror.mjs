// The cloth's reflection in a wet or polished floor really draws, and nothing raises a WebGL error. The
// mirror reads cloth-render's buffers (gpu.cloth), so a changed attribute layout doesn't error in Chrome
// (robust buffer access returns zeros): the mirrored cloth just discards every pixel. So this renders a
// paused frame with the mirrored cloth on and off and counts the 8×8 blocks whose average changes (blocks,
// because the film grain moves even when paused and averages out), against a control of the frame drawn
// twice. Every draw call is checked with getError.
// Owned by the scenes agent.
//   node tests/scenes-mirror.mjs [--scenes unveil,monsoon] [--devices p360,w800] [--quality mid]
import { launch, open, build, advance, DEVICES } from './lib.mjs';

DEVICES.p360 = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, touch: true };
DEVICES.w800 = { viewport: { width: 800, height: 450 }, deviceScaleFactor: 1, touch: false };
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// the scenes whose floor reflects (koinobori and banner stand on grass)
const scenes = arg('--scenes', 'noren,unveil,embers,monsoon').split(',');
const devices = arg('--devices', 'p360,w800').split(',');
const quality = arg('--quality', 'mid');
// where the reflection must show: Unveil's polished floor and Monsoon's puddles, from their high cameras
const MUST = new Set(['unveil', 'monsoon']);

const url = build();
const browser = await launch();
let bad = 0;
for (const scene of scenes) {
  let best = 0;
  for (const device of devices) {
    const { ctx, page, errors } = await open(browser, url, { device, query: `scene=${scene}&quality=${quality}&rain=1` });
    await page.evaluate(() => {
      const gl = window.__cloth.world.gl, log = (window.__glerr = []);
      gl.getError();
      for (const name of ['drawArrays', 'drawElements', 'clear']) {
        const f = gl[name].bind(gl);
        gl[name] = (...a) => {
          f(...a);
          const e = gl.getError();
          if (e && log.length < 12) {
            const where = (new Error().stack || '').split('\n').slice(2, 5).map((s) => s.trim().replace(/^at /, '').replace(/\s*\(.*$/, '')).join(' < ');
            log.push(`${name} 0x${e.toString(16)} in ${where}`);
          }
        };
      }
      const c = window.__cloth.modules.scenes.clock; if (c) c.t = 99;   // the settled framing, not the push-in
    });
    for (let f = 0; f < 120; f += 12) await advance(page, 12);
    const r = await page.evaluate(() => {
      const C = window.__cloth, w = C.world, gl = w.gl, dbg = C.modules.env.debug;
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const grab = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
      // 8×8 block averages of r+g+b, compared block by block (grain averages out; a reflection doesn't)
      const blocks = (a) => {
        const bw = W >> 3, bh = H >> 3, s = new Float32Array(bw * bh);
        for (let y = 0; y < bh * 8; y++) for (let x = 0; x < bw * 8; x++) { const i = (y * W + x) * 4; s[(y >> 3) * bw + (x >> 3)] += a[i] + a[i + 1] + a[i + 2]; }
        for (let k = 0; k < s.length; k++) s[k] /= 64;
        return s;
      };
      const diff = (a, b) => { const A = blocks(a), B = blocks(b); let n = 0; for (let k = 0; k < A.length; k++) if (Math.abs(A[k] - B[k]) > 6) n++; return n; };
      w.paused = true;
      C.advance(1); const on = grab();
      C.advance(1); const again = grab();
      dbg.mirrorCloth = false; C.advance(1); const off = grab(); dbg.mirrorCloth = true;
      w.paused = false;
      return { cloth: diff(on, off), control: diff(on, again), wet: +w.rain.intensity.toFixed(2) };
    });
    const log = await page.evaluate(() => window.__glerr);
    const shows = r.cloth >= Math.max(6, 5 * r.control);
    best = Math.max(best, shows ? r.cloth : 0);
    console.log(`  ${scene.padEnd(9)} ${device.padEnd(5)} cloth reflection changes ${String(r.cloth).padStart(5)} blocks of 8×8 (control ${r.control}) · rain ${r.wet}${log.length ? ' · GL ERRORS' : ''}`);
    for (const e of log) console.log('     ', e);
    for (const e of errors) console.log('     ', e.slice(0, 400));
    if (log.length || errors.length) bad++;
    await ctx.close();
  }
  const ok = best > 0 || !MUST.has(scene);
  console.log(`${ok ? '✓' : '✗'} ${scene}${MUST.has(scene) ? '' : ' (reflection off-frame is allowed here)'}`);
  if (!ok) bad++;
}
await browser.close();
process.exit(bad ? 1 : 0);
