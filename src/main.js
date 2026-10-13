// Boot, the frame loop, and world.api. Owned by the lead (integration); module agents don't edit it.
//
// Frame order (see CONTRACT.md § Frame):
//   input → scene → wind → rain → wet → dye → fire → physics → camera + projection → particles →
//   rain.late → audio → render (shadow → env → cloth → particles → bloom) → hud → clear events
import { world } from './core/world.js';
import { seed } from './core/rng.js';
import { clearEvents } from './core/events.js';
import { makeQ, guessTier, tierFromBenchmark, governor, resetGovernor, TIERS } from './core/quality.js';
import { updateCamera, projectAll, unproject } from './core/camera.js';
import { makeNoiseData } from './core/noise.js';
import { MATERIAL_IDS } from './core/materials.js';
import { createGL, texture, resetState, bindTarget } from './render/gl.js';
import * as sim from './sim/cloth.js';
import * as scenes from './scenes/index.js';
import * as env from './render/env.js';
import * as clothR from './render/cloth.js';
import * as shadow from './render/shadow.js';
import * as particles from './render/particles.js';
import * as post from './render/post.js';
import * as wind from './fx/wind.js';
import * as rain from './fx/rain.js';
import * as wet from './fx/wet.js';
import * as dye from './fx/dye.js';
import * as fire from './fx/fire.js';
import * as hud from './ui/hud.js';
import * as input from './ui/input.js';
import * as audio from './audio/audio.js';

const params = new URLSearchParams(location.search);
/** Tests only: ?norender=1 skips drawing, to separate CPU cost from a software GPU's back-pressure. */
const NORENDER = params.has('norender');
const now = () => performance.now();
/** Every module, in the order their onScene/onMaterial/onResize hooks run. */
const MODULES = [sim, wind, rain, wet, dye, fire, particles, env, clothR, shadow, post, audio, hud, input];
const hook = (name) => { for (const m of MODULES) if (typeof m[name] === 'function') m[name](world); };

const tmp3 = new Float32Array(3), tmpA = new Float32Array(3), tmpB = new Float32Array(3);
const timings = new Float32Array(240);
let tIx = 0;
let wetAccF = 0, wetAccS = 0;   // seconds owed to each half of the water update (30 Hz on the low and mid tiers)

// ---------------------------------------------------------------- api
function applySceneDefaults(s) {
  world.materialId = s.defaults.material || 'cotton';
  world.tool = s.defaults.tool || 'grab';
  world.toggles.wind = s.defaults.wind == null ? 1 : s.defaults.wind;
  world.toggles.rain = !!s.defaults.rain;
}

function buildScene(id) {
  for (const P of world.pointers) { P.active = false; P.particle = -1; }
  const rig = world.cameraRig;
  rig.uiOffset[0] = rig.uiOffset[1] = rig.uiOffset[2] = 0; rig.zoom = 1;
  scenes.load(world, id);
  world.gravityDefault.set(world.gravity);
  hook('onScene');
  updateCamera(world);
  projectAll(world);
  world.q.rebuild = false;
  resetGovernor();
}

const api = {
  /** Load a scene with its own defaults (material, tool, wind, rain). */
  setScene(id) {
    applySceneDefaults(scenes.sceneById(id));
    buildScene(id);
    world.events.ui.push(2, 0, 0, 0);
    hud.sync(world);
  },
  /** Rebuild the current scene, keeping the current material, tool and toggles. */
  reset() { buildScene(world.sceneId); world.events.ui.push(6, 0, 0, 0); hud.sync(world); },
  setMaterial(id) {
    if (!MATERIAL_IDS.includes(id)) return;
    world.materialId = id;
    hook('onMaterial');
    world.events.ui.push(3, 0, 0, 0);
    hud.sync(world);
  },
  setTool(t) { world.tool = t; world.events.ui.push(1, 0, 0, 0); hud.sync(world); },
  setDye(i) { world.dyeColor = i; hud.sync(world); },
  setToggle(name, v) {
    world.toggles[name] = v;
    if (name === 'tilt' && !v) world.gravity.set(world.gravityDefault);
    world.events.ui.push(4, 0, 0, 0);
    hud.sync(world);
  },
  setQuality(name) {
    if (name === 'auto') { world.q.auto = true; return; }
    if (!TIERS[name]) return;
    world.q = makeQ(name); world.q.auto = false; world.stats.tier = name;
    resize(); api.reset();
  },
  pickRadius() { return world.touch ? 44 : 28; },
  pick(x, y, r) { return sim.pick(world, x, y, r || api.pickRadius()); },
  grabStart(slot, x, y) {
    const v = api.pick(x, y); if (v < 0) return false;
    const P = world.pointers[slot], o = v * 3;
    P.particle = v; P.depth = world.screen[o + 2];
    unproject(world, x, y, P.depth, P.target);
    world.events.grab.push(world.cloth.pos[o], world.cloth.pos[o + 1], world.cloth.pos[o + 2], slot);
    return true;
  },
  grabMove(slot, x, y) {
    const P = world.pointers[slot]; if (P.particle < 0) return;
    unproject(world, x, y, P.depth, P.target);
  },
  grabEnd(slot) {
    const P = world.pointers[slot], v = P.particle; if (v < 0) return;
    const o = v * 3, c = world.cloth;
    world.events.release.push(c.pos[o], c.pos[o + 1], c.pos[o + 2], Math.hypot(c.vel[o], c.vel[o + 1], c.vel[o + 2]));
    P.particle = -1;
  },
  slice(x0, y0, x1, y1) { return sim.slice(world, x0, y0, x1, y1); },
  /**
   * A swipe through empty air (css px, from (x0,y0) to (x1,y1) over dt seconds) pushes a puff of wind
   * along it at the cloth's depth. strength grows with the swipe's length per move.
   */
  gust(x0, y0, x1, y1, dt) {
    if (!(dt > 0) || !wind.gustAt) return;
    const d = world.camera.dist, a = tmpA, b = tmpB;
    unproject(world, x0, y0, d, a); unproject(world, x1, y1, d, b);
    const px = Math.hypot(x1 - x0, y1 - y0);
    wind.gustAt(world, b[0], b[1], b[2], (b[0] - a[0]) / dt, (b[1] - a[1]) / dt, (b[2] - a[2]) / dt, Math.min(1.5, px / 60));
  },
  /** A glowing slash streak on screen (css px); the slice tool calls it on every move. */
  trail(x0, y0, x1, y1) { particles.trail(world, x0, y0, x1, y1); },
  ignite(x, y) { const v = api.pick(x, y); return v >= 0 && fire.ignite(world, v, 1); },
  torch(x, y, dt) { const v = api.pick(x, y); if (v >= 0) fire.torch(world, v, dt); },
  togglePin(x, y) { const v = api.pick(x, y); return v >= 0 ? sim.togglePin(world, v) : -1; },
  /** Pin or unpin a known vertex (the UI found it already, e.g. the pin under the finger). */
  togglePinVertex(v) { return v >= 0 && world.cloth && v < world.cloth.n ? sim.togglePin(world, v) : -1; },
  dye(x, y) { const v = api.pick(x, y); return v >= 0 && dye.drop(world, v, world.dyeColor); },
  /** World point under a screen point at the cloth's typical depth (for tools that act in the air). */
  airPoint(x, y, out = tmp3) { return unproject(world, x, y, world.camera.dist, out); },
  audioUnlock() { audio.unlock(world); },
  sfx(name) { audio.sfx(world, name); },
};
world.api = api;

// ---------------------------------------------------------------- sizing
function resize() {
  const c = world.canvas;
  const w = Math.max(1, c.clientWidth || window.innerWidth), h = Math.max(1, c.clientHeight || window.innerHeight);
  const dpr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, world.q.dprCap) * world.q.dprScale);
  const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  world.width = w; world.height = h; world.dpr = dpr; world.pxWidth = pw; world.pxHeight = ph;
  hook('onResize');
}

// ---------------------------------------------------------------- frame
function render() {
  const gl = world.gl;
  world.stats.drawCalls = 0;
  resetState(gl);
  clothR.upload(world);
  shadow.render(world);
  bindTarget(world, null);
  resetState(gl);
  gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  env.draw(world);
  resetState(gl);
  clothR.draw(world);
  resetState(gl);
  particles.draw(world, 'main');
  resetState(gl);
  if (post.begin(world)) {
    env.drawEmissive(world); resetState(gl);
    clothR.drawEmissive(world); resetState(gl);
    particles.draw(world, 'emissive'); resetState(gl);
  }
  post.end(world);
  resetState(gl);
}

/** One whole frame: simulate realDt seconds of wall time and draw. */
function tick(realDt) {
  const ms = world.stats.ms;
  let t = now(), t1;
  world.frameDt = Math.min(Math.max(realDt, 0), 1 / 20);
  if (world.slowmoPulse > 0) world.slowmoPulse = Math.max(0, world.slowmoPulse - world.frameDt);
  world.timeScaleTarget = world.toggles.slowmo ? 0.22 : world.slowmoPulse > 0 ? 0.3 : 1;
  world.timeScale += (world.timeScaleTarget - world.timeScale) * Math.min(1, world.frameDt * (world.timeScaleTarget < world.timeScale ? 18 : 4));
  world.dt = world.paused ? 0 : world.frameDt * world.timeScale;
  world.time += world.dt; world.realTime += realDt; world.frame++;
  const dt = world.dt;

  input.update(world, world.frameDt);
  t1 = now(); ms.input = t1 - t; t = t1;
  scenes.update(world, dt);
  t1 = now(); ms.scene = t1 - t; t = t1;
  wind.update(world, dt); rain.update(world, dt);
  // water soaks, runs and pools slowly, so on the low and mid tiers its two halves take turns at 30 Hz on a
  // double step (rain still lands every frame through wet.deposit): the flow on even frames, beside the low
  // tier's self-collision, and soak-and-drip on odd ones, beside the wind lattice and the wet-buffer upload.
  // Run together on every other frame they made that frame twice the cost of the next. High and ultra run
  // the whole update every frame.
  wetAccF += dt; wetAccS += dt;
  if (world.q.name !== 'low' && world.q.name !== 'mid') { wet.update(world, wetAccF); wetAccF = 0; wetAccS = 0; }
  else if ((world.frame & 1) === 0) { wet.flowStep(world, wetAccF); wetAccF = 0; }
  else { wet.settle(world, wetAccS); wetAccS = 0; }
  dye.update(world, dt);
  t1 = now(); ms.weather = t1 - t; t = t1;
  fire.update(world, dt);
  t1 = now(); ms.fire = t1 - t; t = t1;
  sim.step(world, dt);
  updateCamera(world);
  projectAll(world);
  t1 = now(); ms.sim = t1 - t; t = t1;
  particles.update(world, dt);
  rain.late(world, dt);
  t1 = now(); ms.particles = t1 - t; t = t1;
  audio.update(world, world.frameDt);
  t1 = now(); ms.audio = t1 - t; t = t1;
  if (!NORENDER) render();
  t1 = now(); ms.render = t1 - t; t = t1;
  hud.update(world, world.frameDt);
  t1 = now(); ms.ui = t1 - t; t = t1;
  clearEvents(world.events);
  if (world.q.rebuild && !world.pointers.some((p) => p.active)) api.reset();
}

let last = 0, raf = 0, running = false;
function frame(ts) {
  raf = requestAnimationFrame(frame);
  const realDt = last ? Math.min(0.25, (ts - last) / 1000) : 1 / 60;
  last = ts;
  const t0 = now();
  tick(realDt);
  const js = now() - t0;
  timings[tIx++ % timings.length] = js;
  const st = world.stats;
  st.jsMs = st.jsMs * 0.9 + js * 0.1;
  st.frameMs = st.frameMs * 0.9 + realDt * 1000 * 0.1;
  st.fps = 1000 / Math.max(1, st.frameMs);
  if (governor(world, realDt * 1000, js, ts)) { resize(); hud.sync(world); }
}
function start() { if (running) return; running = true; last = 0; raf = requestAnimationFrame(frame); }
function stop() { running = false; cancelAnimationFrame(raf); }

// ---------------------------------------------------------------- boot
function boot() {
  seed(Number(params.get('seed')) || 1);
  world.canvas = document.getElementById('gl');
  world.touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const glx = createGL(world.canvas);
  if (!glx) throw new Error('This browser has WebGL turned off, so the cloth has nothing to draw with.');
  world.glx = glx; world.gl = glx.gl;

  const qp = params.get('quality');
  let tier = TIERS[qp] ? qp : guessTier();
  if (!TIERS[qp]) tier = tierFromBenchmark(sim.benchmark(), 12000, tier);
  world.q = makeQ(tier);
  if (TIERS[qp] || params.has('nogov')) world.q.auto = false;
  world.stats.tier = tier;

  world.gpu.noiseTex = texture(glx, { w: 256, h: 256, data: makeNoiseData(256), filter: 'linear', wrap: 'repeat' });
  for (const m of MODULES) if (typeof m.init === 'function') m.init(world);
  resize();

  const s = scenes.sceneById(params.get('scene') || 'noren');
  applySceneDefaults(s);
  if (params.get('material')) world.materialId = params.get('material');
  if (params.get('tool')) world.tool = params.get('tool');
  if (params.has('wind')) world.toggles.wind = Number(params.get('wind'));
  if (params.has('rain')) world.toggles.rain = params.get('rain') === '1';
  if (params.has('stats')) world.toggles.stats = params.get('stats') !== '0';
  buildScene(s.id);
  hud.sync(world);

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else if (!params.has('manual')) start(); });
  world.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); });
  world.canvas.addEventListener('webglcontextrestored', () => location.reload());

  // Test hooks. ?manual=1 leaves the loop stopped so tests can drive frames with advance().
  window.__cloth = {
    world, api,
    modules: { sim, scenes, env, clothR, shadow, particles, post, wind, rain, wet, dye, fire, hud, input, audio },
    input: input.handle,
    /** Run n whole frames of dt each; returns per-frame JS ms. */
    advance(n = 1, dt = 1 / 60) { const out = []; for (let i = 0; i < n; i++) { const t0 = now(); tick(dt); out.push(now() - t0); } return out; },
    timings: () => Array.from(timings),
    /** Run n frames; per-frame JS ms in total and for every system (tests: where the time goes). */
    profile(n = 60, dt = 1 / 60) {
      const keys = Object.keys(world.stats.ms), out = { total: [] };
      for (const k of keys) out[k] = [];
      for (let i = 0; i < n; i++) { const t0 = now(); tick(dt); out.total.push(now() - t0); for (const k of keys) out[k].push(world.stats.ms[k]); }
      return out;
    },
    start, stop,
  };
  document.body.dataset.ready = '1';
  if (!params.has('manual')) start();
}

try { boot(); } catch (e) {
  console.error(e);
  document.body.dataset.bootError = String((e && e.message) || e);
  try { hud.fatal(String((e && e.message) || e)); } catch {}
}
