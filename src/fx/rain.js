// Rain: drops that fall through the visible scene, slanted by the wind, and land ON the cloth.
//
// Each frame it rains, the cloth is rasterised into a coarse voxel grid ("which cells hold cloth, and
// which vertex"). Every new drop gets its own straight path — terminal speed, slanted by the local,
// gusty wind it falls through — and a 3-D DDA march along that path finds the first cell holding cloth.
// That height becomes the drop's kill height (aux); a drop that finds no cloth falls to the floor. So
// drops hit the top of a tarp and the windward face of a hanging cloth, and the lee stays dry.
//
// late() (after particles.update) resolves this frame's landings (events.rainLand): a drop that met
// the cloth adds water there (fx/wet.js), knocks the cloth a little, splashes (more on standing water),
// hisses into steam if the cloth is hot, and pushes events.rainHit; a drop that met the floor splashes.
// When the particle pool is full (a big fire), drops that can't get a particle still fall "virtually":
// they are queued and land on schedule, so rain keeps soaking — and quenching — whatever the budget.
import { PK } from '../core/world.js';
import { rand } from '../core/rng.js';
import { spawn } from '../render/particles.js';
import { deposit, setDropMass, surfaceWater } from './wet.js';

const FLUX = 0.055;       // kg/m²/s on a level surface in full rain (a monsoon downpour, for drama)
const VT = 7.4;           // terminal speed of a drop, m/s
const FOLLOW = 0.92;      // drops move sideways with ~92% of the wind they fall through
const JITTER = 0.35;      // m/s of extra random sideways speed per drop (no two streaks parallel)
const MAX_SLANT = 1.5;    // never flatter than ~56°
const KNOCK = 0.32;       // m/s a drop knocks a (dry) vertex along its path
const VCAP = 65536;       // voxels at most
const DIM = 56;           // per axis at most

// ---- voxel occupancy (rebuilt each frame while raining)
const vStamp = new Int32Array(VCAP), vVert = new Int32Array(VCAP);
let stamp = 0, gx0 = 0, gy0 = 0, gz0 = 0, cs = 0.1, ics = 10, nx = 0, ny = 0, nz = 0, gridOK = false;
let cellMin = 0.1;
let floorY = 0, carry = 0, kgDrop = 0.003;
// the rain box: where drops cross the cloth's mid-height, and the spawn height
// (in the camera's ground frame: a along its right axis, b along its forward axis, around the cloth centre)
let bA0 = -2, bA1 = 2, bB0 = -1, bB1 = 1, bcx = 0, bcz = 0, brx = 1, brz = 0, bfx = 0, bfz = -1, yMid = 1, ySpawn = 4;
const wv = new Float32Array(3);
// march result
let hitV = -1, hitY = 0;
// virtual drops (no particle available): land on schedule
const QN = 256;
const qT = new Float64Array(QN), qX = new Float32Array(QN), qY = new Float32Array(QN), qZ = new Float32Array(QN);
const qDX = new Float32Array(QN), qDY = new Float32Array(QN), qDZ = new Float32Array(QN);
let qHead = 0, qCount = 0, simT = 0;

export function init() {}

export function onScene(world) {
  const cl = world.cloth;
  // a cell must be at least a thread long or rain would slip between the vertices
  let s = 0, k = 0;
  for (let j = 0; j < cl.m; j++) if (cl.kind[j] === 0) { s += cl.rest[j]; k++; }
  cellMin = Math.max(0.03, (k ? s / k : 0.08) * 1.15);
  floorY = -Infinity;
  const P = world.colliders.planes;
  for (let i = 0; i < P.length; i++) { const p = P[i]; if (p.ny > 0.7) { const h = -p.d / p.ny; if (h > floorY) floorY = h; } }
  if (floorY === -Infinity) floorY = 0;
  carry = 0; gridOK = false; qCount = 0;
  world.rain.intensity = world.toggles.rain ? 1 : 0;   // a scene that opens in the rain is already raining
}

/**
 * The rain volume: a band around the cloth in the camera's ground frame — as wide as the view at the
 * cloth's depth, from a little behind the cloth to a little in front of it (where floor splashes show).
 * Rain beyond that is invisible at this drop budget, so it isn't simulated.
 */
function rainBox(world) {
  const cam = world.camera, cp = cam.pos, t = cam.target;
  const b = world.cloth.bounds, hasB = b.max[0] > b.min[0];
  const cx = hasB ? (b.min[0] + b.max[0]) * 0.5 : t[0], cz = hasB ? (b.min[2] + b.max[2]) * 0.5 : t[2];
  yMid = hasB ? (b.min[1] + b.max[1]) * 0.5 : t[1];
  // ground-plane camera frame
  let fx = cam.fwd[0], fz = cam.fwd[2]; const fl = Math.hypot(fx, fz);
  if (fl > 1e-3) { fx /= fl; fz /= fl; } else { fx = 0; fz = -1; }
  bfx = fx; bfz = fz; brx = -fz; brz = fx;
  bcx = cx; bcz = cz;
  const ex = (cx - cp[0]) * fx + (cz - cp[2]) * fz;            // how far ahead of the camera the cloth is
  const span = hasB ? Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) : 2;
  const hw = Math.max(span * 0.5 + 0.5, Math.max(1, ex) * cam.tanHalf * cam.aspect * 1.15);
  bA0 = -Math.min(hw, 4.5); bA1 = Math.min(hw, 4.5);
  const depth = hasB ? Math.abs((b.max[0] - b.min[0]) * fx) + Math.abs((b.max[2] - b.min[2]) * fz) : 1;
  bB1 = depth * 0.5 + 1.0;                                       // behind the cloth
  bB0 = -Math.max(0.3, Math.min(depth * 0.5 + 1.8, ex - 1.4));   // in front of it, never on the lens
  const top = Math.max(hasB ? b.max[1] : t[1], t[1] + cam.dist * cam.tanHalf);
  ySpawn = Math.max(top + 0.6, cp[1] + 0.3);
}

/** Rasterise the cloth into the voxel grid (stamped, so nothing is cleared). */
function buildGrid(world) {
  const cl = world.cloth, p = cl.pos, vTri = cl.vTri, n = cl.n, alias = cl.alias;
  let ax = Infinity, ay = Infinity, az = Infinity, bx = -Infinity, by = -Infinity, bz = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!vTri[i]) continue;
    const o = i * 3, x = p[o], y = p[o + 1], z = p[o + 2];
    if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; if (z < az) az = z; if (z > bz) bz = z;
  }
  if (!(ax < Infinity)) { gridOK = false; return; }
  let c = cellMin;
  for (;;) {
    nx = ((bx - ax) / c | 0) + 3; ny = ((by - ay) / c | 0) + 3; nz = ((bz - az) / c | 0) + 3;
    if (nx <= DIM && ny <= DIM && nz <= DIM && nx * ny * nz <= VCAP) break;
    c *= 1.25;
  }
  cs = c; ics = 1 / c;
  gx0 = ax - c; gy0 = ay - c; gz0 = az - c;
  stamp++;
  if (stamp > 2e9) { stamp = 1; vStamp.fill(0); }
  for (let i = 0; i < n; i++) {
    if (!vTri[i]) continue;
    const o = i * 3, y = p[o + 1];
    const ix = ((p[o] - gx0) * ics) | 0, iy = ((y - gy0) * ics) | 0, iz = ((p[o + 2] - gz0) * ics) | 0;
    const v = (iz * ny + iy) * nx + ix;
    const m = alias[i] >= 0 ? alias[i] : i;
    if (vStamp[v] !== stamp) { vStamp[v] = stamp; vVert[v] = m; }
    else if (y > p[vVert[v] * 3 + 1]) vVert[v] = m;
  }
  gridOK = true;
}

/**
 * March a straight drop path from (x, y, z) along (dx, dy, dz) (unit, dy < 0) through the voxel grid.
 * Sets hitV (master vertex or -1) and hitY (where it meets the cloth).
 */
function march(cl, x, y, z, dx, dy, dz) {
  hitV = -1;
  if (!gridOK) return;
  // slab test against the grid box
  const ex = gx0 + nx * cs, ey = gy0 + ny * cs, ez = gz0 + nz * cs;
  let t0 = 0, t1 = 1e9;
  if (Math.abs(dx) > 1e-9) { let a = (gx0 - x) / dx, b = (ex - x) / dx; if (a > b) { const s = a; a = b; b = s; } if (a > t0) t0 = a; if (b < t1) t1 = b; } else if (x < gx0 || x > ex) return;
  { let a = (gy0 - y) / dy, b = (ey - y) / dy; if (a > b) { const s = a; a = b; b = s; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
  if (Math.abs(dz) > 1e-9) { let a = (gz0 - z) / dz, b = (ez - z) / dz; if (a > b) { const s = a; a = b; b = s; } if (a > t0) t0 = a; if (b < t1) t1 = b; } else if (z < gz0 || z > ez) return;
  if (t0 > t1) return;
  const t = t0 + 1e-5;
  const px = x + dx * t, py = y + dy * t, pz = z + dz * t;
  let ix = ((px - gx0) * ics) | 0, iy = ((py - gy0) * ics) | 0, iz = ((pz - gz0) * ics) | 0;
  if (ix < 0) ix = 0; else if (ix >= nx) ix = nx - 1;
  if (iy < 0) iy = 0; else if (iy >= ny) iy = ny - 1;
  if (iz < 0) iz = 0; else if (iz >= nz) iz = nz - 1;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const ddx = Math.abs(dx) > 1e-9 ? cs / Math.abs(dx) : 1e9, ddy = cs / -dy, ddz = Math.abs(dz) > 1e-9 ? cs / Math.abs(dz) : 1e9;
  let tx = Math.abs(dx) > 1e-9 ? ((gx0 + (ix + (dx > 0 ? 1 : 0)) * cs) - x) / dx : 1e9;
  let ty = ((gy0 + iy * cs) - y) / dy;
  let tz = Math.abs(dz) > 1e-9 ? ((gz0 + (iz + (dz > 0 ? 1 : 0)) * cs) - z) / dz : 1e9;
  let tc = t0;
  for (let k = nx + ny + nz + 3; k > 0; k--) {
    const v = (iz * ny + iy) * nx + ix;
    if (vStamp[v] === stamp) {
      const vert = vVert[v], vy = cl.pos[vert * 3 + 1], ye = y + dy * tc;
      hitV = vert;
      // fall on through the cell to the cloth itself, never past the cell's floor
      hitY = vy < ye ? (vy > ye - cs ? vy : ye - cs) : ye;
      return;
    }
    if (tx < ty && tx < tz) { tc = tx; ix += sx; if (ix < 0 || ix >= nx) return; tx += ddx; }
    else if (ty < tz) { tc = ty; iy -= 1; if (iy < 0) return; ty += ddy; }
    else { tc = tz; iz += sz; if (iz < 0 || iz >= nz) return; tz += ddz; }
  }
}

/** Which cloth vertex is at (x, y, z) now (the drop's landing point), or -1. */
function vertexAt(cl, x, y, z) {
  if (!gridOK) return -1;
  const ix = Math.floor((x - gx0) * ics), iy = Math.floor((y - gy0) * ics), iz = Math.floor((z - gz0) * ics);
  let best = -1, bd = Infinity;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const X = ix + c, Y = iy + a, Z = iz + b;
    if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
    const v = (Z * ny + Y) * nx + X;
    if (vStamp[v] !== stamp) continue;
    const o = vVert[v] * 3, ex = cl.pos[o] - x, ey = cl.pos[o + 1] - y, ez = cl.pos[o + 2] - z, d = ex * ex + ey * ey + ez * ez;
    if (d < bd) { bd = d; best = vVert[v]; }
  }
  return bd < cs * cs * 4 ? best : -1;
}

export function update(world, dt) {
  // intensity eases in over a couple of seconds and tails off a little faster
  const target = world.toggles.rain ? 1 : 0;
  const I0 = world.rain.intensity;
  if (dt > 0) { world.rain.intensity = I0 + (target - I0) * (1 - Math.exp(-dt * (target > I0 ? 0.7 : 1.1))); simT += dt; }
  const I = world.rain.intensity;
  if (I < 0.004) { if (target === 0) world.rain.intensity = 0; if (qCount === 0) gridOK = false; return; }
  if (dt <= 0 || !world.cloth) return;
  const cl = world.cloth, W = world.wind;
  rainBox(world);
  buildGrid(world);
  // drops: q.rain per second at full rain; each carries an equal share of the water flux
  const rate = world.q.rain * world.q.particleScale;
  const area = (bA1 - bA0) * (bB1 - bB0);
  kgDrop = (FLUX * area) / Math.max(1, rate);
  setDropMass(kgDrop);
  carry += rate * I * dt;
  if (carry > 40) carry = 40;
  let full = false;
  while (carry >= 1) {
    carry -= 1;
    // where the drop crosses the cloth's height, and the gusty wind it falls through there
    const a = bA0 + rand() * (bA1 - bA0), bb = bB0 + rand() * (bB1 - bB0);
    const xc = bcx + brx * a + bfx * bb, zc = bcz + brz * a + bfz * bb;
    W.sample(xc, yMid, zc, wv);
    const v = VT * (0.9 + 0.2 * rand());
    let hx = wv[0] * FOLLOW + (rand() - 0.5) * JITTER * 2, hz = wv[2] * FOLLOW + (rand() - 0.5) * JITTER * 2;
    const sl = Math.hypot(hx, hz) / v; if (sl > MAX_SLANT) { hx *= MAX_SLANT / sl; hz *= MAX_SLANT / sl; }
    const y0 = ySpawn + rand() * v * dt;        // spread within the frame: no sheet of drops
    const back = (y0 - yMid) / v;
    const x0 = xc - hx * back, z0 = zc - hz * back;
    const L = Math.hypot(hx, v, hz), dx = hx / L, dy = -v / L, dz = hz / L;
    march(cl, x0, y0, z0, dx, dy, dz);
    const aux = hitV >= 0 ? hitY : floorY;
    if (y0 < aux + 0.05) continue;
    const life = ((y0 - aux) / v) * 1.6 + 0.4;   // long enough even if particles.js lets it fall slower
    if (!full && spawn(world, PK.RAIN, x0, y0, z0, hx, -v, hz, 0.009 + 0.004 * rand(), life, aux)) continue;
    full = true;
    // no particle to spare: the drop still falls and lands (on the cloth only; the floor needs no water)
    if (hitV >= 0 && qCount < QN) {
      const k = (qHead + qCount) % QN, tl = (y0 - aux) / v;
      qT[k] = simT + tl; qX[k] = x0 + hx * tl; qY[k] = aux; qZ[k] = z0 + hz * tl; qDX[k] = dx; qDY[k] = dy; qDZ[k] = dz;
      qCount++;
    }
  }
}

/** After particles.update: resolve this frame's landed drops (and any virtual ones now due). */
export function late(world) {
  const cl = world.cloth; if (!cl) return;
  const ev = world.events.rainLand, I = world.rain.intensity;
  const splashN = world.q.particles >= 2600 ? 3 : world.q.particles >= 1400 ? 2 : 1;
  if (ev.n) {
    const d = ev.data;
    for (let k = 0; k < ev.n; k++) {
      const o = k * 4, x = d[o], y = d[o + 1], z = d[o + 2];
      if (y < floorY + 0.04) { hitFloor(world, x, y, z, splashN); continue; }
      const v = vertexAt(cl, x, y, z);
      if (v >= 0) {
        // the drop's direction isn't in the event: rain falls mostly down, slanted with the wind
        const W = world.wind, hx = W.x * FOLLOW, hz = W.z * FOLLOW, L = Math.hypot(hx, VT, hz);
        hitCloth(world, cl, v, x, y, z, hx / L, -VT / L, hz / L, splashN, I, true);
      }
    }
  }
  while (qCount > 0 && qT[qHead] <= simT) {
    const k = qHead; qHead = (qHead + 1) % QN; qCount--;
    const v = vertexAt(cl, qX[k], qY[k], qZ[k]);
    if (v >= 0) hitCloth(world, cl, v, qX[k], qY[k], qZ[k], qDX[k], qDY[k], qDZ[k], splashN, I, false);
  }
}

function hitCloth(world, cl, v, x, y, z, ddx, ddy, ddz, splashN, I, visible) {
  const vo = v * 3;
  // a drop on hot cloth flashes to steam (and still cools it: the rest soaks in)
  let kg = kgDrop;
  const heat = cl.heat[v];
  if (heat > 0.2) {
    const flash = kg * Math.min(0.75, heat);
    kg -= flash;
    if (rand() < 0.6) spawn(world, PK.STEAM, x, y + 0.03, z, (rand() - 0.5) * 0.3, 0.5 + rand() * 0.4, (rand() - 0.5) * 0.3, 0.05 + rand() * 0.04, 0.6 + rand() * 0.5, 0);
    world.events.steam.push(x, y, z, flash);
  }
  // the face it lands on: the front if the normal looks back at the drop
  const face = cl.normal[vo] * ddx + cl.normal[vo + 1] * ddy + cl.normal[vo + 2] * ddz > 0 ? -1 : 1;
  deposit(world, v, kg, face);
  // the drop's momentum: a small knock along its path (heavier, wetter cloth barely moves)
  if (!cl.pinned[v] && !cl.grabbed[v]) {
    const k = KNOCK / Math.max(1, cl.massScale[v]);
    cl.vel[vo] += ddx * k; cl.vel[vo + 1] += ddy * k; cl.vel[vo + 2] += ddz * k;
  }
  world.events.rainHit.push(x, y, z, I);
  if (!visible) return;
  // splash: off the face the drop hit, more of it on standing water
  let nx = cl.normal[vo], ny = cl.normal[vo + 1], nz = cl.normal[vo + 2];
  if (nx * ddx + ny * ddy + nz * ddz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  const pooled = surfaceWater(v) > kgDrop;
  const m = pooled ? splashN + 1 : splashN;
  // a drop into standing water on up-facing cloth throws a crown ring (particles draws it for aux = 1)
  const ring = pooled && ny > 0.8 ? 1 : 0;
  for (let s = 0; s < m; s++) {
    const up = 0.5 + rand() * (pooled ? 1.3 : 0.8), tj = 0.45;
    if (!spawn(world, PK.SPLASH, x + nx * 0.01, y + ny * 0.01, z + nz * 0.01,
      nx * up + (rand() - 0.5) * tj + ddx * 0.4, ny * up + (rand() - 0.5) * tj * 0.5, nz * up + (rand() - 0.5) * tj + ddz * 0.4,
      0.006 + rand() * 0.005, 0.2 + rand() * 0.15, s === 0 ? ring : 0)) break;
  }
}

function hitFloor(world, x, y, z, splashN) {
  for (let s = 0; s < splashN; s++) {
    if (!spawn(world, PK.SPLASH, x, y + 0.01, z, (rand() - 0.5) * 0.7, 0.7 + rand() * 0.9, (rand() - 0.5) * 0.7, 0.006 + rand() * 0.005, 0.22 + rand() * 0.12, 0)) break;
  }
}
