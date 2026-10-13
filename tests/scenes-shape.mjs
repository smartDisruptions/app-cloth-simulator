// Print the cloth's settled shape (height profiles across the first grid piece), to check designed sags and
// drapes numerically. Owned by the scenes agent.   node tests/scenes-shape.mjs [scene] [frames] [quality]
import { launch, open, build, advance, DEVICES } from './lib.mjs';

DEVICES.tiny = { viewport: { width: 160, height: 160 }, deviceScaleFactor: 1, touch: false };
const scene = process.argv[2] || 'monsoon', frames = Number(process.argv[3] || 150), quality = process.argv[4] || 'mid';
const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device: 'tiny', query: `scene=${scene}&quality=${quality}` });
for (let f = 0; f < frames; f += 15) await advance(page, Math.min(15, frames - f));
const out = await page.evaluate(() => {
  const cl = window.__cloth.world.cloth, p = cl.pieces[0], P = cl.pos;
  const at = (c, r) => { const i = p.id(c, r) * 3; return [P[i], P[i + 1], P[i + 2]].map((x) => +x.toFixed(3)); };
  const rows = [], C = p.cols, R = p.rows;
  for (const fr of [0, 0.25, 0.5, 0.75, 1]) {
    const r = Math.round(fr * (R - 1)), line = [];
    for (const fc of [0, 0.25, 0.5, 0.75, 1]) line.push(at(Math.round(fc * (C - 1)), r)[1]);
    rows.push(`row ${fr.toFixed(2)}: y = ${line.join('  ')}`);
  }
  let lo = 1e9, li = -1; for (let i = 0; i < cl.n; i++) if (P[i * 3 + 1] < lo) { lo = P[i * 3 + 1]; li = i; }
  return { piece: p.name, cols: C, rows: R, profile: rows, lowest: [P[li * 3], lo, P[li * 3 + 2]].map((x) => +x.toFixed(3)), b: [Array.from(cl.bounds.min).map((x) => +x.toFixed(2)), Array.from(cl.bounds.max).map((x) => +x.toFixed(2))] };
});
console.log(JSON.stringify(out, null, 1));
for (const e of errors) console.log('   ', e.slice(0, 800));
await browser.close();
