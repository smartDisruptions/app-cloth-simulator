// Look at the scenes: each scene on a 360×740 portrait phone and an 800×450 landscape screen, at chosen
// moments, HUD hidden so the composition is what you judge. Owned by the scenes agent.
//   node tests/scenes-look.mjs [--scenes noren,banner] [--devices p360,w800] [--quality mid] [--at 30,90,180]
//                              [--hud] [--q "rain=1"] [--tag x] [--do "grab:0.5,0.6,40,30"]
// Writes tests/out/look-<scene>-<device>-<quality>-f<frame><tag>.png and prints each path.
import { launch, open, build, advance, drag, clothRect, DEVICES, OUT } from './lib.mjs';
import { join } from 'node:path';

DEVICES.p360 = { viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, touch: true };
DEVICES.w800 = { viewport: { width: 800, height: 450 }, deviceScaleFactor: 1, touch: false };

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scenes = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const devices = arg('--devices', 'p360,w800').split(',');
const quality = arg('--quality', 'mid');
const at = arg('--at', '90').split(',').map(Number);
const extra = arg('--q', ''), tag = arg('--tag', ''), hud = process.argv.includes('--hud'), devShadow = false; // the stand-in shadow is gone: render/shadow.js is real now
const opening = process.argv.includes('--opening'); // keep the opening push-in (default: judge the settled framing)
const actions = (arg('--do', '') || '').split(';').filter(Boolean);

const url = build();
const browser = await launch();
let bad = 0;
for (const scene of scenes) for (const device of devices) {
  const { ctx, page, errors } = await open(browser, url, { device, query: [`scene=${scene}`, `quality=${quality}`, extra].filter(Boolean).join('&') });
  if (!hud) await page.addStyleTag({ content: '#ui{display:none!important}' });
  // stand-in coloured shadow while render/shadow.js is still a stub (inactive once the real one publishes)
  if (!opening) await page.evaluate(() => { const c = window.__cloth.modules.scenes.clock; if (c) c.t = 99; });
  let f = 0, acted = !actions.length;
  for (const target of at) {
    if (!acted && target > at[0]) {
      const r = await clothRect(page);
      const X = (v) => r.x0 + r.w * v, Y = (v) => r.y0 + r.h * v;
      for (const a of actions) {
        const [name, rest = ''] = a.split(':'); const v = rest.split(',').map(Number);
        if (name === 'grab') await drag(page, [[X(v[0]), Y(v[1])], [X(v[0]) + v[2] / 2, Y(v[1]) + v[3] / 2], [X(v[0]) + v[2], Y(v[1]) + v[3]]], { tool: 'grab', framesPerStep: 4 });
        else if (name === 'slice') await drag(page, [[X(v[0]), Y(v[1])], [(X(v[0]) + X(v[2])) / 2, (Y(v[1]) + Y(v[3])) / 2], [X(v[2]), Y(v[3])]], { tool: 'slice', framesPerStep: 1 });
        else if (['burn', 'pin', 'dye'].includes(name)) await drag(page, [[X(v[0]), Y(v[1])], [X(v[0]) + 1, Y(v[1])]], { tool: name, framesPerStep: 6 });
        else if (name === 'rain') await page.evaluate((x) => window.__cloth.api.setToggle('rain', !!x), v[0]);
        else if (name === 'wind') await page.evaluate((x) => window.__cloth.api.setToggle('wind', x), v[0]);
        else if (name === 'material') await page.evaluate((m) => window.__cloth.api.setMaterial(m), rest);
      }
      acted = true;
      f = await page.evaluate(() => window.__cloth.world.frame);
    }
    while (f < target) {
      const n = Math.min(12, target - f);
      await advance(page, n); f += n;
      await page.evaluate(() => { const gl = window.__cloth.world.gl, px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); });
    }
    const path = join(OUT, `look-${scene}-${device}-${quality}-f${target}${tag}.png`);
    await page.screenshot({ path });
    console.log(`${errors.length ? '✗' : '✓'} ${path}`);
  }
  const st = await page.evaluate(() => { const w = window.__cloth.world, s = w.stats; return { verts: s.verts, calls: s.drawCalls, tris: s.tris, cam: Array.from(w.camera.pos).map((x) => +x.toFixed(2)) }; });
  console.log('   ', JSON.stringify(st));
  for (const e of errors) console.log('   ', e.slice(0, 1500));
  if (errors.length) bad++;
  await ctx.close();
}
await browser.close();
process.exit(bad ? 1 : 0);
