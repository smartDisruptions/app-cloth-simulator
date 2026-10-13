// The prints (and the carp variants) painted flat, with their masks, into one sheet, each at a scene's real
// cloth size (aspect = metres per u ÷ metres per v, mV = metres per v; the integration scenes' sizes) and at
// the texel shape render/cloth.js would pick, so what you see is what lands on the cloth.
//   node tests/cloth-render-prints.mjs [--size 1024] [--out cr-prints.png] [--only noren,banner]
import { launch, open, build, OUT } from './lib.mjs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const size = Number(arg('--size', '1024')), out = join(OUT, arg('--out', 'cr-prints.png'));
// four carp tubes stacked in v (scenes/koinobori.js): magoi, higoi, kogoi tapering to the tail, then the streamer
const KOI = [0.188, 0.18, 0.15, 0.11, 0.19, 0.18, 0.15, 0.11, 0.19, 0.18, 0.15, 0.11, 0.15, 0.14, 0.13, 0.12];
// [id, aspect, mV, profile]
const ALL = [['noren', 1.35, 1.24], ['koinobori', 0.16, 8.2, KOI], ['koinobori-single', 0.62, 2.4], ['koinobori-family', 1.9, 2.4], ['banner', 0.245, 2.5], ['unveil', 1, 2.3], ['embers', 0.84, 1.85], ['monsoon', 1.36, 1.6]];
const only = arg('--only', '');
const LIST = only ? ALL.filter((p) => only.split(',').includes(p[0])) : ALL;
const pow2 = (x) => 2 ** Math.round(Math.log2(Math.max(1, x)));
const dims = (a) => { const ar = Math.sqrt(a); let w = Math.max(size / 4, pow2(size * ar)), h = Math.max(size / 4, pow2(size / ar)); while (w * h > size * size * 1.5) { if (w > h) w /= 2; else h /= 2; } return [w, h]; };

const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device: 'shot', query: 'quality=low&nogov=1' });
const imgs = await page.evaluate((list) => list.map(([id, a, mV, prof, w, h]) => ({ id, a, mV, w, h, ...window.__cloth.modules.clothR.printPreview(id, w, h, a, mV, prof || null) })), LIST.map((p) => [...p.slice(0, 3), p[3] || null, ...dims(p[1])]));
const H = 420;
const cells = imgs.map((p) => {
  const wd = Math.max(40, Math.round(H * Math.min(2.4, p.a)));
  const mask = p.maskMode[0] || p.maskMode[1] ? `<img src="${p.mask}" style="width:${Math.round(wd / 3)}px;height:${Math.round(H / 3)}px;display:block;border:1px solid #444">` : '';
  return `<div style="margin:6px"><img src="${p.print}" style="width:${wd}px;height:${H}px;display:block"><div style="width:${Math.max(wd, 160)}px">${p.id} · ${p.w}×${p.h}<br>aspect ${p.a} · ${p.mV} m${p.maskMode[0] ? ' · damask' : p.maskMode[1] ? ' · gold' : ''}</div>${mask}</div>`;
}).join('');
const sheet = await page.context().newPage();
await sheet.setViewportSize({ width: 1500, height: 500 });
await sheet.setContent(`<body style="margin:0;background:#222;color:#ddd;font:12px monospace;display:flex;flex-wrap:wrap;align-items:flex-start;width:1500px">${cells}</body>`);
await sheet.screenshot({ path: out, fullPage: true });
console.log(`${errors.length ? '✗' : '✓'} ${out}`);
for (const e of errors) console.log('   ', e.slice(0, 800));
await browser.close();
process.exit(errors.length ? 1 : 0);
