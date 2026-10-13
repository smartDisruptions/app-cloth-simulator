// Camera: rig → matrices (every frame), and the screen-space helpers picking and slicing use.
import { lookAt, perspective, multiply, invert } from './math.js';

const tmpEye = new Float32Array(3);

/** Fit the rig's subject box to the screen and build view/proj. Called by main.js every frame. */
export function updateCamera(world) {
  const r = world.cameraRig, c = world.camera;
  const aspect = world.width / Math.max(1, world.height);
  const fovY = (r.fov * Math.PI) / 180, th = Math.tan(fovY / 2);
  let dx = r.dir[0], dy = r.dir[1], dz = r.dir[2];
  const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
  let dist = Math.max((r.height * 0.5) / th, (r.width * 0.5) / (th * aspect)) * r.margin * (r.zoom || 1);
  dist = Math.min(r.maxDist, Math.max(r.minDist, dist));
  const u = r.uiOffset;
  tmpEye[0] = r.target[0] - dx * dist + r.offset[0] + u[0];
  tmpEye[1] = r.target[1] - dy * dist + r.offset[1] + u[1];
  tmpEye[2] = r.target[2] - dz * dist + r.offset[2] + u[2];
  c.pos[0] = tmpEye[0]; c.pos[1] = tmpEye[1]; c.pos[2] = tmpEye[2];
  c.target[0] = r.target[0]; c.target[1] = r.target[1]; c.target[2] = r.target[2];
  c.fovY = fovY; c.tanHalf = th; c.aspect = aspect; c.dist = dist;
  c.near = Math.max(0.02, dist * 0.02); c.far = dist * 6 + 40;
  lookAt(c.view, c.pos, c.target, r.up);
  perspective(c.proj, fovY, aspect, c.near, c.far);
  multiply(c.viewProj, c.proj, c.view);
  invert(c.invViewProj, c.viewProj);
  // camera basis from the view matrix rows
  c.right[0] = c.view[0]; c.right[1] = c.view[4]; c.right[2] = c.view[8];
  c.up[0] = c.view[1]; c.up[1] = c.view[5]; c.up[2] = c.view[9];
  c.fwd[0] = -c.view[2]; c.fwd[1] = -c.view[6]; c.fwd[2] = -c.view[10];
}

/** Project every cloth vertex into world.screen (css x, css y, view depth). Called after physics. */
export function projectAll(world) {
  const cl = world.cloth; if (!cl) return;
  const p = cl.pos, s = world.screen, m = world.camera.viewProj, n = cl.n;
  const hw = world.width * 0.5, hh = world.height * 0.5;
  const m0 = m[0], m1 = m[1], m3 = m[3], m4 = m[4], m5 = m[5], m7 = m[7], m8 = m[8], m9 = m[9], m11 = m[11], m12 = m[12], m13 = m[13], m15 = m[15];
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const w = m3 * x + m7 * y + m11 * z + m15;
    const o = i * 3;
    if (w <= 1e-4) { s[o] = -1e5; s[o + 1] = -1e5; s[o + 2] = -1; continue; }
    const iw = 1 / w;
    s[o] = ((m0 * x + m4 * y + m8 * z + m12) * iw + 1) * hw;
    s[o + 1] = (1 - (m1 * x + m5 * y + m9 * z + m13) * iw) * hh;
    s[o + 2] = w;
  }
}

/** World point → screen (css x, css y, view depth) into out. */
export function project(world, x, y, z, out) {
  const m = world.camera.viewProj;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (w <= 1e-4) { out[0] = -1e5; out[1] = -1e5; out[2] = -1; return out; }
  out[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * world.width * 0.5;
  out[1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * world.height * 0.5;
  out[2] = w;
  return out;
}

/** Screen point (css px) at a given view depth → world point into out. */
export function unproject(world, sx, sy, depth, out) {
  const c = world.camera;
  const nx = (sx / world.width) * 2 - 1, ny = 1 - (sy / world.height) * 2;
  const ox = nx * c.tanHalf * c.aspect * depth, oy = ny * c.tanHalf * depth;
  out[0] = c.pos[0] + c.fwd[0] * depth + c.right[0] * ox + c.up[0] * oy;
  out[1] = c.pos[1] + c.fwd[1] * depth + c.right[1] * ox + c.up[1] * oy;
  out[2] = c.pos[2] + c.fwd[2] * depth + c.right[2] * ox + c.up[2] * oy;
  return out;
}

/** Screen point → world-space ray direction (unit) into out. Origin is world.camera.pos. */
export function screenRay(world, sx, sy, out) {
  unproject(world, sx, sy, 1, out);
  const c = world.camera.pos;
  out[0] -= c[0]; out[1] -= c[1]; out[2] -= c[2];
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}
