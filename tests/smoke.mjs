// Boots every scene, runs it with each tool, and fails on any console error. Screenshots land in
// tests/out/smoke-<scene>.png.     node tests/smoke.mjs [--scenes noren,embers] [--quality low]
import { launch, open, build, advance, drag, clothRect, summarize, OUT } from './lib.mjs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SCENES = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const quality = arg('--quality', 'mid');

const url = build();
const browser = await launch();
let failed = 0;
for (const scene of SCENES) {
  const { page, errors, ctx } = await open(browser, url, { device: 'shot', query: `scene=${scene}&quality=${quality}` });
  const t = [];
  t.push(...await advance(page, 60));
  const r = await clothRect(page);
  await drag(page, [[r.cx, r.cy], [r.cx + 40, r.cy + 30], [r.cx + 90, r.cy + 60]], { tool: 'grab' });
  await drag(page, [[r.x0 + r.w * 0.2, r.cy - 20], [r.x0 + r.w * 0.5, r.cy], [r.x0 + r.w * 0.8, r.cy + 20]], { tool: 'slice', framesPerStep: 1 });
  await drag(page, [[r.cx, r.y0 + r.h * 0.8], [r.cx + 2, r.y0 + r.h * 0.8]], { tool: 'burn', framesPerStep: 10 });
  await drag(page, [[r.cx - 30, r.cy + 30]], { tool: 'pin' });
  await drag(page, [[r.cx + 30, r.cy - 30]], { tool: 'dye' });
  await page.evaluate(() => { window.__cloth.api.setToggle('rain', true); window.__cloth.api.setMaterial('chainmail'); window.__cloth.api.setMaterial('silk'); });
  t.push(...await advance(page, 90));
  const stats = await page.evaluate(() => { const s = window.__cloth.world.stats; return { burning: s.burning, particles: s.particles, links: `${s.constraintsAlive}/${s.constraints}`, verts: s.verts, calls: s.drawCalls }; });
  await page.screenshot({ path: join(OUT, `smoke-${scene}.png`) });
  const nan = await page.evaluate(() => { const p = window.__cloth.world.cloth.pos; for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return true; return false; });
  if (nan) errors.push('[sim] non-finite cloth positions');
  console.log(`${errors.length ? '✗' : '✓'} ${scene.padEnd(10)} js/frame ${JSON.stringify(summarize(t))}  ${JSON.stringify(stats)}`);
  for (const e of errors) console.log('   ', e.slice(0, 600));
  if (errors.length) failed++;
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
