// Pure-JS cost of the cloth renderer's per-frame loops (fold curvature from the bends, fx byte packing), in
// Node's V8 with a real scene's topology (built by the scenes' own builder code, no browser).
//   node tests/cloth-render-loops.mjs [--scene noren] [--res 0.55]
import { createBuilder } from '../src/sim/builder.js';
import { SCENES } from '../src/scenes/index.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const id = arg('--scene', 'noren'), res = Number(arg('--res', '0.55'));
const world = { lights: { keyDir: new Float32Array(3), keyCol: new Float32Array(3), sky: new Float32Array(3), ground: new Float32Array(3), pointPos: new Float32Array(3), pointCol: new Float32Array(3), firePos: new Float32Array(3), fireCol: new Float32Array(3), fogCol: new Float32Array(3), shadow: { pos: new Float32Array(3), dir: new Float32Array(3) } }, colliders: { spheres: [], capsules: [], planes: [] }, cameraRig: { target: [0, 0, 0], dir: [0, 0, -1], offset: [0, 0, 0], up: [0, 1, 0] }, gravity: new Float32Array(3) };
const scene = SCENES.find((s) => s.id === id);
const b = createBuilder();
scene.build(world, b, res);
const cl = b.finalize(world);
const n = cl.n;
for (let i = 0; i < n * 3; i++) { cl.pos[i] += Math.sin(i * 1.7) * 0.01; cl.normal[i] = i % 3 === 2 ? 1 : 0; }

// --- the same loops as render/cloth.js ---
let nb = 0;
for (let j = 0; j < cl.m; j++) if (cl.kind[j] === 2 && cl.bendDep[j * 2] >= 0 && cl.bendDep[j * 2 + 1] >= 0) nb++;
const bendA = new Int32Array(nb), bendB = new Int32Array(nb), bendC = new Int32Array(nb), bendJ = new Int32Array(nb), bendK = new Float32Array(nb);
let k = 0;
for (let j = 0; j < cl.m; j++) {
  if (cl.kind[j] !== 2) continue;
  const d0 = cl.bendDep[j * 2], d1 = cl.bendDep[j * 2 + 1]; if (d0 < 0 || d1 < 0) continue;
  const x0 = cl.cA[d0], y0 = cl.cB[d0], x1 = cl.cA[d1], y1 = cl.cB[d1];
  bendA[k] = cl.cA[j]; bendB[k] = x0 === x1 || x0 === y1 ? x0 : y0; bendC[k] = cl.cB[j]; bendJ[k] = j; bendK[k] = 8 / (cl.rest[j] ** 2); k++;
}
const curv = new Float32Array(n), curvAcc = new Float32Array(n), curvCnt = new Uint8Array(n), inv0 = new Float32Array(n), edge = new Float32Array(n);
for (let i = 0; i < n; i++) inv0[i] = cl.vTri[i] ? 1 / cl.vTri[i] : 0;
const fx = new Uint8ClampedArray(n * 8);
let half = 0;
function curvature() {
  const p = cl.pos, N = cl.normal, alive = cl.alive;
  curvAcc.fill(0); curvCnt.fill(0);
  half ^= 1;
  for (let q = half; q < bendJ.length; q += 2) {
    if (!alive[bendJ[q]]) continue;
    const a = bendA[q] * 3, m = bendB[q], bb = m * 3, c = bendC[q] * 3;
    const dx = p[bb] - 0.5 * (p[a] + p[c]), dy = p[bb + 1] - 0.5 * (p[a + 1] + p[c + 1]), dz = p[bb + 2] - 0.5 * (p[a + 2] + p[c + 2]);
    curvAcc[m] += (dx * N[bb] + dy * N[bb + 1] + dz * N[bb + 2]) * bendK[q];
    curvCnt[m]++;
  }
  for (let i = 0; i < n; i++) if (curvCnt[i]) curv[i] = curv[i] * 0.45 + curvAcc[i] / curvCnt[i] * 0.55;
}
function pack() {
  const { heat, fuel, wet } = cl, chr = cl.char, K = 127.5 / 60;
  let hMax = 0, fMin = 1;
  for (let i = 0, o = 0; i < n; i++, o += 8) {
    const c = chr[i], h = heat[i], e = edge[i];
    let f = fuel[i];
    if (e > 0.01 && c > 0.12) f *= 1 - 0.8 * e * (c > 0.453 ? 1 : (c - 0.12) * 3);
    fx[o] = h * 255; fx[o + 1] = f * 255; fx[o + 2] = c * 255; fx[o + 3] = wet[i] * 255;
    fx[o + 4] = curv[i] * K + 127.5;
    if (h > hMax) hMax = h; if (f < fMin) fMin = f;
  }
  return hMax + fMin;
}
const bench = (name, fn, reps = 4000) => {
  for (let i = 0; i < 500; i++) fn();
  const t = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  const us = Number(process.hrtime.bigint() - t) / 1e3 / reps;
  console.log(`${name.padEnd(12)} ${us.toFixed(2)} µs  (×4 throttle ≈ ${(us * 4 / 1000).toFixed(3)} ms)`);
};
console.log(`${id} @ res ${res}: ${n} verts, ${cl.t} tris, ${nb} bends`);
bench('curvature', curvature);
bench('pack', pack);
