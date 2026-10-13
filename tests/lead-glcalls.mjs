// How many WebGL calls a frame makes, by method (wraps the context in the page).
//   node tests/lead-glcalls.mjs [--scene noren] [--quality low]
import { launch, open, build, advance } from './lib.mjs';
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'noren'), quality = arg('--quality', 'low');
const url = build();
const browser = await launch();
const { page, ctx } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}&nogov=1` });
await advance(page, 60);
const r = await page.evaluate(() => {
  const gl = window.__cloth.world.gl, counts = {}, proto = Object.getPrototypeOf(gl);
  for (const k of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (!d || typeof d.value !== 'function' || k === 'constructor') continue;
    const f = gl[k].bind(gl); gl[k] = (...a) => { counts[k] = (counts[k] || 0) + 1; return f(...a); };
  }
  window.__cloth.advance(30);
  const rows = Object.entries(counts).map(([k, v]) => [k, v / 30]).sort((a, b) => b[1] - a[1]);
  return { total: rows.reduce((s, r) => s + r[1], 0), rows: rows.slice(0, 22) };
});
console.log(`${scene} · ${quality}: ${r.total.toFixed(0)} GL calls/frame`);
for (const [k, v] of r.rows) console.log(`${v.toFixed(1).padStart(7)}  ${k}`);
await ctx.close(); await browser.close();
