// Cloth rendering. Owned by cloth-render.
//
// Per frame: upload() streams positions and normals (straight from the sim's arrays, no copy) and packs the
// per-vertex FX into 8 bytes (heat, fuel, char, wet · fold curvature, torn edge), re-packing the index buffer
// only when tearing changed the topology. draw() shades the cloth in ONE double-sided call (the reverse side
// really differs); drawEmissive() renders exactly what glows (ember edges, smouldering char, red-hot rings,
// the aurora's own light) for the bloom pass, black elsewhere.
//
// Publishes world.gpu.printTex, world.gpu.printPixels ({ w, h, data } RGBA, once per scene) and
// world.gpu.cloth = { pos, nrm, uv, fx, index, count, fxStride: 8 } (fx = UNSIGNED_BYTE ×8, normalised:
// heat, fuel as drawn, char, wet, curvature (0.5 flat), torn-edge factor, standing water (1/255 = 1 mm), 0).
// Reads cloth.pool when fx/wet.js provides it (depth of standing water, m): the water's skin is drawn at
// pos + (0, pool, 0).
import { program, buffer, texture, useAttribs, attrib, UNIT } from './gl.js';
import { COMMON, SHADOW, setCommon, setShadow } from './glsl.js';
import { RENDER_MATERIALS, qualityOf, makeWeave, clothVS, clothFS } from './materials.js';
import { makePrint } from './prints.js';

let glx = null;
const opts = { a2c: false, highp: true };
const progs = Object.create(null);
let P = null, PE = null, quality = -1, matId = '';
let dummyDye = null;
const weaves = Object.create(null);     // material id → { tex, perTile }
let bPos = null, bNrm = null, bUV = null, bFx = null, bIdx = null;
let fx = new Uint8ClampedArray(0), idx = new Uint16Array(0), count = 0, topo = -1;
// fold curvature from the bend constraints (a–b–c: how far b sits off the a–c midpoint along its normal)
let bendA = new Int32Array(0), bendB = new Int32Array(0), bendC = new Int32Array(0), bendJ = new Int32Array(0), bendK = new Float32Array(0);
let curv = new Float32Array(0), curvAcc = new Float32Array(0), curvCnt = new Uint8Array(0), inv0 = new Float32Array(0);
let edge = new Float32Array(0), edgeTopo = -1, torn = false;
let aliasList = new Int32Array(0);
// the scene's cloth in metres (from the rest mesh), and the repeats that follow from it
let metresU = 1, metresV = 1;
const prof = new Float32Array(17);
const weaveRep = new Float32Array(2), noiseRep = new Float32Array(2), maskU = new Float32Array(2), shotU = new Float32Array(3);
const phase = new Float32Array(4);
let printKey = '';
let staticVer = 1;       // bumped when the per-scene uniforms change (programs re-send them once)
let glowing = false, cutting = false;   // this frame: any heat? any burnt/torn edge? (from upload)
let PO = null;           // the emissive pass's black occluder, for quiet frames
const OCC_VS = 'attribute vec3 aPos; uniform mat4 uViewProj; void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }';
const OCC_FS = 'void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }';
const occLocs = [0];
const locs = [0, 0, 0, 0, 0];

const PASSES = ['main', 'emissive', 'shadow'];

/** The compiled program for a pass with the current material and quality (compiles on first use). */
export function getProgram(world, pass) {
  const q = qualityOf(world.q), id = RENDER_MATERIALS[world.materialId] ? world.materialId : 'cotton';
  const key = `${pass}|${id}|${q}`;
  let p = progs[key];
  if (p) return p;
  const o = { a2c: opts.a2c && pass === 'main', highp: opts.highp };
  p = program(world.glx, clothVS(id, q, pass, o), COMMON + (pass === 'main' ? SHADOW : '') + clothFS(id, q, pass, o), `cloth-${pass}-${id}-q${q}`);
  const gl = world.gl;
  gl.useProgram(p.prog);
  if (p.u.uPrint) gl.uniform1i(p.u.uPrint, UNIT.PRINT);
  if (p.u.uDye) gl.uniform1i(p.u.uDye, UNIT.DYE);
  if (p.u.uWeave) gl.uniform1i(p.u.uWeave, UNIT.A);
  progs[key] = p;
  return p;
}

let PS = null;
function ensurePrograms(world) {
  const q = qualityOf(world.q);
  if (q === quality && matId === world.materialId && P) return;
  quality = q; matId = world.materialId;
  P = getProgram(world, 'main');
  PE = getProgram(world, 'emissive');
  PS = getProgram(world, 'shadow');
}

/** The current material's shadow (transmittance) program, for shadow.js (no lookup per frame). */
export const shadowProgram = () => PS;

export function init(world) {
  glx = world.glx;
  const gl = world.gl;
  opts.highp = !!glx.caps.highp;
  // alpha-to-coverage gives anti-aliased burn and ring edges, but only with a multisampled screen
  opts.a2c = !!glx.ext.deriv && (gl.getParameter(gl.SAMPLES) | 0) > 1;
  dummyDye = texture(glx, { w: 1, h: 1, data: new Uint8Array([255, 255, 255, 0]) });
  PO = program(glx, OCC_VS, OCC_FS, 'cloth-occluder');
  ensurePrograms(world);
}

export function onResize(world) { if (world.cloth) ensurePrograms(world); }

// ---------------------------------------------------------------------------------------------- scene
/** Metres per uv unit along u and v from the rest mesh, plus the u/v aspect in 16 bands of v (tubes taper). */
function measure(cl) {
  const B = 16, su = new Float64Array(B), sv = new Float64Array(B), sw = new Float64Array(B);
  let tu = 0, tv = 0, tw = 0;
  const p = cl.restPos || cl.pos, uv = cl.uv, T = cl.tri;   // the rest shape (physics publishes restPos)
  for (let t = 0; t < cl.t; t++) {
    const a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
    const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
    const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
    const du1 = uv[b * 2] - uv[a * 2], dv1 = uv[b * 2 + 1] - uv[a * 2 + 1], du2 = uv[c * 2] - uv[a * 2], dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const id = 1 / det;
    const lu = Math.hypot((e1x * dv2 - e2x * dv1) * id, (e1y * dv2 - e2y * dv1) * id, (e1z * dv2 - e2z * dv1) * id);
    const lv = Math.hypot((e2x * du1 - e1x * du2) * id, (e2y * du1 - e1y * du2) * id, (e2z * du1 - e1z * du2) * id);
    const area = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    tu += lu * area; tv += lv * area; tw += area;
    const k = Math.min(B - 1, Math.max(0, Math.floor(((uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3) * B)));
    su[k] += lu * area; sv[k] += lv * area; sw[k] += area;
  }
  metresU = tw > 0 ? tu / tw : 1; metresV = tw > 0 ? tv / tw : 1;
  const flat = metresU / metresV;
  for (let k = 0; k < B; k++) prof[k] = sw[k] > 0 && sv[k] > 0 ? su[k] / sv[k] : flat;
  prof[B] = prof[B - 1];
}
const geo = {
  aspect: 1,   // metres per u ÷ metres per v
  mV: 1,       // metres per uv unit along v (prints size repeating patterns in metres with it)
  aspectAt(v) { const x = Math.min(15.999, Math.max(0, v * 16 - 0.5)), i = Math.floor(x), f = x - i; return prof[i] + (prof[i + 1] - prof[i]) * f; },
};
const pow2 = (x) => 2 ** Math.round(Math.log2(Math.max(1, x)));

/** Bend constraints → (a, b mid, c) triples for the per-frame fold curvature. */
function buildBends(cl) {
  let nb = 0;
  for (let j = 0; j < cl.m; j++) if (cl.kind[j] === 2 && cl.bendDep[j * 2] >= 0 && cl.bendDep[j * 2 + 1] >= 0) nb++;
  bendA = new Int32Array(nb); bendB = new Int32Array(nb); bendC = new Int32Array(nb); bendJ = new Int32Array(nb); bendK = new Float32Array(nb);
  let k = 0;
  for (let j = 0; j < cl.m; j++) {
    if (cl.kind[j] !== 2) continue;
    const d0 = cl.bendDep[j * 2], d1 = cl.bendDep[j * 2 + 1];
    if (d0 < 0 || d1 < 0) continue;
    const x0 = cl.cA[d0], y0 = cl.cB[d0], x1 = cl.cA[d1], y1 = cl.cB[d1];
    const mid = x0 === x1 || x0 === y1 ? x0 : y0;
    const r = cl.rest[j] || 1e-3;
    bendA[k] = cl.cA[j]; bendB[k] = mid; bendC[k] = cl.cB[j]; bendJ[k] = j; bendK[k] = 8 / (r * r);
    k++;
  }
}

function updateReps(world) {
  const m = RENDER_MATERIALS[world.materialId] || RENDER_MATERIALS.cotton;
  const w = weaves[world.materialId];
  const per = (m.threads || 60) / (w ? w.perTile : 8);
  // whole repeats per uv unit, so a tube's texture closes seamlessly where u wraps
  weaveRep[0] = Math.max(1, Math.round(per * metresU)); weaveRep[1] = Math.max(1, Math.round(per * metresV));
  noiseRep[0] = Math.max(1, Math.round(metresU / 0.6)); noiseRep[1] = Math.max(1, Math.round(metresV / 0.6));
  staticVer++;
}

export function onScene(world) {
  const gl = world.gl, cl = world.cloth, n = cl.n;
  for (const b of [bPos, bNrm, bUV, bFx, bIdx]) if (b) gl.deleteBuffer(b);
  bPos = buffer(gl, gl.ARRAY_BUFFER, cl.pos.byteLength, gl.DYNAMIC_DRAW);
  bNrm = buffer(gl, gl.ARRAY_BUFFER, cl.normal.byteLength, gl.DYNAMIC_DRAW);
  bUV = buffer(gl, gl.ARRAY_BUFFER, cl.uv, gl.STATIC_DRAW);
  fx = new Uint8ClampedArray(n * 8);
  bFx = buffer(gl, gl.ARRAY_BUFFER, fx.byteLength, gl.DYNAMIC_DRAW);
  idx = new Uint16Array(cl.t * 3);
  bIdx = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, idx.byteLength, gl.DYNAMIC_DRAW);
  topo = -1; count = 0;
  curv = new Float32Array(n); curvAcc = new Float32Array(n); curvCnt = new Uint8Array(n);
  inv0 = new Float32Array(n); edge = new Float32Array(n); edgeTopo = -1; torn = false;
  for (let i = 0; i < n; i++) inv0[i] = cl.vTri[i] ? 1 / cl.vTri[i] : 0;
  let na = 0; for (let i = 0; i < n; i++) if (cl.alias[i] >= 0) na++;
  aliasList = new Int32Array(na); na = 0;
  for (let i = 0; i < n; i++) if (cl.alias[i] >= 0) aliasList[na++] = i;
  buildBends(cl);
  measure(cl);
  geo.aspect = metresU / metresV; geo.mV = metresV;

  // the print: repainted only when the scene, the size or the cloth's proportions change. Its texels are
  // about square ON THE CLOTH (a tall nobori gets 512 × 2048 rather than a squashed 1024²), at about the
  // tier's texel budget.
  const id = (world.scene && world.scene.print) || 'unveil';
  const size = world.q.name === 'low' ? 512 : 1024, maxT = Math.min(4096, glx.caps.maxTex || 4096);
  const ar = Math.sqrt(Math.max(0.02, Math.min(50, geo.aspect)));
  let tw = Math.min(maxT, Math.max(size / 4, pow2(size * ar))), th = Math.min(maxT, Math.max(size / 4, pow2(size / ar)));
  while (tw * th > size * size * 1.5) { if (tw > th) tw /= 2; else th /= 2; }
  const key = `${id}|${tw}x${th}|${geo.aspect.toFixed(3)}|${geo.mV.toFixed(2)}|${prof[0].toFixed(2)}|${prof[15].toFixed(2)}`;
  if (key !== printKey || !world.gpu.printTex) {
    printKey = key;
    const pr = makePrint(id, tw, th, geo);
    if (world.gpu.printTex) gl.deleteTexture(world.gpu.printTex);
    world.gpu.printTex = texture(glx, { w: pr.w, h: pr.h, data: pr.data, filter: 'mip', wrap: 'clamp', aniso: 4 });
    world.gpu.printPixels = { w: pr.w, h: pr.h, data: pr.data };
    shotU[0] = pr.shot[0]; shotU[1] = pr.shot[1]; shotU[2] = pr.shot[2];
    maskU[0] = pr.mask[0]; maskU[1] = pr.mask[1];
  }
  world.gpu.cloth = { pos: bPos, nrm: bNrm, uv: bUV, fx: bFx, index: bIdx, count: 0, fxStride: 8 };
  onMaterial(world);
}

export function onMaterial(world) {
  const id = RENDER_MATERIALS[world.materialId] ? world.materialId : 'cotton';
  if (!weaves[id]) {
    const w = makeWeave(id, 128);
    weaves[id] = { tex: texture(glx, { w: w.size, h: w.size, data: w.data, filter: 'mip', wrap: 'repeat', aniso: 8 }), perTile: w.perTile, mean: new Float32Array(w.mean) };
  }
  updateReps(world);
  ensurePrograms(world);
}

// --------------------------------------------------------------------------------------------- frame
let half = 0;
/** Fold curvature, smoothed over time. Each frame visits every other bend (alternating halves): a vertex
 *  sees its horizontal and vertical bends on alternate frames and the smoothing blends them. */
function curvature(cl) {
  const p = cl.pos, N = cl.normal, alive = cl.alive, n = cl.n;
  curvAcc.fill(0); curvCnt.fill(0);
  half ^= 1;
  for (let k = half; k < bendJ.length; k += 2) {
    if (!alive[bendJ[k]]) continue;
    const a = bendA[k] * 3, m = bendB[k], b = m * 3, c = bendC[k] * 3;
    const dx = p[b] - 0.5 * (p[a] + p[c]), dy = p[b + 1] - 0.5 * (p[a + 1] + p[c + 1]), dz = p[b + 2] - 0.5 * (p[a + 2] + p[c + 2]);
    curvAcc[m] += (dx * N[b] + dy * N[b + 1] + dz * N[b + 2]) * bendK[k];
    curvCnt[m]++;
  }
  for (let i = 0; i < n; i++) if (curvCnt[i]) curv[i] = curv[i] * 0.45 + curvAcc[i] / curvCnt[i] * 0.55;
  for (let k = 0; k < aliasList.length; k++) { const i = aliasList[k]; curv[i] = curv[cl.alias[i]]; }
}

/** Stream this frame's cloth into the GL buffers. Called once per frame before any cloth draw. */
export function upload(world) {
  const gl = world.gl, cl = world.cloth;
  if (!cl || !bPos) return;
  // time as wrapped phases, in double precision here so the shaders stay mediump-safe forever
  const t = world.time, TAU = 6.283185307179586;
  phase[0] = (t * 9) % TAU; phase[1] = (t * 2.7) % TAU; phase[2] = (t * 0.4) % TAU; phase[3] = (t * 0.9) % 1;
  gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, cl.pos);
  gl.bindBuffer(gl.ARRAY_BUFFER, bNrm); gl.bufferSubData(gl.ARRAY_BUFFER, 0, cl.normal);
  curvature(cl);
  const { heat, fuel, wet, vTri } = cl, chr = cl.char, n = cl.n, K = 127.5 / 60;
  if (edgeTopo !== cl.topoVersion) {
    // torn-edge factor: the share of a vertex's triangles that are gone (only changes with the topology)
    edgeTopo = cl.topoVersion; torn = false;
    for (let i = 0, o = 5; i < n; i++, o += 8) {
      const e = vTri[i] ? 1 - vTri[i] * inv0[i] : 0;
      edge[i] = e; fx[o] = e * 255;
      if (e > 0.001) torn = true;
    }
  }
  let hMax = 0, fMin = 1;
  for (let i = 0, o = 0; i < n; i++, o += 8) {
    const c = chr[i], h = heat[i], e = edge[i];
    let f = fuel[i];
    // a charred vertex on a hole's rim burns away visually (as soon as it has lost a triangle), so the hole's
    // visible edge runs organically between the rim and the next ring in, never along a triangle edge
    if (e > 0.01 && c > 0.12) f *= 1 - 0.85 * (e > 0.125 ? 1 : e * 8) * (c > 0.453 ? 1 : (c - 0.12) * 3);
    fx[o] = h * 255; fx[o + 1] = f * 255; fx[o + 2] = c * 255; fx[o + 3] = wet[i] * 255;
    fx[o + 4] = curv[i] * K + 127.5;
    if (h > hMax) hMax = h; if (f < fMin) fMin = f;
  }
  // standing water (fx/wet.js publishes cloth.pool: depth in metres above the cloth), 1 byte = 1 mm
  const pool = cl.pool;
  if (pool) {
    for (let i = 0, o = 6; i < n; i++, o += 8) fx[o] = pool[i] * 1000;
    for (let k = 0; k < aliasList.length; k++) { const i = aliasList[k]; fx[i * 8 + 6] = fx[cl.alias[i] * 8 + 6]; }
  }
  // quiet: nothing glows and nothing is cut away, so the emissive pass only has to occlude
  glowing = hMax > 0.02; cutting = fMin < 0.995 || torn;
  gl.bindBuffer(gl.ARRAY_BUFFER, bFx); gl.bufferSubData(gl.ARRAY_BUFFER, 0, fx);
  if (topo !== cl.topoVersion) {
    topo = cl.topoVersion;
    let k = 0; const tri = cl.tri, alive = cl.triAlive;
    for (let t = 0; t < cl.t; t++) if (alive[t]) { idx[k++] = tri[t * 3]; idx[k++] = tri[t * 3 + 1]; idx[k++] = tri[t * 3 + 2]; }
    count = k;
    // the whole array (no subarray view: that would allocate on every tearing frame); the stale tail past
    // `count` is never drawn
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx); gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idx);
    world.gpu.cloth.count = count;
  }
}

/** Bind the cloth's attributes, textures and per-scene uniforms for any cloth program (shadow.js uses it). */
export function bindCloth(world, p, viewProj) {
  const gl = world.gl, u = p.u, g = world.gpu;
  locs[0] = p.a.aPos; locs[1] = p.a.aNrm; locs[2] = p.a.aUV; locs[3] = p.a.aFx; locs[4] = p.a.aFx2;
  useAttribs(gl, locs);
  attrib(gl, p.a.aPos, bPos, 3); attrib(gl, p.a.aNrm, bNrm, 3); attrib(gl, p.a.aUV, bUV, 2);
  gl.bindBuffer(gl.ARRAY_BUFFER, bFx);   // both fx attributes come from one interleaved byte buffer
  if (p.a.aFx >= 0) gl.vertexAttribPointer(p.a.aFx, 4, gl.UNSIGNED_BYTE, true, 8, 0);
  if (p.a.aFx2 >= 0) gl.vertexAttribPointer(p.a.aFx2, 4, gl.UNSIGNED_BYTE, true, 8, 4);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
  gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
  if (u.uPhase) gl.uniform4fv(u.uPhase, phase);
  if (u.uPrint) { gl.activeTexture(gl.TEXTURE0 + UNIT.PRINT); gl.bindTexture(gl.TEXTURE_2D, g.printTex); }
  if (u.uDye) { gl.activeTexture(gl.TEXTURE0 + UNIT.DYE); gl.bindTexture(gl.TEXTURE_2D, g.dyeTex || dummyDye); }
  const w = weaves[world.materialId] || weaves.cotton;
  if (u.uWeave) { gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.bindTexture(gl.TEXTURE_2D, w ? w.tex : null); }
  // per-scene uniforms: sent to each program once per change, not every frame
  if (p.ver !== staticVer) {
    p.ver = staticVer;
    if (u.uWeaveMean && w) gl.uniform4fv(u.uWeaveMean, w.mean);
    if (u.uWeaveRep) gl.uniform2fv(u.uWeaveRep, weaveRep);
    if (u.uNoiseRep) gl.uniform2fv(u.uNoiseRep, noiseRep);
    if (u.uMask) gl.uniform2fv(u.uMask, maskU);
    if (u.uShot) gl.uniform3fv(u.uShot, shotU);
  }
}

/** Number of indices to draw this frame (0 = nothing left of the cloth). */
export const indexCount = () => count;

let shadowDepth = 0;
/** shadow.js: whether its map's alpha holds the nearest cloth depth (EXT_blend_minmax), for self-shadowing. */
export function setShadowDepth(on) { shadowDepth = on ? 1 : 0; }

/** Shade the cloth into the current target (the screen). */
export function draw(world) {
  if (!count || !P) return;
  const gl = world.gl, u = P.u;
  gl.useProgram(P.prog);
  setCommon(world, P);
  setShadow(world, P);
  const sp = world.lights.shadow.type === 'point' ? 1 : 0;
  if (u.uShadowSelf && P.self !== shadowDepth) { P.self = shadowDepth; gl.uniform1f(u.uShadowSelf, shadowDepth); }
  if (u.uShadowPoint && P.sp !== sp) { P.sp = sp; gl.uniform1f(u.uShadowPoint, sp); }
  const rain = world.rain.intensity;
  if (u.uRain && P.rain !== rain) { P.rain = rain; gl.uniform1f(u.uRain, rain); }
  bindCloth(world, P, world.camera.viewProj);
  // alpha-to-coverage only matters where something is cut out (burns, tears, rings)
  const a2c = opts.a2c && (cutting || matId === 'chainmail');
  if (a2c) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  if (a2c) gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  world.stats.drawCalls++;
}

/** Only the glow (and black, depth-writing cloth elsewhere) into the current target (the bloom buffer). */
export function drawEmissive(world) {
  if (!count || !PE) return;
  const gl = world.gl;
  const pc = world.lights.pointCol, lamp = pc[0] + pc[1] + pc[2] > 0.3;   // a lamp may make the cloth glow
  if (!glowing && !cutting && !lamp && matId !== 'chainmail' && matId !== 'aurora') {
    // a quiet frame: nothing glows or shows through, so a plain black occluder is all the bloom needs
    gl.useProgram(PO.prog);
    occLocs[0] = PO.a.aPos; useAttribs(gl, occLocs);
    attrib(gl, PO.a.aPos, bPos, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bIdx);
    gl.uniformMatrix4fv(PO.u.uViewProj, false, world.camera.viewProj);
  } else {
    gl.useProgram(PE.prog);
    setCommon(world, PE);
    bindCloth(world, PE, world.camera.viewProj);
  }
  gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  world.stats.drawCalls++;
}

/**
 * Test hook: paint print `id` flat into a PNG data URL. aspect: metres per u ÷ metres per v (taper: the
 * aspect at the far end of v, for tubes). Not used at runtime.
 */
export function printPreview(id, w = 512, h = w, aspect = 1, mV = 1, profile = null) {
  const g = { aspect, mV, aspectAt: (v) => (profile ? profile[Math.min(profile.length - 1, Math.floor(v * profile.length))] : aspect) };
  const pr = makePrint(id, w, h, g);
  const c = document.createElement('canvas'); c.width = pr.w; c.height = pr.h;
  const x = c.getContext('2d'), img = x.createImageData(pr.w, pr.h);
  for (let i = 0; i < pr.data.length; i += 4) { img.data[i] = pr.data[i]; img.data[i + 1] = pr.data[i + 1]; img.data[i + 2] = pr.data[i + 2]; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  const mask = document.createElement('canvas'); mask.width = pr.w; mask.height = pr.h;
  const mx = mask.getContext('2d'), mi = mx.createImageData(pr.w, pr.h);
  for (let i = 0; i < pr.data.length; i += 4) { const a = 255 - pr.data[i + 3]; mi.data[i] = mi.data[i + 1] = mi.data[i + 2] = a; mi.data[i + 3] = 255; }
  mx.putImageData(mi, 0, 0);
  return { print: c.toDataURL(), mask: mask.toDataURL(), maskMode: pr.mask };
}

/** Debug/test hook: what the renderer derived for this scene (fx: the packed per-vertex bytes, live). */
export function debug() {
  return { metresU, metresV, aspect: geo.aspect, prof: Array.from(prof), weaveRep: Array.from(weaveRep), noiseRep: Array.from(noiseRep), a2c: opts.a2c, quality, programs: Object.keys(progs), passes: PASSES, fx, edge };
}
