// A scripted ~10 s session in the real app (grab and fling, a katana slice, two burns, rain, a pin, ink,
// then chainmail), recorded frame by frame as the director sees it, replayed through an OfflineAudioContext
// with the same engine, and written to tests/out/audio-session.wav with a level summary.
//   node tests/audio-session.mjs [--scene embers] [--quality low]
import { join } from 'node:path';
import { OUT, build, open, advance, clothRect } from './lib.mjs';
import { launch, audioPage, writeWav } from './audio-lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const scene = arg('--scene', 'embers'), quality = arg('--quality', 'low');

const url = build();
const browser = await launch();
const { page, ctx, errors } = await open(browser, url, { device: 'shot', query: `scene=${scene}&quality=${quality}` });
await advance(page, 30);
const r = await clothRect(page);
await page.evaluate(() => { window.__cloth.api.audioUnlock(); window.__cloth.modules.audio.startTrace(); });
const step = (fn, arg2) => page.evaluate(fn, arg2);

await advance(page, 45); // the scene's air
// grab and swing, then fling
await step(([r]) => {
  const C = window.__cloth; C.api.setTool('grab'); C.input('down', r.cx, r.cy, 1);
  for (let i = 0; i < 50; i++) { C.input('move', r.cx + Math.sin(i * 0.25) * 70, r.cy + Math.cos(i * 0.18) * 35, 1); C.advance(1); }
  for (let i = 0; i < 6; i++) { C.input('move', r.cx + 70 + i * 40, r.cy - i * 25, 1); C.advance(1); }
  C.input('up', r.cx + 310, r.cy - 150, 1); C.advance(1);
}, [r]);
await advance(page, 25);
// the katana: one swipe across
await step(([r]) => {
  const C = window.__cloth; C.api.setTool('slice');
  C.input('down', r.x0 - 10, r.y0 + r.h * 0.45, 2);
  for (let i = 1; i <= 6; i++) { C.input('move', r.x0 - 10 + (r.w + 20) * (i / 6), r.y0 + r.h * (0.45 + 0.05 * i), 2); C.advance(1); }
  C.input('up', r.x1 + 10, r.y0 + r.h * 0.75, 2); C.advance(1);
}, [r]);
await advance(page, 45);
// burn: light and hold, then a second flame
const burn = (x, y, hold) => step(([x, y, hold]) => { const C = window.__cloth; C.api.setTool('burn'); C.input('down', x, y, 3); C.advance(hold); C.input('up', x, y, 3); C.advance(1); }, [x, y, hold]);
await burn(r.cx - r.w * 0.2, r.y0 + r.h * 0.2, 25);
await advance(page, 60);
await burn(r.cx + r.w * 0.25, r.y0 + r.h * 0.3, 20);
await advance(page, 40);
// rain
await step(() => window.__cloth.api.setToggle('rain', true));
await advance(page, 140);
// a pin, two drops of ink
await step(([r]) => { const C = window.__cloth; C.api.setTool('pin'); C.input('down', r.cx - 30, r.y0 + 20, 4); C.advance(2); C.input('up', r.cx - 30, r.y0 + 20, 4); C.advance(10);
  C.api.setTool('dye'); C.input('down', r.cx + 20, r.y0 + 30, 5); C.advance(6); C.input('move', r.cx + 40, r.y0 + 45, 5); C.advance(6); C.input('up', r.cx + 40, r.y0 + 45, 5); C.advance(10); }, [r]);
// chainmail, and a grab of it
await step(([r]) => { const C = window.__cloth; C.api.setMaterial('chainmail'); C.advance(10); C.api.setTool('grab'); C.input('down', r.cx, r.y0 + 25, 6); C.advance(20); C.input('up', r.cx, r.y0 + 25, 6); C.advance(15); }, [r]);
const trace = await page.evaluate(() => window.__cloth.modules.audio.stopTrace());
const live = await page.evaluate(() => window.__cloth.modules.audio.debug());
await ctx.close();

const counts = {};
for (const f of trace) for (const k in f.ev) counts[k] = (counts[k] || 0) + f.ev[k].length / 4;
console.log(`trace: ${trace.length} frames (${(trace.length / 60).toFixed(1)} s), ${scene}/${quality}; events ${JSON.stringify(counts)}`);
console.log(`live engine after the session: ${JSON.stringify(live)}`);

const ap = await audioPage(browser);
const out = await ap.page.evaluate(([t]) => window.AUDIO.renderTrace(t, { pcm: true, tail: 2 }), [trace]);
const file = join(OUT, 'audio-session.wav');
writeWav(file, out.pcm); delete out.pcm;
console.log(`wav: ${file} (${out.seconds} s)`);
console.log(`whole: peak ${out.peakDb} dBFS · rms ${out.wholeRmsDb} dBFS · active rms ${out.rmsDb} · centre ${out.centroidHz} Hz · bands% ${out.bands.map((b) => Math.round(b * 100)).join('/')} · clipped samples ${out.over} · NaN ${out.nan}`);
console.log(`voices: ${out.played} played, ${out.stolen} stolen, max ${out.maxVoices} at once · director ${out.directorMs} ms for ${trace.length} frames (offline, unthrottled)`);
console.log('per second (rms / peak dBFS): ' + out.perSecond.map((s, i) => `${i}s ${s.rmsDb}/${s.peakDb}`).join('  '));
const size = await ap.page.evaluate(([t, title]) => window.AUDIO.drawSpectrogram(t, title), [trace, `${scene} · ${quality}: grab+fling, slice, two burns, rain, pin, ink, chainmail`]);
await ap.page.setViewportSize({ width: size.w, height: size.h });
await ap.page.screenshot({ path: join(OUT, 'audio-session.png'), clip: { x: 0, y: 0, width: size.w, height: size.h } });
console.log(`picture: ${join(OUT, 'audio-session.png')} (spectrogram + events + loudness)`);
const prof = await ap.page.evaluate(() => window.AUDIO.profileBank('low'));
const top = Object.entries(prof.jobs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ');
console.log(`bank: ${prof.genMs} ms to synthesise everything (unthrottled, this CPU); heaviest jobs: ${top}`);
const bad = [...errors, ...ap.errors];
if (out.peakDb > -1) bad.push(`peak ${out.peakDb} dBFS above −1 dBFS`);
if (out.nan) bad.push(`${out.nan} NaN samples`);
for (const e of bad) console.log('   ✗', e);
await browser.close();
process.exit(bad.length ? 1 : 0);
