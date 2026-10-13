// In-browser cost of the particles-post area under CPU throttling (owner: particles-post): real WebGL
// bindings, a phone viewport, the low tier, the pool held near its cap by a stress mix (fire, rain, a slash).
//   node tests/particles-perf.mjs [--throttle 4] [--quality low] [--scene embers] [--frames 150]
// Method: the Chrome CPU profiler samples normal throttled frames; a sample counts when any code from
// render/particles.js, render/post.js or render/fx-*.js is on the stack (so the WebGL calls they make are
// included), split into update (simulation) and draw (packing + both passes + bloom + composite).
// The page clock is too coarse (0.1 ms) to time single calls, and back-to-back draws make SwiftShader
// stall the JS thread, so sampling real frames is the honest measure. SwiftShader rasterises on the same
// (shared) CPU, and when it falls behind, random GL calls block: --small (default on) shrinks the canvas
// so the raster work, and that noise, mostly goes away (the JS submission cost doesn't depend on it).
// Contract budgets at 4×, low: particles update ≤ 0.6 ms · draw submission ≤ 0.5 ms.
import { launch, open, build, advance, throttle } from './lib.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const rate = Number(arg('--throttle', '4')), quality = arg('--quality', 'low'), scene = arg('--scene', 'embers'), FR = Number(arg('--frames', '150'));
const url = build(); // unminified, so the bundle keeps esbuild's "// src/..." section markers
// line ranges of my modules inside the bundle (1-based lines of the html file)
const lines = readFileSync(fileURLToPath(url), 'utf8').split('\n');
const mine = [];
let cur = null;
lines.forEach((l, i) => {
  const m = /^\s*\/\/ src\/(.+\.js)\s*$/.exec(l);
  if (!m) return;
  if (cur) { cur.end = i; cur = null; }
  if (/^render\/(particles|post|fx-[a-z]+)\.js$/.test(m[1])) { cur = { file: m[1], start: i + 1, end: lines.length }; mine.push(cur); }
});
const isMine = (line) => mine.some((r) => line >= r.start && line <= r.end);
const fileOf = (line) => (mine.find((r) => line >= r.start && line <= r.end) || {}).file;

const browser = await launch();
const { page, errors, ctx } = await open(browser, url, { device: 'phone', query: `scene=${scene}&quality=${quality}&nogov=1` });
page.setDefaultTimeout(900000);
if (!process.argv.includes('--full')) await page.setViewportSize({ width: 120, height: 240 });
await advance(page, 20);
await page.evaluate(() => {
  const C = window.__cloth, W = C.world, P = C.modules.particles, cl = W.cloth;
  let s = 99; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  window.__feed = (f) => {
    for (let k = 0; k < 14; k++) { const v = (r() * cl.n) | 0; P.spawn(W, 0, cl.pos[v * 3], cl.pos[v * 3 + 1], cl.pos[v * 3 + 2] + 0.01, 0, 0.4, 0, 0.05 + 0.05 * r(), 0.4 + 0.4 * r()); }
    if (f % 2) P.spawn(W, 2, 0, 1.2, 0.02, (r() - 0.5) * 0.4, 0.6, 0, 0.011, 2);
    if (f % 3 === 0) P.spawn(W, 4, 0, 1.4, 0, 0, 0.3, 0, 0.12, 2.5);
    if (f % 3 === 1) P.spawn(W, 1, 0, 1, 0.02, (r() - 0.5) * 2, 2 + r(), 0.5, 0.006, 1);
    for (let k = 0; k < 9; k++) P.spawn(W, 6, (r() - 0.5) * 2.5, 3 + r(), (r() - 0.5) * 1.5, 0.4, -9.5, 0, 0.012, 2, 0);
    C.api.trail(40 + (f % 50) * 6, 300 + (f % 50) * 3, 46 + (f % 50) * 6, 303 + (f % 50) * 3);
  };
  for (let f = 0; f < 240; f++) { window.__feed(f); C.advance(1); }
});
const cdp = await throttle(page, rate);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
await cdp.send('Profiler.start');
const pool = await page.evaluate((FR) => {
  const C = window.__cloth, W = C.world, P = C.modules.particles;
  let sum = 0; for (let f = 0; f < FR; f++) { window.__feed(f); C.advance(1); sum += P.count(); }
  return { mean: Math.round(sum / FR), cap: P.capacity(W) };
}, FR);
const { profile } = await cdp.send('Profiler.stop');

// attribute samples: walk each sample's stack; split by the outermost frame of mine (update vs draw paths)
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
let tUpdate = 0, tDraw = 0, tAll = 0;
const perFile = {}, selfTop = {};
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i] / 1000; // ms
  tAll += dt;
  const leaf = byId.get(profile.samples[i]).callFrame;
  let id = profile.samples[i], outer = null;
  while (id != null) {
    const cf = byId.get(id).callFrame;
    if (cf.url && cf.url.startsWith('file:') && isMine(cf.lineNumber + 1)) outer = cf;
    id = parent.get(id);
  }
  if (!outer) continue;
  const f = fileOf(outer.lineNumber + 1);
  perFile[f] = (perFile[f] || 0) + dt;
  const lk = `${leaf.functionName || '(anon)'}${leaf.url ? '' : ' [native]'}`;
  selfTop[lk] = (selfTop[lk] || 0) + dt;
  if (outer.functionName.startsWith('update') || outer.functionName.startsWith('spawn') || outer.functionName.startsWith('trail')) tUpdate += dt; else tDraw += dt;
}
console.log('where the particles-post time goes (self, ms/frame):', Object.entries(selfTop).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, t]) => `${k} ${(t / FR).toFixed(3)}`).join(' · '));
const per = (t) => (t / FR).toFixed(3);
console.log(`throttle ${rate}× · ${quality} · ${scene} · pool ≈ ${pool.mean}/${pool.cap} · ${FR} frames · whole frame ${per(tAll)} ms`);
console.log(`particles-post, simulation (update, spawn, trail)        ${per(tUpdate)} ms/frame   (budget 0.6)`);
console.log(`particles-post, draw submission (both passes, bloom, grade) ${per(tDraw)} ms/frame   (budget 0.5)`);
console.log('by file:', Object.entries(perFile).map(([f, t]) => `${f} ${per(t)}`).join(' · '));
for (const e of errors) console.log('   ', e.slice(0, 400));
await ctx.close(); await browser.close();
