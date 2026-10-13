// Per-frame wall time including GPU completion (SwiftShader), per env pass, to find slow shaders.
// Owned by the scenes agent.   node tests/scenes-diag.mjs [scene] [device] [quality]
import { launch, open, build, advance, DEVICES } from './lib.mjs';

DEVICES.p360 = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, touch: true };
DEVICES.w800 = { viewport: { width: 800, height: 450 }, deviceScaleFactor: 1, touch: false };
const scene = process.argv[2] || 'noren', device = process.argv[3] || 'p360', quality = process.argv[4] || 'mid';
const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device, query: `scene=${scene}&quality=${quality}` });
await advance(page, 2);
const timeIt = async (label, flags) => {
  await page.evaluate((f) => Object.assign(window.__cloth.modules.env.debug, f), flags);
  const ms = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    await advance(page, 1);
    await page.evaluate(() => { const gl = window.__cloth.world.gl; const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return px[0]; });
    ms.push(Date.now() - t0);
  }
  console.log(label.padEnd(22), ms.join(' '), 'ms');
};
await timeIt('all', { sky: true, mirror: true, props: true, emissive: true });
await timeIt('no env', { sky: false, mirror: false, props: false, emissive: false });
await timeIt('sky only', { sky: true, mirror: false, props: false, emissive: false });
await timeIt('props only', { sky: false, mirror: false, props: true, emissive: false });
await timeIt('props trivial FS', { sky: false, mirror: false, props: true, emissive: false, propsTrivial: true });
await page.evaluate(() => { window.__cloth.modules.env.debug.propsTrivial = false; });
await timeIt('mirror only', { sky: false, mirror: true, props: false, emissive: false });
await timeIt('emissive only', { sky: false, mirror: false, props: false, emissive: true });
const st = await page.evaluate(() => { const w = window.__cloth.world; return { calls: w.stats.drawCalls, verts: w.stats.verts }; });
console.log('props verts', await page.evaluate(() => window.__cloth.modules.env.propVerts && window.__cloth.modules.env.propVerts()));
console.log(JSON.stringify(st));
for (const e of errors) console.log('   ', e.slice(0, 2000));
await browser.close();
