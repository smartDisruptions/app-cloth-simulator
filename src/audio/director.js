// The director: reads one frame of the world and decides what it sounds like. The live page (audio.js) and
// the tests' offline renderer (offline.js) both run this exact code, so a WAV from the tests is what the
// page plays. It never allocates: events are aggregated in place, one-shots go through engine.P.
//
// Rules of taste it enforces: bursts become one longer sound (many tears = one rip, never a machine gun);
// every one-shot is rate-limited per type, with a per-frame budget of new voices (by tier); every repeat is
// varied (variant, pitch, filter, pan); slow-mo lowers pitch and stretches what plays, muffles the world
// and opens the reverb, while the katana rings clear and deep on top.
import { P, resetP, play, excite, texIdle, texStop, texBuffer, setp, setpa, wakeBed, sleepBed, ambSet, setMaster, want, ID, MASTER } from './engine.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

let ds = 0x2545f491;
function rr() { let x = ds; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; ds = x; return (x >>> 0) / 4294967296; }

/**
 * Each material's voice. rip*: the tear texture (buffer, band centre/Q, body peak, top lowpass, grain
 * rate, level, decay); rus*: rustle colour; fl*: flutter bands; swish; pat/tap*: rain on it; cutF: the
 * blade parting it; metal: rings instead of rips.
 */
export const MATS = {
  cotton: { rip: 'grain', ripF: 1900, ripQ: 0.9, bodyF: 600, bodyG: 4, ripLP: 7500, ripRate: 1, ripLvl: 1.35, ripTau: 0.06, rusHP: 700, rusLP: 5200, flLo: 430, flHi: 1800, flQ: 1.1, flQh: 1, swish: 1100, patLP: 2600, tapHP: 120, tapLP: 2600, cutF: 4300, metal: 0 },
  silk: { rip: 'grainFine', ripF: 4300, ripQ: 1.1, bodyF: 1800, bodyG: 0, ripLP: 12000, ripRate: 1.2, ripLvl: 1, ripTau: 0.05, rusHP: 1600, rusLP: 9000, flLo: 650, flHi: 2900, flQ: 1.3, flQh: 1.2, swish: 1700, patLP: 3800, tapHP: 300, tapLP: 3800, cutF: 6200, metal: 0 },
  denim: { rip: 'grain', ripF: 1100, ripQ: 0.85, bodyF: 240, bodyG: 8, ripLP: 5000, ripRate: 0.72, ripLvl: 1.5, ripTau: 0.08, rusHP: 300, rusLP: 3200, flLo: 300, flHi: 1150, flQ: 1, flQh: 0.9, swish: 800, patLP: 1900, tapHP: 80, tapLP: 1900, cutF: 3000, metal: 0 },
  velvet: { rip: 'grain', ripF: 850, ripQ: 0.7, bodyF: 300, bodyG: 3, ripLP: 1500, ripRate: 0.85, ripLvl: 1.35, ripTau: 0.09, rusHP: 200, rusLP: 1600, flLo: 320, flHi: 950, flQ: 0.8, flQh: 0.8, swish: 650, patLP: 1300, tapHP: 80, tapLP: 1300, cutF: 2400, metal: 0 },
  chainmail: { rip: 'grain', ripF: 5200, ripQ: 2, bodyF: 3000, bodyG: 0, ripLP: 12000, ripRate: 1, ripLvl: 0.3, ripTau: 0.05, rusHP: 1500, rusLP: 12000, flLo: 2700, flHi: 4300, flQ: 7, flQh: 9, swish: 2600, patLP: 9000, tapHP: 1200, tapLP: 12000, cutF: 5200, metal: 1 },
  aurora: { rip: 'crinkle', ripF: 5200, ripQ: 1, bodyF: 2400, bodyG: 0, ripLP: 13000, ripRate: 1.1, ripLvl: 1.6, ripTau: 0.045, rusHP: 2000, rusLP: 11000, flLo: 900, flHi: 3800, flQ: 1.6, flQh: 1.4, swish: 2200, patLP: 4500, tapHP: 400, tapLP: 4500, cutF: 7000, metal: 0 },
};

/** Per-scene ambience: [bank buffer, level]. Barely there. */
const AMB = { noren: ['hum', 0.035], embers: ['crickets', 0.06], unveil: ['moon', 0.025] };
/** How much each scene's cloth flaps out loud (the carp streamer is the showcase). */
const FLAP = { koinobori: 1.4 };
/** Each scene's space: how much of the room comes back (a gallery hall, a walled courtyard, open sky). */
const ROOM = { unveil: 1, embers: 0.8, noren: 0.7, monsoon: 0.5, banner: 0.4, koinobori: 0.35 };
const DYE_SEMI = [0, 5, 9, -5];        // indigo, vermilion, gold, sumi: each ink has its own register
const PENTA = [0, 2, 4, 7, 9];         // dragging the dye tool walks a pentatonic scale
/** events.ui codes: 1 tool · 2 scene · 3 material · 4 toggle · 5 ink colour pick · 6 reset · 7 sheet open · 8 sheet close. */
const UI_CODE = { tap: 0, tool: 1, scene: 2, material: 3, toggle: 4, ink: 5, reset: 6, open: 7, close: 8 };

// rate-limit slots
const T_SHING = 0, T_JINGLE = 1, T_IGNITE = 2, T_POP = 3, T_DRIP = 4, T_SPLASH = 5, T_PIN = 6, T_GRAB = 7, T_RELEASE = 8,
  T_DYE = 9, T_TAP = 10, T_SNAP = 11, T_CHIME = 12, T_THUNDER = 13, T_TINK = 14, T_WHOOSH = 15, T_UI = 16;

const S = {
  f: 0, trig: 0, muted: false, matId: '', mat: MATS.cotton, tuned: null, scene: '',
  last: new Float64Array(26), lastV: new Int8Array(26), lastUI: -1e9,
  hitRate: 0, popN: 0, popX: 0, popY: 0, popZ: 0, nextPop: 0, nextTap: 0, ripQuiet: 0,
  dyeStep: 0, heat: 0, thunderAt: 0, sizzleAt: 0, keSlow: 0, shing: null, shingAt: 0, grabPan: 0,
};

/** Fresh state (unlock, a new offline render). */
export function reset(E, w, t) {
  S.f = 0; S.muted = false; S.matId = ''; S.tuned = null; S.scene = '';
  S.last.fill(-1e9); S.lastV.fill(-1); S.lastUI = -1e9;
  S.hitRate = 0; S.popN = 0; S.popX = S.popY = S.popZ = 0; S.nextPop = 0; S.nextTap = 0; S.ripQuiet = 0;
  S.dyeStep = 0; S.heat = 0; S.thunderAt = t + 6; S.sizzleAt = 0; S.keSlow = 0; S.shing = null; S.shingAt = 0; S.grabPan = 0;
  ds = 0x2545f491;
}

function pickVar(type, n) {
  let v = (rr() * n) | 0;
  if (n > 1 && v === S.lastV[type]) v = (v + 1) % n;
  S.lastV[type] = v;
  return v;
}

/** Stereo position of a world point: its NDC x, softened (never hard left or right). */
function panAt(w, x, y, z) {
  const m = w.camera.viewProj, cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(cw > 1e-4)) return 0;
  const nx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
  return nx < -1 ? -0.8 : nx > 1 ? 0.8 : nx * 0.8;
}

// ---------------------------------------------------------------- the frame
/** One frame. Returns false while muted (the caller may then suspend the context). */
export function frame(E, w, t, dt) {
  S.f++;
  if (!w.toggles.sound) {
    if (!S.muted) { S.muted = true; setMaster(E, 0, t + 0.09, 0.03); } // let the toggle's own click through
    return false;
  }
  if (S.muted) { S.muted = false; setMaster(E, MASTER, t, 0.08); }
  if (w.sceneId !== S.scene) sceneChange(E, w, t);
  const ev = w.events, ts = w.timeScale, slow = Math.min(ts, w.timeScaleTarget);
  const oneRate = 0.8 + 0.2 * clamp01((slow - 0.22) / 0.78); // slow-mo: one-shots a little lower and longer
  if (w.materialId !== S.matId) { S.matId = w.materialId; S.mat = MATS[S.matId] || MATS.cotton; }
  const M = S.mat;
  if (S.tuned !== M && E.tex) tune(E, M, t);
  S.trig = E.tier.trig;

  if (ev.ui.n) for (let k = 0; k < ev.ui.n; k++) ui(E, w, t, ev.ui.data[k * 4] | 0);
  if (ev.slice.n) slices(E, w, t, ev.slice, M, slow);
  if (ev.tear.n) tears(E, w, t, ev.tear, M, oneRate);
  if (ev.ignite.n) ignite(E, w, t, ev.ignite, M, oneRate);
  if (ev.burnout.n || S.popN) burnouts(E, w, t, ev.burnout, oneRate);
  if (ev.steam.n) steam(E, w, t, ev.steam);
  if (ev.grab.n) grab(E, w, t, ev.grab, M, oneRate);
  if (ev.release.n) release(E, w, t, ev.release, M, oneRate);
  if (ev.pin.n) pin(E, w, t, ev.pin, oneRate);
  if (ev.dye.n) dye(E, w, t, ev.dye, oneRate);
  if (ev.drip.n) drip(E, w, t, ev.drip, oneRate);
  if (ev.splash.n) splash(E, w, t, ev.splash, oneRate);
  rainHits(E, w, t, dt, ev.rainHit, M, oneRate);
  if ((S.f & 1) === 0 && (w.stats.tension || 0) > 1.55) strain(E, w, t, M, oneRate);

  // beds: at most one every other frame, round robin (each is steered 7.5×/s; setTargetAtTime makes that seamless)
  const ph = S.f & 7, dt8 = dt * 8;
  if (ph === 0) { wind(E, w, t, ts, dt8); slowmo(E, t, ts); }
  else if (ph === 2) flutter(E, w, t, ts, M, dt8);
  else if (ph === 4) fire(E, w, t, ts, M, dt8);
  else if (ph === 6) rain(E, w, t, ts, M, dt8);
  else if ((S.f & 31) === 5) ambience(E, w, t, oneRate);

  const T = E.tex;
  if (T) { texIdle(E, T.rip, t); texIdle(E, T.cut, t); texIdle(E, T.steam, t); }
  return true;
}

/** A UI sound by name ('tap', 'tool', 'scene', 'toggle', 'material', 'reset'). */
export function sfx(E, w, t, name) {
  if (!w.toggles.sound) return;
  const c = UI_CODE[name];
  ui(E, w, t, c === undefined ? 0 : c);
}

function sceneChange(E, w, t) {
  S.scene = w.sceneId;
  setp(E, ID.room, E.revOut.gain, ROOM[w.sceneId] || 0.6, t, 0.5, 0.02);
  S.thunderAt = t + 6 + rr() * 8;
  S.hitRate = 0;
}

/** A new cloth was built (scene load or reset): stop textures still ringing from the old one. */
export function scene(E, w, t) {
  sceneChange(E, w, t);
  S.ripQuiet = 0; S.popN = 0; S.popX = S.popY = S.popZ = 0;
  const T = E.tex;
  if (T) { texStop(E, T.rip, t); texStop(E, T.cut, t); texStop(E, T.steam, t); }
}

/** Re-voice the textures for a material (once per change). */
function tune(E, M, t) {
  S.tuned = M;
  const R = E.tex.rip, C = E.tex.cut;
  texBuffer(E, R, M.rip, t);
  R.f1.frequency.setTargetAtTime(M.ripF, t, 0.02); R.f1.Q.setTargetAtTime(M.ripQ, t, 0.02);
  R.f2.frequency.setTargetAtTime(M.bodyF, t, 0.02); R.f2.gain.setTargetAtTime(M.bodyG, t, 0.02);
  R.f3.frequency.setTargetAtTime(M.ripLP, t, 0.02);
  C.f1.frequency.setTargetAtTime(M.cutF, t, 0.02);
}

// ---------------------------------------------------------------- one-shots
function ui(E, w, t, code) {
  const c = code < 0 || code > 9 ? 0 : code;
  if (t - S.last[T_UI + c] < 0.06) return; // the HUD's sfx() and its ui event in the same gesture: one sound
  if (c === 0 && t - S.lastUI < 0.08) return; // a generic tap yields to the control's own sound
  const U = E.bank.ui;
  let b = U.tap, g = 0.6, send = 0.04, rate = 1 + (rr() - 0.5) * 0.04;
  if (c === 1) { b = U.tool; g = 0.55; }
  else if (c === 2) { b = U.scene; g = 0.25; send = 0.3; rate = 1; } // soft and wide, under the title card
  else if (c === 4) { b = U.toggle; g = 0.62; }
  else if (c === 5) { // picking an ink: a small drop, in that ink's register
    const K = E.bank.bloop, dc = w.dyeColor | 0;
    if (K.length) { b = K[0]; g = 0.3; send = 0.1; rate = 1.7 * Math.pow(2, DYE_SEMI[dc >= 0 && dc < 4 ? dc : 0] / 12); }
  }
  else if (c === 6) { b = U.reset; g = 0.42; send = 0.1; }
  else if (c === 7) { b = U.open; g = 0.34; send = 0.05; }
  else if (c === 8) { b = U.close; g = 0.3; send = 0.05; }
  else if (c === 3) { if (swatch(E, t)) { S.last[T_UI + c] = t; S.lastUI = t; } return; }
  if (!b) return;
  resetP(); P.prio = 9; P.buf = b; P.rate = rate; P.gain = g; P.send = send;
  if (play(E, true, t)) { S.last[T_UI + c] = t; S.lastUI = t; }
}

/** Choosing a material lets you hear it: its rustle, its rings. */
function swatch(E, t) {
  const M = S.mat, K = E.bank;
  resetP(); P.prio = 9; P.send = 0.06;
  if (M.metal) { if (!K.jingle.length) return false; P.buf = K.jingle[pickVar(T_JINGLE, K.jingle.length)]; P.gain = 0.32; P.hp = 1200; }
  else { if (!K.rustle.length) return false; P.buf = K.rustle[pickVar(T_GRAB, K.rustle.length)]; P.gain = 0.5; P.hp = M.rusHP; P.lp = M.rusLP; P.rate = 1.15; }
  return play(E, true, t);
}

function jingleAt(E, t, pan, g, rate) {
  const K = E.bank.jingle;
  if (!K.length || t - S.last[T_JINGLE] < 0.11 || S.trig <= 0) return;
  resetP(); P.prio = 5; P.buf = K[pickVar(T_JINGLE, K.length)]; P.rate = rate * (0.9 + 0.2 * rr()); P.gain = g; P.pan = pan; P.hp = 1500; P.send = 0.12;
  if (play(E, false, t)) { S.last[T_JINGLE] = t; S.trig--; }
}

/** The katana: one shing per swipe (deeper in slow-mo), an air whoosh, and the cloth parting under the blade. */
function slices(E, w, t, r, M, slow) {
  const d = r.data;
  let cnt = 0, x = 0, y = 0, z = 0;
  for (let k = 0; k < r.n; k++) { const o = k * 4, c = d[o + 3] > 0 ? d[o + 3] : 1; cnt += c; x += d[o] * c; y += d[o + 1] * c; z += d[o + 2] * c; }
  x /= cnt; y /= cnt; z /= cnt;
  const pan = panAt(w, x, y, z), big = Math.min(1, cnt / 14); // stretch + shear threads only
  const C = E.tex && E.tex.cut;
  if (C) excite(E, C, t, (0.22 + 0.4 * big) * (M.metal ? 0.5 : 1), pan, 0.03, 0.06, 0.8 + 0.2 * slow);
  if (M.metal) jingleAt(E, t, pan, 0.35 + 0.3 * big, 0.9 + 0.1 * slow);
  if (t - S.last[T_SHING] < 0.3) {
    // the blade's ring travels with the swipe
    const sl = S.shing;
    if (sl && sl.start === S.shingAt && Math.abs(pan - sl.panV) > 0.03) { sl.pan.pan.setTargetAtTime(pan, t, 0.05); sl.panV = pan; E.calls++; }
    return;
  }
  const deep = 0.6 + 0.4 * clamp01((slow - 0.22) / 0.75);
  const K = E.bank;
  if (K.shing.length) {
    resetP(); P.prio = 8; P.buf = K.shing[pickVar(T_SHING, K.shing.length)];
    P.rate = deep * (M.metal ? 1.12 : 1) * (0.97 + 0.06 * rr()); P.gain = 0.58 + 0.3 * big; P.pan = pan;
    P.send = 0.28 + 0.3 * (1 - deep); P.hp = 500;
    if (play(E, true, t)) { S.last[T_SHING] = t; S.shing = E.lastSlot; S.shingAt = E.lastSlot.start; }
  }
  if (K.whoosh.length) {
    resetP(); P.prio = 6; P.buf = K.whoosh[pickVar(T_WHOOSH, K.whoosh.length)]; P.rate = 1.35 * deep;
    P.gain = 0.3 + 0.2 * big; P.pan = pan * 0.7; P.hp = 250; P.send = 0.08;
    if (play(E, false, t)) S.trig--;
  }
}

/** Tears: aggregated into the rip texture, so a run of breaking threads is one continuous rip. */
function tears(E, w, t, r, M, oneRate) {
  const d = r.data, n = r.n;
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < n; k++) { x += d[k * 4]; y += d[k * 4 + 1]; z += d[k * 4 + 2]; }
  const pan = panAt(w, x / n, y / n, z / n);
  if (M.metal) { jingleAt(E, t, pan, Math.min(0.5, 0.22 + 0.06 * n), oneRate); return; }
  const V = E.tex && E.tex.rip; if (!V) return;
  const fresh = t > S.ripQuiet;
  const lvl = M.ripLvl * Math.min(1.25, 0.45 + 0.2 * Math.log2(1 + n));
  if (excite(E, V, t, lvl, pan, 0.045 + 0.004 * Math.min(n, 12), M.ripTau, M.ripRate * oneRate * (0.96 + 0.08 * rr()))) {
    S.ripQuiet = t + 0.045 + M.ripTau * 2.5;
  }
  const K = E.bank.snap;
  if (fresh && K.length && t - S.last[T_SNAP] > 0.12 && S.trig > 0) { // the first thread to go
    resetP(); P.prio = 5; P.buf = K[pickVar(T_SNAP, K.length)]; P.rate = oneRate * M.ripRate * (0.9 + 0.2 * rr());
    P.gain = 0.5 * lvl; P.pan = pan; P.hp = M.rusHP * 0.6; P.lp = M.ripLP; P.send = 0.05;
    if (play(E, false, t)) { S.last[T_SNAP] = t; S.trig--; }
  }
}

/** Threads near breaking (stats.tension: worst strain, ~1 at rest, ~2.2 at a rip) creak: the rip's grain, slow and quiet. */
function strain(E, w, t, M, oneRate) {
  if (M.metal || t < S.ripQuiet) return; // chainmail doesn't creak; a rip already covers it
  const V = E.tex && E.tex.rip; if (!V) return;
  const k = smooth(1.55, 2.1, w.stats.tension);
  excite(E, V, t, M.ripLvl * 0.16 * k, S.grabPan, 0.08, 0.1, M.ripRate * 0.55 * oneRate);
}

/** A match strike, then the flame catching (a whoomph a beat later). */
function ignite(E, w, t, r, M, oneRate) {
  if (t - S.last[T_IGNITE] < 0.14 || S.trig <= 0) return;
  const o = (r.n - 1) * 4, d = r.data, str = d[o + 3] > 0 ? clamp01(d[o + 3]) : 1, pan = panAt(w, d[o], d[o + 1], d[o + 2]);
  const K = E.bank;
  S.last[T_IGNITE] = t;
  if (K.strike.length) {
    resetP(); P.prio = 7; P.buf = K.strike[pickVar(T_IGNITE, K.strike.length)]; P.rate = oneRate * (0.94 + 0.12 * rr());
    P.gain = 0.36; P.pan = pan; P.hp = 900; P.send = 0.06;
    if (play(E, false, t)) S.trig--;
  }
  if (K.whoomph.length && S.trig > 0) {
    resetP(); P.prio = 7; P.buf = K.whoomph[(rr() * K.whoomph.length) | 0]; P.rate = oneRate * (0.92 + 0.16 * rr());
    P.gain = (M.metal ? 0.26 : 0.6) * (0.6 + 0.4 * str); P.pan = pan; P.lp = 2400; P.send = 0.16; P.delay = 0.045;
    if (play(E, false, t)) S.trig--;
  }
}

/** Cloth burning through: soft pops, never more than a few a second (the crackle bed carries the density). */
function burnouts(E, w, t, r, oneRate) {
  const n = r.n;
  if (n) { const d = r.data; for (let k = 0; k < n; k++) { S.popX += d[k * 4]; S.popY += d[k * 4 + 1]; S.popZ += d[k * 4 + 2]; } S.popN += n; }
  if (S.popN <= 0 || t < S.nextPop || S.trig <= 0) return;
  const K = E.bank.pop; if (!K.length) return;
  const pan = panAt(w, S.popX / S.popN, S.popY / S.popN, S.popZ / S.popN);
  resetP(); P.prio = 3; P.buf = K[pickVar(T_POP, K.length)]; P.rate = oneRate * (0.8 + 0.45 * rr());
  P.gain = Math.min(0.35, 0.15 + 0.06 * Math.log2(1 + S.popN)); P.pan = pan; P.send = 0.08;
  if (play(E, false, t)) S.trig--;
  S.nextPop = t + 0.07 + rr() * 0.16; S.popN = 0; S.popX = S.popY = S.popZ = 0;
}

/** Water meeting heat: a hiss that lingers. */
function steam(E, w, t, r) {
  const V = E.tex && E.tex.steam; if (!V) return;
  const d = r.data, n = r.n;
  let a = 0, x = 0, y = 0, z = 0;
  for (let k = 0; k < n; k++) { const o = k * 4; a += d[o + 3] > 0 ? d[o + 3] : 0; x += d[o]; y += d[o + 1]; z += d[o + 2]; }
  // amount: kg of water flashed to steam (a gram is a good hiss)
  excite(E, V, t, Math.min(0.3, 0.1 + 0.06 * Math.log2(1 + n + a * 1000)), panAt(w, x / n, y / n, z / n), 0.12, 0.22, 0.9 + 0.2 * rr());
}

function grab(E, w, t, r, M, oneRate) {
  if (t - S.last[T_GRAB] < 0.05 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, pan = panAt(w, d[o], d[o + 1], d[o + 2]);
  S.grabPan = pan; // where the hand is: the strain creaks there
  if (M.metal) { jingleAt(E, t, pan, 0.3, oneRate); S.last[T_GRAB] = t; return; }
  const K = E.bank.rustle; if (!K.length) return;
  resetP(); P.prio = 6; P.buf = K[pickVar(T_GRAB, K.length)]; P.rate = oneRate * (0.94 + 0.12 * rr());
  P.gain = 0.47; P.pan = pan; P.hp = M.rusHP; P.lp = M.rusLP; P.send = 0.05;
  if (play(E, false, t)) { S.last[T_GRAB] = t; S.trig--; }
}

/** Letting go: a whoosh as big and fast as the fling. */
function release(E, w, t, r, M, oneRate) {
  if (t - S.last[T_RELEASE] < 0.08 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, sp = d[o + 3];
  if (!(sp > 0.7)) return;
  const g = clamp01((sp - 0.7) / 6), pan = panAt(w, d[o], d[o + 1], d[o + 2]), K = E.bank.whoosh;
  if (!K.length) return;
  resetP(); P.prio = 5; P.buf = K[pickVar(T_RELEASE, K.length)]; P.rate = oneRate * (0.8 + 0.55 * g) * (0.95 + 0.1 * rr());
  P.gain = 0.12 + 0.45 * g; P.pan = pan; P.hp = 180 + 300 * g; P.lp = 2500 + 6000 * g; P.send = 0.06;
  if (play(E, false, t)) { S.last[T_RELEASE] = t; S.trig--; }
  if (M.metal && g > 0.2) jingleAt(E, t, pan, 0.2 + 0.3 * g, oneRate);
}

function pin(E, w, t, r, oneRate) {
  if (t - S.last[T_PIN] < 0.04 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, K = E.bank.tick; if (!K.length) return;
  const on = d[o + 3] > 0.5 ? 0 : 1;
  resetP(); P.prio = 6; P.buf = K[on < K.length ? on : 0]; P.rate = oneRate * (0.97 + 0.06 * rr());
  P.gain = 0.63; P.pan = panAt(w, d[o], d[o + 1], d[o + 2]); P.send = 0.05;
  if (play(E, false, t)) { S.last[T_PIN] = t; S.trig--; }
}

/** Ink: a liquid bloop, pitched by colour; a drag of drops walks up a pentatonic scale. */
function dye(E, w, t, r, oneRate) {
  if (t - S.last[T_DYE] < 0.075 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, K = E.bank.bloop; if (!K.length) return;
  const c = d[o + 3] | 0, semi = DYE_SEMI[c >= 0 && c < 4 ? c : 0] + PENTA[S.dyeStep];
  S.dyeStep = (S.dyeStep + 1 + (rr() < 0.3 ? 1 : 0)) % 5;
  resetP(); P.prio = 5; P.buf = K[pickVar(T_DYE, K.length)]; P.rate = oneRate * Math.pow(2, semi / 12);
  P.gain = 0.32; P.pan = panAt(w, d[o], d[o + 1], d[o + 2]); P.send = 0.12;
  if (play(E, false, t)) { S.last[T_DYE] = t; S.trig--; }
}

/** Size → 0..1 (a drop's radius in metres; clamped so any sane scale still sounds right). */
const size01 = (s) => clamp01((s - 0.002) / 0.012);

function drip(E, w, t, r, oneRate) {
  if (t - S.last[T_DRIP] < 0.07 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, K = E.bank.plink; if (!K.length) return;
  const s = size01(d[o + 3]);
  resetP(); P.prio = 4; P.buf = K[pickVar(T_DRIP, K.length)]; P.rate = oneRate * (1.25 - 0.45 * s) * (0.95 + 0.1 * rr());
  P.gain = 0.32 + 0.22 * s; P.pan = panAt(w, d[o], d[o + 1], d[o + 2]); P.send = 0.14;
  if (play(E, false, t)) { S.last[T_DRIP] = t; S.trig--; }
}

function splash(E, w, t, r, oneRate) {
  if (t - S.last[T_SPLASH] < 0.06 || S.trig <= 0) return;
  const d = r.data, o = (r.n - 1) * 4, K = E.bank.splash; if (!K.length) return;
  const s = size01(d[o + 3]);
  resetP(); P.prio = 4; P.buf = K[pickVar(T_SPLASH, K.length)]; P.rate = oneRate * (0.9 + 0.25 * rr()) * (1.1 - 0.2 * s);
  P.gain = 0.34 + 0.28 * s; P.pan = panAt(w, d[o], d[o + 1], d[o + 2]); P.hp = 200; P.send = 0.1;
  if (play(E, false, t)) { S.last[T_SPLASH] = t; S.trig--; }
}

/** Rain on the cloth: the patter bed follows the hit rate; a few individual taps add place and detail. */
function rainHits(E, w, t, dt, r, M, oneRate) {
  const n = r.n;
  S.hitRate += ((dt > 0 ? n / dt : 0) - S.hitRate) * Math.min(1, dt * 2.5);
  if (!n || t < S.nextTap || S.trig <= 0) return;
  const K = M.metal ? E.bank.tink : E.bank.tap; if (!K.length) return;
  const d = r.data, o = ((rr() * n) | 0) * 4, it = d[o + 3] > 0 ? clamp01(d[o + 3]) : 0.6, wet = clamp01(w.stats.wetness || 0);
  resetP(); P.prio = 2; P.buf = K[pickVar(T_TAP, K.length)]; P.pan = panAt(w, d[o], d[o + 1], d[o + 2]); P.send = 0.05;
  if (M.metal) { P.gain = 0.1 + 0.08 * it; P.rate = oneRate * (0.85 + 0.3 * rr()); P.hp = 1200; }
  else { P.gain = 0.14 + 0.14 * it; P.rate = oneRate * (0.88 + 0.26 * rr()) * (1 - 0.18 * wet); P.hp = M.tapHP; P.lp = M.tapLP * (1 - 0.45 * wet); }
  if (play(E, false, t)) S.trig--;
  S.nextTap = t + (0.6 + 0.8 * rr()) / E.tier.taps;
}

// ---------------------------------------------------------------- beds
/** Wake a bed when it has something to say; put it to sleep after 2.5 s of silence. */
function alive(E, Bd, level, t, dt4) {
  if (level > 0.002) {
    Bd.quiet = 0;
    return Bd.on || wakeBed(E, Bd, t);
  }
  if (!Bd.on) return false;
  Bd.quiet += dt4;
  if (Bd.quiet > 2.5) { sleepBed(E, Bd, t); return false; }
  return true;
}

/** Wind: a broad band of air that rises and brightens with speed and gusts, and at gale strength two whistles that wander. */
function wind(E, w, t, ts, dt4) {
  const Bd = E.wind; if (!Bd) return;
  const sp = w.wind.speed || 0, g = clamp01(w.wind.gust || 0), x = Math.min(1.3, sp / 7.5); // levels 0.15 / 2.8 / 7.2 m/s: still is silent
  const body = 1.0 * x * Math.sqrt(Math.sqrt(x)) * (0.8 + 0.4 * g); // ≈ x^1.25 (stereo: +2 dB for phones that sum L+R)
  const wh = 0.2 * smooth(0.42, 1, x) * (0.55 + 0.7 * g);
  if (!alive(E, Bd, body + wh, t, dt4)) return;
  const pitch = 0.6 + 0.4 * ts, f = (470 + 820 * x + 300 * g) * pitch;
  setp(E, ID.wBody, Bd.gBody.gain, body, t, 0.3, 0.08);
  setp(E, ID.wRum, Bd.gRum.gain, body * 0.6 * smooth(0.3, 0.9, x), t, 0.35, 0.1);
  setp(E, ID.wWh, Bd.gWh.gain, wh, t, 0.35, 0.1);
  if (body + wh < 0.003) return; // fading out: leave the colour alone
  setp(E, ID.wLP, Bd.lp.frequency, (450 + 1300 * x * Math.sqrt(Math.sqrt(x)) * (0.8 + 0.4 * g)) * pitch, t, 0.35, 0.08);
  if (wh > 0.002) { setp(E, ID.wF1, Bd.bp1.frequency, f, t, 0.4, 0.06); setp(E, ID.wF2, Bd.bp2.frequency, f * 1.505, t, 0.4, 0.06); }
}

// stats.flutter: the RMS angular speed of the surface normals, rad/s. ~0 still · 5–15 a flag in a breeze · 15–30 snapping in a gale
const FL_LO = 2, FL_HI = 26;
/** Speed of the fastest grabbed vertex (m/s): the user swinging the cloth. */
function dragSpeed(w) {
  if (typeof w.drag === 'number') return w.drag;
  const cl = w.cloth, ps = w.pointers; if (!cl || !ps) return 0;
  let m = 0;
  for (let i = 0; i < ps.length; i++) {
    const v = ps[i].particle; if (!ps[i].active || v < 0) continue;
    const o = v * 3, s = Math.sqrt(cl.vel[o] * cl.vel[o] + cl.vel[o + 1] * cl.vel[o + 1] + cl.vel[o + 2] * cl.vel[o + 2]);
    if (s > m) m = s;
  }
  return m;
}
/** The cloth itself: flapping in the wind (snaps, faster in a gale, slower in slow-mo), and a swish when a hand swings it or it falls. */
function flutter(E, w, t, ts, M, dt4) {
  const Bd = E.flutter; if (!Bd) return;
  const st = w.stats, sp = w.wind.speed || 0, fl = st.flutter || 0, ke = st.kinetic || 0;
  S.keSlow += (ke - S.keSlow) * Math.min(1, dt4 * 0.4); // kinetic the wind explains; swish answers what's above it
  const flap = 0.22 * (FLAP[w.sceneId] || 1) * smooth(FL_LO, FL_HI, fl); // wind or hand: whatever makes it flap
  const swish = 0.26 * smooth(0.25, 2.5, dragSpeed(w)) + 0.12 * smooth(0.15, 1.2, ke - S.keSlow * 1.1);
  if (!alive(E, Bd, flap + swish, t, dt4)) return;
  const metal = M.metal;
  setp(E, ID.fFlap, Bd.gFlap.gain, flap * (metal ? 0.45 : 1), t, 0.15, 0.1);
  setp(E, ID.fSw, Bd.gSw.gain, swish * (metal ? 0.35 : 1), t, 0.1, 0.1);
  if (flap + swish < 0.003) return;
  const rate = Math.max(0.6, Math.min(8, (0.8 + 0.22 * fl) * ts)); // the snaps follow the normals' swing: ~3/s in a breeze, ~5.5/s in a gale
  setp(E, ID.fRateA, Bd.run[1].frequency, rate, t, 0.2, 0.08);
  setp(E, ID.fRateB, Bd.run[2].frequency, rate * 1.37, t, 0.2, 0.08);
  setp(E, ID.fJitA, Bd.jitA.gain, rate * 0.3, t, 0.2, 0.1);
  setp(E, ID.fJitB, Bd.jitB.gain, rate * 1.37 * 0.3, t, 0.2, 0.1);
  const pitch = 0.7 + 0.3 * ts;
  setp(E, ID.fLo, Bd.bpLo.frequency, M.flLo * pitch, t, 0.1, 0.03);
  setp(E, ID.fHi, Bd.bpHi.frequency, M.flHi * pitch, t, 0.1, 0.03);
  setp(E, ID.fLoQ, Bd.bpLo.Q, M.flQ, t, 0.1, 0.05);
  setp(E, ID.fHiQ, Bd.bpHi.Q, M.flQh, t, 0.1, 0.05);
  setp(E, ID.fSwF, Bd.bpSw.frequency, M.swish * (0.8 + 0.4 * clamp01(ke / 3)) * pitch, t, 0.15, 0.1);
}

/** Mean heat of the cloth (chainmail glows instead of burning). Called by fire(), so every 8th frame; O(n). */
function heatMean(w) {
  if (typeof w.hm === 'number') return w.hm;
  const cl = w.cloth; if (!cl || !cl.heat) return 0;
  const h = cl.heat, n = cl.n;
  let s = 0;
  for (let i = 0; i < n; i++) s += h[i];
  S.heat = Math.min(1, (s / Math.max(1, n)) * 6);
  return S.heat;
}

/** Fire: roar and crackle grow with the number of burning vertices; red-hot chainmail sizzles and ticks. */
function fire(E, w, t, ts, M, dt4) {
  const Bd = E.fire; if (!Bd) return;
  const nb = w.stats.burning || 0;
  let roar, cr, dn;
  if (M.metal) {
    const h = heatMean(w);
    roar = 0.08 * h; cr = 0; dn = 0;
    if (h > 0.25 && t > S.sizzleAt) {
      S.sizzleAt = t + 0.25 + rr() * 0.5;
      const V = E.tex && E.tex.steam; if (V) excite(E, V, t, 0.06 + 0.14 * h, 0, 0.2, 0.3, 0.7);
      const K = E.bank.tink;
      if (K.length && rr() < h && S.trig > 0) {
        resetP(); P.prio = 2; P.buf = K[pickVar(T_TINK, K.length)]; P.rate = 0.8 + 0.4 * rr(); P.gain = 0.1 + 0.1 * h; P.pan = (rr() - 0.5) * 0.8; P.send = 0.15;
        if (play(E, false, t)) S.trig--;
      }
    }
  } else {
    const f = 1 - Math.exp(-nb / 60), g = clamp01(w.wind.gust || 0);
    roar = 0.68 * f * (0.8 + 0.4 * g); cr = 0.55 * Math.min(1, 0.25 + nb / 40); dn = 0.42 * smooth(8, 140, nb); // gusts swell the roar; the pops stay on top
  }
  if (!alive(E, Bd, roar + cr + dn, t, dt4)) return;
  const f2 = 1 - Math.exp(-nb / 120), pitch = 0.55 + 0.45 * ts;
  setp(E, ID.xRoar, Bd.gRoar.gain, roar, t, 0.2, 0.1);
  setp(E, ID.xLP, Bd.lpR.frequency, (500 + 1400 * f2) * pitch, t, 0.3, 0.08);
  setp(E, ID.xC, Bd.gC.gain, cr, t, 0.15, 0.1);
  setp(E, ID.xD, Bd.gD.gain, dn, t, 0.2, 0.1);
  if (roar + cr + dn < 0.003) return;
  const fp = w.lights && w.lights.firePos;
  if (fp && nb > 0) setpa(E, ID.xPan, Bd.pan.pan, panAt(w, fp[0], fp[1], fp[2]), t, 0.3, 0.08);
  setp(E, ID.xCRate, Bd.run[1].playbackRate, 0.5 + 0.5 * ts, t, 0.1, 0.05);
}

/** Rain: wash and drop field ∝ intensity (slowed and deepened in slow-mo); patter ∝ hits; soaked cloth drums. */
function rain(E, w, t, ts, M, dt4) {
  const Bd = E.rainBed; if (!Bd) return;
  const I = clamp01(w.rain.intensity || 0), hr = Math.min(1, S.hitRate / 70), wet = clamp01(w.stats.wetness || 0);
  const wash = 0.38 * I, tex = 0.4 * Math.pow(I, 0.8), pat = 0.3 * hr * (M.metal ? 0.4 : 1);
  if (!alive(E, Bd, wash + tex + pat, t, dt4)) return;
  setp(E, ID.rWash, Bd.gWash.gain, wash, t, 0.5, 0.1);
  setp(E, ID.rTex, Bd.gTex.gain, tex, t, 0.5, 0.1);
  setp(E, ID.rPat, Bd.gPat.gain, pat, t, 0.35, 0.1);
  if (wash + tex + pat < 0.003) return;
  setp(E, ID.rLP, Bd.lpW.frequency, (2200 + 4000 * I) * (0.6 + 0.4 * ts), t, 0.5, 0.08);
  setp(E, ID.rTexRate, Bd.run[1].playbackRate, 0.55 + 0.45 * ts, t, 0.15, 0.04);
  setp(E, ID.rPatLP, Bd.lpP.frequency, M.patLP * (1 - 0.4 * wet), t, 0.5, 0.08);
  setp(E, ID.rDrum, Bd.drum.gain, M.metal ? 0 : 7 * wet, t, 0.6, 0.12);
}

/** Slow-mo: the world muffles and the room opens up (the dry bus, and so the katana, stays clear). */
function slowmo(E, t, ts) {
  const lp = ts > 0.97 ? 18000 : 2600 * Math.pow(18000 / 2600, clamp01((ts - 0.22) / 0.75));
  setp(E, ID.worldLP, E.worldLP.frequency, lp, t, 0.06, 0.08);
  setp(E, ID.revIn, E.revIn.gain, 1 + 0.9 * (1 - clamp01(ts)), t, 0.12, 0.08);
}

/** Each scene's air: hum, crickets, moon; wind chimes that answer the gusts; thunder far off in the rain. */
function ambience(E, w, t, oneRate) {
  if (!E.amb) return;
  const sc = w.sceneId, a = AMB[sc];
  if (a && !E.bank[a[0]]) want(E, a[0]);
  // the crickets fall silent as the fire grows
  const hush = sc === 'embers' ? 1 - 0.85 * smooth(2, 60, w.stats.burning || 0) : 1;
  ambSet(E, a ? a[0] : '', a ? a[1] * hush * (0.75 + 0.25 * w.timeScale) : 0, t);
  if (sc === 'koinobori') {
    const K = E.bank.chime;
    if (K.length < 5) want(E, 'chime');
    const g = clamp01(w.wind.gust || 0), p = (0.05 + 0.5 * g * g) * smooth(0.8, 5, w.wind.speed || 0);
    if (K.length && rr() < p && t - S.last[T_CHIME] > 0.4) {
      resetP(); P.prio = 1; P.buf = K[pickVar(T_CHIME, K.length)]; P.rate = oneRate; P.gain = 0.08 + 0.1 * g;
      P.pan = (rr() - 0.5) * 1.2; P.send = 0.35; P.lp = 9000;
      if (play(E, false, t)) S.last[T_CHIME] = t;
    }
  } else if (sc === 'monsoon') {
    if (!E.bank.thunder) want(E, 'thunder');
    if ((w.rain.intensity || 0) > 0.5 && t > S.thunderAt && E.bank.thunder) {
      S.thunderAt = t + 22 + rr() * 30;
      resetP(); P.prio = 2; P.buf = E.bank.thunder; P.rate = oneRate * (0.9 + 0.2 * rr()); P.gain = 0.25;
      P.pan = (rr() - 0.5) * 0.9; P.lp = 900; P.send = 0.3;
      play(E, false, t);
    }
  }
}
