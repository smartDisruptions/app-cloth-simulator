// Cached strings, so per-frame UI code never builds one (CONTRACT: no allocation in per-frame code).
//
// Numbers: each distinct value is formatted once and remembered (a Map per format, capped so a long
// session can't grow it without bound). Positions: one `translate3d` string per whole CSS pixel, built
// when the screen grows (resize), never per frame. Overlays move with two nested elements, the outer on
// X and the inner on Y, so two small tables cover every position.

const CAP = 4096;
const INT = new Map(), F1 = new Map(), F2 = new Map();

function cached(map, key, make) {
  let s = map.get(key);
  if (s === undefined) {
    if (map.size >= CAP) map.clear();
    s = make(key);
    map.set(key, s);
  }
  return s;
}
const mkInt = (i) => String(i);
const mkF1 = (i) => (i / 10).toFixed(1);
const mkF2 = (i) => (i / 100).toFixed(2);

/** "1320" */
export const int = (v) => cached(INT, v === v ? Math.round(v) : 0, mkInt);
/** "16.7" */
export const f1 = (v) => cached(F1, v === v ? Math.round(v * 10) : 0, mkF1);
/** "1.25" */
export const f2 = (v) => cached(F2, v === v ? Math.round(v * 100) : 0, mkF2);

// ---- positions ----
const OFF = 320;           // overlays may sit a little off screen
const TX = [], TY = [];
let txN = 0, tyN = 0;

/** Make sure every whole-pixel position on a w × h screen (plus a margin) has its strings. */
export function ensure(w, h) {
  const nx = Math.ceil(w) + OFF * 2, ny = Math.ceil(h) + OFF * 2;
  for (let i = txN; i < nx; i++) TX[i] = 'translate3d(' + (i - OFF) + 'px,0,0)';
  for (let i = tyN; i < ny; i++) TY[i] = 'translate3d(0,' + (i - OFF) + 'px,0)';
  if (nx > txN) txN = nx;
  if (ny > tyN) tyN = ny;
}

/** Whole-pixel index for a CSS x (clamped into the table). */
export function ix(x) { let i = (x + OFF + 0.5) | 0; if (!(i > 0)) i = 0; else if (i >= txN) i = txN - 1; return i; }
export function iy(y) { let i = (y + OFF + 0.5) | 0; if (!(i > 0)) i = 0; else if (i >= tyN) i = tyN - 1; return i; }
export const tx = (i) => TX[i];
export const ty = (i) => TY[i];
