// Tilt: the phone's orientation becomes world.gravity, rotated into the camera's frame, so tilting the
// phone left swings the cloth left on screen and laying it flat swings the cloth away from you. "Level"
// is however the phone was held when Tilt was switched on (and again after the screen rotates), so it
// works lying in bed as well as standing up. Also a small parallax signal for the camera (ui/input.js).
//
// iOS needs DeviceOrientationEvent.requestPermission() from a tap; desktops expose the event but never
// fire it. Both end in bus.tiltState(-2 | -1) and the HUD turns the toggle off with a short note.
import { bus } from './bus.js';

const D2R = Math.PI / 180;
const GAIN = 1.4;                   // world tilt = phone tilt × GAIN (1 would be literal)
let listening = false, state = 0;   // 0 off · 1 waiting for a first reading · 2 live
let calibrated = false, angle = 0;
const M = new Float64Array(2);   // [0] gravity strength · [1] seconds of frame time spent waiting for a reading
M[0] = 9.81;
const g = new Float32Array(3);      // latest gravity in screen axes (x right, y up, z out of the glass), unit
const Q = new Float32Array(9);      // rotation taking the neutral gravity to (0, -1, 0)
const a = new Float32Array(3);      // smoothed neutral-relative gravity, screen axes
/** Parallax signal for the camera, each about -1..1 (0 when Tilt is off): sideways, and up. */
export const par = new Float32Array(2);

export const supported = () => typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';

export function init() {
  readAngle();
  const re = () => { readAngle(); calibrated = false; };
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
  state = 0; calibrated = false;
  par[0] = par[1] = 0;
}

export const live = () => state === 2;

function listen() {
  if (!listening) { window.addEventListener('deviceorientation', onOrient); listening = true; }
  state = 1; calibrated = false; M[1] = 0;
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
  if (!calibrated) { calibrate(); calibrated = true; }
  if (state === 1) { state = 2; bus.tiltState(1); }
}

/** Q = the rotation (Rodrigues) that takes the current gravity to straight down the screen. */
function calibrate() {
  const nx = g[0], ny = g[1], nz = g[2];
  let kx = nz, kz = -nx;            // n × (0, -1, 0)
  const s = Math.sqrt(kx * kx + kz * kz), c = -ny;
  if (s < 1e-5) {
    Q.fill(0); Q[0] = 1;
    if (c > 0) { Q[4] = 1; Q[8] = 1; } else { Q[4] = -1; Q[8] = -1; }
    return;
  }
  kx /= s; kz /= s;
  const t = 1 - c;
  Q[0] = c + t * kx * kx; Q[1] = -s * kz;  Q[2] = t * kx * kz;
  Q[3] = s * kz;          Q[4] = c;        Q[5] = -s * kx;
  Q[6] = t * kx * kz;     Q[7] = s * kx;   Q[8] = c + t * kz * kz;
}

/** Per frame (ui/input.js): write world.gravity while Tilt is on and the sensor is live. */
export function update(world) {
  // no reading after 1.6 s of frames (frame time, so one long hitch isn't mistaken for no sensor)
  if (state === 1) { M[1] += world.frameDt; if (M[1] > 1.6) fail(-1); return; }
  const dt = world.frameDt;
  if (state !== 2 || !world.toggles.tilt) { par[0] = par[1] = 0; return; }
  const rx = Q[0] * g[0] + Q[1] * g[1] + Q[2] * g[2];
  const ry = Q[3] * g[0] + Q[4] * g[1] + Q[5] * g[2];
  const rz = Q[6] * g[0] + Q[7] * g[1] + Q[8] * g[2];
  const k = 1 - Math.exp(-dt * 12);   // sensors jitter; cloth has weight
  a[0] += (rx - a[0]) * k; a[1] += (ry - a[1]) * k; a[2] += (rz - a[2]) * k;
  const l = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1;
  let ax = a[0] / l, ay = a[1] / l, az = a[2] / l;
  // A little gain on the angle away from level, so a natural wrist tilt visibly swings the cloth.
  const h = Math.sqrt(ax * ax + az * az);
  if (h > 1e-5) {
    let phi = Math.atan2(h, -ay) * GAIN;
    if (phi > Math.PI) phi = Math.PI;
    const s = Math.sin(phi) / h;
    ax *= s; az *= s; ay = -Math.cos(phi);
  }
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
  par[0] = ax; par[1] = -az;
}
