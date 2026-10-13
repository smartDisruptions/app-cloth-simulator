// Helpers every scene uses (kept apart from index.js so scenes don't import their own registry).
// Load-time helpers may allocate; the per-frame ones (frame, bone*, flicker) never do.
import { noise3 } from '../core/noise.js';

/** Put lights back to neutral defaults (scenes call this first in build). */
export function resetLights(world) {
  const L = world.lights;
  L.keyDir.set([0.35, 0.8, 0.5]); L.keyCol.set([1.0, 0.95, 0.85]);
  L.sky.set([0.32, 0.36, 0.48]); L.ground.set([0.1, 0.09, 0.08]);
  L.pointPos.set([0, 2, -2]); L.pointCol.set([0, 0, 0]);
  L.firePos.set([0, 0, 0]); L.fireCol.set([0, 0, 0]);
  L.fogCol.set([0.05, 0.06, 0.1]); L.fogDensity = 0.02; L.exposure = 1;
  L.shadow.type = 'dir'; L.shadow.pos.set([0, 4, 3]); L.shadow.dir.set([-0.35, -0.8, -0.5]); L.shadow.strength = 0.85;
  L.shadow.fov = 150;   // only used when the point light sits inside the cloth (render/shadow.js)
  const n = Math.hypot(L.keyDir[0], L.keyDir[1], L.keyDir[2]); L.keyDir[0] /= n; L.keyDir[1] /= n; L.keyDir[2] /= n;
}

/** Grid dimension scaled by the tier's cloth resolution (never below `min`). */
export const dim = (n, res, min = 6) => Math.max(min, Math.round(n * res));

/** 0xRRGGBB (sRGB) → linear [r, g, b] × k, matching the shaders' toLinear (c²). */
export function lin(hex, k = 1) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  return [r * r * k, g * g * k, b * b * k];
}

export function unit(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

/** A camera framing: where to look, from which direction, what box must fit. */
export function framing(target, dir, width, height, fov = 38, margin = 1.06) {
  return { target, dir, width, height, fov, margin };
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Seconds since the scene was (re)built. scenes/index.js resets and advances it. */
export const clock = { t: 0 };
/** The opening push-in: the camera starts this much further back and settles over PUSH_T seconds. */
const PUSH = 0.18, PUSH_T = 3.5;

/**
 * Blend a portrait and a landscape framing by the screen's aspect (runs every frame; no allocation). For
 * the first seconds of a scene the camera eases in from further back, like an establishing shot.
 */
export function frame(world, P, L, a0 = 0.62, a1 = 1.5) {
  const t = smooth(a0, a1, world.width / Math.max(1, world.height));
  const r = world.cameraRig;
  for (let i = 0; i < 3; i++) {
    r.target[i] = P.target[i] + (L.target[i] - P.target[i]) * t;
    r.dir[i] = P.dir[i] + (L.dir[i] - P.dir[i]) * t;
  }
  r.width = P.width + (L.width - P.width) * t;
  r.height = P.height + (L.height - P.height) * t;
  r.fov = P.fov + (L.fov - P.fov) * t;
  r.margin = (P.margin + (L.margin - P.margin) * t) * (1 + PUSH * (1 - smooth(0, PUSH_T, clock.t)));
  return t;
}

/** A lamp's flicker: ~1 ± amount, smooth, deterministic in time. */
export function flicker(t, seed, amount = 0.08, speed = 7) {
  return 1 + amount * (noise3(t * speed, seed, 0.5) * 0.7 + noise3(t * speed * 2.7, seed + 3.1, 1.5) * 0.3);
}

/** out = T(p) · R(axis, angle) · T(−p): a rotation about an axis through pivot p. Axis must be unit. */
export function boneRotate(out, px, py, pz, ax, ay, az, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const m00 = t * ax * ax + c, m01 = t * ax * ay - s * az, m02 = t * ax * az + s * ay;
  const m10 = t * ax * ay + s * az, m11 = t * ay * ay + c, m12 = t * ay * az - s * ax;
  const m20 = t * ax * az - s * ay, m21 = t * ay * az + s * ax, m22 = t * az * az + c;
  // column-major: out[col * 4 + row]
  out[0] = m00; out[1] = m10; out[2] = m20; out[3] = 0;
  out[4] = m01; out[5] = m11; out[6] = m21; out[7] = 0;
  out[8] = m02; out[9] = m12; out[10] = m22; out[11] = 0;
  out[12] = px - (m00 * px + m01 * py + m02 * pz);
  out[13] = py - (m10 * px + m11 * py + m12 * pz);
  out[14] = pz - (m20 * px + m21 * py + m22 * pz);
  out[15] = 1;
  return out;
}

/** out = a · b (column-major 4×4). out may alias neither input. */
export function boneMul(out, a, b) {
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[i * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[i * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[i * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Transform point (x, y, z) by bone m into out. */
export function boneApply(out, m, x, y, z) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export const newBones = () => [mat(), mat(), mat()];
function mat() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
