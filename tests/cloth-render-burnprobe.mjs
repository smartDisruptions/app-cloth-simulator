// Probe the burn eat-in: paint a burn (as tests/cloth-render-sheet.mjs burnfield does), then print, for the
// hole's boundary vertices, their fuel, char, torn-edge factor and the fuel byte the renderer packed.
//   node tests/cloth-render-burnprobe.mjs
import { launch, open, build, advance } from './lib.mjs';

const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=mid&nogov=1' });
await advance(page, 30);
const out = await page.evaluate(() => {
  const C = window.__cloth, W = C.world, c = W.cloth, ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  W.paused = true;
  const cu = 0.5, cv = 0.55, r = 0.14;
  for (let i = 0; i < c.n; i++) {
    const d = Math.hypot(c.uv[i * 2] - cu, c.uv[i * 2 + 1] - cv) / r;
    c.fuel[i] = Math.min(c.fuel[i], ss(0.45, 1.0, d)); c.char[i] = Math.max(c.char[i], 1 - ss(0.75, 1.7, d)); c.heat[i] = (1 - ss(0.6, 1.25, d)) * 0.85;
  }
  const vt0 = Uint16Array.from(c.vTri);
  for (let i = 0; i < c.n; i++) if (c.fuel[i] <= 0.02) C.modules.sim.killVertex(W, i);
  C.advance(2);
  const dbg = C.modules.clothR.debug(), fx = dbg.fx, rows = [];
  for (let i = 0; i < c.n && rows.length < 14; i++) {
    if (c.vTri[i] > 0 && c.vTri[i] < vt0[i]) rows.push(`v${i} vTri ${c.vTri[i]}/${vt0[i]} fuel ${c.fuel[i].toFixed(2)} char ${c.char[i].toFixed(2)} edge ${dbg.edge[i].toFixed(2)} -> fx fuel ${(fx[i * 8 + 1] / 255).toFixed(2)} edgeByte ${(fx[i * 8 + 5] / 255).toFixed(2)}`);
  }
  return rows.join('\n');
});
console.log(out);
for (const e of errors) console.log('   ', e.slice(0, 600));
await browser.close();
