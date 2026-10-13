// Coloured transmittance shadows, the signature effect: light passing THROUGH the cloth lands on the wall
// and floor in the print's colours (a white crest on indigo throws a bright crest into a blue pool), dye
// stains the light, wet cloth lets more through, and burnt holes and cuts throw bright patches.
//
// Each frame: render the cloth from world.lights.shadow ('dir': an ortho box fitted to cloth.bounds;
// 'point': a perspective frustum fitted to the bounds' corners) into a small RGBA target (world.q.shadowRes)
// holding transmittance: white where no cloth, print colour × the material's transmission where cloth.
// Layers multiply (blend DST_COLOR, ZERO), so folds and overlapping panels stack. Alpha keeps the NEAREST
// cloth depth (blend MIN, EXT_blend_minmax), so a receiver can tell whether it is in front of the cloth.
// A separable blur softens the edges on the larger maps. Publishes world.gpu.shadowTex / shadowMat
// (world → uv in xy, depth 0..1 in z) / shadowOn. Receivers sample it through glsl.js SHADOW shadowAt().
import { program, target, deleteTarget, bindTarget, drawFullscreen, FS_VERT, UNIT } from './gl.js';
import { setCommon } from './glsl.js';
import { lookAt, ortho, multiply } from '../core/math.js';
import { shadowProgram, bindCloth, indexCount, setShadowDepth } from './cloth.js';

let A = null, B = null, PB = null, res = 0, minmax = null;
const view = new Float32Array(16), proj = new Float32Array(16), vp = new Float32Array(16);
const BIAS = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);
const eye = new Float32Array(3), ctr = new Float32Array(3), up = new Float32Array(3);
const step = new Float32Array(2);

const BLUR = `
uniform sampler2D uTex; uniform vec2 uStep; varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(uTex, vUv);
  vec4 c1 = texture2D(uTex, vUv + uStep), c2 = texture2D(uTex, vUv - uStep);
  vec4 c3 = texture2D(uTex, vUv + uStep * 2.4), c4 = texture2D(uTex, vUv - uStep * 2.4);
  vec3 c = c0.rgb * 0.3 + (c1.rgb + c2.rgb) * 0.24 + (c3.rgb + c4.rgb) * 0.11;
  gl_FragColor = vec4(c, min(c0.a, min(min(c1.a, c2.a), min(c3.a, c4.a))));
}`;

export function init(world) {
  minmax = world.gl.getExtension('EXT_blend_minmax');
  setShadowDepth(!!minmax);
  PB = program(world.glx, FS_VERT, BLUR, 'shadow-blur');
  world.gl.useProgram(PB.prog);
  world.gl.uniform1i(PB.u.uTex, UNIT.A);
}

function allocate(world) {
  const gl = world.gl;
  deleteTarget(gl, A); deleteTarget(gl, B);
  res = world.q.shadowRes;
  A = target(gl, res, res, { filter: 'linear' });
  B = res > 128 ? target(gl, res, res, { filter: 'linear' }) : null;
}

export function onScene(world) { world.gpu.shadowOn = 0; if (res !== world.q.shadowRes) allocate(world); }
export function onResize(world) { if (A && res !== world.q.shadowRes) allocate(world); }

/** Off-centre perspective (column-major), like glFrustum. */
function frustum(out, l, r, b, t, n, f) {
  out.fill(0);
  out[0] = (2 * n) / (r - l); out[5] = (2 * n) / (t - b);
  out[8] = (r + l) / (r - l); out[9] = (t + b) / (t - b); out[10] = -(f + n) / (f - n); out[11] = -1;
  out[14] = (-2 * f * n) / (f - n);
}

/** Fit the casting light's projection around the cloth's bounds. Returns false when there is nothing to fit. */
function fit(world) {
  const S = world.lights.shadow, bn = world.cloth.bounds, mn = bn.min, mx = bn.max;
  if (!(mx[0] >= mn[0]) || !(mx[1] >= mn[1]) || !(mx[2] >= mn[2]) || !Number.isFinite(mx[0] - mn[0])) return false;
  const pad = 0.04;
  ctr[0] = (mn[0] + mx[0]) * 0.5; ctr[1] = (mn[1] + mx[1]) * 0.5; ctr[2] = (mn[2] + mx[2]) * 0.5;
  const rad = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * 0.5 + pad;
  let dx, dy, dz;
  if (S.type === 'point') { eye[0] = S.pos[0]; eye[1] = S.pos[1]; eye[2] = S.pos[2]; dx = ctr[0] - eye[0]; dy = ctr[1] - eye[1]; dz = ctr[2] - eye[2]; }
  else {
    dx = S.dir[0]; dy = S.dir[1]; dz = S.dir[2];
    const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
    eye[0] = ctr[0] - dx * (rad + 1); eye[1] = ctr[1] - dy * (rad + 1); eye[2] = ctr[2] - dz * (rad + 1);
  }
  const dl = Math.hypot(dx, dy, dz) || 1;
  if (Math.abs(dy / dl) > 0.97) { up[0] = 0; up[1] = 0; up[2] = 1; } else { up[0] = 0; up[1] = 1; up[2] = 0; }
  if (S.type === 'point' && dl < 1e-3) { ctr[0] = eye[0]; ctr[1] = eye[1] - 1; ctr[2] = eye[2]; up[0] = 0; up[1] = 0; up[2] = 1; }
  lookAt(view, eye, ctr, up);
  // the bounds' corners in light view space
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity, sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity;
  const v = view;
  for (let k = 0; k < 8; k++) {
    const px = (k & 1 ? mx[0] + pad : mn[0] - pad), py = (k & 2 ? mx[1] + pad : mn[1] - pad), pz = (k & 4 ? mx[2] + pad : mn[2] - pad);
    const X = v[0] * px + v[4] * py + v[8] * pz + v[12], Y = v[1] * px + v[5] * py + v[9] * pz + v[13], Z = -(v[2] * px + v[6] * py + v[10] * pz + v[14]);
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    if (Z > 1e-3) { const a = X / Z, b = Y / Z; if (a < sx0) sx0 = a; if (a > sx1) sx1 = a; if (b < sy0) sy0 = b; if (b > sy1) sy1 = b; }
  }
  let extent;   // the map's width in world units where the cloth is (for the blur's penumbra)
  if (S.type === 'point') {
    const near = Math.max(0.04, z0 * 0.92), far = Math.max(near + 0.1, z1 * 1.08);
    extent = Math.max(sx1 - sx0, sy1 - sy0) * (z0 + z1) * 0.5;
    if (z0 < 0.06 || sx1 - sx0 > 7 || sy1 - sy0 > 7) {
      // the light is in or right at the cloth (the moon under the sheet): fitting fails, so look along the
      // scene's shadow.dir (default: down) with its shadow.fov (default 150°), out to the farthest corner
      let ax = S.dir[0], ay = S.dir[1], az = S.dir[2];
      const al = Math.hypot(ax, ay, az);
      if (al < 1e-6) { ax = 0; ay = -1; az = 0; } else { ax /= al; ay /= al; az /= al; }
      ctr[0] = eye[0] + ax; ctr[1] = eye[1] + ay; ctr[2] = eye[2] + az;
      if (Math.abs(ay) > 0.97) { up[0] = 0; up[1] = 0; up[2] = 1; } else { up[0] = 0; up[1] = 1; up[2] = 0; }
      lookAt(view, eye, ctr, up);
      let fv = Number(S.fov) || 150; fv = Math.min(170, Math.max(20, fv));
      const n2 = 0.08, t = Math.tan((fv * Math.PI) / 360) * n2;
      frustum(proj, -t, t, -t, t, n2, Math.max(n2 + 0.5, dl + rad * 1.1 + 0.2));   // past the farthest cloth
      extent = 2 * (t / n2) * Math.max(0.3, dl);
    } else frustum(proj, sx0 * near, sx1 * near, sy0 * near, sy1 * near, near, far);
  } else {
    ortho(proj, x0, x1, y0, y1, Math.max(0.01, z0 - 0.05), z1 + 0.05);
    extent = Math.max(x1 - x0, y1 - y0);
  }
  multiply(vp, proj, view);
  multiply(world.gpu.shadowMat, BIAS, vp);
  // blur step in texels: a ~1 cm penumbra in world terms, measured on the fitted plane
  const texel = Math.max(1e-4, (Number.isFinite(extent) ? extent : 1) / res);
  step[0] = Math.min(3, 0.011 / texel);
  return true;
}

/** Render the coloured shadow map for this frame. Runs after cloth.upload() and before env.draw(). */
export function render(world) {
  const g = world.gpu, cl = world.cloth, n = indexCount(), S = world.lights.shadow, p = shadowProgram();
  if (!cl || !n || !p || !world.q.shadowRes || !(S.strength > 0)) { g.shadowOn = 0; return; }
  if (!A || res !== world.q.shadowRes) allocate(world);
  if (!fit(world)) { g.shadowOn = 0; return; }
  const gl = world.gl;
  bindTarget(world, A);   // no depth buffer on this target: the depth test passes everything, no need to switch it off
  gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  if (minmax) { gl.blendEquationSeparate(gl.FUNC_ADD, minmax.MIN_EXT); gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ONE, gl.ONE); }
  else gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ZERO);
  gl.useProgram(p.prog);
  setCommon(world, p);
  bindCloth(world, p, vp);
  const st = Math.min(1, S.strength);
  if (p.st !== st) { p.st = st; gl.uniform1f(p.u.uShadowStrength, st); }
  gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_SHORT, 0);
  world.stats.drawCalls++;
  if (minmax) gl.blendEquation(gl.FUNC_ADD);
  gl.disable(gl.BLEND);
  if (B && step[0] >= 0.3) {
    gl.useProgram(PB.prog);
    gl.activeTexture(gl.TEXTURE0 + UNIT.A);
    bindTarget(world, B); gl.bindTexture(gl.TEXTURE_2D, A.tex); step[1] = 0; step[0] /= res; gl.uniform2fv(PB.u.uStep, step); drawFullscreen(gl, PB);
    step[1] = step[0]; step[0] = 0;
    bindTarget(world, A); gl.bindTexture(gl.TEXTURE_2D, B.tex); gl.uniform2fv(PB.u.uStep, step); drawFullscreen(gl, PB);
    world.stats.drawCalls += 2;
  }
  bindTarget(world, null);
  g.shadowTex = A.tex; g.shadowOn = 1;
}

/** Test hook: the target size, whether depth-in-alpha is available, and the blur step (texels). */
export function debug() { return { res, minmax: !!minmax, blur: !!B }; }
