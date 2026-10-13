// Physics viewer: renders the simulated cloth to a PNG contact sheet with a tiny software rasteriser, in
// Node, no browser (the shared machine's SwiftShader runs are slow). Flat-shaded triangles from the
// scene's own camera, colliders outlined, pins dotted; --strain colours every triangle by its most
// stretched edge (white ≤ 2 %, gold 10 %, vermilion ≥ 25 %) so stretch and tears are visible at a glance.
//
//   node tests/physics-view.mjs --scene koinobori --quality mid --frames 30,90,150,240 --out koi.png
//     [--wind 2] [--material silk] [--strain] [--w 195 --h 350]
//     [--grab "fx,fy,dx,dy,f0,f1"]   pinch the cloth at a fraction of its screen box at frame f0, drag by
//                                    (dx, dy) css px until f1, release (repeatable: separate with ';')
//     [--slice "fx0,fy0,fx1,fy1,f"]  katana swipe at frame f       [--wet "f,scale"]  soak from frame f
//     [--burn "fx,fy,f"]             kill the vertices under a point (a burn-through stand-in)
//     [--dir "x,y,z"]                look along this direction instead of the scene's (e.g. 0,-1,-0.05 from above)
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { world } from '../src/core/world.js';
import { unproject } from '../src/core/camera.js';
import * as sim from '../src/sim/cloth.js';
import { setup, frame } from './physics-lab.mjs';
import { clearEvents } from '../src/core/events.js';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

// ------------------------------------------------------------------------------------------- png
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = ihdr[11] = ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------- raster
const PAPER = [244, 239, 228], INDIGO = [43, 58, 150], VERMILION = [226, 65, 42], GOLD = [200, 150, 46], INK = [16, 19, 42];

function proj(m, x, y, z, W, H, out) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 1e-4) return false;
  out[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * W * 0.5;
  out[1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * H * 0.5;
  out[2] = w;
  return true;
}

/** Render the current world into an RGB buffer (W×H). */
export function render(W, H, { strain = false } = {}) {
  const rgb = new Uint8Array(W * H * 3), zb = new Float32Array(W * H).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 3, t = y / H; rgb[o] = INK[0] + 18 * t; rgb[o + 1] = INK[1] + 16 * t; rgb[o + 2] = INK[2] + 20 * t; }
  const cl = world.cloth, m = world.camera.viewProj, p = cl.pos;
  // floor grid line at y = 0
  const A = new Float32Array(3), B = new Float32Array(3), C = new Float32Array(3);
  for (let gx = -3; gx <= 3; gx += 0.5) for (let s = 0; s < 60; s++) {
    if (proj(m, gx, 0, -3 + s * 0.1, W, H, A)) { const x = A[0] | 0, y = A[1] | 0; if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; rgb[o] = 60; rgb[o + 1] = 64; rgb[o + 2] = 90; } }
    if (proj(m, -3 + s * 0.1, 0, gx, W, H, A)) { const x = A[0] | 0, y = A[1] | 0; if (x >= 0 && y >= 0 && x < W && y < H) { const o = (y * W + x) * 3; rgb[o] = 60; rgb[o + 1] = 64; rgb[o + 2] = 90; } }
  }
  const L = [0.35, 0.75, 0.55], ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
  const cam = world.camera.pos;
  const S = cl.solver;
  // per-triangle max edge strain (by alive stretch edges)
  for (let t = 0; t < cl.t; t++) {
    if (!cl.triAlive[t]) continue;
    let ia = cl.tri[t * 3], ib = cl.tri[t * 3 + 1], ic = cl.tri[t * 3 + 2];
    if (!proj(m, p[ia * 3], p[ia * 3 + 1], p[ia * 3 + 2], W, H, A) || !proj(m, p[ib * 3], p[ib * 3 + 1], p[ib * 3 + 2], W, H, B) || !proj(m, p[ic * 3], p[ic * 3 + 1], p[ic * 3 + 2], W, H, C)) continue;
    const ma = cl.alias[ia] >= 0 ? cl.alias[ia] : ia, mb = cl.alias[ib] >= 0 ? cl.alias[ib] : ib, mc = cl.alias[ic] >= 0 ? cl.alias[ic] : ic;
    const ux = p[mb * 3] - p[ma * 3], uy = p[mb * 3 + 1] - p[ma * 3 + 1], uz = p[mb * 3 + 2] - p[ma * 3 + 2];
    const vx = p[mc * 3] - p[ma * 3], vy = p[mc * 3 + 1] - p[ma * 3 + 1], vz = p[mc * 3 + 2] - p[ma * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    const cx = (p[ma * 3] + p[mb * 3] + p[mc * 3]) / 3 - cam[0], cy = (p[ma * 3 + 1] + p[mb * 3 + 1] + p[mc * 3 + 1]) / 3 - cam[1], cz = (p[ma * 3 + 2] + p[mb * 3 + 2] + p[mc * 3 + 2]) / 3 - cam[2];
    const front = nx * cx + ny * cy + nz * cz < 0;
    const sgn = front ? 1 : -1;
    const lam = Math.max(0, sgn * (nx * L[0] + ny * L[1] + nz * L[2]));
    let base = front ? PAPER : [150, 160, 200];
    if (strain) {
      let s = 1;
      for (const [x, y] of [[ma, mb], [mb, mc], [mc, ma]]) {
        // rest length from restPos (grids are flat: exact), current length now
        const r = Math.hypot(cl.restPos[y * 3] - cl.restPos[x * 3], cl.restPos[y * 3 + 1] - cl.restPos[x * 3 + 1], cl.restPos[y * 3 + 2] - cl.restPos[x * 3 + 2]);
        const l = Math.hypot(p[y * 3] - p[x * 3], p[y * 3 + 1] - p[x * 3 + 1], p[y * 3 + 2] - p[x * 3 + 2]);
        const k = l / (r || 1); if (k > s && r > 0) s = k;
      }
      const e = Math.min(1, Math.max(0, (s - 1.02) / 0.23));
      const g = Math.min(1, Math.max(0, (s - 1.02) / 0.08));
      base = e > 0.35 ? [GOLD[0] + (VERMILION[0] - GOLD[0]) * (e - 0.35) / 0.65, GOLD[1] + (VERMILION[1] - GOLD[1]) * (e - 0.35) / 0.65, GOLD[2] + (VERMILION[2] - GOLD[2]) * (e - 0.35) / 0.65]
        : [PAPER[0] + (GOLD[0] - PAPER[0]) * g, PAPER[1] + (GOLD[1] - PAPER[1]) * g, PAPER[2] + (GOLD[2] - PAPER[2]) * g];
    }
    const sh = 0.32 + 0.68 * lam;
    const col = [base[0] * sh, base[1] * sh, base[2] * sh];
    // rasterise
    const x0 = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
    const y0 = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(d) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / d, l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / d, l2 = 1 - l0 - l1;
      if (l0 < 0 || l1 < 0 || l2 < 0) continue;
      const z = l0 * A[2] + l1 * B[2] + l2 * C[2], o = y * W + x;
      if (z >= zb[o]) continue;
      zb[o] = z; rgb[o * 3] = col[0]; rgb[o * 3 + 1] = col[1]; rgb[o * 3 + 2] = col[2];
    }
  }
  // colliders (outlines) and pins
  const dot = (x, y, c, r = 1) => { for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) { const X = (x | 0) + a, Y = (y | 0) + b; if (X >= 0 && Y >= 0 && X < W && Y < H) { const o = (Y * W + X) * 3; rgb[o] = c[0]; rgb[o + 1] = c[1]; rgb[o + 2] = c[2]; } } };
  for (const s of world.colliders.spheres) for (let k = 0; k < 90; k++) {
    const a = (k / 90) * Math.PI * 2; const r = world.camera.right, u = world.camera.up;
    if (proj(m, s.x + (r[0] * Math.cos(a) + u[0] * Math.sin(a)) * s.r, s.y + (r[1] * Math.cos(a) + u[1] * Math.sin(a)) * s.r, s.z + (r[2] * Math.cos(a) + u[2] * Math.sin(a)) * s.r, W, H, A)) dot(A[0], A[1], GOLD, 0);
  }
  for (let i = 0; i < cl.n; i++) if (cl.pinned[i] && proj(m, p[i * 3], p[i * 3 + 1], p[i * 3 + 2], W, H, A)) dot(A[0], A[1], VERMILION, 1);
  for (const P of world.pointers) if (P.active && P.particle >= 0 && proj(m, p[P.particle * 3], p[P.particle * 3 + 1], p[P.particle * 3 + 2], W, H, A)) dot(A[0], A[1], [120, 200, 255], 2);
  return rgb;
}

// ------------------------------------------------------------------------------------------- cli
function clothRect() {
  const s = world.screen, cl = world.cloth;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < cl.n; i++) { if (s[i * 3 + 2] <= 0 || !cl.vTri[i]) continue; x0 = Math.min(x0, s[i * 3]); x1 = Math.max(x1, s[i * 3]); y0 = Math.min(y0, s[i * 3 + 1]); y1 = Math.max(y1, s[i * 3 + 1]); }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const scene = arg('--scene', 'noren'), quality = arg('--quality', 'mid');
  const shots = arg('--frames', '30,90,150,240').split(',').map(Number);
  const Wt = Number(arg('--w', '195')), Ht = Number(arg('--h', '350')); // the lab's 390×700 aspect
  const opts = { quality, material: arg('--material', null) || undefined };
  if (has('--wind')) opts.wind = Number(arg('--wind'));
  setup(scene, opts);
  if (arg('--dir', '')) { const d = arg('--dir').split(',').map(Number); world.cameraRig.dir = d; world.cameraRig.up = [0, 0, -1]; }
  const grabs = (arg('--grab', '') || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const slices = (arg('--slice', '') || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const burns = (arg('--burn', '') || '').split(';').filter(Boolean).map((s) => s.split(',').map(Number));
  const wet = arg('--wet', '') ? arg('--wet').split(',').map(Number) : null;
  const total = Math.max(...shots);
  const sheet = Buffer.alloc(Wt * shots.length * Ht * 3);
  let tears = 0, cuts = 0, maxT = 0;
  const gstate = grabs.map(() => ({ x: 0, y: 0, slot: -1 }));
  for (let f = 0; f <= total; f++) {
    // scripted input, in screen space like a finger (world.screen is last frame's projection)
    grabs.forEach((g, k) => {
      const [fx, fy, dx, dy, f0, f1] = g, st = gstate[k];
      if (f === f0) {
        const r = clothRect(); st.x = r.x0 + r.w * fx; st.y = r.y0 + r.h * fy;
        const v = sim.pick(world, st.x, st.y, 44);
        if (v >= 0) { const P = world.pointers[k]; P.active = true; P.particle = v; P.depth = world.screen[v * 3 + 2]; unproject(world, st.x, st.y, P.depth, P.target); st.slot = k; }
      } else if (f > f0 && f <= f1 && st.slot >= 0) {
        const t = (f - f0) / (f1 - f0), P = world.pointers[st.slot];
        unproject(world, st.x + dx * t, st.y + dy * t, P.depth, P.target);
        if (f === f1) { P.active = false; P.particle = -1; st.slot = -1; }
      }
    });
    for (const [a, b, c, d, fs] of slices) if (f === fs) { const r = clothRect(); cuts += sim.slice(world, r.x0 + r.w * a, r.y0 + r.h * b, r.x0 + r.w * c, r.y0 + r.h * d); }
    for (const [a, b, fs] of burns) if (f === fs) { const r = clothRect(); const v = sim.pick(world, r.x0 + r.w * a, r.y0 + r.h * b, 30); if (v >= 0) { sim.killVertex(world, v); } }
    if (wet && f >= wet[0]) world.cloth.massScale.fill(wet[1]);
    frame(1 / 60);
    tears += world.events.tear.n; if (f > 10) maxT = Math.max(maxT, world.stats.tension);
    clearEvents(world.events);
    const si = shots.indexOf(f);
    if (si >= 0) {
      const img = render(Wt, Ht, { strain: has('--strain') });
      for (let y = 0; y < Ht; y++) img.subarray(y * Wt * 3, (y + 1) * Wt * 3).forEach((v, i) => { sheet[(y * Wt * shots.length + si * Wt) * 3 + i] = v; });
    }
  }
  // the camera rig was fitted for 390×700; render() used the same matrices scaled to W×H
  const out = arg('--out', `${scene}.png`), path = isAbsolute(out) ? out : join(OUT, out);
  writeFileSync(path, png(Wt * shots.length, Ht, sheet));
  console.log(`✓ ${path}  frames ${shots.join(',')}  tears ${tears} cuts ${cuts} maxTension ${maxT.toFixed(3)} kinetic ${world.stats.kinetic.toFixed(2)} flutter ${world.stats.flutter.toFixed(1)}`);
}
