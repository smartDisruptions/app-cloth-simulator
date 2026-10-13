// Dumps the particle sprite atlas to PNGs without a browser, so the sprites can be looked at directly.
//   node tests/particles-atlas.mjs   → tests/out/particles-atlas-{rgb,r,g,b,look}.png
// rgb = the raw texture · r/g/b = one channel each as grey · look = each sprite composited the way the shader
// uses it (R as coverage over night ink; G through the flame ramp for the glowing cells).
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAtlas, ATLAS_SIZE, CELL } from '../src/render/fx-atlas.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const t0 = performance.now();
const times = [];
const A = makeAtlas(times);
const ms = performance.now() - t0;
const names = Object.fromEntries(Object.entries(CELL).map(([k, v]) => [v, k]));
console.log(times.map((t, c) => `${names[c]} ${t.toFixed(1)}`).join(' · '));
const S = ATLAS_SIZE, px = S * S;
const save = (name, fn) => {
  const b = Buffer.alloc(px * 3);
  for (let i = 0; i < px; i++) { const [r, g, bl] = fn(i); b[i * 3] = r; b[i * 3 + 1] = g; b[i * 3 + 2] = bl; }
  writeFileSync(join(OUT, `particles-atlas-${name}.png`), png(S, S, b));
};
save('rgb', (i) => [A[i * 4], A[i * 4 + 1], A[i * 4 + 2]]);
for (const [c, k] of [['r', 0], ['g', 1], ['b', 2]]) save(c, (i) => [A[i * 4 + k], A[i * 4 + k], A[i * 4 + k]]);
const glowing = new Set([CELL.DISC, CELL.FLAME_A, CELL.FLAME_B, CELL.EMBER, CELL.BEAM]);
const ink = [16, 19, 42];
save('look', (i) => {
  const x = i % S, y = (i / S) | 0, cell = ((y / 128) | 0) * 4 + ((x / 128) | 0);
  const R = A[i * 4] / 255, G = A[i * 4 + 1] / 255, B = A[i * 4 + 2] / 255;
  let c;
  if (glowing.has(cell)) {
    const T = G * 0.95, T2 = T * T;
    c = [1.6 * T + (cell === CELL.BEAM ? 0.3 * G + B : 0), 1.15 * T2 + (cell === CELL.BEAM ? 0.8 * G + B : 0) + (cell <= 2 ? 0.1 * B : 0), 0.8 * T2 * T2 + (cell === CELL.BEAM ? G + B : 0) + (cell <= 2 ? 0.45 * B : 0)].map((v) => v * R);
    return c.map((v, k) => Math.min(255, ink[k] + v * 255));
  }
  const base = cell === CELL.PETAL ? [0.96, 0.78, 0.83] : cell === CELL.ASH ? [0.2, 0.19, 0.18] : [0.8, 0.8, 0.82];
  c = base.map((b) => b * (0.25 + 0.75 * G) + 0.35 * B);
  return c.map((v, k) => Math.round(ink[k] * (1 - R) + Math.min(1, v) * 255 * R));
});
console.log(`✓ atlas painted in ${ms.toFixed(1)} ms → tests/out/particles-atlas-*.png`);
