// Tilt: the phone's real gravity becomes world.gravity, turned into the camera's frame. Hold the phone
// upright and the cloth hangs straight down the screen; tilt it left and the cloth swings left; lay it flat
// and gravity points into the scene, so the cloth swings away from you. (Until 2026-10-13 "level" was
// however the phone was held when Tilt was switched on, so switching it on with the phone on a table made
// flat the hanging pose. Josh: upright should hang.) Also a small parallax signal for the camera
// (ui/input.js) that follows the phone's movement and settles back while it is held still.
//
// iOS needs DeviceOrientationEvent.requestPermission() from a tap; desktops expose the event but never
// fire it. Both end in bus.tiltState(-2 | -1) and the HUD turns the toggle off with a short note.
import { bus } from './bus.js';

const D2R = Math.PI / 180;
let listening = false, state = 0;   // 0 off · 1 waiting for a first reading · 2 live
let primed = false, angle = 0;      // primed: the parallax baseline has its first reading
const M = new Float64Array(2);   // [0] gravity strength · [1] seconds of frame time spent waiting for a reading
M[0] = 9.81;
const g = new Float32Array(3);      // latest gravity in screen axes (x right, y up, z out of the glass), unit
const a = new Float32Array(3);      // smoothed gravity, screen axes
const base = new Float32Array(2);   // slow average of the sideways and in/out gravity: the parallax rests on it
/** Parallax signal for the camera, each about -1..1 (0 when Tilt is off): sideways, and up. */
export const par = new Float32Array(2);

export const supported = () => typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';

export function init() {
  readAngle();
  const re = () => { readAngle(); primed = false; };
  window.addEventListener('orientationchange', re);
  try { if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', re); } catch (e) { /* old browsers */ }
}

/** A new scene: remember its gravity's strength (tilt only turns it). */
export function onScene(world) {
  const G = world.gravity, m = Math.sqrt(G[0] * G[0] + G[1] * G[1] + G[2] * G[2]);
  if (m > 0.1 && state !== 2) M[0] = m;
}

/** Switch the sensor on. Call it from a click handler: iOS only asks for permission inside one. */
export function start() {
  if (!supported()) { fail(-1); return; }
  const DOE = window.DeviceOrientationEvent;
  if (typeof DOE.requestPermission === 'function') {
    let p = null;
    try { p = DOE.requestPermission(); } catch (e) { fail(-2); return; }
    p.then((r) => { if (r === 'granted') listen(); else fail(-2); }, () => fail(-2));
  } else listen();
}

export function stop() {
  if (listening) { window.removeEventListener('deviceorientation', onOrient); listening = false; }
  state = 0; primed = false;
  par[0] = par[1] = 0;
}

export const live = () => state === 2;

function listen() {
  if (!listening) { window.addEventListener('deviceorientation', onOrient); listening = true; }
  state = 1; primed = false; M[1] = 0;
  a[0] = 0; a[1] = -1; a[2] = 0;
  readAngle();
}

function fail(code) { stop(); bus.tiltState(code); }

function readAngle() {
  let ang = 0;
  try {
    if (screen.orientation && typeof screen.orientation.angle === 'number') ang = screen.orientation.angle;
    else if (typeof window.orientation === 'number') ang = window.orientation;
  } catch (e) { ang = 0; }
  angle = ((Math.round(ang / 90) * 90) % 360 + 360) % 360;
}

function onOrient(e) {
  if (state === 0) return;
  const b = e.beta, c = e.gamma;
  if (b == null || c == null) { if (state === 1) fail(-1); return; }
  // W3C Z-X'-Y'' angles → the down vector in device axes (x right, y toward the top, z out of the glass)
  const cb = Math.cos(b * D2R), sb = Math.sin(b * D2R), cg = Math.cos(c * D2R), sg = Math.sin(c * D2R);
  const x = cb * sg, y = -sb, z = -cb * cg;
  // device axes → screen axes for the current screen rotation
  let sx = x, sy = y;
  if (angle === 90) { sx = -y; sy = x; } else if (angle === 180) { sx = -x; sy = -y; } else if (angle === 270) { sx = y; sy = -x; }
  g[0] = sx; g[1] = sy; g[2] = z;
  if (state === 1) { state = 2; bus.tiltState(1); }
}

/** Per frame (ui/input.js): write world.gravity while Tilt is on and the sensor is live. */
export function update(world) {
  // no reading after 1.6 s of frames (frame time, so one long hitch isn't mistaken for no sensor)
  if (state === 1) { M[1] += world.frameDt; if (M[1] > 1.6) fail(-1); return; }
  const dt = world.frameDt;
  if (state !== 2 || !world.toggles.tilt) { par[0] = par[1] = 0; return; }
  if (!primed) { a[0] = g[0]; a[1] = g[1]; a[2] = g[2]; base[0] = g[0]; base[1] = g[2]; primed = true; }
  const k = 1 - Math.exp(-dt * 12);   // sensors jitter; cloth has weight
  a[0] += (g[0] - a[0]) * k; a[1] += (g[1] - a[1]) * k; a[2] += (g[2] - a[2]) * k;
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
  const ax = a[0] / l, ay = a[1] / l, az = a[2] / l;
  // screen axes → world: right = the camera's right (level), up = world up, out = toward the viewer, level
  const R = world.camera.right, F = world.camera.fwd;
  let rxw = R[0], rzw = R[2];
  const rl = Math.sqrt(rxw * rxw + rzw * rzw) || 1; rxw /= rl; rzw /= rl;
  let bx = -F[0], bz = -F[2];
  const bl = Math.sqrt(bx * bx + bz * bz);
  if (bl < 1e-3) { bx = -rzw; bz = rxw; } else { bx /= bl; bz /= bl; }
  const G = world.gravity, mag = M[0];
  G[0] = mag * (ax * rxw + az * bx);
  G[1] = mag * ay;
  G[2] = mag * (ax * rzw + az * bz);
  // parallax: how far the phone has moved from where it has been resting lately (a ~1.5 s average), so
  // holding it at any angle leaves the camera centred and moving it gives the scene a little depth
  const kb = 1 - Math.exp(-dt * 0.7);
  base[0] += (ax - base[0]) * kb; base[1] += (az - base[1]) * kb;
  const px = ax - base[0], py = base[1] - az;
  par[0] = px > 1 ? 1 : px < -1 ? -1 : px; par[1] = py > 1 ? 1 : py < -1 ? -1 : py;
}
