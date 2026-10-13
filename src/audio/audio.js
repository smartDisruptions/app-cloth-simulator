// Audio: every sound in the simulator, synthesised live. Nothing is loaded; nothing exists before the first
// touch. This file is the module's door (CONTRACT.md § Module interface); the work lives in
//   bank.js      the synthesis of every buffer (rips, crackle, rain, the katana, drips, chimes, crickets)
//   engine.js    the graph: master chain, pooled voices, beds, textures, idle-time building
//   director.js  the world → sound mapping, shared with the tests' offline renderer
//   offline.js   (tests only) renders scenarios and recorded sessions through an OfflineAudioContext
//
// Cost: update() runs the director (event aggregation, a few param calls, at most a couple of start()s);
// every node and buffer is made in idle time. Muted for a moment, or hidden, the context is suspended.
import { createEngine, setMaster, activeVoices, bankDone, pending, MASTER } from './engine.js';
import * as director from './director.js';
import { EVENT_TYPES } from '../core/events.js';

const LOOKAHEAD = 0.012; // schedule this far ahead so an attack is never clipped by the render quantum
let W = null, E = null, ctx = null, mutedFor = 0, suspending = false, TRACE = null;

/** Nothing happens until the first gesture: no context, no buffers, no listeners. */
export function init(world) { W = world; }

/** A new cloth (scene load or reset): textures still ringing from the old one stop. */
export function onScene(world) { if (E) director.scene(E, world, ctx.currentTime + LOOKAHEAD); }

/** Create (first call) or wake the AudioContext. Called from every pointer-down and HUD tap. */
export function unlock(world) {
  W = world;
  if (E) {
    if (ctx.state !== 'running' && world.toggles.sound && !document.hidden) resume();
    return;
  }
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return;
  try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return; } }
  try { // iOS: a one-sample silent buffer started inside the gesture opens the output
    const b = ctx.createBuffer(1, 1, 22050), s = ctx.createBufferSource();
    s.buffer = b; s.connect(ctx.destination); s.start(0);
  } catch (e) { /* not needed elsewhere */ }
  E = createEngine(ctx, { tier: world.q && world.q.name, sync: false });
  const t = ctx.currentTime + LOOKAHEAD;
  director.reset(E, world, t);
  if (world.toggles.sound) setMaster(E, MASTER, t, 0.05);
  resume();
  document.addEventListener('visibilitychange', onVisibility);
  // Some WebKit versions only let a context start from pointerup/touchend/click: keep listening until it runs.
  for (let i = 0; i < GESTURES.length; i++) window.addEventListener(GESTURES[i], onGesture, true);
}
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'];
function onGesture() {
  if (!ctx) return;
  if (ctx.state === 'running') { for (let i = 0; i < GESTURES.length; i++) window.removeEventListener(GESTURES[i], onGesture, true); return; }
  if (W && W.toggles.sound && !document.hidden) resume();
}

function noop() {}
function resume() { try { const p = ctx.resume(); if (p && p.then) p.then(noop, noop); } catch (e) { /* ignore */ } suspending = false; }
function onVisibility() {
  if (!ctx) return;
  if (document.hidden) { try { const p = ctx.suspend(); if (p && p.then) p.then(noop, noop); } catch (e) { /* ignore */ } }
  else if (W && W.toggles.sound) resume();
}

/** Per frame (real dt): this frame's events, stats, wind, rain, toggles → sound. */
export function update(world, dt) {
  if (TRACE) record(world);
  if (!E) return;
  const on = director.frame(E, world, ctx.currentTime + LOOKAHEAD, dt);
  if (!on) {
    mutedFor += dt;
    if (mutedFor > 0.6 && !suspending && ctx.state === 'running') {
      suspending = true;
      try { const p = ctx.suspend(); if (p && p.then) p.then(noop, noop); } catch (e) { /* ignore */ }
    }
  } else if (mutedFor > 0) {
    mutedFor = 0;
    if (ctx.state !== 'running' && !document.hidden) resume();
  }
}

/** A UI sound: 'tap', 'tool', 'scene', 'toggle', 'material', 'reset'. */
export function sfx(world, name) {
  if (!E) return;
  director.sfx(E, world, ctx.currentTime + LOOKAHEAD, name);
}

// ---------------------------------------------------------------- test hooks (never used by the page)
/** Engine state for tests: { state, sampleRate, voices, played, stolen, bankDone, genMs }. */
export function debug() {
  if (!E) return null;
  return { state: ctx.state, sampleRate: ctx.sampleRate, voices: activeVoices(E, ctx.currentTime), played: E.played, stolen: E.stolen, bankDone: bankDone(E), genMs: +E.genMs.toFixed(1), tier: E.tierName, paramCalls: E.calls, wakes: E.wakes,
    worker: !!E.worker, fromWorker: E.fromWorker, workerMs: +E.workerMs.toFixed(1),
    idleReq: E.idleReq, job: E.job, dead: E.dead, slotsArmed: E.slots.filter((s) => s.armed).length + '/' + E.slots.length,
    wind: E.wind ? (E.wind.on ? 'on' : 'armed ' + E.wind.armed.map((a) => (a ? 1 : 0)).join('')) : 'none', chimes: E.bank.chime.length,
    textures: E.tex ? ['rip', 'cut', 'steam'].filter((k) => E.tex[k].on).join(' ') : '', idles: E.idles, windSpeed: W && +W.wind.speed.toFixed(2), pending: pending(E).join(' ') };
}
/** Record what the director reads each frame, to replay offline (tests/audio-session.mjs). */
export function startTrace() { TRACE = []; }
export function stopTrace() { const t = TRACE; TRACE = null; return t; }
function record(w) {
  const ev = {};
  for (let i = 0; i < EVENT_TYPES.length; i++) {
    const k = EVENT_TYPES[i], r = w.events[k];
    if (r.n) ev[k] = Array.from(r.data.subarray(0, r.n * 4));
  }
  let hm;
  if (w.materialId === 'chainmail' && w.cloth) { let s = 0; for (let i = 0; i < w.cloth.n; i++) s += w.cloth.heat[i]; hm = Math.min(1, (s / w.cloth.n) * 6); }
  const st = w.stats;
  TRACE.push({
    ev, st: { flutter: st.flutter, kinetic: st.kinetic, burning: st.burning, wetness: st.wetness, tension: st.tension }, dye: w.dyeColor,
    wind: { speed: w.wind.speed, gust: w.wind.gust }, rain: w.rain.intensity, snd: w.toggles.sound,
    ts: w.timeScale, tsT: w.timeScaleTarget, mat: w.materialId, scene: w.sceneId, tier: w.q && w.q.name,
    vp: Array.from(w.camera.viewProj), fire: Array.from(w.lights.firePos), hm, dt: w.frameDt, drag: dragOf(w),
  });
}
function dragOf(w) {
  let m = 0;
  for (const P of w.pointers) if (P.active && P.particle >= 0 && w.cloth) { const o = P.particle * 3, v = w.cloth.vel; m = Math.max(m, Math.hypot(v[o], v[o + 1], v[o + 2])); }
  return m;
}
