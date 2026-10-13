// Every sound the engine makes, rendered offline through the real graph (engine + director + master chain)
// and measured: peak, loudness, length, attack, spectral centre, band balance. Fails on clipping (> −1 dBFS),
// NaNs, sound while muted, a silent sound, or two sounds that are too alike (same envelope and same spectrum).
//   node tests/audio-sounds.mjs [--only tear:cotton,slice] [--wav]   (--wav writes each to tests/out/audio-<name>.wav)
import { join } from 'node:path';
import { OUT } from './lib.mjs';
import { launch, audioPage, writeWav } from './audio-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const wav = process.argv.includes('--wav');
const browser = await launch();
const { page, errors } = await audioPage(browser);
const names = arg('--only', '') ? arg('--only', '').split(',') : await page.evaluate(() => Object.keys(window.AUDIO.SCENARIOS));

const rows = [];
let failed = 0;
const fail = (name, why) => { failed++; console.log(`   ✗ ${name}: ${why}`); };
for (const name of names) {
  const r = await page.evaluate(([n, pcm]) => window.AUDIO.renderScenario(n, { pcm }), [name, wav]);
  if (r.pcm) { writeWav(join(OUT, `audio-${name.replace(/[:]/g, '-')}.wav`), r.pcm); delete r.pcm; }
  rows.push(r);
  const b = r.bands.map((x) => Math.round(x * 100)).join('/');
  console.log(`${name.padEnd(20)} peak ${String(r.peakDb).padStart(7)} dBFS  rms ${String(r.rmsDb).padStart(7)}  dur ${String(r.durS).padStart(5)}s  atk ${String(r.attackS).padStart(4)}s  centre ${String(r.centroidHz).padStart(5)} Hz  roll ${String(r.rolloffHz).padStart(5)}  bands% ${b.padEnd(12)} L-R ${r.balanceDb}  corr ${r.corr}  voices ${r.maxVoices}`);
  if (r.nan) fail(name, `${r.nan} non-finite samples`);
  if (r.peakDb > -1) fail(name, `peak ${r.peakDb} dBFS is above −1 dBFS`);
  if (name === 'muted') { if (r.peakDb > -90) fail(name, `muted but peak ${r.peakDb} dBFS`); }
  else if (r.peakDb < -60) fail(name, `silent (peak ${r.peakDb} dBFS)`);
  if (Math.abs(Number(r.dc)) > 0.01) fail(name, `DC offset ${r.dc}`);
  if (name === 'slice:sweep') {
    const b = r.balance100ms;
    console.log(`   stereo L−R dB per 100 ms: ${b.join(' ')}`);
    if (!(b[0] > 1.5 && Math.min(...b.slice(1, 8)) < -1.5)) fail(name, 'the ring should travel from left to right with the swipe');
  }
}

// Slow-mo: the world muffles and pitches down (the same gale and flutter, a quarter speed).
const fast = rows.find((r) => r.name === 'bed:flutter'), slow = rows.find((r) => r.name === 'bed:flutter-slowmo');
if (fast && slow) {
  console.log(`slow-mo: gale+flutter centre ${fast.centroidHz} Hz → ${slow.centroidHz} Hz at quarter speed`);
  if (!(slow.centroidHz < fast.centroidHz * 0.75)) fail('bed:flutter-slowmo', 'slow-mo should muffle and pitch the world down');
}

// Strain: threads creak before they go (tension climbs from 1.2 to 2.2 over 1.5 s, then they rip at 1.5 s).
const st = rows.find((r) => r.name === 'strain');
if (st) {
  const pre = Math.max(...st.shape50ms.slice(14, 29)), rip = Math.max(...st.shape50ms.slice(30, 36));
  console.log(`strain: the creak before the rip peaks at ${pre} dB, the rip at ${rip} dB (50 ms windows)`);
  if (!(pre > -55 && pre < rip - 6)) fail('strain', 'the creak should be audible before the rip, and well under it');
}

// Distinctness: every pair of one-shots must differ in envelope or spectrum.
const oneShots = rows.filter((r) => !/^(bed|amb):|muted|sweep|strain/.test(r.name) && r.peakDb > -60); // sweep = slice, panned (a space test); strain = creak + rip
const feat = (r) => [Math.log2(Math.max(50, r.centroidHz)), Math.log2(Math.max(0.01, r.durS)) * 0.8, r.attackS * 8, ...r.bands.map((b) => b * 3)];
let closest = { d: 1e9 };
for (let i = 0; i < oneShots.length; i++) for (let j = i + 1; j < oneShots.length; j++) {
  const a = feat(oneShots[i]), b = feat(oneShots[j]);
  const d = Math.hypot(...a.map((x, k) => x - b[k]));
  if (d < closest.d) closest = { d, a: oneShots[i].name, b: oneShots[j].name };
  if (d < 0.25) fail(`${oneShots[i].name} ~ ${oneShots[j].name}`, `too alike (feature distance ${d.toFixed(2)})`);
}
console.log(`closest pair: ${closest.a} ~ ${closest.b} (distance ${closest.d.toFixed(2)}; < 0.25 fails)`);
for (const e of errors) { console.log('   ', e); failed++; }
console.log(failed ? `✗ ${failed} problem(s)` : `✓ ${rows.length} sounds: no clipping, no NaN, silent when muted, all distinct`);
await browser.close();
process.exit(failed ? 1 : 0);
