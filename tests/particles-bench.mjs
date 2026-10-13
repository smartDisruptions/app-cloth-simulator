// CPU cost and allocation check for render/particles.js, in plain Node (no browser), so the numbers hold
// up even when eight agents share four cores. It drives the REAL module (update + both draw passes, the
// vertex packing, the trail) with the real world object and camera, against a stub GL.
//   node --expose-gc tests/particles-bench.mjs [--quality low] [--frames 2000]
// Reports per-frame JS ms (CPU time: contention-proof) for update() and draw('main') + draw('emissive'),
// scaled ×4 as the contract's "4× throttle" estimate, and heap growth across the steady-state run (the
// "no per-frame allocation" receipt).
import { world } from '../src/core/world.js';
import { makeQ } from '../src/core/quality.js';
import { updateCamera } from '../src/core/camera.js';
import { seed, rand } from '../src/core/rng.js';
import { createBuilder } from '../src/sim/builder.js';
import * as particles from '../src/render/particles.js';
import * as post from '../src/render/post.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const quality = arg('--quality', 'low'), FRAMES = Number(arg('--frames', '2000'));

// ---- a GL that accepts everything and does nothing (a plain object: a Proxy would cost more than the code)
const noop = () => {};
const glStub = {
  getShaderParameter: () => true, getProgramParameter: (p, k) => (k === 'LINK_STATUS' ? true : 0),
  getParameter: () => 4096, getShaderPrecisionFormat: () => ({ precision: 23 }), isContextLost: () => false,
  createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}), createTexture: () => ({}),
  createFramebuffer: () => ({}), createRenderbuffer: () => ({}), getExtension: () => null,
};
for (const m of ['shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'getActiveAttrib', 'getActiveUniform', 'getAttribLocation', 'getUniformLocation',
  'bindBuffer', 'bufferData', 'bufferSubData', 'bindTexture', 'texImage2D', 'texParameteri', 'texParameterf', 'pixelStorei', 'generateMipmap', 'activeTexture',
  'bindFramebuffer', 'framebufferTexture2D', 'bindRenderbuffer', 'renderbufferStorage', 'framebufferRenderbuffer', 'deleteFramebuffer', 'deleteTexture', 'deleteRenderbuffer',
  'useProgram', 'uniform1i', 'uniform1f', 'uniform2f', 'uniform3f', 'uniform4f', 'uniform3fv', 'uniformMatrix4fv', 'enableVertexAttribArray', 'disableVertexAttribArray',
  'vertexAttribPointer', 'drawElements', 'drawArrays', 'enable', 'disable', 'blendFunc', 'depthMask', 'depthFunc', 'viewport', 'clear', 'clearColor', 'colorMask']) glStub[m] = noop;
for (const c of ['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'TEXTURE_2D', 'TEXTURE0', 'RGBA', 'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'FLOAT', 'TRIANGLES',
  'BLEND', 'ONE', 'ONE_MINUS_SRC_ALPHA', 'DEPTH_TEST', 'CULL_FACE', 'LEQUAL', 'FRAMEBUFFER', 'COLOR_ATTACHMENT0', 'DEPTH_ATTACHMENT', 'RENDERBUFFER', 'DEPTH_COMPONENT16',
  'LINEAR', 'NEAREST', 'LINEAR_MIPMAP_LINEAR', 'CLAMP_TO_EDGE', 'REPEAT', 'TEXTURE_MIN_FILTER', 'TEXTURE_MAG_FILTER', 'TEXTURE_WRAP_S', 'TEXTURE_WRAP_T', 'UNPACK_FLIP_Y_WEBGL',
  'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'VERTEX_SHADER', 'FRAGMENT_SHADER', 'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_ATTRIBUTES', 'ACTIVE_UNIFORMS', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT', 'HIGH_FLOAT', 'TRIANGLES'])
  glStub[c] = c;
world.gl = glStub;
world.glx = { gl: glStub, ext: {}, caps: { highp: true, maxTex: 4096, maxPoint: 64 } };
world.q = makeQ(quality); world.q.auto = false;
world.width = 360; world.height = 740; world.dpr = 1.25; world.pxWidth = 450; world.pxHeight = 925;
seed(7);

// ---- a scene: an embers-like hanging cloth, so fibres have a real cloth and print to read
const b = createBuilder();
b.grid({ name: 'cloth', cols: 20, rows: 24, origin: [-0.75, 2.4, 0], u: [1.5, 0, 0], v: [0, -1.8, 0], pin: (c, r) => r === 0 });
b.finalize(world);
world.scene = { id: 'embers', env: { floor: { y: 0 } }, ambient: { motes: 60, petals: 20 } };
world.sceneId = 'embers';
Object.assign(world.cameraRig, { target: [0, 1.5, 0], dir: [0, -0.05, -1], width: 2.0, height: 2.2, fov: 40 });
world.colliders.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
world.gpu.printPixels = { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(180) };
updateCamera(world);
world.wind.x = 2.4; world.wind.z = 0.3;
world.wind.sample = function (x, y, z, out) { // a weather-module-like field: a few trig calls
  const t = world.time; out[0] = this.x * (1 + 0.35 * Math.sin(x * 1.7 + t * 3.1) * Math.cos(z * 1.3 + y * 0.9 + t * 2.3)); out[1] = 0.4 * Math.sin(y * 2.1 - t * 2.7 + x * 0.7); out[2] = this.z; return out;
};
particles.init(world); post.init(world); post.onResize(world);
particles.onScene(world); post.onScene(world);

// ---- spawners: a stress mix that keeps the low-tier pool (700) full: fire + rain + a slice in progress
const K = { FLAME: 0, SPARK: 1, EMBER: 2, ASH: 3, SMOKE: 4, STEAM: 5, RAIN: 6, SPLASH: 7, DRIP: 8, FIBER: 9, STREAK: 10, MOTE: 11, PETAL: 12 };
const cl = world.cloth;
function spawners(f) {
  for (let k = 0; k < 9; k++) { const v = (rand() * cl.n) | 0; particles.spawn(world, K.FLAME, cl.pos[v * 3], cl.pos[v * 3 + 1], 0.01, 0, 0.4, 0, 0.06 + 0.04 * rand(), 0.4 + 0.4 * rand()); }
  if (f % 2 === 0) particles.spawn(world, K.SPARK, 0, 1, 0.02, (rand() - 0.5) * 2, 2 + rand(), 0.5, 0.006, 1);
  if (f % 2 === 1) particles.spawn(world, K.EMBER, 0, 1, 0.02, (rand() - 0.5) * 0.4, 0.6, 0, 0.011, 2);
  if (f % 3 === 0) particles.spawn(world, K.SMOKE, 0, 1.3, 0, 0, 0.3, 0, 0.12, 2.5);
  if (f % 3 === 1) particles.spawn(world, K.ASH, 0, 1.2, 0.02, 0.1, 0.4, 0, 0.016, 3);
  for (let k = 0; k < 6; k++) particles.spawn(world, K.RAIN, (rand() - 0.5) * 3, 3.5 + rand(), (rand() - 0.5) * 2, 0, -9.5, 0, 0.012, 2, 0);
  if (f % 4 === 0) particles.spawn(world, K.DRIP, 0.2, 1.0, 0, 0, -0.1, 0, 0.012, 3, 0);
  if (f % 6 === 0) particles.spawn(world, K.STREAK, -1, 1.5 + rand(), 0, 0, 0, 0, 0.02, 0.9);
  // rain.late: landed drops become splashes
  const ev = world.events.rainLand;
  for (let k = 0; k < ev.n; k++) { const o = k * 4; particles.spawn(world, K.SPLASH, ev.data[o], ev.data[o + 1] + 0.01, ev.data[o + 2], (rand() - 0.5) * 0.6, 1 + rand(), (rand() - 0.5) * 0.6, 0.012, 0.25); }
  // a tear every few frames, and a slash trail in progress for half the run
  if (f % 5 === 0) { const j = (rand() * cl.m) | 0; world.events.tear.push(0, 1.5, 0, j); }
  if ((f >> 6) & 1) particles.trail(world, 40 + (f % 64) * 4, 300 + (f % 64) * 2, 44 + (f % 64) * 4, 302 + (f % 64) * 2);
}
const clear = () => { for (const k in world.events) world.events[k].clear(); };

const now = () => performance.now();
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
let tU = null, tD = null;
function frame(f, i, timed) {
  world.dt = 1 / 60; world.frameDt = 1 / 60; world.time += world.dt; world.realTime += world.dt;
  spawners(f);
  if (timed) {
    const t0 = cpu(); particles.update(world, world.dt);
    const t1 = cpu(); particles.draw(world, 'main'); particles.draw(world, 'emissive');
    const t2 = cpu(); tU[i] = t1 - t0; tD[i] = t2 - t1;
  } else { particles.update(world, world.dt); particles.draw(world, 'main'); particles.draw(world, 'emissive'); }
  clear();
}
for (let f = 0; f < 600; f++) frame(f, 0, false); // warm up: fill the pool, let V8 optimise
if (process.argv.includes('--heapprof')) {
  // where do the steady-state bytes come from? sample allocations over 3000 warm frames, print the top sites
  const { Session } = await import('node:inspector/promises');
  const ses = new Session(); ses.connect();
  await ses.post('HeapProfiler.enable');
  await ses.post('HeapProfiler.startSampling', { samplingInterval: 64 });
  for (let f = 0; f < 3000; f++) frame(1000 + f, 0, false);
  const { profile } = await ses.post('HeapProfiler.stopSampling');
  const tot = new Map();
  const walk = (nd, stack) => {
    const fr = nd.callFrame, st = [...stack, `${fr.functionName || '(anon)'}@${fr.url.split('/').pop()}:${fr.lineNumber + 1}`];
    if (nd.selfSize) { const k = st.slice(-3).reverse().join(' < '); tot.set(k, (tot.get(k) || 0) + nd.selfSize); }
    for (const c of nd.children) walk(c, st);
  };
  walk(profile.head, []);
  for (const [k, v] of [...tot].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${(v / 3000).toFixed(1).padStart(7)} B/frame  ${k}`);
  process.exit(0);
}
// 1) allocation: the same frames untimed, heap before/after (the harness itself allocates nothing per frame)
if (global.gc) global.gc();
let h0 = process.memoryUsage().heapUsed;
for (let f = 0; f < FRAMES; f++) frame(600 + f, f, false);
let h1 = process.memoryUsage().heapUsed;
// 2) timing
tU = new Float64Array(FRAMES); tD = new Float64Array(FRAMES);
const wall0 = now();
for (let f = 0; f < FRAMES; f++) frame(600 + FRAMES + f, f, true);
const wall = (now() - wall0) / FRAMES;
const stat = (a) => { const s = Array.from(a).sort((x, y) => x - y); return { mean: s.reduce((x, y) => x + y, 0) / s.length, p50: s[(s.length * 0.5) | 0], p95: s[(s.length * 0.95) | 0] }; };
const U = stat(tU), D = stat(tD);
const f3 = (x) => +x.toFixed(3);
console.log(`quality ${quality} · cap ${particles.capacity(world)} · alive ${particles.count()} · ${FRAMES} frames · wall ${f3(wall)} ms/frame (whole loop, unthrottled)`);
console.log(`update  ms: mean ${f3(U.mean)}  p50 ${f3(U.p50)}  p95 ${f3(U.p95)}   → ×4 throttle ≈ ${f3(U.mean * 4)} (budget 0.6)`);
console.log(`draw    ms: mean ${f3(D.mean)}  p50 ${f3(D.p50)}  p95 ${f3(D.p95)}   → ×4 throttle ≈ ${f3(D.mean * 4)} (budget 0.5: packing + GL calls on a stub)`);
console.log(`drawn quads ${particles.debug.quads} of ${particles.count()} alive (+ trail) · glow from ${particles.debug.glowStart}`);
console.log(`heap growth over ${FRAMES} untimed frames (spawners + update + draw): ${((h1 - h0) / 1024).toFixed(1)} KB (${((h1 - h0) / FRAMES).toFixed(1)} B/frame)`);
