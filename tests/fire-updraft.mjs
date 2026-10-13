// fire.updraft(): the plume as a velocity field (the CONTRACT REQUEST for wind.sample), measured.
//   node tests/fire-updraft.mjs
// Probes the field above a burning silk sheet, then compares how far the cloth above the fire rises
// with wind.sample chained through updraft (a test-only wrapper; weather owns wind.js) and without.
import { launch, open, build, advance } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'monsoon'), at = arg('--uv', '0.5,0.5').split(',').map(Number), settle = Number(arg('--settle', '150'));
const above = Number(arg('--above', '-0.05')); // band: cloth within 35 cm horizontally and higher than flame + this
const url = build();
const browser = await launch();
async function run(withUpdraft) {
  const { page, ctx } = await open(browser, url, { device: 'shot', query: `scene=${scene}&quality=low&material=silk&wind=0&rain=0` });
  await advance(page, settle);
  const r = await page.evaluate(([withUpdraft, at, above]) => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    const base = W.wind.sample;
    let calls = 0;
    if (withUpdraft) W.wind.sample = function (x, y, z, out) { calls++; base.call(this, x, y, z, out); return F.updraft(x, y, z, out); };
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - at[0]) ** 2 + (c.uv[i * 2 + 1] - at[1]) ** 2; if (d < best) { best = d; v = i; } }
    F.ignite(W, v, 1);
    // the cloth above the fire (within 35 cm horizontally, higher than the flame): its mean rise over 1.5 s
    const band = [], p = c.pos, vx = p[v * 3], vy = p[v * 3 + 1], vz = p[v * 3 + 2];
    for (let i = 0; i < c.n; i++) { const dx = p[i * 3] - vx, dz = p[i * 3 + 2] - vz; if (dx * dx + dz * dz < 0.35 * 0.35 && p[i * 3 + 1] > vy + above) band.push(i); }
    let lift = 0, maxLift = 0;
    const y0 = band.map((i) => c.pos[i * 3 + 1]);
    for (let f = 0; f < 90; f++) {
      C.advance(1);
      let m = 0; for (let k = 0; k < band.length; k++) m += c.pos[band[k] * 3 + 1] - y0[k];
      m /= band.length; lift += m / 90; if (m > maxLift) maxLift = m;
    }
    const L = W.lights, out = new Float32Array(3), probe = [];
    for (const h of [-0.1, 0, 0.15, 0.4, 0.8]) { out.fill(0); F.updraft(L.firePos[0], L.firePos[1] - 0.15 + h, L.firePos[2] - 0.13, out); probe.push(`${h}m:${out[1].toFixed(2)}`); }
    return { calls, probe: probe.join(' '), lift: +lift.toFixed(3), maxLift: +maxLift.toFixed(3), band: band.length };
  }, [withUpdraft, at, above]);
  await ctx.close();
  return r;
}
const a = await run(false), b = await run(true);
console.log('without:', JSON.stringify(a));
console.log('with   :', JSON.stringify(b));
// the field: up the column above the flames, weaker below and higher up (probe is "height:vy m/s")
const vy = Object.fromEntries(b.probe.split(' ').map((s) => s.replace('m', '').split(':').map(Number)));
// (since integration wind.sample includes updraft itself, and the probe origin follows the fire LIGHT, which
// now stands 0.3 m off the cloth: so just check the column is strong near the flames and fades with height)
const ok = vy['0.15'] > 0.5 && vy['0.8'] < vy['0.15'];
console.log(`${ok ? '✓' : '✗'} plume field: ${b.probe}`);
console.log(`  cloth over the fire rises ${a.maxLift} → ${b.maxLift} m with the plume in wind.sample (baseline aero; informational)`);
await browser.close();
process.exit(ok ? 0 : 1);
