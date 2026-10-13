// QA contact sheet: every scene, portrait and landscape, after the opening settles (hint dismissed).
//   node tests/lead-qa.mjs [--quality mid] [--frames 300] [--scenes a,b] [--q extra] [--do "burn:0.5,0.8"] [--out qa]
import { launch, open, build, advance, drag, clothRect, SEEN, OUT } from './lib.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const quality = arg('--quality', 'mid'), frames = Number(arg('--frames', '300')), extra = arg('--q', ''), out = arg('--out', 'qa');
const SCENES = arg('--scenes', 'noren,koinobori,banner,unveil,embers,monsoon').split(',');
const action = arg('--do', '');
const url = build();
const browser = await launch();
const files = { p: [], l: [] };
for (const [dev, key] of [['shot', 'p'], ['shot-wide', 'l']]) for (const scene of SCENES) {
  const { page, ctx, errors } = await open(browser, url, { device: dev, query: `scene=${scene}&quality=${quality}${extra ? '&' + extra : ''}`, init: SEEN });
  await advance(page, Math.floor(frames / 2));
  if (action) {
    const r = await clothRect(page); const [name, rest] = action.split(':'); const v = rest.split(',').map(Number);
    await drag(page, [[r.x0 + r.w * v[0], r.y0 + r.h * v[1]]], { tool: name, framesPerStep: 3 });
  }
  await advance(page, Math.ceil(frames / 2));
  const f = join(OUT, `${out}-${key}-${scene}.png`); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); await page.screenshot({ path: f, timeout: 120000 }); files[key].push(f);
  if (errors.length) console.log(`✗ ${scene} ${dev}:`, errors.slice(0, 3).join(' | ').slice(0, 300));
  await ctx.close();
}
await browser.close();
// two contact sheets (python/PIL is in the container)
const py = `
from PIL import Image
import sys, json
for key, cols in (('p', 3), ('l', 2)):
    fs = json.loads(sys.argv[1])[key]
    if not fs: continue
    ims = [Image.open(f) for f in fs]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (w * cols, h * rows))
    for i, im in enumerate(ims): sheet.paste(im, ((i % cols) * w, (i // cols) * h))
    s = 0.62 if key == 'p' else 0.5
    sheet = sheet.resize((int(sheet.width * s), int(sheet.height * s)))
    sheet.save(sys.argv[2] + '-' + key + '.png')
`;
execFileSync('python3', ['-c', py, JSON.stringify(files), join(OUT, out)]);
console.log(`✓ ${join(OUT, out)}-p.png and -l.png`);
