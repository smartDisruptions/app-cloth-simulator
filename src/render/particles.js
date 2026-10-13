// Particles: how every kind moves after it is spawned and how it looks (owner: particles-post).
// fx modules decide WHERE and WHEN (spawn); this module decides the rest.
//
// One fixed pool in typed arrays, packed densely (swap-remove on death), nothing allocated after init.
// Every frame draw('main') culls what the camera can't see and writes each visible particle as a
// camera-facing (or velocity-stretched) quad into one preallocated buffer (a ring of three VBOs), grouped
// so the order is right without a sort:
//   [soft alpha: smoke, steam] [small alpha: ash, petals, fibres, rain, drips, splashes, crown rings]
//   [additive: motes, wind streaks] [glowing: flames, sparks, embers, the slash trail]
// 'main' draws all of it in ONE call; 'emissive' re-draws just the glowing tail of the same buffer into the
// bloom target (no second upload). One shader does every look: atlas density (eroded for smoke), light
// terms computed per vertex from the scene lights (smoke lit from above by the key and from below by the
// fire, rain and dust glinting toward lights, the coloured shadow through the cloth tinting dust), and a
// blackbody ramp for anything hot. See fx-shaders.js for the vertex layout.
//
// Also here: thread scraps from tears and cuts (coloured from the print), the ambient population of dust
// motes and petals each scene asks for, crown rings under splashes, and the katana trail (fx-trail.js).
//
// Speed notes (this runs for every particle every frame on an old phone): trig comes from a sine table,
// colours are packed inline (a helper returning a 32-bit int would box it), the doubles that persist
// between frames live in a Float64Array (a module-level `let` double allocates on every write), and only
// one particle in eight samples the wind field each frame (the rest reuse their cached sample).
import { PK } from '../core/world.js';
import { program, buffer, texture, useAttribs, UNIT } from './gl.js';
import { setCommon } from './glsl.js';
import { rand } from '../core/rng.js';
import { makeAtlas, ATLAS_SIZE, CELL } from './fx-atlas.js';
import { particleVS, particleFS } from './fx-shaders.js';
import { F, U, WORDS, QUAD_WORDS, STRIDE, UNIT_M, UNIT_TURN, MAX_PARTICLES as MAX, MAX_QUADS, MODE, rgba, viewFor } from './fx-buffer.js';
import * as trail$ from './fx-trail.js';
import { emissiveSize } from './post.js';

const { FLAME, SPARK, EMBER, ASH, SMOKE, STEAM, RAIN, SPLASH, DRIP, FIBER, STREAK, MOTE, PETAL } = PK;
const RING = 13; // internal: the crown ring a splash leaves on the ground
const PI = Math.PI, TAU = Math.PI * 2, HALF_PI = Math.PI * 0.5;

// ---------------------------------------------------------------- per-tier knobs (the cap is world.q's)
//   puffs: smoke + steam alive (they are the overdraw) · fibers: thread scraps alive · fiberRate: per frame
//   rings: crown rings alive · maxFrac: biggest sprite radius as a fraction of the target height
//   coc: depth-of-field blur (fraction of target height) · amb: ambient population scale
const TIER = {
  low: { puffs: 44, fibers: 60, fiberRate: 6, rings: 14, maxFrac: 0.15, coc: 0, amb: 0.4, Q: 0 },
  mid: { puffs: 96, fibers: 120, fiberRate: 10, rings: 28, maxFrac: 0.2, coc: 0.006, amb: 0.65, Q: 1 },
  high: { puffs: 170, fibers: 200, fiberRate: 16, rings: 44, maxFrac: 0.26, coc: 0.009, amb: 1, Q: 2 },
  ultra: { puffs: 240, fibers: 280, fiberRate: 22, rings: 60, maxFrac: 0.3, coc: 0.011, amb: 1.2, Q: 2 },
};
let T = TIER.mid;
const setTier = (world) => { T = TIER[world.q.name] || TIER.mid; };

/**
 * What each scene shows when its module doesn't set `scene.ambient` itself ({ motes, petals,
 * petalColors }: counts at the high tier, colours 0xRRGGBB). A scene's own `ambient` always wins.
 */
const AMBIENT = {
  noren: { motes: 70, petals: 0 },
  unveil: { motes: 90, petals: 0 },
  koinobori: { motes: 0, petals: 40, petalColors: [0xf6b8c8, 0xf2a4b8, 0xf9d0da, 0xfde6ec] },
  // dusk: backlit leaves read as warm dark silhouettes with a bright rim against the orange sky
  banner: { motes: 20, petals: 22, petalColors: [0x8a3b1e, 0x6e2c18, 0xa4501f, 0x5a3a1a, 0xb8692a] },
  // night courtyard: a little dust that only shows where the lantern or the fire catches it
  embers: { motes: 34, petals: 0 },
};
const SAKURA = 0xf6b8c8;

// ---------------------------------------------------------------- the pool
const px = new Float32Array(MAX), py = new Float32Array(MAX), pz = new Float32Array(MAX);
const vx = new Float32Array(MAX), vy = new Float32Array(MAX), vz = new Float32Array(MAX);
const age = new Float32Array(MAX), life = new Float32Array(MAX), size = new Float32Array(MAX), aux = new Float32Array(MAX);
const seed = new Float32Array(MAX), rot = new Float32Array(MAX), spin = new Float32Array(MAX);
const wx = new Float32Array(MAX), wy = new Float32Array(MAX), wz = new Float32Array(MAX); // cached wind sample
const kind = new Uint8Array(MAX), flag = new Uint8Array(MAX);
const kindN = new Int32Array(16);
let n = 0;

const SPIN = new Float32Array(16);
SPIN[EMBER] = 7; SPIN[ASH] = 5; SPIN[SMOKE] = 0.5; SPIN[STEAM] = 0.8; SPIN[FIBER] = 10; SPIN[PETAL] = 2.6;
/** kinds that follow the local wind field (sampled for an eighth of them each frame, then cached) */
const WINDY = new Uint8Array(16);
WINDY[FLAME] = 1; WINDY[EMBER] = 1; WINDY[ASH] = 1; WINDY[SMOKE] = 1; WINDY[STEAM] = 1; WINDY[FIBER] = 1;
WINDY[MOTE] = 1; WINDY[PETAL] = 1; // (STREAK samples the field itself, every frame)
/** Water is never starved: every other kind (fire included) stops at this share of the pool. */
const DRY_SHARE = 0.85;
const GROUP = new Uint8Array(16);
GROUP[SMOKE] = 0; GROUP[STEAM] = 0;
GROUP[ASH] = 1; GROUP[PETAL] = 1; GROUP[FIBER] = 1; GROUP[RAIN] = 1; GROUP[DRIP] = 1; GROUP[SPLASH] = 1; GROUP[RING] = 1;
GROUP[MOTE] = 2; GROUP[STREAK] = 2;
GROUP[FLAME] = 3; GROUP[SPARK] = 3; GROUP[EMBER] = 3;
// view culling: a bound on each sprite's world radius = size × GROW[kind] + speed × SHUT[kind] (the streak's
// half-length at full time scale), plus a screen margin for kinds whose depth-of-field disc can spill over
const GROW = new Float32Array(16), SHUT = new Float32Array(16), MARGIN = new Float32Array(16);
GROW[FLAME] = 1.2; GROW[SPARK] = 0.9; GROW[EMBER] = 1; GROW[ASH] = 1; GROW[SMOKE] = 3.7; GROW[STEAM] = 4.3; GROW[RAIN] = 0.5;
GROW[SPLASH] = 0.4; GROW[DRIP] = 0.6; GROW[FIBER] = 1; GROW[STREAK] = 0.5; GROW[MOTE] = 1; GROW[PETAL] = 1; GROW[RING] = 5.8;
SHUT[FLAME] = 0.025; SHUT[SPARK] = 0.0175; SHUT[RAIN] = 0.0105; SHUT[SPLASH] = 0.013; SHUT[DRIP] = 0.0075; SHUT[STREAK] = 0.111;
MARGIN[MOTE] = 0.35; MARGIN[EMBER] = 0.35;
// the visible particles of each draw group, in pool order (filled by pack's culling pass)
const B0 = new Int16Array(MAX), B1 = new Int16Array(MAX), B2 = new Int16Array(MAX), B3 = new Int16Array(MAX);
const bN = new Int32Array(4);

// ---------------------------------------------------------------- state
// doubles that persist between frames: in a typed array, so writing them never allocates
const ST = new Float64Array(6);
const SIM_T = 0, FLOOR = 2, RING_X = 3, RING_Y = 4, RING_Z = 5; // (the trail clock is fx-trail.js CLOCK)
let frame = 0, warm = false, quads = 0, glowStart = 0, packedFrame = -1, lastRingFrame = -1;
const wtmp = new Float32Array(3);

// a sine table: 4096 steps a turn is plenty for flicker, sway and tumble, and far cheaper than Math.sin
const SK = 4096 / TAU, SINT = new Float32Array(4096);
for (let i = 0; i < 4096; i++) SINT[i] = Math.sin(i / SK);
// usage, inline:  sin(x) = SINT[(x * SK) & 4095]   cos(x) = SINT[(x * SK + 1024) & 4095]

// ---------------------------------------------------------------- GL
const PROG = [null, null, null];
let atlasTex = null, whiteTex = null, ibo = null, Q = -1;
// three vertex buffers in rotation: each frame refills one with bufferSubData (half the cost of
// bufferData in Chrome) while the GPU may still be reading the previous frames' (no sync stall)
const VBO = [null, null, null];
let vbo = null, vboIx = 0;
const locs = [0, 0, 0, 0, 0, 0];
const clothC = new Float32Array(3), shDir = new Float32Array(3);

function ensureProgram(world) {
  setTier(world);
  Q = T.Q;
  if (!PROG[Q]) PROG[Q] = program(world.glx, particleVS(Q), particleFS(Q), `particles-q${Q}`);
  return PROG[Q];
}

export function init(world) {
  const gl = world.gl;
  atlasTex = texture(world.glx, { w: ATLAS_SIZE, h: ATLAS_SIZE, data: makeAtlas(), filter: 'mip', wrap: 'clamp' });
  whiteTex = texture(world.glx, { w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
  for (let b = 0; b < 3; b++) VBO[b] = buffer(gl, gl.ARRAY_BUFFER, F.byteLength, gl.DYNAMIC_DRAW);
  vbo = VBO[0];
  const idx = new Uint16Array(MAX_QUADS * 6);
  for (let q = 0; q < MAX_QUADS; q++) {
    const v = q * 4, o = q * 6;
    idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2; idx[o + 3] = v + 2; idx[o + 4] = v + 1; idx[o + 5] = v + 3;
  }
  ibo = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  ensureProgram(world);
}

export function onScene(world) {
  n = 0; kindN.fill(0); warm = true; quads = 0; glowStart = 0;
  trail$.reset();
  // the floor: the scene's env floor, else the first upward-facing collision plane, else y = 0
  ST[FLOOR] = 0;
  const env = world.scene && world.scene.env;
  if (env && env.floor && Number.isFinite(env.floor.y)) ST[FLOOR] = env.floor.y;
  else for (const p of world.colliders.planes) if (p.ny > 0.7) { ST[FLOOR] = -p.d / p.ny; break; }
  if (world.glx) ensureProgram(world); else setTier(world);   // (no GL in the Node test harnesses)
}
export function onResize(world) { ensureProgram(world); }

/** Live capacity: the tier's cap × the governor's particle dial. */
export function capacity(world) { return Math.min(MAX, Math.floor(world.q.particles * world.q.particleScale)); }
export function count() { return n; }

function add(world, k, x, y, z, ux, uy, uz, s, l, a) {
  const i = n++;
  px[i] = x; py[i] = y; pz[i] = z; vx[i] = ux; vy[i] = uy; vz[i] = uz;
  size[i] = s; age[i] = 0; life[i] = l; aux[i] = a; kind[i] = k; flag[i] = 0;
  seed[i] = rand();
  rot[i] = k === SMOKE || k === STEAM ? (rand() - 0.5) * 0.9 : rand() * TAU; // puffs start near upright
  spin[i] = (rand() - 0.5) * 2 * SPIN[k];
  const W = world.wind; wx[i] = W.x; wy[i] = W.y; wz[i] = W.z;
  kindN[k]++;
  return i;
}

/**
 * Spawn one particle. Returns 1, or 0 when the pool (or this kind's budget) is full: callers don't retry.
 * RAIN, SPLASH and DRIP may fill the whole pool; every other kind stops at 85% of it, so a big fire can
 * never starve the rain.
 */
export function spawn(world, k, x, y, z, ux, uy, uz, s, l, a = 0) {
  const cap = capacity(world);
  if (n >= cap || !(l > 0) || !(s > 0) || !(k >= 0 && k <= PETAL) || !(x === x && y === y && z === z)) return 0;
  if (k !== RAIN && k !== SPLASH && k !== DRIP && n >= cap * DRY_SHARE) return 0;
  if ((k === SMOKE || k === STEAM) && kindN[SMOKE] + kindN[STEAM] >= T.puffs * world.q.particleScale) return 0;
  add(world, k, x, y, z, ux || 0, uy || 0, uz || 0, s, l, a || 0);
  // a crown ring only where the surface is flat: the floor, or standing water (the spawner passes aux = 1)
  if (k === SPLASH && (a === 1 || y < ST[FLOOR] + 0.08)) ring(world, x, y, z, s);
  return 1;
}

/** A crown ring under a splash: one per landing spot per frame, capped per tier. */
function ring(world, x, y, z, s) {
  if (n >= capacity(world) * DRY_SHARE || kindN[RING] >= T.rings) return;
  if (lastRingFrame === frame) {
    const dx = x - ST[RING_X], dy = y - ST[RING_Y], dz = z - ST[RING_Z];
    if (dx * dx + dy * dy + dz * dz < 0.0009) return;
  }
  lastRingFrame = frame; ST[RING_X] = x; ST[RING_Y] = y; ST[RING_Z] = z;
  add(world, RING, x, y, z, 0, 0, 0, Math.max(0.006, s), 0.32 + 0.12 * rand(), 0);
}

/** A glowing slash streak on screen from (x0,y0) to (x1,y1), css px. The slice tool calls it every move. */
export function trail(world, x0, y0, x1, y1) { trail$.add(x0, y0, x1, y1); }

// ---------------------------------------------------------------- update
function kill(i) {
  kindN[kind[i]]--;
  const j = --n;
  if (i === j) return;
  px[i] = px[j]; py[i] = py[j]; pz[i] = pz[j]; vx[i] = vx[j]; vy[i] = vy[j]; vz[i] = vz[j];
  age[i] = age[j]; life[i] = life[j]; size[i] = size[j]; aux[i] = aux[j]; kind[i] = kind[j]; flag[i] = flag[j];
  seed[i] = seed[j]; rot[i] = rot[j]; spin[i] = spin[j]; wx[i] = wx[j]; wy[i] = wy[j]; wz[i] = wz[j];
}

/** Is particle i outside the view (with a margin)? Ambient particles that drift out are recycled. */
function outOfView(c, i) {
  const rx = px[i] - c.pos[0], ry = py[i] - c.pos[1], rz = pz[i] - c.pos[2];
  const d = rx * c.fwd[0] + ry * c.fwd[1] + rz * c.fwd[2];
  if (d < c.near * 3 || d > c.dist * 3) return true;
  const sx = (rx * c.right[0] + ry * c.right[1] + rz * c.right[2]) / (d * c.tanHalf * c.aspect);
  const sy = (rx * c.up[0] + ry * c.up[1] + rz * c.up[2]) / (d * c.tanHalf);
  return sx < -1.3 || sx > 1.3 || sy < -1.35 || sy > 1.35;
}

/** A point in view at screen coords (sx, sy ∈ −1..1) and view depth d, into wtmp. */
function viewPoint(c, sx, sy, d) {
  const ox = sx * c.tanHalf * c.aspect * d, oy = sy * c.tanHalf * d;
  wtmp[0] = c.pos[0] + c.fwd[0] * d + c.right[0] * ox + c.up[0] * oy;
  wtmp[1] = c.pos[1] + c.fwd[1] * d + c.right[1] * ox + c.up[1] * oy;
  wtmp[2] = c.pos[2] + c.fwd[2] * d + c.right[2] * ox + c.up[2] * oy;
}

function ambient(world) {
  const sc = world.scene;
  const A = sc ? (sc.ambient !== undefined ? sc.ambient : AMBIENT[sc.id]) : null;
  if (!A) { warm = false; return; }
  const cap = Math.floor(capacity(world) * DRY_SHARE), scale = T.amb * world.q.particleScale;
  const room = Math.floor(cap * 0.22);
  const wantM = Math.min(Math.round((A.motes || 0) * scale), room);
  const wantP = Math.min(Math.round((A.petals || 0) * scale), room - wantM);
  if (kindN[MOTE] >= wantM && kindN[PETAL] >= wantP) { warm = false; return; }
  const c = world.camera, W = world.wind, fl = ST[FLOOR];
  let budget = warm ? 400 : 2;
  while (kindN[MOTE] < wantM && budget-- > 0 && n < cap) {
    viewPoint(c, rand() * 2.1 - 1.05, rand() * 2.1 - 1.05, c.dist * (0.35 + 0.75 * rand()));
    if (wtmp[1] < fl + 0.04) wtmp[1] = fl + 0.04 + rand() * 0.6;
    const l = 7 + 8 * rand();
    const i = add(world, MOTE, wtmp[0], wtmp[1], wtmp[2], (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.03, (rand() - 0.5) * 0.04, 0.005 + 0.006 * rand(), l, 0);
    if (warm) age[i] = l * 0.85 * rand();
  }
  budget = warm ? 400 : 2;
  const cols = A.petalColors && A.petalColors.length ? A.petalColors : null;
  while (kindN[PETAL] < wantP && budget-- > 0 && n < cap) {
    let sx = rand() * 2 - 1, sy = rand() * 2 - 1;
    if (!warm) {
      // enter from the upwind side of the frame (or the top when the wind is calm)
      const wr = W.x * c.right[0] + W.y * c.right[1] + W.z * c.right[2];
      if (Math.abs(wr) > 0.6 && rand() < 0.75) sx = wr > 0 ? -1.12 : 1.12; else sy = 1.12;
    }
    viewPoint(c, sx, sy, c.dist * (0.2 + 0.65 * rand())); // nearer the lens than the subject, where they read
    if (wtmp[1] < fl + 0.1) wtmp[1] = fl + 0.1 + rand();
    const col = cols ? cols[(rand() * cols.length) | 0] : SAKURA;
    const l = 8 + 8 * rand();
    const i = add(world, PETAL, wtmp[0], wtmp[1], wtmp[2], W.x * 0.8, W.y * 0.8 - 0.3, W.z * 0.8, 0.022 + 0.012 * rand(), l, col);
    if (warm) age[i] = l * 0.7 * rand();
  }
  warm = false;
}

/** Thread scraps fly from tears and cuts, in the print's colour at the broken edge (charred → dark). */
function fibers(world) {
  const cl = world.cloth; if (!cl) return;
  const ev = world.events, tear = ev.tear, cut = ev.cut, total = tear.n + cut.n;
  if (!total) return;
  const sc = world.q.particleScale;
  let budget = Math.min(Math.max(1, Math.round(T.fiberRate * sc)), Math.round(T.fibers * sc) - kindN[FIBER], Math.floor(capacity(world) * DRY_SHARE) - n);
  if (budget <= 0) return;
  const stride = Math.max(1, Math.ceil(total / budget));
  const pp = world.gpu.printPixels, uv = cl.uv, vel = cl.vel;
  for (let e = frame % stride; e < total && budget > 0; e += stride) {
    const isCut = e >= tear.n, d = isCut ? cut.data : tear.data, o = (isCut ? e - tear.n : e) * 4;
    const j = d[o + 3] | 0; if (j < 0 || j >= cl.m) continue;
    const ia = cl.cA[j], ib = cl.cB[j];
    let r = 1, g = 1, b = 1;
    if (pp && pp.data && pp.w > 0) {
      let u = (uv[ia * 2] + uv[ib * 2]) * 0.5, v = (uv[ia * 2 + 1] + uv[ib * 2 + 1]) * 0.5;
      u = u < 0 ? 0 : u > 1 ? 1 : u; v = v < 0 ? 0 : v > 1 ? 1 : v;
      const pi = (((v * (pp.h - 1)) | 0) * pp.w + ((u * (pp.w - 1)) | 0)) * 4;
      r = pp.data[pi] / 255; g = pp.data[pi + 1] / 255; b = pp.data[pi + 2] / 255;
    }
    const ch = Math.min(1, Math.max(cl.char[ia], cl.char[ib]) * 1.3);
    if (ch > 0) { r += (0.12 - r) * ch; g += (0.085 - g) * ch; b += (0.06 - b) * ch; }
    const wt = 1 - 0.35 * Math.max(cl.wet[ia], cl.wet[ib]);
    const col = (((r * wt * 255) | 0) << 16) | (((g * wt * 255) | 0) << 8) | ((b * wt * 255) | 0);
    const kick = isCut ? 1.5 : 0.9;
    add(world, FIBER, d[o], d[o + 1], d[o + 2],
      vel[ia * 3] * 0.6 + (rand() - 0.5) * kick, vel[ia * 3 + 1] * 0.6 + (0.25 + 0.6 * rand()) * kick, vel[ia * 3 + 2] * 0.6 + (rand() - 0.5) * kick,
      0.02 + 0.02 * rand(), 1.4 + 1.6 * rand(), col);
    budget--;
  }
}

/** A drop met the floor: tell everyone (events.splash), and throw a few droplets (which leave a ring). */
function landDrip(world, x, y, z, s) {
  world.events.splash.push(x, y, z, s);
  const k = 2 + ((rand() * 3) | 0);
  for (let m = 0; m < k; m++) {
    const a = rand() * TAU, sp = 0.25 + 0.5 * rand();
    spawn(world, SPLASH, x, y + 0.004, z, Math.cos(a) * sp, 0.7 + 0.9 * rand(), Math.sin(a) * sp, Math.max(0.004, s * 0.45), 0.28 + 0.16 * rand(), 1);
  }
}

export function update(world, dt) {
  frame++;
  setTier(world);
  trail$.CLOCK[0] += world.paused ? 0 : world.frameDt * (0.35 + 0.65 * world.timeScale);
  if (dt > 0) {
    ST[SIM_T] += dt;
    ambient(world);
    fibers(world);
    integrate(world, dt);
  }
  world.stats.particles = n;
}

function integrate(world, dt) {
  const W = world.wind, ev = world.events, g = world.gravity, cam = world.camera;
  const gx = g[0], gy = g[1], gz = g[2];
  const gm = Math.sqrt(gx * gx + gy * gy + gz * gz) || 9.81;
  const ux = -gx / gm, uy = -gy / gm, uz = -gz / gm; // "up" for buoyancy: tilt the phone and fire follows
  const t = ST[SIM_T], fl = ST[FLOOR], stag = frame & 7;
  for (let i = n - 1; i >= 0; i--) {
    const a = (age[i] += dt), L = life[i];
    if (a >= L) { kill(i); continue; }
    const k = kind[i];
    if ((i & 7) === stag && WINDY[k]) { W.sample(px[i], py[i], pz[i], wtmp); wx[i] = wtmp[0]; wy[i] = wtmp[1]; wz[i] = wtmp[2]; }
    const f = a / L, s = seed[i];
    const x = px[i], z = pz[i];
    let y = py[i], u = vx[i], v = vy[i], w = vz[i];
    switch (k) {
      case FLAME: {
        // a buoyant tongue: accelerates up as it heats, sways with its neighbours (the sway is a function
        // of height and time, so a column of flames bends together), and leans with the wind
        const b = 2.2 + 4.0 * f;
        const sx = SINT[((y * 8.5 - t * 6.5 + s * 4.0) * SK) & 4095] * 1.5, sz = SINT[((y * 7.1 - t * 5.2 + s * 6.0) * SK + 1024) & 4095] * 1.1;
        u += (ux * b + (wx[i] * 0.6 - u) * 2.6 + sx) * dt;
        v += (uy * b + (wy[i] * 0.6 - v) * 2.2) * dt;
        w += (uz * b + (wz[i] * 0.6 - w) * 2.6 + sz) * dt;
        break;
      }
      case SPARK: {
        u += (gx - u * 0.35) * dt; v += (gy - v * 0.35) * dt; w += (gz - w * 0.35) * dt;
        if (y + v * dt < fl && v < 0) { // bounce, scatter a little, die after a few
          v = -v * (0.3 + 0.15 * s); u = u * 0.6 + (s - 0.5) * 0.4; w *= 0.6;
          if (++flag[i] > 2) life[i] = Math.min(L, a + 0.1);
        }
        break;
      }
      case EMBER: {
        if (flag[i]) { u = v = w = 0; break; } // landed: it glows out where it lies
        const cool = 1 - f, b = 1.7 * cool * cool;
        u += (ux * b + gx * 0.07 + (wx[i] - u) * 1.3 + SINT[((t * (1.3 + s) + s * 40) * SK) & 4095] * 0.7) * dt;
        v += (uy * b + gy * 0.07 + (wy[i] - v) * 1.3) * dt;
        w += (uz * b + gz * 0.07 + (wz[i] - w) * 1.3 + SINT[((t * (1.1 + s) + s * 20) * SK + 1024) & 4095] * 0.5) * dt;
        rot[i] += spin[i] * dt;
        if (y + v * dt < fl + 0.003 && v < 0) { y = fl + 0.003; flag[i] = 1; u = v = w = 0; life[i] = Math.min(L, a + 0.6); }
        break;
      }
      case ASH: case FIBER: case PETAL: {
        if (flag[i]) { u = v = w = 0; break; } // resting on the floor
        // flutter: light flakes swing side to side as they fall (the falling-leaf zigzag)
        const fr = k === PETAL ? 2.0 + s : k === ASH ? 3.4 + 2 * s : 4 + 3 * s;
        const z1 = SINT[((a * fr + s * 9) * SK) & 4095], z2 = SINT[((a * fr * 0.8 + s * 5) * SK + 1024) & 4095];
        const gk = k === PETAL ? 0.11 : k === ASH ? 0.12 : 0.3, dr = k === FIBER ? 2.4 : 2.6, sw = k === FIBER ? 1.1 : 1.7;
        u += (gx * gk + (wx[i] - u) * dr + z1 * sw) * dt;
        v += (gy * gk + (wy[i] - v) * dr + z1 * z2 * sw * 0.6) * dt;
        w += (gz * gk + (wz[i] - w) * dr + z2 * sw * 0.8) * dt;
        rot[i] += spin[i] * dt;
        if (k === FIBER) spin[i] *= 1 - 0.5 * dt;
        if (y + v * dt < fl + 0.003) { y = fl + 0.003; flag[i] = 1; u = v = w = 0; life[i] = Math.min(L, a + (k === PETAL ? 2.5 : 1.4)); }
        else if (k === PETAL && ((i + frame) & 7) === 0 && outOfView(cam, i)) { kill(i); continue; }
        break;
      }
      case SMOKE: case STEAM: {
        const steam = k === STEAM;
        const b = (steam ? 2.1 : 1.1) * (1 - f) * (1 - f) + 0.12;
        const dr = steam ? 1.6 : 0.9;
        u += (ux * b + (wx[i] * 0.85 - u) * dr) * dt;
        v += (uy * b + (wy[i] * 0.85 - v) * dr) * dt;
        w += (uz * b + (wz[i] * 0.85 - w) * dr) * dt;
        rot[i] += spin[i] * dt;
        break;
      }
      case RAIN: {
        // straight and steady: fx/rain.js launches each drop at terminal speed with the wind's slant built
        // in, and predicts where it lands from that straight path, so nothing here may bend it
        const ka = aux[i];
        if (y + v * dt <= ka) {
          const tc = v < 0 ? (ka - y) / (v * dt) : 0;
          ev.rainLand.push(x + u * dt * tc, ka, z + w * dt * tc, 0);
          kill(i); continue;
        }
        break;
      }
      case SPLASH: {
        u += (gx - u * 0.6) * dt; v += (gy - v * 0.6) * dt; w += (gz - w * 0.6) * dt;
        if (y + v * dt < fl && v < 0) { kill(i); continue; }
        break;
      }
      case DRIP: {
        u += (gx - u * 0.1) * dt; v += (gy - v * 0.1) * dt; w += (gz - w * 0.1) * dt;
        const ka = aux[i];
        if (y + v * dt <= ka) { const sz = size[i]; kill(i); landDrip(world, x, ka, z, sz); continue; }
        break;
      }
      case STREAK: W.sample(x, y, z, wtmp); u = wtmp[0]; v = wtmp[1]; w = wtmp[2]; break; // rides the wind field exactly
      case MOTE: {
        // dust barely moves: a slow wander, a hint of the wind
        u += (SINT[((t * 0.37 + s * 50) * SK) & 4095] * 0.05 + wx[i] * 0.12 - u) * 0.8 * dt;
        v += (SINT[((t * 0.29 + s * 31) * SK) & 4095] * 0.035 + wy[i] * 0.12 - v) * 0.8 * dt;
        w += (SINT[((t * 0.33 + s * 17) * SK + 1024) & 4095] * 0.05 + wz[i] * 0.12 - w) * 0.8 * dt;
        if (((i + frame) & 7) === 0 && outOfView(cam, i)) { kill(i); continue; }
        break;
      }
      default: u = v = w = 0; // RING: stays where it landed
    }
    vx[i] = u; vy[i] = v; vz[i] = w;
    px[i] = x + u * dt; py[i] = y + v * dt; pz[i] = z + w * dt;
  }
}

// ---------------------------------------------------------------- packing (draw 'main', once per frame)
const M_FLAME = 0 /* unlit, soft additive */, M_SPARK = MODE.ADD, M_EMBER = MODE.ADD | MODE.DOF, M_ASH = MODE.LIT, M_PUFF = MODE.LIT | MODE.VOL;
const M_STEAM = MODE.LIT | MODE.VOL | MODE.SCAT, M_WATER = MODE.LIT | MODE.SCAT, M_FIBER = MODE.LIT;
const M_STREAK = MODE.LIT | MODE.ADD | MODE.SCAT, M_MOTE = MODE.LIT | MODE.ADD | MODE.SCAT | MODE.DOF;
const M_PETAL = MODE.LIT, M_RING = MODE.LIT | MODE.SCAT | MODE.PRE;
// colours that never change, packed once (alpha 0); the per-particle alpha byte is OR-ed in as `A8 << 24`
const C_BLACK = rgba(0, 0, 0, 0), C_WHITE = rgba(1, 1, 1, 0), C_GREY18 = rgba(0.18, 0.18, 0.18, 0), C_GREY30 = rgba(0.3, 0.3, 0.3, 0);
const C_PETAL_SHEEN = rgba(0.9, 0.88, 0.88, 0), C_RAIN = rgba(0.74, 0.79, 0.86, 0), C_SPLASH = rgba(0.72, 0.78, 0.85, 0);
const C_DRIP = rgba(0.55, 0.62, 0.7, 0), C_STEAM = rgba(0.86, 0.88, 0.92, 0), C_STREAK = rgba(0.9, 0.94, 1, 0), C_STREAK_B = rgba(0.6, 0.7, 0.8, 0);
const C_MOTE = rgba(1, 0.96, 0.88, 0);
const A_FLAME = 140 << 24, A_FULL = 255 << 24; // flames: soft additive at 0.55 (dense fire converges, not sums)
const MISC_RING = M_RING | (CELL.RING << 8) | (255 << 24);
/** 0..1 → an alpha byte in the top of a colour word */
const a8 = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0) << 24;
/** smoothstep */
const sm = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };

function pack(world) {
  const ts = world.timeScale, rT = ST[SIM_T]; // flicker and twinkle run on simulated time: slow-mo slows them
  // many flames at once (on cloth the fire light already brightens) would add up to a white blob: ease
  // each one's heat down as the fire grows, so a big fire reads gold and orange with white only at hearts
  const heatK = Math.max(0.62, Math.min(1, 1.1 - kindN[FLAME] / 600));
  const cam = world.camera, M = cam.viewProj, P0 = cam.proj[0], P5 = cam.proj[5], near = cam.near;
  const m0 = M[0], m1 = M[1], m3 = M[3], m4 = M[4], m5 = M[5], m7 = M[7], m8 = M[8], m9 = M[9], m11 = M[11], m12 = M[12], m13 = M[13], m15 = M[15];
  // pass 1: skip what the camera can't see, and bucket the rest by draw group (the draw order, no sort)
  bN[0] = bN[1] = bN[2] = bN[3] = 0;
  for (let i = 0; i < n; i++) {
    const k = kind[i], x = px[i], y = py[i], z = pz[i], ux = vx[i], uy = vy[i], uz = vz[i];
    const r = size[i] * GROW[k] + ((ux < 0 ? -ux : ux) + (uy < 0 ? -uy : uy) + (uz < 0 ? -uz : uz)) * SHUT[k];
    const w = m3 * x + m7 * y + m11 * z + m15;
    if (w + r < near) continue;
    const wm = w * (1 + MARGIN[k]), xc = m0 * x + m4 * y + m8 * z + m12, yc = m1 * x + m5 * y + m9 * z + m13;
    const lx = wm + r * P0, ly = wm + r * P5;
    if (xc > lx || -xc > lx || yc > ly || -yc > ly) continue;
    const grp = GROUP[k];
    if (grp === 0) B0[bN[0]++] = i; else if (grp === 1) B1[bN[1]++] = i; else if (grp === 2) B2[bN[2]++] = i; else B3[bN[3]++] = i;
  }
  // pass 2: write the quads, group by group
  let q = 0;
  for (let grp = 0; grp < 4; grp++) {
  if (grp === 3) glowStart = q;
  const BK = grp === 0 ? B0 : grp === 1 ? B1 : grp === 2 ? B2 : B3, cnt = bN[grp];
  for (let j = 0; j < cnt; j++) {
    const i = BK[j], k = kind[i];
    const a = age[i], f = a / life[i], s = seed[i], sz = size[i], g = 1 - f;
    let ax = 0, ay = 0, az = 0, sa = sz, sl = sz, rt = 0, ca = 0, cb = 0, mode = 0, cell = 0, ero = 0, shw = 0;
    switch (k) {
      case FLAME: {
        const fl = 0.88 + 0.12 * SINT[((rT * 31 + s * 47) * SK) & 4095] * SINT[((rT * 17 + s * 13) * SK) & 4095];
        const grow = 0.55 + 2.4 * f * g; // swells as the gas rises, then burns out at the tip
        sa = sz * 0.72 * grow; sl = sz * grow;
        ax = vx[i] * 0.045; ay = vy[i] * 0.045; az = vz[i] * 0.045; // the tongue stretches with its speed (shape, not blur)
        // a rising turbulence mask shared by neighbours: bright tongues and dark gaps that climb together,
        // so a dense fire has structure instead of summing to one flat sheet of gold
        const x = px[i], y = py[i];
        const turb = 0.7 + 0.3 * SINT[((x * 11.3 + y * 2.0 + rT * 1.7) * SK) & 4095] * SINT[((y * 7.7 - rT * 5.3 + x * 3.1) * SK) & 4095];
        // born dim (no bright dots at the spawn points), hottest early, cooling to red as it rises
        const fin = f < 0.08 ? f * 12.5 : 1;
        // warmth (aux, from the fire module: 0 deep red … 1 white-gold, per material) scales the temperature;
        // 0 means "not given" and reads as a cotton-like 0.6 (×1.0); 0.2 (denim) ×0.7, 0.95 (aurora) ×1.26
        const wa = aux[i], warm = wa > 0 ? (wa < 1 ? wa : 1) : 0.6;
        let heat = 1.45 * fin * fin * (3 - 2 * fin) * g * (0.9 + 0.1 * g) * fl * heatK * turb * (0.55 + 0.75 * warm);
        if (heat > 1.75) heat = 1.75;
        // the thin blue skirt where fuel meets air: only on young, hot flames
        const base = g * g * g * (heat < 1 ? heat : 1) * (0.4 + 0.6 * warm);
        ca = A_FLAME;
        cb = ((8 * base) | 0) | (((20 * base) | 0) << 8) | (((80 * base) | 0) << 16) | (((heat * 127.5) | 0) << 24);
        mode = M_FLAME; cell = s < 0.55 ? CELL.FLAME_A : CELL.FLAME_B; rt = HALF_PI;
        shw = 128; // half weight in the bloom: a big fire has 100–200 flames 3–5 deep, it must glow, not blow out
        break;
      }
      case SPARK: {
        sa = sl = sz * 0.9;
        const sh = ts / 30; // a 1/30 s shutter in real time: slow-mo freezes sparks into short dashes
        ax = vx[i] * sh; ay = vy[i] * sh; az = vz[i] * sh;
        let heat = 1.3 * Math.sqrt(g) * (0.92 + 0.08 * SINT[((rT * 40 + s * 70) * SK) & 4095]);
        if (heat > 1.95) heat = 1.95;
        ca = A_FULL; cb = ((heat * 127.5) | 0) << 24;
        mode = M_SPARK; cell = CELL.STREAK; rt = HALF_PI; // the streak's head is white-hot, its tail red
        shw = 255; // full weight in the bloom
        break;
      }
      case EMBER: {
        const tumble = SINT[((a * (3 + 4 * s) + s * 9) * SK + 1024) & 4095];
        sa = sz * (0.25 + 0.75 * (tumble < 0 ? -tumble : tumble)); rt = rot[i];
        const fl = 0.5 + 0.5 * SINT[((rT * (7 + 9 * s) + s * 60) * SK) & 4095];
        const out = f > 0.85 ? (f - 0.85) * 6.667 : 0;
        const heat = (0.5 + 0.45 * g) * (0.55 + 0.45 * fl) * (1 - out * out * (3 - 2 * out));
        ca = A_FULL; cb = ((heat * 127.5) | 0) << 24;
        mode = M_EMBER; cell = CELL.EMBER;
        shw = 217; // bloom weight 0.85
        break;
      }
      case ASH: {
        const tumble = SINT[((a * (5 + 4 * s) + s * 7) * SK + 1024) & 4095];
        sa = sz * (0.15 + 0.85 * (tumble < 0 ? -tumble : tumble)); sl = sz * 0.9; rt = rot[i];
        const g0 = 0.1 + 0.12 * s, op = 0.92 * sm(0, 0.06, f) * (1 - sm(0.8, 1, f));
        const hot = a < 0.7 ? (1 - a / 0.7) * 0.32 : 0; // leaves the fire with a dull orange edge
        ca = ((g0 * 255) | 0) | (((g0 * 245) | 0) << 8) | (((g0 * 235) | 0) << 16) | a8(op);
        cb = C_GREY18 | a8(hot);
        mode = M_ASH; cell = CELL.ASH; shw = 255;
        break;
      }
      case SMOKE: {
        const sf = Math.sqrt(f);
        sa = sl = sz * (1 + 2.6 * sf);
        rt = HALF_PI + rot[i]; // slowly turning, near upright so the lit top stays up
        ero = ((0.06 + 0.5 * f * (0.7 + 0.3 * f)) * 255) | 0;
        // sootiness (aux, from the fire module: 0 pale … 1 black, per material; 0 = not given → cotton's 0.45):
        // sooty smoke is darker and thicker; all of it pales and thins as it rises
        const sa0 = aux[i], soot = sa0 > 0 ? (sa0 < 1 ? sa0 : 1) : 0.45;
        const fin = f < 0.12 ? f * 8.333 : 1;
        const op = (0.48 + 0.32 * soot) * fin * fin * (3 - 2 * fin) * Math.sqrt(g);
        const lum = 0.5 - 0.37 * soot + 0.24 * f;
        ca = ((lum * 255) | 0) | ((((lum - 0.01) * 255) | 0) << 8) | ((((lum - 0.02 + 0.02 * f) * 255) | 0) << 16) | a8(op);
        mode = M_PUFF; cell = s < 0.5 ? CELL.SMOKE_A : CELL.SMOKE_B; shw = 150;
        break;
      }
      case STEAM: {
        sa = sl = sz * (1 + 3.2 * Math.sqrt(f));
        rt = HALF_PI + rot[i];
        ero = ((0.12 + 0.55 * f) * 255) | 0;
        const fin = f < 0.06 ? f * 16.667 : 1;
        ca = C_STEAM | a8(0.42 * fin * fin * (3 - 2 * fin) * g * (0.7 + 0.3 * g));
        mode = M_STEAM; cell = CELL.SMOKE_C; shw = 150;
        break;
      }
      case RAIN: {
        sa = sl = sz * 0.5;
        const sh = ts / 50; // slow-mo turns the streaks into hanging beads
        ax = vx[i] * sh; ay = vy[i] * sh; az = vz[i] * sh;
        // a drop is a lens: it shows a bright sliver of the sky and every light behind it (the B core),
        // so it reads lighter than an overcast sky and glints near lanterns and fire
        const fin = a < 0.06 ? a * 16.667 : 1;
        ca = C_RAIN | a8(0.5 * fin * fin * (3 - 2 * fin)); cb = C_WHITE;
        mode = M_WATER; cell = CELL.STREAK; shw = 255; rt = -HALF_PI;
        break;
      }
      case SPLASH: {
        sa = sl = sz * 0.32;
        const sh = ts / 40; ax = vx[i] * sh; ay = vy[i] * sh; az = vz[i] * sh;
        ca = C_SPLASH | a8(0.7 * g); cb = C_WHITE;
        mode = M_WATER; cell = CELL.DISC; shw = 255; rt = HALF_PI;
        break;
      }
      case DRIP: {
        sa = sz * 0.5; sl = sz * 0.55;
        const sh = ts / 70; ax = vx[i] * sh; ay = vy[i] * sh; az = vz[i] * sh; // stretches as it falls
        ca = C_DRIP | (230 << 24); cb = C_WHITE;
        mode = M_WATER; cell = CELL.DROP; shw = 255; rt = -HALF_PI;
        break;
      }
      case FIBER: {
        const tumble = SINT[((a * (4 + 6 * s) + s * 11) * SK + 1024) & 4095];
        sa = sz * (0.25 + 0.75 * (tumble < 0 ? -tumble : tumble)); rt = rot[i];
        const c = aux[i] | 0;
        const fo = f > 0.75 ? (f - 0.75) * 4 : 0;
        // aux is 0xRRGGBB; the vertex wants the bytes the other way round (R lowest)
        ca = ((c >> 16) & 255) | (c & 0xff00) | ((c & 255) << 16) | a8(1 - fo * fo * (3 - 2 * fo));
        cb = C_GREY30;
        mode = M_FIBER; cell = s < 0.5 ? CELL.FIBER_A : CELL.FIBER_B; shw = 255;
        break;
      }
      case STREAK: {
        // a thin line along its velocity, whatever size it was spawned with
        sa = sz * 0.25; if (sa > 0.005) sa = 0.005;
        sl = sa * 2;
        ax = vx[i] * 0.22; ay = vy[i] * 0.22; az = vz[i] * 0.22;
        const al = ax * ax + ay * ay + az * az;
        if (al > 1.96) { const r = 1.4 / Math.sqrt(al); ax *= r; ay *= r; az *= r; }
        ca = C_STREAK | a8(0.1 * SINT[((f * PI) * SK) & 4095]); cb = C_STREAK_B;
        mode = M_STREAK; cell = CELL.STREAK; shw = 120;
        break;
      }
      case MOTE: {
        const tw = 0.5 + 0.5 * SINT[((rT * (0.8 + 1.7 * s) + s * 40) * SK) & 4095], tw3 = tw * tw * tw;
        const fin = f < 0.12 ? f * 8.333 : 1, fo = f > 0.8 ? (f - 0.8) * 5 : 0;
        const env = fin * fin * (3 - 2 * fin) * (1 - fo * fo * (3 - 2 * fo));
        ca = C_MOTE | a8((0.45 + 0.55 * tw3 * tw3) * env); // dim specks that flare as they turn
        mode = M_MOTE; cell = CELL.DISC; shw = 255;
        break;
      }
      case PETAL: {
        const tumble = SINT[((a * (2.6 + 2 * s) + s * 5) * SK + 1024) & 4095];
        sa = sz * (0.18 + 0.82 * (tumble < 0 ? -tumble : tumble)); sl = sz * 0.8; rt = rot[i];
        const c = (aux[i] | 0) || SAKURA, L = life[i];
        // they drift in from outside the frame, so only a short fade in, and a slow one out where they lie
        const fin = a < 0.15 ? a * 6.667 : 1, fo = a > L - 0.8 ? (a - L + 0.8) * 1.25 : 0;
        ca = ((c >> 16) & 255) | (c & 0xff00) | ((c & 255) << 16) | a8(fin * fin * (3 - 2 * fin) * (1 - fo * fo * (3 - 2 * fo)));
        cb = C_PETAL_SHEEN; // a petal is thin and translucent: its rim lights up with sun and sky
        mode = M_PETAL; cell = CELL.PETAL; shw = 255;
        break;
      }
      default: { // RING: a flat quad on the ground, built here
        const r = sz * (0.7 + 5.0 * Math.sqrt(f) * (0.85 + 0.15 * f)), y = py[i] + 0.004, x = px[i], z = pz[i];
        ca = C_SPLASH | a8(0.6 * g * Math.sqrt(g)); cb = C_WHITE;
        let o = q * QUAD_WORDS;
        for (let c = 0; c < 4; c++, o += WORDS) {
          F[o] = x + ((c & 1) ? r : -r); F[o + 1] = y; F[o + 2] = z + ((c & 2) ? r : -r);
          U[o + 3] = 0; U[o + 4] = 0; U[o + 5] = 0;
          U[o + 6] = ca; U[o + 7] = cb; U[o + 8] = MISC_RING | (c << 12);
        }
        q++;
        continue;
      }
    }
    const m = mode | (cell << 8) | (ero << 16) | (shw << 24);
    const x = px[i], y = py[i], z = pz[i];
    // the streak and the shape travel as 16-bit fixed point (1/4096 m), the angle as 1/65536 of a turn
    const iax = ax > 7.9 ? 32359 : ax < -7.9 ? -32359 : (ax * UNIT_M) | 0;
    const iay = ay > 7.9 ? 32359 : ay < -7.9 ? -32359 : (ay * UNIT_M) | 0;
    const iaz = az > 7.9 ? 32359 : az < -7.9 ? -32359 : (az * UNIT_M) | 0;
    const isa = sa > 15.9 ? 65126 : (sa * UNIT_M) | 0, isl = sl > 15.9 ? 65126 : (sl * UNIT_M) | 0;
    const irt = ((rt * UNIT_TURN) | 0) & 0xffff;
    // the six 16-bit fields, two to a word (little-endian: the first of each pair in the low half)
    const w3 = (iax & 0xffff) | (iay << 16), w4 = (iaz & 0xffff) | (isa << 16), w5 = isl | (irt << 16);
    let o = q * QUAD_WORDS;
    for (let c = 0; c < 4; c++, o += WORDS) {
      F[o] = x; F[o + 1] = y; F[o + 2] = z;
      U[o + 3] = w3; U[o + 4] = w4; U[o + 5] = w5;
      U[o + 6] = ca; U[o + 7] = cb; U[o + 8] = m | (c << 12);
    }
    q++;
  }
  }
  quads = q + trail$.build(world, q, MAX_QUADS - q);
}

// ---------------------------------------------------------------- draw
/** pass: 'main' (everything, alpha kinds first, then additive) or 'emissive' (glowing kinds + trail). */
export function draw(world, pass) {
  const gl = world.gl, emissive = pass === 'emissive';
  let fresh = false;
  if (!emissive || packedFrame !== frame) {
    pack(world);
    packedFrame = frame; fresh = true;
    if (quads > 0) {
      vboIx = (vboIx + 1) % 3; vbo = VBO[vboIx];
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, viewFor(quads));
    }
  }
  const first = emissive ? glowStart : 0, cnt = quads - first;
  if (cnt <= 0) return;
  const p = PROG[Q] || ensureProgram(world), u = p.u, cam = world.camera;
  gl.useProgram(p.prog);
  let tw = world.pxWidth, th = world.pxHeight;
  if (emissive) { const es = emissiveSize(); if (es[0] > 0) { tw = es[0]; th = es[1]; } }
  gl.uniform3f(u.uView, tw * 0.5, th * 0.5, cam.proj[5] * th * 0.5);
  gl.uniform4f(u.uLimits, 0.7, T.maxFrac * th, T.coc * th, cam.dist);
  // uniforms live in the program: lights, camera and shadow are set once a frame, in the main pass
  if (fresh || !emissive) {
    setCommon(world, p);
    gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
    const L = world.lights, gpu = world.gpu, isPt = L.shadow.type === 'point' ? 1 : 0;
    gl.uniform2f(u.uShade, isPt, gpu.shadowTex && gpu.shadowOn ? 1 : 0);
    if (u.uShadowMat) {
      gl.uniformMatrix4fv(u.uShadowMat, false, gpu.shadowMat);
      if (isPt) gl.uniform3fv(u.uShLight, L.shadow.pos);
      else {
        const d = L.shadow.dir, l = Math.hypot(d[0], d[1], d[2]) || 1;
        shDir[0] = d[0] / l; shDir[1] = d[1] / l; shDir[2] = d[2] / l; gl.uniform3fv(u.uShLight, shDir);
      }
      const cl = world.cloth, b = cl && cl.bounds;
      if (b && Number.isFinite(b.min[0]) && Number.isFinite(b.max[0])) { clothC[0] = (b.min[0] + b.max[0]) * 0.5; clothC[1] = (b.min[1] + b.max[1]) * 0.5; clothC[2] = (b.min[2] + b.max[2]) * 0.5; }
      else { clothC[0] = cam.target[0]; clothC[1] = cam.target[1]; clothC[2] = cam.target[2]; }
      gl.uniform3fv(u.uClothC, clothC);
      gl.uniform3fv(u.uCamRight, cam.right); gl.uniform3fv(u.uCamUp, cam.up);
    }
  } else if (u.uNoise) { // the emissive pass: other modules drew in between, so re-bind the noise
    gl.activeTexture(gl.TEXTURE0 + UNIT.NOISE); gl.bindTexture(gl.TEXTURE_2D, world.gpu.noiseTex);
  }
  if (u.uShadow) {
    const gpu = world.gpu;
    gl.activeTexture(gl.TEXTURE0 + UNIT.SHADOW); gl.bindTexture(gl.TEXTURE_2D, gpu.shadowTex && gpu.shadowOn ? gpu.shadowTex : whiteTex); gl.uniform1i(u.uShadow, UNIT.SHADOW);
  }
  gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.bindTexture(gl.TEXTURE_2D, atlasTex); gl.uniform1i(u.uAtlas, UNIT.A);
  if (emissive) gl.uniform3f(u.uGlow, 0.9, 0.85, 0.8); else gl.uniform3f(u.uGlow, 1, 1, 1);
  gl.uniform1f(u.uEmis, emissive ? 1 : 0);
  const a = p.a;
  locs[0] = a.aPos; locs[1] = a.aAxis; locs[2] = a.aShape; locs[3] = a.aColA; locs[4] = a.aColB; locs[5] = a.aMisc;
  useAttribs(gl, locs);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  if (a.aPos >= 0) gl.vertexAttribPointer(a.aPos, 3, gl.FLOAT, false, STRIDE, 0);
  if (a.aAxis >= 0) gl.vertexAttribPointer(a.aAxis, 3, gl.SHORT, false, STRIDE, 12);
  if (a.aShape >= 0) gl.vertexAttribPointer(a.aShape, 3, gl.UNSIGNED_SHORT, false, STRIDE, 18);
  if (a.aColA >= 0) gl.vertexAttribPointer(a.aColA, 4, gl.UNSIGNED_BYTE, true, STRIDE, 24);
  if (a.aColB >= 0) gl.vertexAttribPointer(a.aColB, 4, gl.UNSIGNED_BYTE, true, STRIDE, 28);
  if (a.aMisc >= 0) gl.vertexAttribPointer(a.aMisc, 4, gl.UNSIGNED_BYTE, false, STRIDE, 32);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  gl.drawElements(gl.TRIANGLES, cnt * 6, gl.UNSIGNED_SHORT, first * 12);
  world.stats.drawCalls++; // (main.js resets blend and depth state after every module)
}

/** Read-only views for tests (tests/particles-*.mjs): the pool, kind counts and the packed vertex words. */
export const debug = {
  pool: { px, py, pz, vx, vy, vz, age, life, size, aux, kind, flag }, F, U, kindN,
  get n() { return n; }, get quads() { return quads; }, get glowStart() { return glowStart; },
};
