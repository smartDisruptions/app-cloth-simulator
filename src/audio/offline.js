// TESTS ONLY (the page never imports this). Renders sound scenarios and recorded sessions through an
// OfflineAudioContext with the real engine and director, and measures what comes out. tests/audio-lib.mjs
// bundles it into a bare page (no WebGL), so rendering is fast and deterministic.
import { createEngine, setMaster, activeVoices, MASTER } from './engine.js';
import * as director from './director.js';
import { makeEvents, EVENT_TYPES } from '../core/events.js';

const DT = 1 / 60;

function fakeWorld(scene, material) {
  const vp = new Float32Array(16); vp[0] = vp[5] = vp[10] = vp[15] = 1; // pan = world x × 0.8
  return {
    events: makeEvents(), stats: { flutter: 0, kinetic: 0, burning: 0, wetness: 0, tension: 1 }, dyeColor: 0,
    wind: { speed: 0, gust: 0.5 }, rain: { intensity: 0 }, toggles: { sound: true },
    timeScale: 1, timeScaleTarget: 1, materialId: material || 'cotton', sceneId: scene || 'banner',
    camera: { viewProj: vp }, lights: { firePos: new Float32Array(3) }, cloth: null, hm: undefined, drag: 0, frameDt: DT,
  };
}
const push = (w, type, x, y, z, a) => w.events[type].push(x, y, z, a);
const clearEv = (w) => { for (const k of EVENT_TYPES) w.events[k].clear(); };
const ui = (code) => ({ frames: 2, tail: 1.2, step: (i, w) => { if (i === 0) push(w, 'ui', code, 0, 0, 0); } });
const tear = (material) => ({ frames: 30, tail: 0.8, material, step: (i, w) => { if (i < 20) for (let k = 0; k < 1 + (i % 3); k++) push(w, 'tear', 0.2, 1, 0, k); } });
const gustyWind = (base) => (i, w) => { const g = 0.5 + 0.5 * Math.sin(i * 0.031) * Math.cos(i * 0.017); w.wind.gust = g; w.wind.speed = base * (0.65 + 0.7 * g); };

/** Every sound the engine makes, in isolation. A scenario: frames of world state, then a tail to render. */
export const SCENARIOS = {
  'ui:tap': ui(0), 'ui:tool': ui(1), 'ui:scene': ui(2), 'ui:material': ui(3), 'ui:toggle': ui(4), 'ui:ink': ui(5), 'ui:reset': ui(6),
  'ui:open': ui(7), 'ui:close': ui(8),
  'tear:cotton': tear('cotton'), 'tear:silk': tear('silk'), 'tear:denim': tear('denim'), 'tear:velvet': tear('velvet'), 'tear:aurora': tear('aurora'),
  'tear:chainmail': tear('chainmail'),
  strain: { frames: 110, tail: 0.8, step: (i, w) => { w.stats.tension = i < 90 ? 1.2 + i * 0.011 : 1; if (i === 90) for (let k = 0; k < 30; k++) push(w, 'tear', 0, 1, 0, k); } },
  'tear:burst': { frames: 2, tail: 1, step: (i, w) => { if (i === 0) for (let k = 0; k < 120; k++) push(w, 'tear', -0.3, 1, 0, k); } },
  slice: { frames: 6, tail: 2, step: (i, w) => { if (i < 4) { push(w, 'slice', 0.1, 1, 0, 9); for (let k = 0; k < 9; k++) push(w, 'cut', 0.1, 1, 0, k); } } },
  'slice:slowmo': { frames: 6, tail: 3, setup: (w) => { w.timeScale = 0.95; w.timeScaleTarget = 0.3; }, step: (i, w) => { if (i < 4) push(w, 'slice', 0, 1, 0, 30); } },
  'slice:sweep': { frames: 10, tail: 1.5, step: (i, w) => { if (i < 8) push(w, 'slice', -0.9 + i * 0.25, 1, 0, 6); } },
  'slice:chainmail': { frames: 6, tail: 2, material: 'chainmail', step: (i, w) => { if (i < 4) push(w, 'slice', 0, 1, 0, 9); } },
  ignite: { frames: 2, tail: 1.5, step: (i, w) => { if (i === 0) push(w, 'ignite', -0.2, 1, 0, 1); } },
  burnout: { frames: 90, tail: 0.6, step: (i, w) => { for (let k = 0; k < 3; k++) push(w, 'burnout', 0.3, 1, 0, 0); } },
  steam: { frames: 30, tail: 1, step: (i, w) => { if (i < 20) push(w, 'steam', 0, 1, 0, 0.002); } },
  drip: { frames: 2, tail: 0.6, step: (i, w) => { if (i === 0) push(w, 'drip', 0.2, 0.5, 0, 0.008); } },
  splash: { frames: 2, tail: 0.8, step: (i, w) => { if (i === 0) push(w, 'splash', -0.2, 0, 0, 0.008); } },
  'pin:on': { frames: 2, tail: 0.4, step: (i, w) => { if (i === 0) push(w, 'pin', 0, 1, 0, 1); } },
  'pin:off': { frames: 2, tail: 0.4, step: (i, w) => { if (i === 0) push(w, 'pin', 0, 1, 0, 0); } },
  grab: { frames: 2, tail: 0.8, step: (i, w) => { if (i === 0) push(w, 'grab', -0.4, 1, 0, 0); } },
  'grab:chainmail': { frames: 2, tail: 0.8, material: 'chainmail', step: (i, w) => { if (i === 0) push(w, 'grab', -0.4, 1, 0, 0); } },
  'release:fast': { frames: 2, tail: 1, step: (i, w) => { if (i === 0) push(w, 'release', 0.4, 1, 0, 6); } },
  'release:slow': { frames: 2, tail: 1, step: (i, w) => { if (i === 0) push(w, 'release', 0.4, 1, 0, 1.6); } },
  dye: { frames: 40, tail: 0.8, step: (i, w) => { if (i % 6 === 0) push(w, 'dye', -0.3 + i * 0.015, 1, 0, 1); } },
  rainhit: { frames: 120, tail: 0.6, step: (i, w) => { for (let k = 0; k < 4; k++) push(w, 'rainHit', ((i * 7 + k * 13) % 20) / 10 - 1, 1, 0, 0.7); } },
  'bed:wind-breeze': { frames: 240, tail: 0.5, step: gustyWind(2.8) },
  'bed:wind-gale': { frames: 240, tail: 0.5, step: gustyWind(7.2) },
  'bed:wind-still': { frames: 120, tail: 0.5, step: (i, w) => { w.wind.speed = 0.15; w.wind.gust = 0.3; } },
  'bed:flutter': { frames: 240, tail: 0.5, setup: (w) => { w.stats.flutter = 22; w.stats.kinetic = 1.2; }, step: (i, w) => { gustyWind(6.2)(i, w); w.stats.flutter = 15 + 15 * w.wind.gust; } },
  'bed:flutter-breeze': { frames: 240, tail: 0.5, setup: (w) => { w.stats.flutter = 10; w.stats.kinetic = 0.4; }, step: (i, w) => { gustyWind(2.15)(i, w); w.stats.flutter = 5 + 10 * w.wind.gust; } },
  'bed:flutter-slowmo': { frames: 240, tail: 0.5, setup: (w) => { w.timeScale = w.timeScaleTarget = 0.25; w.stats.flutter = 22; w.stats.kinetic = 1.2; }, step: (i, w) => { gustyWind(6.2)(i, w); w.stats.flutter = 15 + 15 * w.wind.gust; } },
  'bed:swish': { frames: 180, tail: 0.6, scene: 'unveil', step: (i, w) => { w.drag = i < 120 ? 2.5 + 2 * Math.sin(i * 0.15) : 0; w.stats.kinetic = i < 120 ? 0.6 : 0.2; } },
  'bed:fire': { frames: 240, tail: 0.5, scene: 'embers', setup: (w) => { w.stats.burning = 120; }, step: (i, w) => { w.stats.burning = 60 + i; } },
  'bed:fire-small': { frames: 180, tail: 0.5, scene: 'embers', setup: (w) => { w.stats.burning = 4; }, step: () => {} },
  'bed:chainmail-heat': { frames: 180, tail: 0.5, scene: 'embers', material: 'chainmail', setup: (w) => { w.hm = 0.8; }, step: () => {} },
  'bed:rain': { frames: 240, tail: 0.5, scene: 'monsoon', setup: (w) => { w.rain.intensity = 1; w.stats.wetness = 0.5; }, step: (i, w) => { for (let k = 0; k < 2; k++) push(w, 'rainHit', ((i * 5 + k * 11) % 20) / 10 - 1, 1, 0, 0.7); } },
  'amb:noren': { frames: 300, tail: 0.5, scene: 'noren', step: () => {} },
  'amb:embers': { frames: 300, tail: 0.5, scene: 'embers', step: () => {} },
  'amb:unveil': { frames: 300, tail: 0.5, scene: 'unveil', step: () => {} },
  'amb:koinobori': { frames: 600, tail: 2, scene: 'koinobori', step: (i, w) => { w.wind.speed = 6; w.wind.gust = 0.5 + 0.5 * Math.sin(i * 0.05); } },
  'amb:monsoon': { frames: 900, tail: 4, scene: 'monsoon', setup: (w) => { w.rain.intensity = 0.8; }, step: () => {} },
  muted: { frames: 120, tail: 1, setup: (w) => { w.toggles.sound = false; w.wind.speed = 9; w.stats.burning = 100; w.rain.intensity = 1; },
    step: (i, w) => { push(w, 'tear', 0, 1, 0, 0); if (i % 10 === 0) { push(w, 'slice', 0, 1, 0, 9); push(w, 'ui', 1, 0, 0, 0); push(w, 'ignite', 0, 1, 0, 1); } } },
};

let LAST = null; // the last rendered buffer, for drawSpectrogram()

/** Build a full engine synchronously and report what each bank job cost (ms, unthrottled). */
export function profileBank(tier) {
  const ctx = new OfflineAudioContext(2, 44100, 44100);
  const t0 = performance.now();
  const E = createEngine(ctx, { tier: tier || 'low', sync: true });
  return { totalMs: +(performance.now() - t0).toFixed(1), genMs: +E.genMs.toFixed(1), jobs: E.jobMs };
}

async function render(frames, tail, setupWorld, stepFn, opts) {
  const sr = (opts && opts.sr) || 44100;
  const ctx = new OfflineAudioContext(2, Math.ceil((frames * DT + tail + 0.05) * sr), sr);
  const t0 = performance.now();
  const E = createEngine(ctx, { tier: (opts && opts.tier) || 'high', sync: true });
  const build = performance.now() - t0;
  const w = setupWorld();
  director.reset(E, w, 0);
  setMaster(E, w.toggles.sound ? MASTER : 0, 0, 0.002);
  let maxVoices = 0;
  const t1 = performance.now();
  for (let i = 0; i < frames; i++) {
    clearEv(w);
    stepFn(i, w);
    const t = 0.02 + i * DT;
    director.frame(E, w, t, DT);
    const v = activeVoices(E, t); if (v > maxVoices) maxVoices = v;
  }
  const direct = performance.now() - t1;
  const buf = await ctx.startRendering();
  LAST = buf;
  return { buf, E, build, direct, maxVoices };
}

/** Render one named scenario; returns its measurements (and optionally the samples as base64 PCM16). */
export async function renderScenario(name, opts) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error('no scenario ' + name);
  const r = await render(sc.frames, sc.tail, () => { const w = fakeWorld(sc.scene, sc.material); if (sc.setup) sc.setup(w); return w; }, sc.step, opts);
  const out = analyze(r.buf);
  out.name = name; out.maxVoices = r.maxVoices; out.played = r.E.played; out.stolen = r.E.stolen;
  out.buildMs = +r.build.toFixed(1); out.genMs = +r.E.genMs.toFixed(1);
  if (opts && opts.pcm) out.pcm = pcm16(r.buf);
  return out;
}

/** Replay a trace recorded in the real page (audio.js startTrace/stopTrace) offline. */
export async function renderTrace(trace, opts) {
  const first = trace[0];
  const setupWorld = () => fakeWorld(first.scene, first.mat);
  const step = (i, w) => {
    const f = trace[i];
    for (const k in f.ev) { const r = w.events[k], a = f.ev[k], n = Math.min(r.cap, a.length / 4); r.n = n; r.data.set(a.length > n * 4 ? a.slice(0, n * 4) : a); }
    w.stats.flutter = f.st.flutter; w.stats.kinetic = f.st.kinetic; w.stats.burning = f.st.burning; w.stats.wetness = f.st.wetness;
    w.stats.tension = f.st.tension || 1; w.dyeColor = f.dye | 0;
    w.wind.speed = f.wind.speed; w.wind.gust = f.wind.gust; w.rain.intensity = f.rain; w.toggles.sound = f.snd;
    w.timeScale = f.ts; w.timeScaleTarget = f.tsT; w.materialId = f.mat; w.sceneId = f.scene;
    w.camera.viewProj.set(f.vp); w.lights.firePos.set(f.fire); w.hm = f.hm; w.drag = f.drag || 0;
  };
  const r = await render(trace.length, (opts && opts.tail) || 2, setupWorld, step, { tier: (opts && opts.tier) || first.tier || 'low', sr: opts && opts.sr });
  const out = analyze(r.buf);
  out.maxVoices = r.maxVoices; out.played = r.E.played; out.stolen = r.E.stolen; out.directorMs = +r.direct.toFixed(1);
  out.perSecond = perSecond(r.buf);
  if (opts && opts.pcm) out.pcm = pcm16(r.buf);
  return out;
}

// ---------------------------------------------------------------- measurement
const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Peak, loudness, shape and spectrum of a rendered buffer. */
export function analyze(buf) {
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, n = L.length, sr = buf.sampleRate;
  let peak = 0, nan = 0, over = 0, dc = 0, sl = 0, sr2 = 0, lr = 0;
  for (let i = 0; i < n; i++) {
    const a = L[i], b = R[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) { nan++; continue; }
    const m = Math.max(Math.abs(a), Math.abs(b)); if (m > peak) peak = m;
    if (m > 0.891) over++;
    dc += a + b; sl += a * a; sr2 += b * b; lr += a * b;
  }
  const win = Math.round(sr * 0.01), nw = Math.floor(n / win), env = new Float32Array(nw);
  let emax = 0, imax = 0;
  for (let k = 0; k < nw; k++) {
    let s = 0;
    for (let i = k * win; i < (k + 1) * win; i++) { const m = (L[i] + R[i]) * 0.5; s += m * m; }
    env[k] = Math.sqrt(s / win); if (env[k] > emax) { emax = env[k]; imax = k; }
  }
  const thr = emax * 0.01; // −40 dB from the loudest 10 ms
  let first = -1, last = -1, act = 0, s2 = 0;
  for (let k = 0; k < nw; k++) if (env[k] > thr) { if (first < 0) first = k; last = k; act++; s2 += env[k] * env[k]; }
  // spectrum over the active part
  const N = 2048, re = new Float64Array(N), im = new Float64Array(N), pw = new Float64Array(N / 2);
  const a0 = Math.max(0, first * win), a1 = Math.min(n - N, (last + 1) * win);
  let frames = 0;
  for (let p = a0; p <= a1; p += N) {
    let e = 0;
    for (let i = 0; i < N; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = (L[p + i] + R[p + i]) * 0.5 * h; im[i] = 0; e += re[i] * re[i]; }
    if (e < 1e-12) continue;
    fft(re, im); frames++;
    for (let i = 1; i < N / 2; i++) pw[i] += re[i] * re[i] + im[i] * im[i];
  }
  let tot = 0, cen = 0;
  const bands = [0, 0, 0, 0]; // <250 · 250–1k · 1–4k · >4k
  for (let i = 1; i < N / 2; i++) { const f = (i * sr) / N; tot += pw[i]; cen += f * pw[i]; bands[f < 250 ? 0 : f < 1000 ? 1 : f < 4000 ? 2 : 3] += pw[i]; }
  let roll = 0;
  for (let i = 1, c = 0; i < N / 2; i++) { c += pw[i]; if (c >= tot * 0.85) { roll = (i * sr) / N; break; } }
  const balance = [];
  for (let k = 0; k + 10 <= nw && balance.length < 12; k += 10) {
    let l = 0, r = 0;
    for (let i = k * win; i < (k + 10) * win; i++) { l += L[i] * L[i]; r += R[i] * R[i]; }
    balance.push(+(10 * Math.log10((l + 1e-12) / (r + 1e-12))).toFixed(1));
  }
  const shape = [];
  for (let k = 0; k < nw; k += 5) { let m = 0; for (let j = k; j < Math.min(nw, k + 5); j++) m = Math.max(m, env[j]); shape.push(+db(m).toFixed(1)); }
  return {
    peakDb: +db(peak).toFixed(2), rmsDb: +db(act ? Math.sqrt(s2 / act) : 0).toFixed(2), wholeRmsDb: +db(Math.sqrt((sl + sr2) / (2 * n))).toFixed(2),
    durS: first < 0 ? 0 : +((last - first + 1) * 0.01).toFixed(2), attackS: first < 0 ? 0 : +((imax - first) * 0.01).toFixed(2),
    centroidHz: tot > 0 ? Math.round(cen / tot) : 0, rolloffHz: Math.round(roll), bands: bands.map((b) => +(tot > 0 ? b / tot : 0).toFixed(3)),
    balanceDb: +(db(Math.sqrt(sl / n)) - db(Math.sqrt(sr2 / n))).toFixed(1), corr: +(lr / Math.sqrt(sl * sr2 + 1e-30)).toFixed(2), // 1 = mono · lower = wider
    nan, over, dc: +(dc / (2 * n)).toExponential(1), seconds: +(n / sr).toFixed(2), shape50ms: shape, balance100ms: balance, spectralFrames: frames,
  };
}

/** RMS and peak per second (dBFS), for the session summary. */
function perSecond(buf) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate, out = [];
  for (let s = 0; s + sr <= L.length; s += sr) {
    let p = 0, q = 0;
    for (let i = s; i < s + sr; i++) { const m = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (m > p) p = m; q += (L[i] * L[i] + R[i] * R[i]) * 0.5; }
    out.push({ rmsDb: +db(Math.sqrt(q / sr)).toFixed(1), peakDb: +db(p).toFixed(1) });
  }
  return out;
}

/** Interleaved 16-bit PCM, base64 (for writing a WAV in Node). */
function pcm16(buf) {
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length, u8 = new Uint8Array(n * 4), dv = new DataView(u8.buffer);
  for (let i = 0; i < n; i++) {
    dv.setInt16(i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    dv.setInt16(i * 4 + 2, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { sr: buf.sampleRate, b64: btoa(s) };
}

const EV_COL = { tear: '#ff5a5a', cut: '#ffd75a', slice: '#ffffff', ignite: '#ff9a2a', burnout: '#b0562a', steam: '#cfe8ff', drip: '#5ab4ff',
  rainHit: '#3f7fff', splash: '#7fd0ff', pin: '#9aff7a', grab: '#7affd2', release: '#2affa0', dye: '#d07aff', ui: '#888888' };

/**
 * Draw the last render as a picture you can read: a log-frequency spectrogram (50 Hz–16 kHz, −100…−20 dB),
 * a lane of the trace's events (one colour per type) and the loudness envelope. For the tests' screenshots.
 */
export function drawSpectrogram(trace, title) {
  const buf = LAST, sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
  const W = 1100, H = 300, LANE = 46, ENV = 70, TOP = 22, cv = document.createElement('canvas');
  cv.width = W + 50; cv.height = TOP + H + LANE + ENV + 24; cv.style.background = '#0b0d18';
  document.body.style.margin = '0'; document.body.style.background = '#0b0d18'; document.body.appendChild(cv);
  const g = cv.getContext('2d'), N = 2048, re = new Float64Array(N), im = new Float64Array(N), x0 = 44;
  g.fillStyle = '#0b0d18'; g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#ddd'; g.font = '13px sans-serif'; g.fillText(title || 'session', x0, 15);
  const img = g.createImageData(W, H), fmin = 50, fmax = 16000, lr = Math.log(fmax / fmin);
  const col = (v) => { // inferno-ish
    const t = Math.max(0, Math.min(1, v));
    return [Math.min(255, 30 + 400 * t * t), Math.min(255, Math.max(0, 255 * (t * 1.6 - 0.55))), Math.min(255, 60 + 200 * Math.sin(Math.PI * Math.min(1, t * 1.3)) - 40 * t)];
  };
  for (let x = 0; x < W; x++) {
    const c = Math.floor((x / W) * (n - N));
    for (let i = 0; i < N; i++) { const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = (L[c + i] + R[c + i]) * 0.5 * h; im[i] = 0; }
    fft(re, im);
    for (let y = 0; y < H; y++) {
      const f = fmin * Math.exp(lr * (1 - y / H)), k = Math.min(N / 2 - 1, Math.max(1, Math.round((f * N) / sr)));
      const p = (re[k] * re[k] + im[k] * im[k]) / (N * N * 0.25), d = 10 * Math.log10(p + 1e-14);
      const [r, gg, b] = col((d + 100) / 80), o = (y * W + x) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, x0, TOP);
  g.fillStyle = '#9aa'; g.font = '10px sans-serif';
  for (const f of [100, 300, 1000, 3000, 10000]) { const y = TOP + H * (1 - Math.log(f / fmin) / lr); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), 4, y + 3); g.fillRect(x0 - 4, y, 3, 1); }
  const secs = n / sr;
  for (let s = 0; s <= secs; s++) { const x = x0 + (s / secs) * W; g.fillRect(x, TOP + H, 1, LANE + ENV); g.fillText(s + 's', x + 2, TOP + H + LANE + ENV + 14); }
  if (trace) {
    const types = Object.keys(EV_COL);
    trace.forEach((f, i) => { for (const k in f.ev) { const ti = types.indexOf(k); if (ti < 0) continue; g.fillStyle = EV_COL[k]; g.fillRect(x0 + ((0.02 + i / 60) / secs) * W, TOP + H + 3 + (ti % 7) * 6, 2, 5); } });
    let lx = x0; g.font = '10px sans-serif';
    types.forEach((k) => { g.fillStyle = EV_COL[k]; g.fillText(k, lx, cv.height - 2); lx += g.measureText(k).width + 10; });
  }
  g.strokeStyle = '#7fd'; g.beginPath();
  const step = Math.floor(n / W);
  for (let x = 0; x < W; x++) {
    let s = 0; for (let i = x * step; i < (x + 1) * step; i++) s += L[i] * L[i] + R[i] * R[i];
    const d = 10 * Math.log10(s / (2 * step) + 1e-12), y = TOP + H + LANE + ENV - Math.max(0, Math.min(1, (d + 60) / 60)) * ENV;
    if (x) g.lineTo(x0 + x, y); else g.moveTo(x0, y);
  }
  g.stroke();
  g.fillStyle = '#9aa'; g.fillText('rms −60…0 dB', x0 + W - 70, TOP + H + LANE + 10);
  return { w: cv.width, h: cv.height };
}
