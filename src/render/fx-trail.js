// The katana's slash: a glowing ribbon drawn in screen space. Every slice move hands trail() a segment in
// css px; a segment that starts where a live stroke's tip is continues that stroke (so two fingers can
// slash at once), and each stroke is smoothed with Catmull-Rom so a fast swipe reads as an arc, not a
// polyline. The newest end is widest and hottest; older points narrow and fade, so
// the ribbon tapers into its tail and is gone after LIFE seconds. A bright glint rides the blade's tip.
//
// The ribbon's corners are unprojected to just in front of the near plane, so it is ordinary world-space
// geometry for the particle shader (prebuilt quads), always in front of the cloth, and particles.js draws
// it in the main pass and again in the emissive pass, where it blooms.
import { F, U, WORDS, QUAD_WORDS, MODE, rgba, misc, CORNER } from './fx-buffer.js';
import { CELL } from './fx-atlas.js';

export const LIFE = 0.26;   // seconds of trail clock (mostly real time; slow-mo stretches it a little)
/** The trail clock, advanced by particles.js. Shared through a typed array: a double passed as an
 *  argument to a function that isn't inlined is boxed on the heap every call. */
export const CLOCK = new Float64Array(1);
const NP = 96;              // remembered points
const SUB = 4;              // Catmull-Rom subdivisions per segment
const HALF_W = 16;          // half-width of the glow (css px) at the fresh end; the white core is ~1/8 of it
const GLINT = 22;           // radius of the tip glint (css px)

const px = new Float32Array(NP), py = new Float32Array(NP), pt = new Float32Array(NP);
const ps = new Int32Array(NP);
let head = 0, count = 0, stroke = 0;
// the live strokes (up to four fingers): their ids and the ring index of each one's tip
const NS = 4, sId = new Int32Array(NS).fill(-1), sTip = new Int32Array(NS);
let sNext = 0;

// scratch, sized once: one stroke's points in order, and its subdivided samples with both edges in world
const order = new Int32Array(NP);
const MAXS = NP * SUB + 1;
const sx = new Float32Array(MAXS), sy = new Float32Array(MAXS), sa = new Float32Array(MAXS);
const L3 = new Float32Array(MAXS * 3), R3 = new Float32Array(MAXS * 3);
const MISC_BEAM = misc(MODE.ADD | MODE.PRE, CELL.BEAM, 0, 255);   // (w = 255: full weight in the bloom)
const MISC_GLINT = misc(MODE.ADD | MODE.PRE, CELL.DISC, 0, 255);
// colours without alpha (24-bit, so they stay small ints); the alpha byte is OR-ed in where it's written
const C_GLOW = rgba(0.22, 0.68, 1.0, 0), C_GLINT = rgba(0.6, 0.88, 1.0, 0), C_CORE = rgba(1, 1, 1, 0);
const G3 = new Float32Array(12); // the glint's four corners
// screen → world at a fixed view depth is affine: P(sx, sy) = B + X·sx + Y·sy (set once per build)
const B = new Float32Array(3), X = new Float32Array(3), Y = new Float32Array(3);
function toWorld(sx, sy, out, o) {
  out[o] = B[0] + X[0] * sx + Y[0] * sy; out[o + 1] = B[1] + X[1] * sx + Y[1] * sy; out[o + 2] = B[2] + X[2] * sx + Y[2] * sy;
}

export function reset() { head = 0; count = 0; sId.fill(-1); }

/** Append a point to stroke `id`; returns its ring index. */
function push(id, x, y, t) {
  const k = head;
  px[k] = x; py[k] = y; pt[k] = t; ps[k] = id;
  head = (head + 1) % NP; if (count < NP) count++;
  return k;
}

/** Add one slice segment (css px), now on the trail clock. */
export function add(x0, y0, x1, y1) {
  const t = CLOCK[0];
  if (!(x0 === x0 && y0 === y0 && x1 === x1 && y1 === y1) || Math.abs(x0) + Math.abs(y0) + Math.abs(x1) + Math.abs(y1) > 1e6) return;
  // which live stroke does this segment continue? (its tip is where the segment starts)
  let s = -1;
  for (let j = 0; j < NS; j++) {
    const k = sTip[j];
    if (sId[j] < 0 || ps[k] !== sId[j] || t - pt[k] > 0.12) continue;
    if (Math.abs(px[k] - x0) < 1.5 && Math.abs(py[k] - y0) < 1.5) { s = j; break; }
  }
  if (s < 0) { // a new stroke takes the oldest slot
    s = sNext; sNext = (sNext + 1) % NS;
    sId[s] = ++stroke; sTip[s] = push(stroke, x0, y0, t);
  }
  const k = sTip[s], dx = px[k] - x1, dy = py[k] - y1;
  if (dx * dx + dy * dy < 4) { px[k] = x1; py[k] = y1; pt[k] = t; return; } // a tiny move just slides the tip
  sTip[s] = push(sId[s], x1, y1, t);
}

/** Is anything still visible? */
export function alive() {
  const t = CLOCK[0];
  for (let j = 0; j < NS; j++) if (sId[j] >= 0 && ps[sTip[j]] === sId[j] && t - pt[sTip[j]] < LIFE) return true;
  return false;
}

/** One corner of a prebuilt quad, its position read from src[j..j+2]. Only arrays and small ints cross the
 *  call (a double or a full 32-bit word passed to a function that isn't inlined gets boxed: garbage). */
function writeCorner(o, c, src, j, rgb, alpha, m) {
  F[o] = src[j]; F[o + 1] = src[j + 1]; F[o + 2] = src[j + 2];
  U[o + 3] = 0; U[o + 4] = 0; U[o + 5] = 0; // no streak, no shape: the corner is already placed
  U[o + 6] = rgb | (alpha << 24); U[o + 7] = C_CORE; U[o + 8] = m | CORNER[c];
}

/** Write the ribbon quads starting at quad q0 (at most maxQ). Returns how many quads were written. */
export function build(world, q0, maxQ) {
  if (!alive()) return 0;
  const t = CLOCK[0];
  const cam = world.camera, depth = cam.near * 1.6;
  { // the same mapping as core/camera.js unproject(), folded into a base point and two axes
    const th = cam.tanHalf * depth, tw = th * cam.aspect, kx = (2 / world.width) * tw, ky = (2 / world.height) * th;
    for (let a = 0; a < 3; a++) {
      B[a] = cam.pos[a] + cam.fwd[a] * depth - cam.right[a] * tw + cam.up[a] * th;
      X[a] = cam.right[a] * kx; Y[a] = -cam.up[a] * ky;
    }
  }
  const s2 = Math.min(world.width, world.height) / 390; // scale the ribbon with the screen a little
  const halfW = HALF_W * (0.85 + 0.15 * s2);
  let q = q0;
  const end = q0 + maxQ;
  const first = (head - count + NP) % NP;
  for (let st = 0; st < NS; st++) {
    const sid = sId[st];
    if (sid < 0 || ps[sTip[st]] !== sid || t - pt[sTip[st]] >= LIFE) continue;
    // gather this stroke's points, oldest first (two fingers interleave them in the ring); a long, held
    // slice is one stroke, so skip everything older than the visible tail, keeping one point before it
    // to anchor the tail's curve
    let m = 0;
    for (let i = 0; i < count; i++) {
      const k = (first + i) % NP;
      if (ps[k] !== sid) continue;
      if (t - pt[k] >= LIFE && m > 0) m = 0; // an older point than the tail anchor: restart the gather
      order[m++] = k;
    }
    if (m < 2) continue;
    const newest = order[m - 1];
    // subdivide with Catmull-Rom (positions and ages), compute normals, unproject both edges
    let ns = 0;
    for (let k = 0; k < m - 1; k++) {
      const a = order[k > 0 ? k - 1 : 0], b = order[k], c = order[k + 1], d = order[k + 2 < m ? k + 2 : m - 1];
      const last = k === m - 2 ? SUB : SUB - 1;
      for (let s = 0; s <= last; s++) {
        const u = s / SUB, u2 = u * u, u3 = u2 * u;
        sx[ns] = 0.5 * (2 * px[b] + (-px[a] + px[c]) * u + (2 * px[a] - 5 * px[b] + 4 * px[c] - px[d]) * u2 + (-px[a] + 3 * px[b] - 3 * px[c] + px[d]) * u3);
        sy[ns] = 0.5 * (2 * py[b] + (-py[a] + py[c]) * u + (2 * py[a] - 5 * py[b] + 4 * py[c] - py[d]) * u2 + (-py[a] + 3 * py[b] - 3 * py[c] + py[d]) * u3);
        sa[ns] = t - (pt[b] + (pt[c] - pt[b]) * u);
        ns++;
      }
    }
    for (let j = 0; j < ns; j++) {
      const jp = j > 0 ? j - 1 : 0, jn = j < ns - 1 ? j + 1 : ns - 1;
      let tx = sx[jn] - sx[jp], ty = sy[jn] - sy[jp];
      const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
      const e = 1 - sa[j] / LIFE, wv = e > 0 ? halfW * Math.pow(e, 0.75) : 0;
      toWorld(sx[j] - ty * wv, sy[j] + tx * wv, L3, j * 3);
      toWorld(sx[j] + ty * wv, sy[j] - tx * wv, R3, j * 3);
    }
    for (let j = 0; j < ns - 1 && q < end; j++) {
      const e0 = 1 - sa[j] / LIFE, e1 = 1 - sa[j + 1] / LIFE;
      if (e0 <= 0 && e1 <= 0) continue;
      const i0 = e0 > 0 ? (Math.pow(e0, 1.3) * 255) | 0 : 0, i1 = e1 > 0 ? (Math.pow(e1, 1.3) * 255) | 0 : 0;
      const o = q * QUAD_WORDS, a = j * 3, b = (j + 1) * 3;
      writeCorner(o, 0, L3, a, C_GLOW, i0, MISC_BEAM);
      writeCorner(o + WORDS, 1, R3, a, C_GLOW, i0, MISC_BEAM);
      writeCorner(o + WORDS * 2, 2, L3, b, C_GLOW, i1, MISC_BEAM);
      writeCorner(o + WORDS * 3, 3, R3, b, C_GLOW, i1, MISC_BEAM);
      q++;
    }
    // the glint on the blade's tip, brief
    const ga = t - pt[newest];
    if (ga < 0.14 && q < end) {
      const gi = 1 - ga / 0.14, r = GLINT * (0.85 + 0.15 * s2) * (0.7 + 0.3 * gi), ga8 = (gi * 255) | 0, o = q * QUAD_WORDS;
      const x = px[newest], y = py[newest];
      for (let k = 0; k < 4; k++) {
        toWorld(x + ((k & 1) ? r : -r), y + ((k & 2) ? -r : r), G3, k * 3);
        writeCorner(o + WORDS * k, k, G3, k * 3, C_GLINT, ga8, MISC_GLINT);
      }
      q++;
    }
  }
  return q - q0;
}
