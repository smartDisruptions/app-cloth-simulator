// Screenshot one state.
//   node tests/shot.mjs --q "scene=embers&material=silk" --frames 120 --device shot --out embers.png
//   [--do "burn:0.5,0.8"] actions after the first half of the frames, comma-free list separated by ';':
//     grab:x,y,dx,dy   slice:x0,y0,x1,y1   burn:x,y   pin:x,y   dye:x,y   rain:1   wind:2   material:silk
//   coordinates are fractions of the cloth's on-screen box (0..1).
import { launch, open, build, advance, drag, clothRect, OUT } from './lib.mjs';
import { join, isAbsolute } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const q = arg('--q', ''), frames = Number(arg('--frames', '90')), device = arg('--device', 'shot');
const out = arg('--out', 'shot.png'), path = isAbsolute(out) ? out : join(OUT, out);
const actions = (arg('--do', '') || '').split(';').filter(Boolean);

const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device, query: q });
await advance(page, Math.ceil(frames / 2));
const r = await clothRect(page);
const X = (f) => r.x0 + r.w * f, Y = (f) => r.y0 + r.h * f;
for (const a of actions) {
  const [name, rest = ''] = a.split(':'); const v = rest.split(',').map(Number);
  if (name === 'grab') await drag(page, [[X(v[0]), Y(v[1])], [X(v[0]) + v[2] / 2, Y(v[1]) + v[3] / 2], [X(v[0]) + v[2], Y(v[1]) + v[3]]], { tool: 'grab', framesPerStep: 4 });
  else if (name === 'slice') await drag(page, [[X(v[0]), Y(v[1])], [(X(v[0]) + X(v[2])) / 2, (Y(v[1]) + Y(v[3])) / 2], [X(v[2]), Y(v[3])]], { tool: 'slice', framesPerStep: 1 });
  else if (['burn', 'pin', 'dye'].includes(name)) await drag(page, [[X(v[0]), Y(v[1])]], { tool: name, framesPerStep: 3 });
  else if (name === 'rain') await page.evaluate((v) => window.__cloth.api.setToggle('rain', !!v), v[0]);
  else if (name === 'wind') await page.evaluate((v) => window.__cloth.api.setToggle('wind', v), v[0]);
  else if (name === 'material') await page.evaluate((m) => window.__cloth.api.setMaterial(m), rest);
}
await advance(page, Math.floor(frames / 2));
await page.screenshot({ path });
console.log(`${errors.length ? '✗' : '✓'} ${path}`);
for (const e of errors) console.log('   ', e.slice(0, 600));
await browser.close();
process.exit(errors.length ? 1 : 0);
