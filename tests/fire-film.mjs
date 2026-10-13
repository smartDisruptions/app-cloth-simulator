// A burn, filmed: light the cloth, then capture frames at several moments into one contact sheet.
//   node tests/fire-film.mjs --q "scene=embers&quality=low" --at 0.5,0.85 --shots 20,60,120,240,400,600 --out film-embers.png
//   [--torch 0.5]      hold the burn tool for this many seconds (after the tap) instead of a tap only
//   [--setup "rain:1;wind:2;material:silk;wet:0.55,1,0.7;advance:120"]  steps before lighting:
//                      wet:x0,x1,amount paints cloth.wet over a band of the cloth box's width (test-only,
//                      weather owns wet) · advance:N runs N frames (let a drape settle) · noparticles (judge
//                      the cloth alone) · nolight (fireCol held at 0) · updraft (wind.sample chained through
//                      fire.updraft: a preview of the CONTRACT REQUEST)
//   [--device shot]    [--cols 3]
// Prints the fire's numbers at every shot. Frames are 1/60 s; shots are frame counts after the tap.
import { launch, open, build, advance, clothRect, OUT } from './lib.mjs';
import { join, isAbsolute } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const q = arg('--q', 'scene=embers&quality=low');
const at = arg('--at', '0.5,0.85').split(',').map(Number);
const shots = arg('--shots', '20,60,120,240,400,600').split(',').map(Number);
const torchS = Number(arg('--torch', '0'));
const setup = (arg('--setup', '') || '').split(';').filter(Boolean);
const device = arg('--device', 'shot');
const cols = Number(arg('--cols', '3'));
const out = arg('--out', 'film.png'), path = isAbsolute(out) ? out : join(OUT, out);

const url = build();
const browser = await launch();
const { page, errors, ctx } = await open(browser, url, { device, query: q });
await advance(page, 40);
for (const a of setup) {
  const [name, rest = ''] = a.split(':');
  if (name === 'rain') await page.evaluate((v) => window.__cloth.api.setToggle('rain', v === '1'), rest);
  else if (name === 'wind') await page.evaluate((v) => window.__cloth.api.setToggle('wind', Number(v)), rest);
  else if (name === 'material') await page.evaluate((m) => window.__cloth.api.setMaterial(m), rest);
  else if (name === 'wet') await page.evaluate((v) => {
    const [x0, x1, amt] = v.split(',').map(Number), W = window.__cloth.world, c = W.cloth, s = W.screen;
    let lo = 1e9, hi = -1e9; for (let i = 0; i < c.n; i++) { lo = Math.min(lo, s[i * 3]); hi = Math.max(hi, s[i * 3]); }
    for (let i = 0; i < c.n; i++) { const f = (s[i * 3] - lo) / (hi - lo); if (f >= x0 && f <= x1) c.wet[i] = amt; }
  }, rest);
  else if (name === 'advance') await advance(page, Number(rest));
  else if (name === 'noparticles') await page.evaluate(() => { window.__cloth.world.q.particleScale = 0; });
  else if (name === 'nolight') await page.evaluate(() => { window.__cloth.modules.fire.debugFlags.noLight = true; });
  else if (name === 'updraft') await page.evaluate(() => {
    // preview of the CONTRACT REQUEST: wind.sample adds the fire's plume (weather owns wind.js)
    const W = window.__cloth.world, F = window.__cloth.modules.fire, base = W.wind.sample;
    W.wind.sample = function (x, y, z, out) { base.call(this, x, y, z, out); return F.updraft(x, y, z, out); };
  });
}
const r = await clothRect(page);
const X = r.x0 + r.w * at[0], Y = r.y0 + r.h * at[1];
await page.evaluate(([x, y, hold]) => {
  const C = window.__cloth; C.api.setTool('burn');
  C.input('down', x, y, 7);
  if (!hold) { C.advance(1); C.input('up', x, y, 7); }
}, [X, Y, torchS]);
let frame = torchS ? 0 : 1, released = !torchS;
const imgs = [], rows = [];
const fireMs = [];
for (const s of shots) {
  while (frame < s) {
    const step = Math.min(10, s - frame);
    if (!released && frame + step >= torchS * 60) {
      const k = Math.max(0, Math.round(torchS * 60) - frame);
      if (k) await advance(page, k);
      frame += k;
      await page.evaluate(([x, y]) => { window.__cloth.input('up', x, y, 7); }, [X, Y]);
      released = true; continue;
    }
    await advance(page, step);
    fireMs.push(await page.evaluate(() => window.__cloth.world.stats.ms.fire));
    frame += step;
  }
  const st = await page.evaluate(() => { const W = window.__cloth.world, s = W.stats, d = window.__cloth.modules.fire.debug ? window.__cloth.modules.fire.debug() : {}, L = W.lights;
    return { t: +(W.time).toFixed(2), burning: s.burning, charred: +s.charred.toFixed(3), particles: s.particles, links: s.constraintsAlive, active: d.active, flameArea: d.flameArea && +d.flameArea.toFixed(4), light: Array.from(L.fireCol, (v) => v.toFixed(2)).join('/'), fireMs: +s.ms.fire.toFixed(3) }; });
  rows.push(st);
  console.log(`  f${String(s).padStart(4)} ${JSON.stringify(st)}`);
  imgs.push((await page.screenshot()).toString('base64'));
}
await ctx.close();
// contact sheet
const sheet = await browser.newPage({ viewport: { width: 400, height: 400 } });
const vw = DEVICE_W(device), vh = DEVICE_H(device), scale = 0.5;
const W = Math.ceil(vw * scale), H = Math.ceil(vh * scale), R = Math.ceil(imgs.length / cols);
await sheet.setViewportSize({ width: W * cols, height: H * R });
await sheet.setContent(`<body style="margin:0;background:#000"><canvas id="c" width="${W * cols}" height="${H * R}"></canvas></body>`);
await sheet.evaluate(async ([imgs, labels, W, H, cols]) => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  for (let i = 0; i < imgs.length; i++) {
    const im = new Image(); im.src = 'data:image/png;base64,' + imgs[i]; await im.decode();
    const x = (i % cols) * W, y = Math.floor(i / cols) * H;
    g.drawImage(im, x, y, W, H);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y + H - 16, W, 16);
    g.fillStyle = '#fff'; g.font = '11px monospace'; g.fillText(labels[i], x + 4, y + H - 4);
    g.strokeStyle = '#333'; g.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);
  }
}, [imgs, rows.map((r) => `t=${r.t}s burn ${r.burning} charred ${r.charred}`), W, H, cols]);
await sheet.screenshot({ path });
const sorted = [...fireMs].sort((a, b) => a - b);
console.log(`${errors.length ? '✗' : '✓'} ${path}   fire ms (sampled) p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(3)} max ${sorted[sorted.length - 1]?.toFixed(3)}`);
for (const e of errors) console.log('   ', e.slice(0, 600));
await browser.close();
process.exit(errors.length ? 1 : 0);

function DEVICE_W(d) { return { shot: 390, 'shot-wide': 800, phone: 360 }[d] || 390; }
function DEVICE_H(d) { return { shot: 700, 'shot-wide': 450, phone: 740 }[d] || 700; }
