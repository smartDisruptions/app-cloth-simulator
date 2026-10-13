// The audio engine: one Web Audio graph, built on any BaseAudioContext (the live AudioContext, or the tests'
// OfflineAudioContext). director.js decides WHAT to play from the world; this file decides HOW, cheaply.
//
// Cost model (measured in headless Chromium): creating a node costs 10–100 µs (0.15–0.45 ms at 4× CPU
// throttle), so nothing is created in the frame path:
//   · voices are pooled chains (highpass → lowpass → gain → pan, plus a reverb send) built once;
//   · their sources are pre-created and pre-connected in idle time ("armed", with buffer, loop and rate
//     already set where they're known), so a trigger is start() plus a few param calls;
//   · beds and textures (wind, flutter, fire, rain, rip, cut, steam) are looping sources whose gains and
//     filters the director steers with setTargetAtTime (smooth, no zipper noise), asleep when silent;
//   · every buffer is synthesised by bank.js in a Web Worker (a blob URL made from makeBank's own source),
//     so synthesis never touches a frame; where workers are blocked it runs in idle slices instead.
// Filter TYPES never change after creation (only AudioParams do), so the offline renderer schedules the
// exact same timeline the live page plays.
import { makeBank } from './bank.js';

/** Master level into the compressor (its makeup gain adds ~7 dB to quiet material; tuned by tests/audio-sounds). */
export const MASTER = 0.5;

/** Audio's share of the quality tiers: pool size, new voices per frame, reverb length, rain taps a second. */
export const TIERS = {
  low: { voices: 8, trig: 2, ir: 0.8, taps: 6 },
  mid: { voices: 10, trig: 3, ir: 1.1, taps: 10 },
  high: { voices: 12, trig: 3, ir: 1.5, taps: 14 },
  ultra: { voices: 12, trig: 4, ir: 1.6, taps: 16 },
};
const RANK = { low: 0, mid: 1, high: 2, ultra: 3 };

/** Ids of bed parameters in the dead-band cache (E.pv). */
export const ID = {
  worldLP: 0, revIn: 1,
  wBody: 2, wLP: 3, wWh: 4, wF1: 5, wF2: 6, wRum: 7,
  fFlap: 8, fSw: 9, fRateA: 10, fRateB: 11, fLo: 12, fHi: 13, fSwF: 14, fLoQ: 15, fHiQ: 16,
  xRoar: 17, xLP: 18, xC: 19, xD: 20, xPan: 21, xCRate: 22,
  rWash: 23, rLP: 24, rTex: 25, rPat: 26, rPatLP: 27, rDrum: 28, rTexRate: 29, room: 30, fJitA: 31, fJitB: 32,
};
const NPV = 40;

// ---------------------------------------------------------------- engine RNG (offsets, jitter)
let es = 0x6b43a9b5;
export function erng() { let x = es; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; es = x; return (x >>> 0) / 4294967296; }
const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

// ---------------------------------------------------------------- node helpers (creation time only)
function biq(c, type, f, q) { const n = c.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; }
function gn(c, v) { const n = c.createGain(); n.gain.value = v; return n; }
function panner(c) {
  if (typeof c.createStereoPanner === 'function') return c.createStereoPanner();
  const g = c.createGain(); g.pan = c.createGain().gain; // no StereoPanner (very old Safari): centre, and pan goes nowhere
  return g;
}

let CLIP = null, SNAP = null, GEN = null;
/** The last line of defence: unity up to 0.6, then a soft knee that can never exceed 0.855 (−1.4 dBFS). */
function clipCurve() {
  if (CLIP) return CLIP;
  CLIP = new Float32Array(2048);
  for (let i = 0; i < 2048; i++) {
    const x = (i / 2047) * 2 - 1, a = Math.abs(x), y = a < 0.6 ? a : 0.6 + 0.29 * Math.tanh((a - 0.6) / 0.29);
    CLIP[i] = x < 0 ? -y : y;
  }
  return CLIP;
}
/** A sawtooth (rising −1→1) shaped into a flap: instant snap, ~period/5.5 decay. Drives the flutter's AM. */
function snapCurve() {
  if (SNAP) return SNAP;
  SNAP = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) { const p = i / 1023; SNAP[i] = (1 - Math.exp(-p / 0.012)) * Math.exp(-p * 5.5); }
  return SNAP;
}
/** The bank's generators on this thread (UI sounds, offline renders, and the fallback when workers are blocked). */
const gen = () => GEN || (GEN = makeBank());

function emptyBank() {
  return {
    white: null, pink: null, grain: null, grainFine: null, crinkle: null, crackle: null, crackleDense: null,
    rain: null, patter: null, ir: null, crickets: null, hum: null, moon: null, thunder: null,
    shing: [], whoosh: [], plink: [], splash: [], bloop: [], tick: [], strike: [], whoomph: [], pop: [], snap: [],
    rustle: [], tap: [], jingle: [], tink: [], chime: [],
    ui: { tap: null, tool: null, scene: null, toggle: null, reset: null, open: null, close: null },
  };
}

// ---------------------------------------------------------------- the engine
let LIVE = null; // the engine that owns idle callbacks and the worker (the page's); offline engines are synchronous

/**
 * Build the graph on `ctx`. opts.tier: world.q.name. opts.sync: synthesise the whole bank and arm every
 * source now (offline rendering). Otherwise only the master chain, the UI sounds and three UI voices are
 * built here (inside the user's gesture); the bank goes to a worker and the rest is built in idle time.
 */
export function createEngine(ctx, opts) {
  const tierName = opts && TIERS[opts.tier] ? opts.tier : 'mid';
  const E = {
    ctx, sync: !!(opts && opts.sync), tierName, tier: TIERS[tierName], rank: RANK[tierName],
    bank: emptyBank(), job: 0, want: '', idleReq: false, dead: false,
    worker: null, workerT0: 0, workerIdles: 0, posted: new Uint8Array(JOBS.length), fromWorker: 0, workerMs: 0,
    slots: [], dry: [], tex: null, wind: null, flutter: null, fire: null, rainBed: null, amb: null,
    pv: new Float32Array(NPV).fill(NaN),
    played: 0, stolen: 0, genMs: 0, jobMs: {}, calls: 0, wakes: 0, idles: 0, lastSlot: null,
    worldBus: null, worldLP: null, dryBus: null, revIn: null, conv: null, revOut: null, mix: null, master: null, comp: null,
  };
  const c = ctx;
  E.worldBus = gn(c, 1);
  E.worldLP = biq(c, 'lowpass', 18000, 0.5);
  E.dryBus = gn(c, 1);
  E.revIn = gn(c, 1); E.revIn.channelCount = 1; E.revIn.channelCountMode = 'explicit';
  E.conv = c.createConvolver();
  E.revOut = gn(c, 0.7);
  E.mix = gn(c, 1);
  const shelf = biq(c, 'highshelf', 7500, 0.707); shelf.gain.value = -2.5; // phone speakers: take the edge off
  const hp = biq(c, 'highpass', 35, 0.7); // nothing below what any speaker plays: no wasted headroom, no pumping
  E.master = gn(c, 0);
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2;
  E.comp = comp;
  const clip = c.createWaveShaper(); clip.curve = clipCurve();
  E.worldBus.connect(E.worldLP); E.worldLP.connect(E.mix); E.dryBus.connect(E.mix);
  E.revIn.connect(E.conv); E.conv.connect(E.revOut); E.revOut.connect(E.mix);
  E.mix.connect(hp); hp.connect(shelf); shelf.connect(E.master); E.master.connect(comp); comp.connect(clip); clip.connect(c.destination);

  const U = gen().ui();
  for (const k in U) E.bank.ui[k] = wrap(E, U[k]);
  for (let i = 0; i < 3; i++) E.dry.push(makeSlot(E, E.dryBus));
  if (E.sync) {
    for (; E.job < JOBS.length; E.job++) if (inPass(E, E.job)) { while (!jobDone(E, E.job)) runJob(E, E.job); }
    while (armOne(E)) { /* arm everything */ }
  } else {
    LIVE = E;
    for (let i = 0; i < 3; i++) armOne(E);
    E.worker = startWorker();
    if (E.worker) { E.workerT0 = now(); E.workerIdles = E.idles; for (let i = 0; i < JOBS.length; i++) if (inPass(E, i) && !GRAPH[JOBS[i][0]]) post(E, i, false); }
    needIdle(E);
  }
  return E;
}

/** Stop background work for this engine (page teardown / tests). */
export function dispose(E) {
  E.dead = true;
  if (E.worker) { try { E.worker.terminate(); } catch (e) { /* ignore */ } E.worker = null; }
  if (LIVE === E) LIVE = null;
}

/** Fade the master to v (mute = 0). */
export function setMaster(E, v, t, tau) {
  const g = E.master.gain;
  g.cancelScheduledValues(t); g.setTargetAtTime(v, t, tau);
}

/** Ask for an ambience asset the current scene wants ('hum', 'crickets', 'moon', 'thunder', 'chime'). */
export function want(E, name) {
  if (E.worker) {
    for (let i = 0; i < JOBS.length; i++) if (JOBS[i][0] === name && !E.posted[i] && !haveBuf(E, i)) post(E, i, true);
  } else if (!E.want) { E.want = name; needIdle(E); }
}

// ---------------------------------------------------------------- one-shot voices
function makeSlot(E, bus) {
  const c = E.ctx;
  const f1 = biq(c, 'highpass', 20, 0.707), f2 = biq(c, 'lowpass', 16000, 0.707), env = gn(c, 0), pan = panner(c), send = gn(c, 0);
  f1.connect(f2); f2.connect(env); env.connect(pan); pan.connect(bus); env.connect(send); send.connect(E.revIn);
  return { f1, f2, env, pan, send, armed: null, src: null, start: 0, end: 0, prio: 0, hp: 20, hpQ: 0.707, lp: 16000, lpQ: 0.707, panV: 0, sendV: 0 };
}

/** Scratch parameters for play(): the director fills them, then calls play(). No allocation per sound. */
export const P = { prio: 5, buf: null, rate: 1, gain: 1, pan: 0, send: 0, hp: 20, hpQ: 0.707, lp: 16000, lpQ: 0.707, delay: 0 };
export function resetP() {
  P.prio = 5; P.buf = null; P.rate = 1; P.gain = 1; P.pan = 0; P.send = 0;
  P.hp = 20; P.hpQ = 0.707; P.lp = 16000; P.lpQ = 0.707; P.delay = 0;
}
const moved = (a, b) => (a > b ? a - b : b - a) > 0.02 * b;

/**
 * Play P.buf on a free voice (dry: the UI/hero pool, which skips the slow-mo muffle). When every voice is
 * busy, steal the lowest-priority, oldest one with a 12 ms fade; if all are more important, drop this one.
 */
export function play(E, dry, t) {
  const b = P.buf; if (!b) return false;
  const pool = dry ? E.dry : E.slots;
  let slot = null, steal = null, best = -1e9;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i]; if (!s.armed) continue;
    if (s.end <= t) { slot = s; break; }
    if (s.prio <= P.prio) { const sc = (10 - s.prio) * 10 + (t - s.start); if (sc > best) { best = sc; steal = s; } }
  }
  let t0 = t + P.delay;
  if (!slot) {
    if (!steal) return false;
    slot = steal;
    const g = slot.env.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0, t + 0.012);
    if (slot.src) { try { slot.src.stop(t + 0.013); } catch (e) { /* already ended */ } }
    if (t0 < t + 0.014) t0 = t + 0.014;
    E.stolen++;
  }
  const s = slot.armed; slot.armed = null; slot.src = s;
  s.buffer = b; s.playbackRate.value = P.rate;
  let calls = 4; // buffer, rate, gain, start
  if (moved(P.hp, slot.hp)) { slot.f1.frequency.setValueAtTime(P.hp, t0); slot.hp = P.hp; calls++; }
  if (P.hpQ !== slot.hpQ) { slot.f1.Q.setValueAtTime(P.hpQ, t0); slot.hpQ = P.hpQ; calls++; }
  if (moved(P.lp, slot.lp)) { slot.f2.frequency.setValueAtTime(P.lp, t0); slot.lp = P.lp; calls++; }
  if (P.lpQ !== slot.lpQ) { slot.f2.Q.setValueAtTime(P.lpQ, t0); slot.lpQ = P.lpQ; calls++; }
  slot.env.gain.setValueAtTime(P.gain, t0);
  if (Math.abs(P.pan - slot.panV) > 0.02) { slot.pan.pan.setValueAtTime(P.pan, t0); slot.panV = P.pan; calls++; }
  if (Math.abs(P.send - slot.sendV) > 0.01) { slot.send.gain.setValueAtTime(P.send, t0); slot.sendV = P.send; calls++; }
  s.start(t0);
  E.calls += calls;
  slot.start = t0; slot.end = t0 + b.duration / P.rate + 0.015; slot.prio = P.prio;
  E.played++; E.lastSlot = slot;
  needIdle(E);
  return true;
}

/** Voices sounding at time t (for tests and the receipt). */
export function activeVoices(E, t) {
  let n = 0;
  for (let i = 0; i < E.slots.length; i++) if (E.slots[i].end > t) n++;
  for (let i = 0; i < E.dry.length; i++) if (E.dry[i].end > t) n++;
  return n;
}

// ---------------------------------------------------------------- texture voices (rip, cut, steam)
function makeTex(E, buf, f1, q1) {
  const c = E.ctx;
  const V = {
    buf, f1: biq(c, 'bandpass', f1, q1), f2: biq(c, 'peaking', 600, 1), f3: biq(c, 'lowpass', 14000, 0.707),
    env: gn(c, 0), pan: panner(c), send: gn(c, 0.1), armed: null, armedBuf: '', src: null, on: false, until: 0, panV: 0, rate: 1, lvl: 0, relAt: 0,
  };
  V.f2.gain.value = 0;
  V.f1.connect(V.f2); V.f2.connect(V.f3); V.f3.connect(V.env); V.env.connect(V.pan); V.pan.connect(E.worldBus);
  V.env.connect(V.send); V.send.connect(E.revIn);
  return V;
}

/**
 * Excite a texture: its loop rises to `level` in ~4 ms, holds `hold` s, then decays with time constant tau.
 * Calling it every frame while events keep coming sustains it: many tears make one long rip.
 */
export function excite(E, V, t, level, pan, hold, tau, rate) {
  if (!V.on) {
    if (!V.armed || V.armedBuf !== V.buf) return false; // armed in idle time with its buffer already set
    const s = V.armed; V.armed = null; V.src = s;
    s.playbackRate.value = rate; V.rate = rate;
    s.start(t, erng() * s.buffer.duration);
    V.on = true; needIdle(E);
  } else {
    // already sustaining at about this level, and the release is more than a frame away: nothing to send
    if (t + 0.02 < V.relAt && Math.abs(level - V.lvl) < 0.2 * V.lvl) return true;
    if (Math.abs(rate - V.rate) > 0.06 * V.rate) { V.src.playbackRate.setTargetAtTime(rate, t, 0.04); V.rate = rate; E.calls++; }
  }
  V.lvl = level; V.relAt = t + hold; E.calls += 3;
  const g = V.env.gain;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(level, t, 0.004);
  g.setTargetAtTime(0, t + hold, tau);
  if (Math.abs(pan - V.panV) > 0.04) { V.pan.pan.setTargetAtTime(pan, t, 0.012); V.panV = pan; }
  V.until = t + hold + tau * 7;
  return true;
}

/** Put a texture to sleep once it has decayed (stops its loop; a fresh one is armed in idle time). */
export function texIdle(E, V, t) {
  if (V.on && t > V.until) {
    try { V.src.stop(t); } catch (e) { /* ignore */ }
    V.src = null; V.on = false; needIdle(E);
  }
}
/** Stop a texture now (its buffer must change). */
export function texStop(E, V, t) { if (V.on) { V.env.gain.setTargetAtTime(0, t, 0.01); V.until = t; texIdle(E, V, t + 0.05); } }
/** Switch a texture to another bank buffer (a material change): the next excite plays it. */
export function texBuffer(E, V, name, t) {
  if (V.buf === name) return;
  texStop(E, V, t); V.buf = name;
  if (V.armed && V.armedBuf !== name) { V.armed.disconnect(); V.armed = null; needIdle(E); }
}

// ---------------------------------------------------------------- beds
function spec(buf, osc, type, rate, to, fm) { return { buf, osc, type, rate, to, fm: fm || null }; }
function bed(specs, ids) { return { specs, ids, armed: new Array(specs.length).fill(null), run: new Array(specs.length).fill(null), on: false, quiet: 0 }; }

function makeWind(E) {
  const c = E.ctx;
  // the body is a wide band, not a lowpass: air you can hear on a phone speaker, not rumble
  const lp = biq(c, 'bandpass', 500, 0.6), gBody = gn(c, 0), bp1 = biq(c, 'bandpass', 800, 9), bp2 = biq(c, 'bandpass', 1200, 11), gWh = gn(c, 0);
  const out = gn(c, 1), send = gn(c, 0.12), d1 = gn(c, 70), d2 = gn(c, 105);
  const lpR = biq(c, 'lowpass', 180, 0.7), gRum = gn(c, 0); // weight under a gale, for headphones
  lp.connect(gBody); gBody.connect(out); lpR.connect(gRum); gRum.connect(out); bp1.connect(gWh); bp2.connect(gWh); gWh.connect(out);
  out.connect(E.worldBus); out.connect(send); send.connect(E.revIn);
  d1.connect(bp1.frequency); d2.connect(bp2.frequency); // a slow LFO makes the gale's whistle wander
  const W = bed([spec('pink', 0, '', 1, [lp, lpR]), spec('white', 0, '', 1, [bp1, bp2]), spec(null, 0.09, 'sine', 1, [d1, d2])],
    [ID.wBody, ID.wLP, ID.wWh, ID.wF1, ID.wF2, ID.wRum]);
  W.lp = lp; W.gBody = gBody; W.bp1 = bp1; W.bp2 = bp2; W.gWh = gWh; W.gRum = gRum;
  return W;
}

/** Flutter: noise in two bands, each chopped by a "snap" envelope (a shaped sawtooth), plus a swish ∝ speed. */
function makeFlutter(E) {
  const c = E.ctx;
  const bpLo = biq(c, 'bandpass', 430, 1.1), bpHi = biq(c, 'bandpass', 1800, 1), bpSw = biq(c, 'bandpass', 1100, 0.7);
  const amLo = gn(c, 0), amHi = gn(c, 0), gFlap = gn(c, 0), gSw = gn(c, 0), out = gn(c, 1), send = gn(c, 0.06);
  const shA = c.createWaveShaper(), shB = c.createWaveShaper(); shA.curve = snapCurve(); shB.curve = snapCurve();
  const jitA = gn(c, 0.8), jitB = gn(c, 1.2); // ±Hz of wander on each flap rate (∝ the rate), from two slow LFOs: never periodic
  bpLo.connect(amLo); bpHi.connect(amHi); amLo.connect(gFlap); amHi.connect(gFlap); bpSw.connect(gSw);
  gFlap.connect(out); gSw.connect(out); out.connect(E.worldBus); out.connect(send); send.connect(E.revIn);
  shA.connect(amLo.gain); shB.connect(amHi.gain);
  const F = bed([spec('white', 0, '', 1, [bpLo, bpHi, bpSw]), spec(null, 5, 'sawtooth', 1, [shA], jitA), spec(null, 6.85, 'sawtooth', 1, [shB], jitB),
    spec(null, 0.63, 'sine', 1, [jitA]), spec(null, 0.41, 'sine', 1, [jitB])],
    [ID.fFlap, ID.fSw, ID.fRateA, ID.fRateB, ID.fLo, ID.fHi, ID.fSwF, ID.fLoQ, ID.fHiQ, ID.fJitA, ID.fJitB]);
  F.bpLo = bpLo; F.bpHi = bpHi; F.bpSw = bpSw; F.gFlap = gFlap; F.gSw = gSw; F.jitA = jitA; F.jitB = jitB;
  return F;
}

/** Fire: a breathing roar (pink noise under a lowpass that opens as it grows; an LFO on its level) and two crackle loops, panned to the burn front. */
function makeFire(E) {
  const c = E.ctx;
  const hpR = biq(c, 'highpass', 110, 0.6), lpR = biq(c, 'lowpass', 700, 0.7), breath = gn(c, 1), gRoar = gn(c, 0), depth = gn(c, 0.45);
  const hpC = biq(c, 'highpass', 700, 0.7), gC = gn(c, 0), hpD = biq(c, 'highpass', 1100, 0.7), gD = gn(c, 0);
  const out = gn(c, 1), pan = panner(c), send = gn(c, 0.2);
  hpR.connect(lpR); lpR.connect(breath); breath.connect(gRoar); gRoar.connect(out); depth.connect(breath.gain);
  hpC.connect(gC); gC.connect(out); hpD.connect(gD); gD.connect(out);
  out.connect(pan); pan.connect(E.worldBus); out.connect(send); send.connect(E.revIn);
  const F = bed([spec('pink', 0, '', 0.93, [hpR]), spec('crackle', 0, '', 1, [hpC]), spec('crackleDense', 0, '', 1, [hpD]), spec(null, 0.37, 'sine', 1, [depth])],
    [ID.xRoar, ID.xLP, ID.xC, ID.xD, ID.xPan, ID.xCRate]);
  F.lpR = lpR; F.gRoar = gRoar; F.gC = gC; F.gD = gD; F.pan = pan;
  return F;
}

/** Rain: a pink wash, a stereo drop field, and a patter on the cloth that turns into a drum skin as it soaks. */
function makeRain(E) {
  const c = E.ctx;
  const hpW = biq(c, 'highpass', 250, 0.7), lpW = biq(c, 'lowpass', 3500, 0.6), gWash = gn(c, 0);
  const hpT = biq(c, 'highpass', 900, 0.7), gTex = gn(c, 0);
  const drum = biq(c, 'peaking', 140, 1.2), lpP = biq(c, 'lowpass', 2600, 0.7), gPat = gn(c, 0);
  drum.gain.value = 0;
  const out = gn(c, 1), send = gn(c, 0.1);
  hpW.connect(lpW); lpW.connect(gWash); gWash.connect(out); hpT.connect(gTex); gTex.connect(out);
  drum.connect(lpP); lpP.connect(gPat); gPat.connect(out); out.connect(E.worldBus); out.connect(send); send.connect(E.revIn);
  const R = bed([spec('pink', 0, '', 1.07, [hpW]), spec('rain', 0, '', 1, [hpT]), spec('patter', 0, '', 1, [drum])],
    [ID.rWash, ID.rLP, ID.rTex, ID.rPat, ID.rPatLP, ID.rDrum, ID.rTexRate]);
  R.lpW = lpW; R.gWash = gWash; R.gTex = gTex; R.drum = drum; R.lpP = lpP; R.gPat = gPat;
  return R;
}

/** Ambience: two decks so a scene change crossfades (hum ↔ crickets ↔ moon). */
function makeAmb(E) {
  const c = E.ctx, out = gn(c, 1), send = gn(c, 0.25);
  out.connect(E.worldBus); out.connect(send); send.connect(E.revIn);
  const decks = [];
  for (let i = 0; i < 2; i++) { const g = gn(c, 0); g.connect(out); decks.push({ g, armed: null, src: null, buf: '', lvl: 0 }); }
  return { out, decks, cur: 0 };
}

/** Wake a sleeping bed: start its armed loops at random offsets. False if not armed yet (idle will arm it). */
export function wakeBed(E, Bd, t) {
  const sp = Bd.specs;
  for (let i = 0; i < sp.length; i++) if (!Bd.armed[i]) { needIdle(E); return false; }
  for (let i = 0; i < sp.length; i++) { // armed in idle time with buffer, loop, rate (or wave, frequency) set
    const s = Bd.armed[i];
    Bd.armed[i] = null; Bd.run[i] = s;
    if (sp[i].buf) s.start(t, erng() * s.buffer.duration); else s.start(t);
  }
  for (let i = 0; i < Bd.ids.length; i++) E.pv[Bd.ids[i]] = NaN;
  Bd.on = true; Bd.quiet = 0; E.wakes++; needIdle(E);
  return true;
}

export function sleepBed(E, Bd, t) {
  for (let i = 0; i < Bd.run.length; i++) { const s = Bd.run[i]; if (s) { try { s.stop(t); } catch (e) { /* ignore */ } Bd.run[i] = null; } }
  Bd.on = false; needIdle(E);
}

/** Crossfade the ambience to bank buffer `name` ('' = none) at `level`. */
export function ambSet(E, name, level, t) {
  const A = E.amb; if (!A) return;
  const D = A.decks[A.cur];
  if (D.buf === name) {
    if (name && Math.abs(level - D.lvl) > 0.05 * D.lvl) { D.g.gain.setTargetAtTime(level, t, 0.8); D.lvl = level; }
    return;
  }
  if (D.src) { D.g.gain.cancelScheduledValues(t); D.g.gain.setTargetAtTime(0, t, 0.35); try { D.src.stop(t + 2.5); } catch (e) { /* ignore */ } D.src = null; D.buf = ''; needIdle(E); }
  if (!name) return;
  const b = E.bank[name], N = A.decks[A.cur ^ 1];
  if (!b || !N.armed) { needIdle(E); return; } // retried on the next call
  A.cur ^= 1;
  const s = N.armed; N.armed = null; N.src = s;
  s.buffer = b; s.loop = true; s.start(t, erng() * b.duration);
  N.buf = name; N.lvl = level;
  N.g.gain.cancelScheduledValues(t); N.g.gain.setValueAtTime(0, t); N.g.gain.setTargetAtTime(level, t, 0.8);
  needIdle(E);
}

/**
 * Smoothly steer a bed parameter toward v, unless it is within the dead band of the last value sent
 * (relative eps, with a floor so values near zero don't chatter). Each call that passes costs one
 * setTargetAtTime; most frames send none.
 */
export function setp(E, id, param, v, t, tau, eps) {
  const o = E.pv[id];
  if (o === o && Math.abs(v - o) <= eps * Math.max(Math.abs(o), 0.05)) return;
  param.setTargetAtTime(v, t, tau); E.pv[id] = v; E.calls++;
}
/** As setp, with an absolute dead band (for pan). */
export function setpa(E, id, param, v, t, tau, abs) {
  const o = E.pv[id];
  if (o === o && Math.abs(v - o) <= abs) return;
  param.setTargetAtTime(v, t, tau); E.pv[id] = v; E.calls++;
}


// ---------------------------------------------------------------- the bank: jobs, the worker, arming
// [name, variant, minimum tier rank]. Most useful first: what the first touches need (UI, rustle, tick, tear),
// then the beds, then the rest. Extra variants only above the low tier; ambience assets (rank 9) are built
// only when a scene asks for them (want()). Graph jobs build nodes (main thread, idle time); the rest are
// buffers (worker; or idle time when there is no worker). Every job is small (≲ 2 ms on a desktop core).
const JOBS = [
  ['white'], ['slots'], ['rustle', 0], ['tick', 0], ['tick', 1], ['snap', 0], ['grain', 0], ['tex'],
  ['pink'], ['wind'], ['flutter'], ['rustle', 1], ['shing', 0], ['whoosh', 0], ['plink', 0], ['splash', 0],
  ['bloop', 0], ['strike', 0], ['whoomph', 0], ['pop', 0], ['tap', 0], ['jingle', 0], ['tink', 0],
  ['crackle', 0], ['crackle', 1], ['fire'], ['rain'], ['patter'], ['rainBed'], ['grain', 1], ['crinkle'],
  ['ir'], ['amb'], ['shing', 1], ['rustle', 2], ['plink', 1], ['splash', 1], ['strike', 1], ['pop', 1], ['snap', 1],
  ['tap', 1], ['jingle', 1], ['tink', 1], ['whoosh', 1], ['bloop', 1], ['whoomph', 1],
  ['shing', 2, 1], ['rustle', 3, 1], ['plink', 2, 1], ['splash', 2, 1], ['strike', 2, 1], ['pop', 2, 1], ['pop', 3, 1],
  ['snap', 2, 1], ['tap', 2, 1], ['jingle', 2, 1], ['jingle', 3, 1], ['tink', 2, 1],
  ['hum', 0, 9], ['crickets', 0, 9], ['moon', 0, 9], ['thunder', 0, 9],
  ['chime', 0, 9], ['chime', 1, 9], ['chime', 2, 9], ['chime', 3, 9], ['chime', 4, 9],
];
const GRAPH = { slots: 1, tex: 1, wind: 1, flutter: 1, fire: 1, rainBed: 1, amb: 1 };
const VARIANTS = { shing: 1, whoosh: 1, plink: 1, splash: 1, bloop: 1, tick: 1, strike: 1, whoomph: 1, pop: 1, snap: 1, rustle: 1, tap: 1, jingle: 1, tink: 1, chime: 1 };
/** Is job i part of the default pass for this tier? (sync engines build the ambience too.) */
const inPass = (E, i) => { const r = JOBS[i][2] | 0; return r === 9 ? E.sync : r <= E.rank; };
const bankKey = (n, v) => (n === 'grain' ? (v ? 'grainFine' : 'grain') : n === 'crackle' ? (v ? 'crackleDense' : 'crackle') : n);

function haveBuf(E, i) {
  const n = JOBS[i][0], v = JOBS[i][1] | 0;
  return VARIANTS[n] ? !!E.bank[n][v] : !!E.bank[bankKey(n, v)];
}

function jobDone(E, i) {
  switch (JOBS[i][0]) {
    case 'slots': return E.slots.length >= E.tier.voices;
    case 'tex': return !!E.tex;
    case 'wind': return !!E.wind;
    case 'flutter': return !!E.flutter;
    case 'fire': return !!E.fire;
    case 'rainBed': return !!E.rainBed;
    case 'amb': return !!E.amb;
    default: return haveBuf(E, i);
  }
}

/** Raw { sr, ch } from the bank → an AudioBuffer on this context. */
function wrap(E, raw) {
  const ch = raw.ch, sr = raw.sr;
  let b = null;
  try { b = E.ctx.createBuffer(ch.length, ch[0].length, sr); } catch (e) { b = null; }
  if (b) { for (let c = 0; c < ch.length; c++) b.getChannelData(c).set(ch[c]); return b; }
  // this browser won't make a buffer at that rate: resample (linear) to the context's own
  const r = E.ctx.sampleRate, n = Math.max(2, Math.round((ch[0].length * r) / sr)), k = sr / r;
  b = E.ctx.createBuffer(ch.length, n, r);
  for (let c = 0; c < ch.length; c++) {
    const s = ch[c], d = b.getChannelData(c), last = s.length - 1;
    for (let i = 0; i < n; i++) { const x = i * k, i0 = x | 0, f = x - i0; d[i] = i0 < last ? s[i0] * (1 - f) + s[i0 + 1] * f : s[last]; }
  }
  return b;
}
function store(E, n, v, raw) {
  const b = wrap(E, raw);
  if (VARIANTS[n]) E.bank[n][v] = b; else E.bank[bankKey(n, v)] = b;
  if (n === 'ir') E.conv.buffer = b; // the reverb wakes up
}

/** One step of job i on this thread (graph jobs build nodes; buffer jobs synthesise here: the fallback path). */
function runJob(E, i) {
  if (jobDone(E, i)) return;
  const t0 = now(), n = JOBS[i][0], v = JOBS[i][1] | 0;
  switch (n) {
    case 'slots': for (let k = 0; k < 2 && E.slots.length < E.tier.voices; k++) E.slots.push(makeSlot(E, E.worldBus)); break; // two a slice
    case 'tex': E.tex = { rip: makeTex(E, 'grain', 1900, 0.9), cut: makeTex(E, 'white', 4300, 0.9), steam: makeTex(E, 'white', 3800, 0.7) }; E.tex.steam.f3.frequency.value = 9000; break;
    case 'wind': E.wind = makeWind(E); break;
    case 'flutter': E.flutter = makeFlutter(E); break;
    case 'fire': E.fire = makeFire(E); break;
    case 'rainBed': E.rainBed = makeRain(E); break;
    case 'amb': E.amb = makeAmb(E); break;
    default: store(E, n, v, gen()[n](n === 'ir' ? E.tier.ir : v, E.ctx.sampleRate));
  }
  const ms = now() - t0;
  E.genMs += ms; E.jobMs[n + (JOBS[i].length > 1 ? v : '')] = +ms.toFixed(2);
}

// The worker: makeBank's own source plus a tiny queue (urgent jobs first). Results come back as transferred
// Float32Arrays, so nothing is copied twice; the main thread only wraps them in AudioBuffers.
const WORKER_TAIL = 'var U=[],Q=[],busy=0;onmessage=function(e){var j=e.data;(j.u?U:Q).push(j);if(!busy){busy=1;setTimeout(run,0)}};' +
  'function run(){var j=U.length?U.shift():Q.shift(),t=performance.now();try{var r=G[j.n](j.v,j.sr),x=[];for(var i=0;i<r.ch.length;i++)x.push(r.ch[i].buffer);' +
  'postMessage({i:j.i,sr:r.sr,ch:r.ch,ms:performance.now()-t},x)}catch(err){postMessage({i:j.i,err:String(err)})}' +
  'if(U.length||Q.length)setTimeout(run,0);else busy=0}';

function startWorker() {
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    const url = URL.createObjectURL(new Blob(['var G=(' + makeBank.toString() + ')();' + WORKER_TAIL], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = onWorker; w.onerror = onWorkerError;
    return w;
  } catch (e) { return null; } // CSP, or no workers: idle-time synthesis instead
}
function post(E, i, urgent) {
  const n = JOBS[i][0];
  E.posted[i] = 1;
  E.worker.postMessage({ i, n, v: n === 'ir' ? E.tier.ir : JOBS[i][1] | 0, sr: E.ctx.sampleRate, u: urgent ? 1 : 0 });
}
function onWorker(e) {
  const E = LIVE, m = e.data;
  if (!E || E.dead || !m || !E.worker) return;
  if (m.err) { workerFail(E); return; }
  const t0 = now();
  if (!haveBuf(E, m.i)) store(E, JOBS[m.i][0], JOBS[m.i][1] | 0, m);
  E.genMs += now() - t0; E.workerMs += m.ms || 0; E.fromWorker++;
  needIdle(E); // arm what this buffer makes possible
}
function onWorkerError(ev) { if (ev && ev.preventDefault) ev.preventDefault(); if (LIVE) workerFail(LIVE); }
function workerFail(E) {
  if (E.worker) { try { E.worker.terminate(); } catch (e) { /* ignore */ } }
  E.worker = null; E.posted.fill(0); E.job = 0; // everything not yet here is built in idle time instead
  needIdle(E);
}

/** The first job not done yet for asset E.want, or −1 (fallback path). */
function wantJob(E) {
  for (let i = 0; i < JOBS.length; i++) if (JOBS[i][0] === E.want && !jobDone(E, i)) return i;
  return -1;
}

function armBed(E, Bd) {
  if (!Bd) return false;
  for (let i = 0; i < Bd.specs.length; i++) if (!Bd.armed[i]) {
    const p = Bd.specs[i];
    let s;
    if (p.buf) {
      const b = E.bank[p.buf]; if (!b) continue; // not synthesised yet
      s = E.ctx.createBufferSource(); s.buffer = b; s.loop = true; s.playbackRate.value = p.rate;
    } else { s = E.ctx.createOscillator(); s.type = p.type; s.frequency.value = p.osc; if (p.fm) p.fm.connect(s.frequency); }
    for (let k = 0; k < p.to.length; k++) s.connect(p.to[k]);
    Bd.armed[i] = s; return true;
  }
  return false;
}
function armTex(E, V) {
  const b = E.bank[V.buf]; if (!b) return false;
  const s = E.ctx.createBufferSource(); s.buffer = b; s.loop = true; s.connect(V.f1);
  V.armed = s; V.armedBuf = V.buf; return true;
}
function armSrc(E, holder, dest) { const s = E.ctx.createBufferSource(); s.connect(dest); holder.armed = s; return true; }

/** Arm one missing source (voices first: they make the sound of a touch). False when everything is armed. */
function armOne(E) {
  for (let i = 0; i < E.dry.length; i++) if (!E.dry[i].armed) return armSrc(E, E.dry[i], E.dry[i].f1);
  for (let i = 0; i < E.slots.length; i++) if (!E.slots[i].armed) return armSrc(E, E.slots[i], E.slots[i].f1);
  const T = E.tex;
  if (T) {
    if (!T.rip.armed && armTex(E, T.rip)) return true;
    if (!T.cut.armed && armTex(E, T.cut)) return true;
    if (!T.steam.armed && armTex(E, T.steam)) return true;
  }
  if (armBed(E, E.wind) || armBed(E, E.flutter) || armBed(E, E.fire) || armBed(E, E.rainBed)) return true;
  if (E.amb) for (let i = 0; i < 2; i++) { const d = E.amb.decks[i]; if (!d.armed) return armSrc(E, d, d.g); }
  return false;
}

const IDLE_OPT = { timeout: 200 };
/** Live engines do their building in idle time; offline engines just arm everything immediately. */
export function needIdle(E) {
  if (E.sync) { while (armOne(E)) { /* arm everything */ } return; }
  if (E.idleReq || E.dead || E !== LIVE) return;
  E.idleReq = true;
  if (typeof requestIdleCallback === 'function') requestIdleCallback(onIdle, IDLE_OPT);
  else setTimeout(onIdle, 34);
}

function onIdle(dl) {
  const E = LIVE;
  if (!E || E.dead) return;
  E.idleReq = false; E.idles++;
  const t0 = now(), hasDl = !!(dl && typeof dl.timeRemaining === 'function');
  const budget = hasDl ? Math.min(12, dl.timeRemaining()) : 4, forced = !hasDl || !!dl.didTimeout;
  // a worker that never answers (6 s, and 15 idle slices in which its replies could have landed): build here instead
  if (E.worker && !E.fromWorker && t0 - E.workerT0 > 6000 && E.idles - E.workerIdles > 15) workerFail(E);
  let did = 0;
  try {
    for (;;) {
      const left = budget - (now() - t0);
      if (left < 0.5 && did) break;
      if (armOne(E)) { did++; continue; }                    // arming: ~0.1–0.4 ms each
      if (left < 4 && !(forced && !did)) break;             // a job needs real room (or the timeout forced us)
      if (E.want) { const i = wantJob(E); if (i >= 0) { runJob(E, i); did++; continue; } E.want = ''; }
      while (E.job < JOBS.length && (!inPass(E, E.job) || jobDone(E, E.job) || (E.worker && !GRAPH[JOBS[E.job][0]]))) E.job++;
      if (E.job < JOBS.length) { runJob(E, E.job); did++; continue; }
      if (E.worker && !bankDone(E)) return; // the worker is still synthesising; its results call needIdle
      return; // nothing left to do
    }
  } catch (e) { E.dead = true; return; } // the context went away: stop quietly
  needIdle(E);
}

/** Default-pass jobs not done yet (debug). */
export function pending(E) { const out = []; for (let i = 0; i < JOBS.length; i++) if (inPass(E, i) && !jobDone(E, i)) out.push(JOBS[i].join('')); return out; }

/** Has every buffer and node of the default pass arrived? (tests, debug) */
export function bankDone(E) {
  for (let i = 0; i < JOBS.length; i++) if (inPass(E, i) && !jobDone(E, i)) return false;
  return true;
}
