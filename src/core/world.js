// The one shared state object. Every module reads it; every field has ONE writer, named here and in
// CONTRACT.md. Nothing in here allocates per frame: arrays are sized once (at boot or scene load).
import { makeEvents } from './events.js';
import { mat4 } from './math.js';

/** Particle kinds. render/particles.js draws them; fx modules spawn them (see CONTRACT.md § Particles). */
export const PK = {
  FLAME: 0,   // additive, rises, white-gold → orange → red, short life. aux unused
  SPARK: 1,   // additive, tiny, ballistic + drag, streaks along velocity. aux unused
  EMBER: 2,   // additive glowing flake, drifts up with the wind, flickers. aux unused
  ASH: 3,     // dark flake, flutters down with the wind. aux unused
  SMOKE: 4,   // soft grey puff, rises, expands, fades. aux unused
  STEAM: 5,   // white puff, rises fast, fades fast. aux unused
  RAIN: 6,    // thin streak along velocity. aux = kill height (y); on kill → events.rainLand
  SPLASH: 7,  // tiny droplets bouncing up. aux unused
  DRIP: 8,    // a water drop falling from the cloth. aux = floor height; on kill → events.splash
  FIBER: 9,   // a thread scrap from a tear or a cut, tumbling. aux = packed colour 0xRRGGBB
  STREAK: 10, // faint wind line following the wind field. aux unused
  MOTE: 11,   // dust in the light, slow drift. aux unused
  PETAL: 12,  // a petal or leaf on the wind. aux = packed colour 0xRRGGBB
};
export const PK_COUNT = 13;

export const TOOLS = ['grab', 'slice', 'burn', 'pin', 'dye'];
/** Dye colours, by index (world.dyeColor). The dye module owns how they look on cloth. */
export const DYES = [
  { id: 'ai', name: 'Indigo', rgb: [0.10, 0.17, 0.48] },
  { id: 'shu', name: 'Vermilion', rgb: [0.89, 0.25, 0.16] },
  { id: 'kin', name: 'Gold', rgb: [0.85, 0.62, 0.18] },
  { id: 'sumi', name: 'Ink', rgb: [0.05, 0.05, 0.07] },
];
export const MAX_POINTERS = 5;

function pointer() {
  return {
    active: false, id: -1,         // input.js: a finger/mouse is down in this slot
    x: 0, y: 0, px: 0, py: 0,      // input.js: current and previous position, CSS px
    particle: -1,                  // main api: the grabbed vertex (-1 = not grabbing)
    depth: 0,                      // main api: view depth of the grab point
    target: new Float32Array(3),   // main api: where the grab wants the vertex (world), updated on move
  };
}

export const world = {
  // ---- time (main.js) ----
  time: 0,          // simulated seconds
  realTime: 0,      // wall seconds since boot
  dt: 1 / 60,       // this frame's SIMULATED dt (frameDt × timeScale; 0 when paused)
  frameDt: 1 / 60,  // this frame's real dt, clamped to [0, 1/20]
  timeScale: 1,     // main.js eases it toward timeScaleTarget (slow-mo); UI may set timeScaleTarget
  timeScaleTarget: 1, // main.js: 1, or slow-mo (toggle), or a brief dip while slowmoPulse > 0
  slowmoPulse: 0,     // seconds of dramatic slow-mo left (ui/input.js sets it on a big slice); main.js counts down
  frame: 0,
  paused: false,

  // ---- platform (main.js) ----
  canvas: null, gl: null,
  glx: null,        // { gl, ext: { deriv, aniso }, caps: { highp, maxTex, maxPoint } } from render/gl.js
  touch: false,     // coarse pointer device
  width: 1, height: 1,       // canvas size in CSS px
  dpr: 1,                    // drawing-buffer px per CSS px (quality decides)
  pxWidth: 1, pxHeight: 1,   // drawing buffer size

  // ---- quality (core/quality.js) ----
  q: null,          // the live tier: see core/quality.js TIERS. Read-only for everyone else.

  // ---- scene (scenes/) ----
  sceneId: '',
  scene: null,      // the active scene module (scenes/<id>.js export)
  materialId: 'cotton',   // main api setMaterial
  /** Where the camera looks. Scenes set it on load and may animate it; core/camera.js turns it into matrices. */
  cameraRig: {
    target: [0, 1.2, 0],   // look-at point (world)
    dir: [0, 0, -1],       // view direction (normalised by camera.js)
    up: [0, 1, 0],
    width: 2, height: 2,   // the subject box that must fit on screen, metres
    fov: 38,               // vertical fov, degrees
    margin: 1.08,          // >1 adds room around the subject
    offset: [0, 0, 0],     // extra eye offset in world units, scenes may set
    uiOffset: [0, 0, 0],   // ui/input.js: tilt parallax and the katana kick (world units); main.js zeroes it per scene
    zoom: 1,               // ui/input.js: pinch/wheel zoom, multiplies the fitted camera distance; main.js resets it
    minDist: 0.5, maxDist: 60,
  },
  camera: {        // core/camera.js, every frame
    pos: new Float32Array(3), target: new Float32Array(3),
    right: new Float32Array(3), up: new Float32Array(3), fwd: new Float32Array(3),
    fovY: 0.66, tanHalf: 0.34, aspect: 1, near: 0.05, far: 80, dist: 4,
    view: mat4(), proj: mat4(), viewProj: mat4(), invViewProj: mat4(),
  },
  gravity: new Float32Array([0, -9.81, 0]), // scenes set the default; ui/input.js rotates it when tilt is on
  gravityDefault: new Float32Array([0, -9.81, 0]), // main.js: the scene's own gravity, restored when tilt turns off

  /** Collision shapes (scenes write on load and may move them). Physics reads. All in world metres. */
  colliders: {
    spheres: [],   // { x, y, z, r, friction }
    capsules: [],  // { ax, ay, az, bx, by, bz, r, friction }
    planes: [],    // { nx, ny, nz, d, friction }   (n·p + d >= 0 is outside)
  },

  /** Lighting (scenes write on load; fire writes `fire`). Renderers read via render/glsl.js setCommon(). */
  lights: {
    keyDir: new Float32Array([0.4, 0.8, 0.45]),  // unit vector TOWARD the key light
    keyCol: new Float32Array([1.0, 0.95, 0.85]),  // colour × intensity (linear)
    sky: new Float32Array([0.35, 0.40, 0.55]),    // hemisphere ambient, up
    ground: new Float32Array([0.12, 0.10, 0.09]), // hemisphere ambient, down
    pointPos: new Float32Array([0, 2, -2]),       // a scene light: lantern, doorway glow, moon
    pointCol: new Float32Array([0, 0, 0]),        // colour × intensity; 0 = off
    firePos: new Float32Array([0, 0, 0]),         // fx/fire.js: the burn front's light
    fireCol: new Float32Array([0, 0, 0]),         // fx/fire.js: colour × intensity; 0 = no fire
    fogCol: new Float32Array([0.05, 0.06, 0.1]),  // fog colour (linear)
    fogDensity: 0.02,
    exposure: 1.0,
    /** Shadow-casting light for the coloured transmittance shadow (render/shadow.js reads, scenes write). */
    shadow: { type: 'dir', pos: new Float32Array([0, 4, 3]), dir: new Float32Array([-0.4, -0.8, -0.45]), strength: 0.85 },
  },

  /** Wind. fx/wind.js owns it and replaces sample(); physics, particles, audio read it. */
  wind: {
    x: 0, y: 0, z: 0,      // current mean wind, m/s (already includes the toggle's level)
    speed: 0,              // |mean wind| m/s
    gust: 0,               // 0..1 gust envelope right now (audio)
    sample(x, y, z, out) { out[0] = this.x; out[1] = this.y; out[2] = this.z; return out; },
  },

  /** Rain state. fx/rain.js owns it. */
  rain: { intensity: 0 },  // 0..1, eased toward the toggle

  /** The cloth. sim/builder.js allocates it at scene load; sim/cloth.js simulates it. See CONTRACT.md § Cloth. */
  cloth: null,
  /** Per vertex: css x, css y, view depth (<= 0 means behind the camera). core/camera.js, after physics. */
  screen: new Float32Array(0),

  // ---- interaction (ui/ and main api) ----
  tool: 'grab',      // one of TOOLS
  dyeColor: 0,       // index into DYES
  toggles: {
    wind: 1,         // 0 still · 1 breeze · 2 gale
    rain: false,
    slowmo: false,
    tilt: false,     // gravity follows the phone
    sound: true,
    stats: false,    // the receipt HUD
  },
  tilt: { x: 0, y: 0, active: false }, // ui/input.js: device tilt, -1..1 each axis
  pointers: Array.from({ length: MAX_POINTERS }, pointer),

  // ---- per-frame bus ----
  events: makeEvents(),   // core/events.js; cleared by main.js at the end of each frame

  /** Numbers for the receipt HUD, the governor, audio and tests. Writer in brackets. */
  stats: {
    fps: 60, frameMs: 16.7, jsMs: 0,                    // [main]
    ms: { input: 0, scene: 0, weather: 0, fire: 0, sim: 0, particles: 0, audio: 0, render: 0, ui: 0 }, // [main]
    verts: 0, constraints: 0, constraintsAlive: 0, tris: 0, trisAlive: 0, substeps: 0, // [sim]
    kinetic: 0,     // [sim] mean particle speed, m/s
    flutter: 0,     // [sim] mean |acceleration| change, a proxy for flapping (audio)
    tension: 0,     // [sim] max strain ratio this frame (1 = rest)
    burning: 0,     // [fire] number of vertices on fire
    charred: 0,     // [fire] fraction of cloth burnt away 0..1
    wetness: 0,     // [wet] mean wetness 0..1
    particles: 0,   // [particles] alive particles
    drawCalls: 0,   // [render modules add; main resets]
    tier: '',       // [quality]
  },

  /** GPU resources shared between render modules. Writer in brackets. */
  gpu: {
    noiseTex: null,   // [main] 256² RGBA tileable noise (core/noise.js): r,g = value-noise fbm, b = fibre, a = white
    printTex: null,   // [render/cloth.js] the scene's textile print, sampled with the cloth uv
    printPixels: null,// [render/cloth.js] { w, h, data: Uint8ClampedArray RGBA } of the print, for CPU colour lookups (fibres, ash)
    dyeTex: null,     // [fx/dye.js] RGBA dye layer in cloth uv space: rgb colour, a amount (null = none)
    shadowTex: null,  // [render/shadow.js] coloured transmittance map (white = full light)
    shadowMat: mat4(),// [render/shadow.js] world → shadow map uv in xy, depth in z (0..1)
    shadowOn: 0,      // [render/shadow.js] 0 = receivers skip the lookup
    cloth: null,      // [render/cloth.js] { pos, nrm, uv, fx, index, count } GL buffers, for the shadow pass
  },

  /** High-level verbs. main.js fills this at boot; ui/input.js and tests call it. */
  api: {},
};
