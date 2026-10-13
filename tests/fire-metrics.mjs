// Fire behaviour, measured (no screenshots): front speeds at two cloth resolutions, the wet stall,
// chainmail as a forge, velvet's smoulder, the tap and the torch.
//   node tests/fire-metrics.mjs [--only speeds,wet,chain,velvet,tilt,tools] [--materials cotton,silk,denim,aurora]
import { launch, open, build, advance } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('--only', 'speeds,wet,chain,velvet,tilt,tools').split(',');
const MATS = arg('--materials', 'cotton,silk,denim,aurora').split(',');
const url = build();
const browser = await launch();
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };

/** Light the embers sheet near the bottom centre (by uv) and record when each vertex first flames. */
async function fronts(material, quality, seconds = 8) {
  const { page, ctx } = await open(browser, url, { device: 'shot', query: `scene=embers&quality=${quality}&wind=0&material=${material}` });
  await advance(page, 20);
  const res = await page.evaluate(([seconds]) => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    // the vertex nearest uv (0.5, 0.8): 80% down the sheet, centred
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.5) ** 2 + (c.uv[i * 2 + 1] - 0.8) ** 2; if (d < best) { best = d; v = i; } }
    const W0 = 1.5, H0 = 1.8; // embers sheet size (m)
    const u0 = c.uv[v * 2], v0 = c.uv[v * 2 + 1];
    F.ignite(W, v, 1);
    const first = new Float32Array(c.n).fill(-1);
    const frames = Math.round(seconds * 60);
    for (let f = 0; f < frames; f++) {
      C.advance(1);
      const st = F._state().state;
      for (let i = 0; i < c.n; i++) if (first[i] < 0 && st[i] === 3) first[i] = (f + 1) / 60;
    }
    // arrival time vs distance along up / side / down lines through the ignition point
    const lines = { up: [], side: [], down: [] };
    const du = 1 / Math.max(2, (Math.sqrt(c.n) | 0));
    for (let i = 0; i < c.n; i++) {
      if (first[i] < 0) continue;
      const x = (c.uv[i * 2] - u0) * W0, y = -(c.uv[i * 2 + 1] - v0) * H0; // y up
      if (Math.abs(x) < 0.04 && y > 0.05) lines.up.push([y, first[i]]);
      if (Math.abs(y) < 0.04 && Math.abs(x) > 0.05) lines.side.push([Math.abs(x), first[i]]);
      if (Math.abs(x) < 0.04 && y < -0.05) lines.down.push([-y, first[i]]);
    }
    const speed = (pts) => {
      // farthest point reached and the time it took (from the first flame of the line)
      if (pts.length < 2) return { reach: pts.length ? pts[0][0] : 0, speed: 0 };
      pts.sort((a, b) => a[0] - b[0]);
      const n = pts.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (const [d, t] of pts) { sx += t; sy += d; sxx += t * t; sxy += t * d; }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
      return { reach: +pts[n - 1][0].toFixed(2), speed: +slope.toFixed(3) };
    };
    return { n: c.n, up: speed(lines.up), side: speed(lines.side), down: speed(lines.down), d: F.debug() };
  }, [seconds]);
  await ctx.close();
  return res;
}

if (only.includes('speeds')) {
  for (const m of MATS) {
    const lo = await fronts(m, 'low', 6), mid = await fronts(m, 'mid', 6);
    console.log(`  ${m.padEnd(7)} low (n ${lo.n}): up ${JSON.stringify(lo.up)} side ${JSON.stringify(lo.side)} down ${JSON.stringify(lo.down)}`);
    console.log(`  ${''.padEnd(7)} mid (n ${mid.n}): up ${JSON.stringify(mid.up)} side ${JSON.stringify(mid.side)} down ${JSON.stringify(mid.down)}`);
    if (lo.up.speed > 0 && mid.up.speed > 0) check(Math.abs(lo.up.speed / mid.up.speed - 1) < 0.35, `${m}: upward front speed agrees across tiers (low ${lo.up.speed} vs mid ${mid.up.speed} m/s)`);
    check(lo.up.speed > 2 * Math.max(lo.side.speed, 0.001) || m === 'aurora', `${m}: climbs faster than it spreads sideways`);
  }
}

if (only.includes('wet')) {
  const { page, ctx } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=low&wind=0' });
  await advance(page, 20);
  const r = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    for (let i = 0; i < c.n; i++) if (c.uv[i * 2] > 0.55) c.wet[i] = 0.7; // right side soaked
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.4) ** 2 + (c.uv[i * 2 + 1] - 0.8) ** 2; if (d < best) { best = d; v = i; } }
    const caught = F.ignite(W, v, 1);
    let w = -1; best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.8) ** 2 + (c.uv[i * 2 + 1] - 0.5) ** 2; if (d < best) { best = d; w = i; } }
    const wetCaught = F.ignite(W, w, 1);
    C.advance(600);
    let wetBurnt = 0, wetN = 0, dryBurnt = 0, dryN = 0;
    for (let i = 0; i < c.n; i++) { if (c.alias[i] >= 0) continue; if (c.uv[i * 2] > 0.6) { wetN++; if (c.fuel[i] < 0.5) wetBurnt++; } else if (c.uv[i * 2] < 0.45) { dryN++; if (c.fuel[i] < 0.5) dryBurnt++; } }
    return { caught, wetCaught, wetBurnt: wetBurnt / wetN, dryBurnt: dryBurnt / dryN, d: F.debug() };
  });
  check(r.caught && !r.wetCaught, `wet: a tap on dry cloth catches (${r.caught}), on soaked cloth it fizzles (${r.wetCaught})`);
  check(r.wetBurnt < 0.05 && r.dryBurnt > 0.3, `wet: the front stalls at the wet line (dry burnt ${(r.dryBurnt * 100).toFixed(0)}%, wet burnt ${(r.wetBurnt * 100).toFixed(0)}%)`);
  // the continuous hiss at the wet line is weather's (it evaporates where heat meets water); fire's own
  // steam is the discrete moments: the fizzle of a tap on soaked cloth, a flame drowned, rain in the flames
  check(r.d.events.steam >= 1, `wet: the soaked tap fizzles with steam (${r.d.events.steam} steam events, ${r.d.spawned[5]} STEAM puffs)`);
  await ctx.close();
}

if (only.includes('chain')) {
  const { page, ctx } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=low&material=chainmail' });
  await advance(page, 20);
  const r = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.5) ** 2 + (c.uv[i * 2 + 1] - 0.6) ** 2; if (d < best) { best = d; v = i; } }
    const out = { caught: F.ignite(W, v, 1) };
    for (let f = 0; f < 150; f++) { F.torch(W, v, 1 / 60); C.advance(1); }   // 2.5 s with the torch held
    out.peak = c.heat[v]; out.light = Array.from(W.lights.fireCol, (x) => +x.toFixed(2));
    let warm = 0; for (let i = 0; i < c.n; i++) if (c.heat[i] > 0.45) warm++;
    out.glowing = warm;
    C.advance(180);                                                            // 3 s after letting go
    out.after3s = c.heat[v];
    C.advance(600);
    out.after13s = c.heat[v];
    let minFuel = 1; for (let i = 0; i < c.n; i++) minFuel = Math.min(minFuel, c.fuel[i]);
    out.minFuel = minFuel; out.links = `${c.constraintsAlive}/${c.m}`; out.burning = W.stats.burning; out.d = F.debug();
    return out;
  });
  check(r.minFuel === 1 && r.burning === 0, `chainmail: never burns (min fuel ${r.minFuel}, burning ${r.burning}, links ${r.links})`);
  check(r.peak > 0.85, `chainmail: the torch makes it yellow-hot (peak heat ${r.peak.toFixed(2)}, ${r.glowing} glowing vertices, light ${r.light})`);
  check(r.after3s > 0.5 && r.after13s < r.after3s, `chainmail: cools slowly (3 s: ${r.after3s.toFixed(2)}, 13 s: ${r.after13s.toFixed(2)})`);
  check(r.d.spawned[1] > 30, `chainmail: forge sparks fly (${r.d.spawned[1]} sparks)`);
  await ctx.close();
}

if (only.includes('velvet')) {
  const { page, ctx } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=low&material=velvet&wind=0' });
  await advance(page, 20);
  const r = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.5) ** 2 + (c.uv[i * 2 + 1] - 0.7) ** 2; if (d < best) { best = d; v = i; } }
    F.ignite(W, v, 1);
    const trace = [];
    for (let s = 0; s < 8; s++) { C.advance(60); const d = F.debug(); let ch = 0; for (let i = 0; i < c.n; i++) if (c.char[i] > 0.7) ch++; trace.push([d.smoulder, d.flaming, ch]); }
    return trace;
  });
  console.log('  velvet [smouldering, flaming, deep-charred] per second:', JSON.stringify(r));
  check(r[0][0] > 0 && r[0][1] === 0, 'velvet: a tap starts a smoulder, not a flame');
  check(r.some((x) => x[1] >= 3) && r[1][1] <= r[1][0], 'velvet: deep char bursts into flame later (smoulder leads, flames follow)');
  await ctx.close();
}

if (only.includes('tilt')) {
  // gravity rotated to point along +x (the phone on its side): "up" is now −x, and the fire runs that way
  const { page, ctx } = await open(browser, url, { device: 'shot', query: 'scene=embers&quality=low&wind=0' });
  await advance(page, 20);
  const r = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
    W.gravity[0] = 9.81; W.gravity[1] = 0; W.gravity[2] = 0;
    let v = -1, best = 1e9;
    for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.5) ** 2 + (c.uv[i * 2 + 1] - 0.5) ** 2; if (d < best) { best = d; v = i; } }
    F.ignite(W, v, 1); C.advance(150);
    // where the burnt and burning cloth lies, in the sheet's own coordinates (u across, v down)
    let su = 0, sv = 0, k = 0;
    for (let i = 0; i < c.n; i++) if (c.char[i] > 0.9) { su += c.uv[i * 2] - c.uv[v * 2]; sv += c.uv[i * 2 + 1] - c.uv[v * 2 + 1]; k++; }
    return { du: su / k, dv: sv / k, k };
  });
  check(r.du < -0.04 && Math.abs(r.dv) < Math.abs(r.du), `tilt: with gravity along +x the fire climbs toward −x (burnt centroid du ${r.du.toFixed(3)}, dv ${r.dv.toFixed(3)}, ${r.k} charred)`);
  await ctx.close();
}

if (only.includes('tools')) {
  for (const m of ['cotton', 'denim', 'silk']) {
    const { page, ctx } = await open(browser, url, { device: 'shot', query: `scene=embers&quality=low&material=${m}&wind=0` });
    await advance(page, 20);
    const t = await page.evaluate(() => {
      const C = window.__cloth, W = C.world, c = W.cloth, F = C.modules.fire;
      let v = -1, best = 1e9;
      for (let i = 0; i < c.n; i++) { const d = (c.uv[i * 2] - 0.5) ** 2 + (c.uv[i * 2 + 1] - 0.5) ** 2; if (d < best) { best = d; v = i; } }
      for (let f = 1; f <= 240; f++) { F.torch(W, v, 1 / 60); C.advance(1); if (W.stats.burning > 0) return f / 60; }
      return -1;
    });
    check(t > 0 && t < (m === 'denim' ? 1.2 : 0.6), `torch on ${m}: catches in ${t.toFixed(2)} s`);
    await ctx.close();
  }
}

await browser.close();
console.log(fails ? `${fails} check(s) failed` : 'all fire checks passed');
process.exit(fails ? 1 : 0);
