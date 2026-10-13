// What Tilt looks like: each scene with the phone held upright, then laid flat on a table (synthetic
// DeviceOrientationEvents). Upright, the cloth should hang straight down; flat, it swings away into the scene.
//   node tests/lead-tilt.mjs [--scenes noren,banner]  → tests/out/tilt-<scene>.png (upright | flat)
import { build, launch, advance, OUT } from './lib.mjs';
import { openUI, tapEl } from './ui-lib.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCENES = arg('--scenes', 'noren,banner').split(',');
const SEEN = () => { try { localStorage.setItem('cloth-sim:ui:v1', JSON.stringify({ seen: 1, compact: 0, taught: { tilt: 1 } })); } catch (e) {} };
const url = build();
const browser = await launch();
for (const scene of SCENES) {
  const { page, ctx, errors } = await openUI(browser, url, { device: 'ui-p', query: `scene=${scene}&quality=mid&wind=0`, init: SEEN });
  await advance(page, 60);
  await tapEl(page, '.tg[data-t="tilt"]', 1);
  const fire = (b, g) => page.evaluate(([b, g]) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g })), [b, g]);
  const shots = [];
  for (const [label, b] of [['upright', 90], ['flat', 0]]) {
    await fire(b, 0); await advance(page, 300);
    const g = await page.evaluate(() => [...window.__cloth.world.gravity].map((v) => +v.toFixed(2)));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const f = join(OUT, `tilt-${scene}-${label}.png`);
    await page.screenshot({ path: f, timeout: 120000 });
    shots.push(f);
    console.log(`${scene} ${label.padEnd(8)} gravity ${JSON.stringify(g)}`);
  }
  try { execFileSync('convert', [...shots, '+append', join(OUT, `tilt-${scene}.png`)]); } catch (e) { console.log('   (no ImageMagick: separate shots kept)'); }
  for (const e of errors) console.log('   ', e.slice(0, 300));
  await ctx.close();
}
await browser.close();
