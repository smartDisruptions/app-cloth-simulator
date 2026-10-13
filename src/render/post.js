// Post (owner: particles-post): bloom from an emissive-only pass, then ONE full-resolution composite that
// adds the bloom and grades the frame: vignette, matte lift, animated film grain, and the slow-mo look.
//
// Why emissive-only: re-rendering just the glowing things into a quarter-res buffer is far cheaper on old
// phones than rendering the whole scene to a texture, and the main pass keeps the screen's free MSAA.
// main.js: post.begin(world) → env/cloth/particles drawEmissive → post.end(world).
//
// Bloom is a dual filter (Bjørge 2015, the mobile standard): the ¼-res emissive buffer goes down a chain
// of halvings (5 taps each) and back up (8 taps each), every up step folding in its own level, so the glow
// is a sum of scales: a tight core and a wide halo. Total cost ≈ 0.8 full-screen taps (the old Gaussian
// was 1.25) for a far wider, smoother glow. Intermediate levels store sqrt(colour) so the faint wide halo
// survives 8-bit targets instead of banding to black.
//
// The composite never reads the screen (that would need the scene in a texture), so everything is
// "add colour, and scale what's there": out = rgb + screen × (1 − a). Slow-mo (timeScale < 0.5) deepens the
// vignette, mutes the edges toward a cold grey (desaturation-like), splits the bloom's channels outward
// (chromatic fringing on everything that glows: the katana trail, flames, lanterns) and lifts the grain.
import { program, target, deleteTarget, bindTarget, drawFullscreen, FS_VERT, UNIT } from './gl.js';
import { DOWN_FS, UP_FS, compositeFS } from './fx-shaders.js';
import { gradeFor } from './fx-grade.js';

const QOF = { low: 0, mid: 1, high: 2, ultra: 2 };
let PD = null, PU = null;
const PC = [];               // composite programs by QUALITY * 2 + bloom
let E = null, B = null;      // the emissive target (with depth) and the final bloom at the same size
const D = [], UPS = [];      // down levels, up levels
let levels = 0, Q = 1;
const eSize = new Float32Array(2);
const grade = {};
let sceneRef = null;
const SLOW = new Float64Array(1); // the eased slow-mo amount (a typed array: a module-level double allocates per write)

/** Size (px) of the bloom buffer the emissive pass draws into: particles need it for pixel-sized sprites. */
export function emissiveSize() { return eSize; }

function ensure(world) {
  Q = QOF[world.q.name] != null ? QOF[world.q.name] : 1;
  for (let b = 0; b < 2; b++) if (!PC[Q * 2 + b]) PC[Q * 2 + b] = program(world.glx, FS_VERT, compositeFS(Q, b), `composite-q${Q}${b ? '' : '-nobloom'}`);
}

export function init(world) {
  PD = program(world.glx, FS_VERT, DOWN_FS, 'bloom-down');
  PU = program(world.glx, FS_VERT, UP_FS, 'bloom-up');
  ensure(world);
}

export function onScene(world) { sceneRef = null; gradeFor(world, grade); sceneRef = world.scene; }

export function onResize(world) {
  const gl = world.gl;
  ensure(world);
  const div = world.q.bloomDiv || 4;
  const w = Math.max(16, Math.ceil(world.pxWidth / div)), h = Math.max(16, Math.ceil(world.pxHeight / div));
  // levels below the emissive buffer: each halves again (the deepest are a few dozen texels, nearly free)
  // and widens the halo: low ⅛–1/16 · mid to 1/32 · high to 1/64 · ultra (½-res emissive) to 1/64
  const want = Q === 0 ? 2 : Q === 1 ? 3 : div <= 2 ? 5 : 4;
  if (E && E.w === w && E.h === h && levels === want) return;
  deleteTarget(gl, E); deleteTarget(gl, B);
  for (const t of D) deleteTarget(gl, t);
  for (const t of UPS) deleteTarget(gl, t);
  D.length = 0; UPS.length = 0;
  E = target(gl, w, h, { depth: true });
  B = target(gl, w, h);
  levels = want;
  let lw = w, lh = h;
  for (let l = 0; l < levels; l++) {
    lw = Math.max(2, Math.ceil(lw / 2)); lh = Math.max(2, Math.ceil(lh / 2));
    D.push(target(gl, lw, lh));
    if (l < levels - 1) UPS.push(target(gl, lw, lh));
  }
  eSize[0] = w; eSize[1] = h;
}

/** Bind and clear the emissive buffer. Returns false when bloom is off (callers skip their emissive draws). */
export function begin(world) {
  if (!world.q.bloom || !E) return false;
  const gl = world.gl;
  bindTarget(world, E);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  return true;
}

function down(world, src, dst, decode) {
  const gl = world.gl;
  bindTarget(world, dst);
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.uniform2f(PD.u.uHalf, 1 / src.w, 1 / src.h);
  gl.uniform1f(PD.u.uDec, decode);
  drawFullscreen(gl, PD);
}

function up(world, low, same, dst, sameDecode, encode, mixLow, mixSame) {
  const gl = world.gl;
  bindTarget(world, dst);
  gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.bindTexture(gl.TEXTURE_2D, low.tex);
  gl.activeTexture(gl.TEXTURE0 + UNIT.B); gl.bindTexture(gl.TEXTURE_2D, same.tex);
  gl.uniform2f(PU.u.uHalf, 0.5 / low.w, 0.5 / low.h);
  gl.uniform2f(PU.u.uMix, mixLow, mixSame);
  gl.uniform1f(PU.u.uSameDec, sameDecode);
  gl.uniform1f(PU.u.uEnc, encode);
  drawFullscreen(gl, PU);
}

/** Blur the emissive buffer and composite it (with the grade) onto the screen. */
export function end(world) {
  const gl = world.gl, q = world.q;
  if (sceneRef !== world.scene) { gradeFor(world, grade); sceneRef = world.scene; }
  gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
  const bloom = !!(q.bloom && E);
  let calls = 0;
  if (bloom) {
    // down: E (linear) → D0 … D(L−1), each stored as sqrt
    gl.useProgram(PD.prog);
    gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.uniform1i(PD.u.uTex, UNIT.A);
    let src = E;
    for (let l = 0; l < levels; l++) { down(world, src, D[l], l === 0 ? 0 : 1); src = D[l]; calls++; }
    // up: each level = its own down level, plus the blurrier one above it, upsampled
    gl.useProgram(PU.prog);
    gl.uniform1i(PU.u.uTex, UNIT.A); gl.uniform1i(PU.u.uSame, UNIT.B);
    let low = D[levels - 1];
    for (let l = levels - 2; l >= 0; l--) { up(world, low, D[l], UPS[l], 1, 1, 0.7, 0.3); low = UPS[l]; calls++; }
    // the last step lands at the emissive buffer's size and stays linear for the composite. It leaves the
    // raw ¼-res buffer out: magnified 4× that would draw a stair-stepped outline around every bright edge,
    // and the main pass already shows the sharp object; the bloom only has to be the glow
    up(world, low, E, B, 0, 0, 1, 0); calls++;
  }
  bindTarget(world, null);
  const p = PC[Q * 2 + (bloom ? 1 : 0)] || (ensure(world), PC[Q * 2 + (bloom ? 1 : 0)]), u = p.u;
  gl.useProgram(p.prog);
  if (bloom) { gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.bindTexture(gl.TEXTURE_2D, B.tex); gl.uniform1i(u.uBloom, UNIT.A); }
  gl.activeTexture(gl.TEXTURE0 + UNIT.NOISE); gl.bindTexture(gl.TEXTURE_2D, world.gpu.noiseTex); gl.uniform1i(u.uNoise, UNIT.NOISE);
  // slow-mo eases in and out with the time scale
  const ts = world.timeScale, target = ts >= 0.62 ? 0 : ts <= 0.3 ? 1 : (0.62 - ts) / 0.32;
  SLOW[0] += (target * target * (3 - 2 * target) - SLOW[0]) * Math.min(1, world.frameDt * 7);
  const g = grade, s = SLOW[0];
  if (u.uBloomK) gl.uniform1f(u.uBloomK, g.bloom * 1.6 * (1 + 0.35 * s));
  gl.uniform2f(u.uAspect, 1, 1);
  gl.uniform4f(u.uVig, g.vigCol[0], g.vigCol[1], g.vigCol[2], Math.min(0.92, g.vig + 0.3 * s));
  gl.uniform4f(u.uEdge, 0.05, 0.055, 0.072, 0.42 * s);
  gl.uniform4f(u.uLift, g.lift[0], g.lift[1], g.lift[2], g.liftK);
  // grain: new speckle 24 times a second (film cadence), placed by an R2 sequence on the frame number
  const gf = Math.floor(world.realTime * 24);
  gl.uniform4f(u.uGrain, g.grain * (1 + 0.6 * s), (gf * 0.7548776662) % 1, (gf * 0.5698402910) % 1, 0);
  const gpx = Math.max(1, world.dpr * 0.85);
  gl.uniform2f(u.uGrainScale, 1 / (256 * gpx), 1 / (256 * gpx));
  if (u.uChroma) gl.uniform1f(u.uChroma, 0.004 + 0.022 * s);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  drawFullscreen(gl, p);
  world.stats.drawCalls += calls + 1; // (main.js resets blend and depth state after this)
}
