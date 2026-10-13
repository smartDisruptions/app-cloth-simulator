// DOM overlays above the cloth: a ring under each finger, ripples where a tool lands, the pin markers,
// and the hint's ghost finger. Pooled elements built once; each moves with two nested elements (outer X,
// inner Y) through cached transform strings (ui/fmt.js), written only when the whole pixel changes.
// A frame writes a handful of style properties and allocates nothing.
import { ensure, ix, iy, tx, ty } from './fmt.js';
import { MAX_POINTERS } from '../core/world.js';

const MAXPIN = 24, RIPPLES = 10;

// ---- finger rings ----
export const R_OFF = 0, R_HOLD = 1, R_FREE = 2, R_BURN = 3, R_PIN = 4, R_BLADE = 5, R_PINCH = 6, R_INK = 7, R_TAUT = 8, R_STRAIN = 9;
const RING_CLS = ['ring', 'ring on hold', 'ring on free', 'ring on burn', 'ring on pin', 'ring on blade', 'ring on pinch', 'ring on inkr', 'ring on hold taut', 'ring on hold strain'];
// ---- ripples ----
export const RP_INK = 0; // + dye index 0..3
export const RP_PIN = 4, RP_UNPIN = 5, RP_FIRE = 6, RP_MISS = 7, RP_FREE = 8, RP_TEAR = 9;
const RP_NAMES = ['ink0', 'ink1', 'ink2', 'ink3', 'pinned', 'unpinned', 'fire', 'miss', 'free', 'tear'];
const RP_CLS = [];
for (let k = 0; k < RP_NAMES.length; k++) { RP_CLS.push('rp ' + RP_NAMES[k] + ' a', 'rp ' + RP_NAMES[k] + ' b'); }
// ---- pins ----
const PIN_CLS = ['pin', 'pin on user', 'pin on anchor'];

function mover(parent, cls) {
  const outer = document.createElement('i'); outer.className = cls;
  const inner = document.createElement('i');
  const dot = document.createElement('b');
  inner.appendChild(dot); outer.appendChild(inner); parent.appendChild(outer);
  return { outer, inner, x: -1e9, y: -1e9, kind: 0, flip: 0 };
}
function place(m, x, y) {
  const xi = ix(x), yi = iy(y);
  if (xi !== m.x) { m.outer.style.transform = tx(xi); m.x = xi; }
  if (yi !== m.y) { m.inner.style.transform = ty(yi); m.y = yi; }
}
/** place() for per-frame use: reads x, y = a[o], a[o + 1], so no double crosses a call boundary. */
function placeAt(m, a, o) {
  const xi = ix(a[o]), yi = iy(a[o + 1]);
  if (xi !== m.x) { m.outer.style.transform = tx(xi); m.x = xi; }
  if (yi !== m.y) { m.inner.style.transform = ty(yi); m.y = yi; }
}

const rings = [], ripples = [], pins = [];
let ghost = null, rp = 0;

export function init(root) {
  ensure(window.innerWidth || 800, window.innerHeight || 800);
  const box = document.createElement('div'); box.className = 'fx'; box.setAttribute('aria-hidden', 'true');
  const pl = document.createElement('div'); pl.className = 'fx-pins';
  const rl = document.createElement('div'); rl.className = 'fx-rings';
  const ql = document.createElement('div'); ql.className = 'fx-ripples';
  box.append(pl, ql, rl);
  for (let i = 0; i < MAXPIN; i++) pins.push(mover(pl, PIN_CLS[0]));
  for (let i = 0; i < RIPPLES; i++) ripples.push(mover(ql, 'rp'));
  for (let i = 0; i < MAX_POINTERS; i++) rings.push(mover(rl, RING_CLS[0]));
  ghost = mover(box, 'ghost');
  root.appendChild(box);
}

export function onResize(world) { ensure(world.width, world.height); }

// ---------------------------------------------------------------- rings
export function ring(s, x, y, kind) {
  const r = rings[s]; if (!r) return;
  place(r, x, y);
  if (r.kind !== kind) { r.outer.className = RING_CLS[kind]; r.kind = kind; }
}
export function ringMove(s, x, y) { const r = rings[s]; if (r && r.kind) place(r, x, y); }
/** The ripple at a ring's current spot (no doubles cross the call). */
export function rippleAtRing(s, kind) {
  const r = rings[s], q = ripples[rp]; if (!r || !q) return;
  rp = (rp + 1) % RIPPLES;
  if (q.x !== r.x) { q.outer.style.transform = tx(r.x); q.x = r.x; }
  if (q.y !== r.y) { q.inner.style.transform = ty(r.y); q.y = r.y; }
  q.flip ^= 1;
  q.outer.className = RP_CLS[kind * 2 + q.flip];
}
export function ringKind(s, kind) { const r = rings[s]; if (r && r.kind !== kind) { r.outer.className = RING_CLS[kind]; r.kind = kind; } }

// ---------------------------------------------------------------- ripples
export function ripple(x, y, kind) {
  const r = ripples[rp]; rp = (rp + 1) % RIPPLES;
  if (!r) return;
  place(r, x, y);
  r.flip ^= 1;
  r.outer.className = RP_CLS[kind * 2 + r.flip];   // a/b swap restarts the CSS animation, no reflow
}

// ---------------------------------------------------------------- ghost finger (first-run hint)
export function ghostAt(x, y, cls) { if (!ghost) return; place(ghost, x, y); ghost.outer.className = cls; }

// ---------------------------------------------------------------- pin markers
const users = new Int32Array(MAXPIN);                 // vertices the user pinned, oldest first
let nUsers = 0;
const list = new Int32Array(MAXPIN).fill(-1), kinds = new Uint8Array(MAXPIN), shown = new Uint8Array(MAXPIN);
let mark = new Uint8Array(0), scan = new Int32Array(0);
let dirty = true, topo = -1, lastTool = '';

export function onScene(world) {
  const n = world.cloth ? world.cloth.n : 0;
  if (mark.length < n) { mark = new Uint8Array(n); scan = new Int32Array(n); } else mark.fill(0);
  nUsers = 0; dirty = true;
  for (let i = 0; i < MAXPIN; i++) list[i] = -1;
}

/** The user pinned vertex v (a master). */
export function pinAdd(v) {
  for (let i = 0; i < nUsers; i++) if (users[i] === v) return;
  if (nUsers === MAXPIN) { mark[users[0]] = 0; users.copyWithin(0, 1); nUsers--; }
  users[nUsers++] = v; if (v < mark.length) mark[v] = 1; dirty = true;
}
/** Vertex v is no longer pinned (the user freed it). */
export function pinRemove(v) {
  let k = 0;
  for (let i = 0; i < nUsers; i++) if (users[i] !== v) users[k++] = users[i];
  nUsers = k; if (v < mark.length) mark[v] = 0; dirty = true;
}
export const pinsDirty = () => { dirty = true; };

function rebuild(world) {
  const cl = world.cloth;
  dirty = false; topo = cl.topoVersion; lastTool = world.tool;
  let k = 0;
  for (let i = 0; i < nUsers; i++) {
    const v = users[i];
    if (cl.pinned[v] && cl.vTri[v]) users[k++] = v; else mark[v] = 0;
  }
  nUsers = k;
  let m = 0;
  for (let i = 0; i < nUsers; i++) { list[m] = users[i]; kinds[m] = 1; m++; }
  // With the Pin tool in hand, show the scene's own pins too (small rings), evenly sampled.
  if (world.tool === 'pin') {
    let c = 0;
    const pinned = cl.pinned, vTri = cl.vTri, alias = cl.alias;
    for (let v = 0; v < cl.n; v++) if (pinned[v] && vTri[v] && alias[v] < 0 && !mark[v]) scan[c++] = v;
    const take = Math.min(c, MAXPIN - m);
    for (let j = 0; j < take; j++) { list[m] = scan[Math.floor((j + 0.5) * c / take)]; kinds[m] = 2; m++; }
  }
  for (; m < MAXPIN; m++) list[m] = -1;
}

/** Per frame (hud.update): follow pinned vertices on screen. */
export function update(world) {
  const cl = world.cloth; if (!cl) return;
  if (dirty || cl.topoVersion !== topo || world.tool !== lastTool) rebuild(world);
  const sc = world.screen, pinned = cl.pinned, vTri = cl.vTri;
  for (let i = 0; i < MAXPIN; i++) {
    const v = list[i], p = pins[i];
    let on = 0;
    if (v >= 0) {
      const o = v * 3;
      if (sc[o + 2] > 0 && pinned[v] && vTri[v]) { on = kinds[i]; placeAt(p, sc, o); }
    }
    if (shown[i] !== on) { p.outer.className = PIN_CLS[on]; shown[i] = on; }
  }
}

/** For tests and the HUD: how many markers are showing. */
export function pinCount() { let n = 0; for (let i = 0; i < MAXPIN; i++) if (shown[i]) n++; return n; }
