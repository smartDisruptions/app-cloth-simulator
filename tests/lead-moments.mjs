// The big moments, on the merged build, one screenshot each (portrait, hint dismissed).
//   node tests/lead-moments.mjs [--only fire,slash,pool,ink,forge,gale,reveal]
import { launch, open, build, advance, clothRect, SEEN, OUT } from './lib.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('--only', 'fire,slash,pool,ink,forge,gale,reveal').split(',');
const url = build();
const browser = await launch();
const shots = [];
async function moment(name, query, fn) {
  if (!only.includes(name)) return;
  const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: `quality=mid&${query}`, init: SEEN });
  await advance(page, 200);
  const r = await clothRect(page);
  await page.evaluate(fn, r);
  await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
  const f = join(OUT, `moment-${name}.png`); await page.screenshot({ path: f, timeout: 120000 }); shots.push(f);
  console.log(`${errors.length ? '✗' : '✓'} ${name}`, errors.slice(0, 2).join(' | ').slice(0, 300));
  await ctx.close();
}
await moment('fire', 'scene=embers', (r) => { const C = window.__cloth; C.api.setTool('burn'); const x = r.cx, y = r.y0 + r.h * 0.85; C.input('down', x, y, 1); C.advance(20); C.input('up', x, y, 1); C.advance(170); });
await moment('slash', 'scene=noren', (r) => { const C = window.__cloth; C.api.setTool('slice'); const y = r.y0 + r.h * 0.55; C.input('down', r.x0 - 20, y - 30, 1); for (let k = 1; k <= 8; k++) { C.input('move', r.x0 - 20 + (r.w + 40) * k / 8, y - 30 + 60 * k / 8, 1); C.advance(1); } C.advance(2); });
await moment('pool', 'scene=monsoon', () => { window.__cloth.advance(720); });
await moment('ink', 'scene=noren&wind=0', (r) => { const C = window.__cloth; C.api.setTool('dye'); const pts = [[0.3, 0.5, 1], [0.55, 0.62, 2], [0.72, 0.45, 1]]; for (const [u, v, c] of pts) { C.api.setDye(c); const x = r.x0 + r.w * u, y = r.y0 + r.h * v; C.input('down', x, y, 1); C.advance(2); C.input('up', x, y, 1); C.advance(40); } C.advance(60); });
await moment('forge', 'scene=embers&material=chainmail', (r) => { const C = window.__cloth; C.api.setTool('burn'); const x = r.cx, y = r.cy; C.input('down', x, y, 1); C.advance(150); C.input('up', x, y, 1); C.advance(20); });
await moment('gale', 'scene=banner&wind=2', () => { window.__cloth.advance(120); });
await moment('reveal', 'scene=unveil', (r) => { const C = window.__cloth; C.advance(60); C.api.setTool('grab'); const x = r.x0 + r.w * 0.15, y = r.y0 + r.h * 0.8; C.input('down', x, y, 1); for (let k = 1; k <= 30; k++) { C.input('move', x - 9 * k, y + 2 * k, 1); C.advance(2); } C.input('up', x - 270, y + 60, 1); C.advance(40); });
await browser.close();
execFileSync('python3', ['-c', `
from PIL import Image
import sys, json
fs = json.loads(sys.argv[1]); ims = [Image.open(f) for f in fs]
w, h = ims[0].size; cols = 4; rows = (len(ims) + cols - 1) // cols
s = Image.new('RGB', (w * cols, h * rows))
for i, im in enumerate(ims): s.paste(im, ((i % cols) * w, (i // cols) * h))
s = s.resize((int(s.width * 0.55), int(s.height * 0.55))); s.save(sys.argv[2])`, JSON.stringify(shots), join(OUT, 'moments.png')]);
console.log('✓ tests/out/moments.png');
