// Input: pointers → tools, only through world.api (main.js). handle(type, x, y, id) is the test entry.
//
//   Grab   each finger grabs its own patch. A finger that lands beside the cloth catches it the moment
//          the cloth passes under it ("walk your finger through"). Two fingers on empty space pinch-zoom.
//   Slice  every move cuts along the stroke and draws the blade's trail. A long, fast cut that goes
//          through cloth is the beat: world.slowmoPulse, a buzz, a letterbox and a hair of camera kick.
//   Burn   tap lights it, hold keeps the torch on it (update), drag drags the flame.
//   Pin    tap pins, tap a pin to free it; press, drag and let go to carry a point and pin it there.
//   Dye    tap drops ink; a drag drops it every few pixels along the stroke.
//
// Tilt (ui/tilt.js) writes world.gravity while the Tilt toggle is on. Parallax and the kick go into
// world.cameraRig.uiOffset and zoom into cameraRig.zoom (fields only the UI writes; the scene keeps
// offset and margin). No allocation in update() or in the pointer handlers.
import { MAX_POINTERS } from '../core/world.js';
import * as tilt from './tilt.js';
import * as fx from './fx.js';
import * as haptics from './haptics.js';
import { bus } from './bus.js';
import { material as simMaterial } from '../sim/cloth.js';

const { buzz, TICK, TAP, THUD_K } = haptics;
const M_NONE = 0, M_GRAB = 1, M_FREE = 2, M_SLICE = 3, M_BURN = 4, M_PIN = 5, M_PINMOVE = 6, M_DYE = 7, M_PINCH = 8, M_IDLE = 9;
const INK_STEP = 16;               // css px between ink drops along a stroke
const BEAT_CUTS = 3;               // threads a stroke must cut before speed and length can make the beat
const ZMIN = 0.7, ZMAX = 1.45;     // camera zoom (multiplies the scene's framing margin)

let W = null, reduce = null, offX = 0, offY = 0, lastScene = '';
const ids = new Int32Array(MAX_POINTERS).fill(-1);
const mode = new Uint8Array(MAX_POINTERS);
const downX = new Float32Array(MAX_POINTERS), downY = new Float32Array(MAX_POINTERS);
const lastX = new Float32Array(MAX_POINTERS), lastY = new Float32Array(MAX_POINTERS);
const path = new Float32Array(MAX_POINTERS), speed = new Float32Array(MAX_POINTERS), inkAcc = new Float32Array(MAX_POINTERS);
const cuts = new Int32Array(MAX_POINTERS), moved = new Uint8Array(MAX_POINTERS), pulsed = new Uint8Array(MAX_POINTERS);
// swipe-to-gust: where the last puff left from, and when
const gX = new Float32Array(MAX_POINTERS), gY = new Float32Array(MAX_POINTERS), gT = new Float64Array(MAX_POINTERS);
let pA = -1, pB = -1, inkN = 0, active = 0, tapT = -1e9, tapX = 0, tapY = 0;
// the hold ring's warning: per finger, the cloth's worst strain (stats.tension) when the grab began
// (the lowest seen while holding), and the level shown
const strainLvl = new Uint8Array(MAX_POINTERS), strainFresh = new Uint8Array(MAX_POINTERS);
const strainBase = new Float32Array(MAX_POINTERS);

// Camera shares. Mutable floats live in a typed array: a module-level `let` holding a double makes V8
// box it on every write, which would be a small allocation per frame.
const mine = new Float32Array(3);
const Z = new Float64Array(11);
const ZOOM = 0, ZT = 1, ZA = 2, PX = 3, PY = 4, KX = 5, KY = 6, KVX = 7, KVY = 8, PD0 = 9, PZ0 = 10;
Z[ZOOM] = Z[ZT] = Z[ZA] = 1;

const slotOf = (id) => { for (let s = 0; s < MAX_POINTERS; s++) if (ids[s] === id) return s; return -1; };
const freeSlot = () => { for (let s = 0; s < MAX_POINTERS; s++) if (ids[s] === -1 && !W.pointers[s].active) return s; return -1; };
const slopFor = () => (W.touch ? 10 : 5);

// ---------------------------------------------------------------- the test entry point
/** Feed one pointer event in css px. type: 'down' | 'move' | 'up' | 'cancel'. */
export function handle(type, x, y, id = 1) {
  if (!W || !W.cloth) return;
  if (type === 'down') { down(x, y, id); return; }
  const s = slotOf(id); if (s < 0) return;
  if (type === 'move') move(s, x, y);
  else up(s, x, y, type === 'cancel');
}

function down(x, y, id) {
  let s = slotOf(id);
  if (s >= 0) up(s, x, y, true);          // a stale pointer with this id: end it first
  s = freeSlot(); if (s < 0) return;
  const P = W.pointers[s], api = W.api, tool = W.tool;
  ids[s] = id; P.active = true; P.id = id; P.x = P.px = x; P.y = P.py = y; P.particle = -1;
  downX[s] = lastX[s] = x; downY[s] = lastY[s] = y;
  gX[s] = x; gY[s] = y; gT[s] = performance.now();
  path[s] = 0; speed[s] = 0; inkAcc[s] = 0; cuts[s] = 0; moved[s] = 0; pulsed[s] = 0;
  active++;
  bus.touchStart();
  if (tool === 'grab') {
    if (api.grabStart(s, x, y)) { mode[s] = M_GRAB; strainFresh[s] = 1; fx.ring(s, x, y, fx.R_HOLD); buzz(TICK, true); }
    else {
      const o = other(M_FREE, s);
      if (o >= 0) startPinch(o, s);
      else { mode[s] = M_FREE; fx.ring(s, x, y, fx.R_FREE); }
    }
  } else if (tool === 'slice') {
    mode[s] = M_SLICE; fx.ring(s, x, y, fx.R_BLADE);
  } else if (tool === 'burn') {
    mode[s] = M_BURN; fx.ring(s, x, y, fx.R_BURN);
    if (api.ignite(x, y)) { fx.ripple(x, y, fx.RP_FIRE); buzz(TAP, true); }
  } else if (tool === 'pin') {
    let v = pinnedNear(x, y);              // a pin under the finger wins over the cloth around it
    if (v < 0) v = api.pick(x, y);
    if (v < 0) { mode[s] = M_IDLE; fx.ripple(x, y, fx.RP_MISS); }
    else if (W.cloth.pinned[v]) {
      api.togglePinVertex(v);              // free it now; if the finger drags, it's re-pinned on release
      fx.pinRemove(v);
      mode[s] = api.grabStart(s, x, y) ? M_PINMOVE : M_IDLE;
      buzz(TICK, true);
    } else mode[s] = api.grabStart(s, x, y) ? M_PIN : M_IDLE;
    if (mode[s] !== M_IDLE) fx.ring(s, x, y, fx.R_PIN);
  } else if (tool === 'dye') {
    mode[s] = M_DYE; fx.ring(s, x, y, fx.R_INK);
    if (api.dye(x, y)) { fx.ripple(x, y, fx.RP_INK + (W.dyeColor & 3)); buzz(TICK, true); }
  } else mode[s] = M_IDLE;
}

function move(s, x, y) {
  const P = W.pointers[s], px = P.x, py = P.y;
  P.px = px; P.py = py; P.x = x; P.y = y;
  const dx = x - px, dy = y - py, d = Math.sqrt(dx * dx + dy * dy);
  if (!moved[s]) { const ex = x - downX[s], ey = y - downY[s], sl = slopFor(); if (ex * ex + ey * ey > sl * sl) moved[s] = 1; }
  const m = mode[s], api = W.api;
  if (m === M_GRAB || m === M_PIN || m === M_PINMOVE) api.grabMove(s, x, y);
  else if (m === M_SLICE) {
    if (d > 0.5) {
      const n = api.slice(px, py, x, y);
      api.trail(px, py, x, y);
      cuts[s] += n; path[s] += d;
      if (n > 0) buzz(TICK, true);
    }
  } else if (m === M_DYE) ink(s, px, py, x, y, d);
  else if (m === M_FREE) {
    // grabbing empty air: the swipe pushes a puff of wind along it (until the finger catches cloth)
    const t = performance.now(), ex = x - gX[s], ey = y - gY[s];
    if (t - gT[s] > 45 && ex * ex + ey * ey > 18 * 18) { api.gust(gX[s], gY[s], x, y, (t - gT[s]) / 1000); gX[s] = x; gY[s] = y; gT[s] = t; }
  }
  else if (m === M_PINCH) pinchMove();
  fx.ringMove(s, x, y);
}

function up(s, x, y, cancel) {
  const P = W.pointers[s], api = W.api, m = mode[s];
  if (m === M_GRAB) api.grabEnd(s);
  else if (m === M_PIN || m === M_PINMOVE) {
    const v = P.particle;
    api.grabEnd(s);
    if (!cancel && v >= 0 && (m === M_PIN || moved[s])) pinAt(v);
    else if (m === M_PINMOVE) { fx.ripple(x, y, fx.RP_UNPIN); buzz(TICK, true); }
  } else if (m === M_PINCH) endPinch(s);
  else if (m === M_FREE && !moved[s] && !cancel) {
    // a double tap on empty space puts the camera back where the scene framed it
    const t = performance.now();
    if (t - tapT < 320 && Math.abs(x - tapX) < 40 && Math.abs(y - tapY) < 40 && Z[ZT] !== 1) { Z[ZT] = 1; tapT = -1e9; buzz(TICK, true); }
    else { tapT = t; tapX = x; tapY = y; fx.ripple(x, y, fx.RP_FREE); }
  }
  P.active = false; P.id = -1; P.particle = -1;
  ids[s] = -1; mode[s] = M_NONE; strainLvl[s] = 0;
  fx.ringKind(s, fx.R_OFF);
  if (active > 0) active--;
  if (!active) bus.touchEnd();
}

/** Pin vertex v where it is now on screen (after a carry, or a tap). */
function pinAt(v) {
  const cl = W.cloth, sc = W.screen, o = v * 3, api = W.api;
  if (!cl.vTri[v] || sc[o + 2] <= 0) return;
  const sx = sc[o], sy = sc[o + 1];
  const u = api.pick(sx, sy);
  if (u < 0 || cl.pinned[u]) return;
  if (api.togglePinVertex(u) === 1) { fx.pinAdd(u); fx.ripple(sx, sy, fx.RP_PIN); buzz(TAP, true); }
}

/** The pinned vertex nearest (x, y) on screen within a finger's reach, or -1. */
function pinnedNear(x, y) {
  const cl = W.cloth, sc = W.screen, r = W.touch ? 30 : 18;
  let best = -1, bd = r * r;
  for (let i = 0; i < cl.n; i++) {
    if (!cl.pinned[i] || cl.alias[i] >= 0) continue;
    const o = i * 3; if (sc[o + 2] <= 0) continue;
    const dx = sc[o] - x, dy = sc[o + 1] - y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Ink every INK_STEP px along a drag segment (at most 4 drops per move). */
function ink(s, x0, y0, x1, y1, d) {
  if (d <= 0) return;
  let along = INK_STEP - inkAcc[s], n = 0;
  if (along > d) { inkAcc[s] += d; return; }
  while (along <= d && n < 4) {
    const t = along / d, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (W.api.dye(x, y) && (inkN++ & 3) === 0) fx.ripple(x, y, fx.RP_INK + (W.dyeColor & 3));
    along += INK_STEP; n++;
  }
  inkAcc[s] = n === 4 ? 0 : d - (along - INK_STEP);
}

function other(m, not) { for (let s = 0; s < MAX_POINTERS; s++) if (s !== not && mode[s] === m && ids[s] !== -1) return s; return -1; }

// ---------------------------------------------------------------- pinch + wheel zoom
function pdist(a, b) { const A = W.pointers[a], B = W.pointers[b]; const dx = A.x - B.x, dy = A.y - B.y; return Math.sqrt(dx * dx + dy * dy); }
function startPinch(a, b) {
  mode[a] = M_PINCH; mode[b] = M_PINCH; pA = a; pB = b;
  Z[PD0] = Math.max(24, pdist(a, b)); Z[PZ0] = Z[ZT];
  const A = W.pointers[a], B = W.pointers[b];
  fx.ring(a, A.x, A.y, fx.R_PINCH); fx.ring(b, B.x, B.y, fx.R_PINCH);
}
function pinchMove() {
  if (pA < 0 || pB < 0) return;
  const z = Z[PZ0] * Z[PD0] / Math.max(24, pdist(pA, pB));
  Z[ZT] = z < ZMIN ? ZMIN : z > ZMAX ? ZMAX : z;
}
function endPinch(s) {
  const o = s === pA ? pB : pA;
  if (o >= 0 && mode[o] === M_PINCH) { mode[o] = M_IDLE; fx.ringKind(o, fx.R_OFF); }
  pA = pB = -1;
}
function onWheel(e) {
  if (!W) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
  const z = Z[ZT] * Math.exp(Math.max(-120, Math.min(120, dy)) * 0.0015);
  Z[ZT] = z < ZMIN ? ZMIN : z > ZMAX ? ZMAX : z;
}

// ---------------------------------------------------------------- per frame
/** Latching grabs, the torch, the slice beat, tilt, and the camera shares. Real dt (world.frameDt). */
export function update(world) {
  const api = world.api, dt = world.frameDt;
  for (let s = 0; s < MAX_POINTERS; s++) {
    const m = mode[s]; if (m === M_NONE) continue;
    const P = world.pointers[s];
    if (m === M_FREE) {
      if (api.grabStart(s, P.x, P.y)) { mode[s] = M_GRAB; strainFresh[s] = 1; strainLvl[s] = 0; fx.ringKind(s, fx.R_HOLD); buzz(TICK, false); }
    } else if (m === M_BURN) api.torch(P.x, P.y, dt);
    else if (m === M_SLICE) beat(world, s);
    lastX[s] = P.x; lastY[s] = P.y;
  }
  tilt.update(world);
  camera(world);
}

/** The katana beat: a long, fast stroke that has cut cloth. */
function beat(world, s) {
  const P = world.pointers[s];
  const dx = P.x - lastX[s], dy = P.y - lastY[s], d = Math.sqrt(dx * dx + dy * dy);
  const v = d / Math.max(world.frameDt, 1 / 240);
  speed[s] = v > speed[s] * 0.82 ? v : speed[s] * 0.82;   // peak hold that decays
  if (pulsed[s]) return;
  const dim = Math.min(world.width, world.height);
  // speed and length make the beat; the cut count only proves the blade went through cloth
  // (slice() counts stretch and shear threads, not bends)
  if (cuts[s] >= BEAT_CUTS && path[s] >= 0.28 * dim && speed[s] >= 1.5 * dim) {
    pulsed[s] = 1;
    world.slowmoPulse = 0.6;
    buzz(THUD_K, false);
    bus.beat();
    if (d > 0.5 && !(reduce && reduce.matches)) { Z[KVX] += (dx / d) * 5.5; Z[KVY] -= (dy / d) * 5.5; }
  }
}

function camera(world) {
  const still = reduce && reduce.matches;
  const tpx = still ? 0 : tilt.par[0], tpy = still ? 0 : tilt.par[1];
  // the usual frame: nothing to do
  if (Z[ZOOM] === Z[ZT] && Z[ZOOM] === Z[ZA] && tpx === 0 && tpy === 0 && Z[PX] === 0 && Z[PY] === 0 &&
    Z[KX] === 0 && Z[KY] === 0 && Z[KVX] === 0 && Z[KVY] === 0 && mine[0] === 0 && mine[1] === 0 && mine[2] === 0) return;
  const rig = world.cameraRig, cam = world.camera, dt = world.frameDt;
  if (Z[ZOOM] !== Z[ZT]) {
    Z[ZOOM] += (Z[ZT] - Z[ZOOM]) * (1 - Math.exp(-dt * 10));
    if (Math.abs(Z[ZOOM] - Z[ZT]) < 1e-4) Z[ZOOM] = Z[ZT];
  }
  if (Z[ZOOM] !== Z[ZA]) { rig.zoom = Z[ZOOM]; Z[ZA] = Z[ZOOM]; }
  const kp = 1 - Math.exp(-dt * 5);
  Z[PX] += (tpx - Z[PX]) * kp; Z[PY] += (tpy - Z[PY]) * kp;
  if (Z[KX] !== 0 || Z[KY] !== 0 || Z[KVX] !== 0 || Z[KVY] !== 0) {
    const w = 16, h = Math.min(dt, 1 / 30);
    Z[KVX] += (-w * w * Z[KX] - 2 * w * Z[KVX]) * h; Z[KVY] += (-w * w * Z[KY] - 2 * w * Z[KVY]) * h;
    Z[KX] += Z[KVX] * h; Z[KY] += Z[KVY] * h;
    if (Math.abs(Z[KX]) + Math.abs(Z[KY]) + Math.abs(Z[KVX]) + Math.abs(Z[KVY]) < 1e-4) Z[KX] = Z[KY] = Z[KVX] = Z[KVY] = 0;
  }
  if (Math.abs(Z[PX]) < 1e-5 && Math.abs(Z[PY]) < 1e-5) Z[PX] = Z[PY] = 0;
  if (Z[PX] === 0 && Z[PY] === 0 && Z[KX] === 0 && Z[KY] === 0 && mine[0] === 0 && mine[1] === 0 && mine[2] === 0) return;
  const dist = cam.dist || 4;
  const ox = (Z[PX] * 0.06 + Z[KX] * 0.12) * dist, oy = (Z[PY] * 0.06 + Z[KY] * 0.12) * dist;
  const R = cam.right, U = cam.up, off = rig.uiOffset;
  const wx = R[0] * ox + U[0] * oy, wy = R[1] * ox + U[1] * oy, wz = R[2] * ox + U[2] * oy;
  off[0] += wx - mine[0]; off[1] += wy - mine[1]; off[2] += wz - mine[2];
  mine[0] = wx; mine[1] = wy; mine[2] = wz;
}

/**
 * Feedback that needs this frame's physics (hud.update calls it after the step). A holding finger's
 * ring warns before the cloth rips: it judges how far stats.tension (the worst thread strain) has risen
 * since this grab began (the lowest it has been while holding, so cloth that rests taut, like a hem at
 * its pins, doesn't cry wolf) toward where the material snaps at once, ~1.6 × its tear ratio
 * (sim.material().tear). Gold from 35 % of that rise, vermilion from 60 %. A thread that snaps while a
 * finger holds bursts and buzzes. Chainmail never tears, so it never warns.
 */
export function feel(world) {
  if (!active) return;
  const mat = simMaterial(), tear = mat ? mat.tear : 0;
  const tearable = tear > 1 && tear < 1e6, T = world.stats.tension, snap = 1.6 * tear;
  let first = -1;
  for (let s = 0; s < MAX_POINTERS; s++) {
    if (mode[s] !== M_GRAB) continue;
    if (first < 0) first = s;
    if (strainFresh[s]) { strainFresh[s] = 0; strainBase[s] = T; } else if (T < strainBase[s]) strainBase[s] = T;
    let lvl = 0;
    if (tearable) {
      const f = (T - strainBase[s]) / Math.max(0.05, snap - strainBase[s]);
      lvl = f >= 0.6 ? 2 : f >= 0.35 ? 1 : 0;
    }
    if (lvl !== strainLvl[s]) {
      strainLvl[s] = lvl;
      fx.ringKind(s, lvl === 2 ? fx.R_STRAIN : lvl === 1 ? fx.R_TAUT : fx.R_HOLD);
    }
  }
  if (first >= 0 && world.events.tear.n > 0) { fx.rippleAtRing(first, fx.RP_TEAR); buzz(TICK, false); }
}

/** Zoom level for the HUD/tests (1 = the scene's framing). */
export const zoomLevel = () => Z[ZT];

// ---------------------------------------------------------------- lifecycle
export function init(world) {
  W = world;
  haptics.init();
  tilt.init();
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { reduce = null; }
  const c = world.canvas;
  c.addEventListener('pointerdown', onDown, { passive: false });
  c.addEventListener('pointermove', onMove, { passive: true });
  c.addEventListener('pointerup', onUp);
  c.addEventListener('pointercancel', onCancel);
  c.addEventListener('contextmenu', prevent);
  c.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', onVis);
}

export function onResize(world) {
  try { const r = world.canvas.getBoundingClientRect(); offX = r.left; offY = r.top; } catch (e) { offX = offY = 0; }
}

export function onScene(world) {
  // main.js released world.pointers; forget our side of them too
  for (let s = 0; s < MAX_POINTERS; s++) { ids[s] = -1; mode[s] = M_NONE; strainLvl[s] = 0; fx.ringKind(s, fx.R_OFF); }
  pA = pB = -1; active = 0;
  bus.touchEnd();
  // main.js buildScene() zeroes cameraRig.uiOffset and resets .zoom, so our shares start again from zero
  mine[0] = mine[1] = mine[2] = 0; Z[ZA] = 1;
  if (world.sceneId !== lastScene) { Z[ZOOM] = Z[ZT] = 1; lastScene = world.sceneId; Z[KX] = Z[KY] = Z[KVX] = Z[KVY] = 0; }
  tilt.onScene(world);
}

function onDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  try { W.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  e.preventDefault();
  handle('down', e.clientX - offX, e.clientY - offY, e.pointerId);
  if (e.pointerType === 'mouse') W.api.audioUnlock();   // mouse down is a user activation; touch waits for up
}
function onMove(e) {
  if (slotOf(e.pointerId) < 0) return;
  handle('move', e.clientX - offX, e.clientY - offY, e.pointerId);
}
function onUp(e) {
  if (slotOf(e.pointerId) >= 0) handle('up', e.clientX - offX, e.clientY - offY, e.pointerId);
  W.api.audioUnlock();                                   // touch: pointerup carries the activation audio needs
}
function onCancel(e) { if (slotOf(e.pointerId) >= 0) handle('cancel', e.clientX - offX, e.clientY - offY, e.pointerId); }
function prevent(e) { e.preventDefault(); }
function onVis() { if (document.hidden) releaseAll(); }
function releaseAll() {
  if (!W) return;
  for (let s = 0; s < MAX_POINTERS; s++) if (ids[s] !== -1) { const P = W.pointers[s]; up(s, P.x, P.y, true); }
}
