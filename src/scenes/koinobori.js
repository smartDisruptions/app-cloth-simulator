// Koinobori 鯉のぼり: carp streamers on a tall pole on a spring afternoon. A five-colour fukinagashi, the
// black father carp (magoi), the red mother (higoi) and the small blue child (kogoi) ride on mouth rings
// clipped to the halyard; the rings swivel downwind, droop when the wind drops and bob in the gusts, so the
// carp swim. At the top the arrow wheels (yaguruma) spin on a yoke that turns into the wind.
//
// Print layout (render/prints.js 'koinobori'): four horizontal bands of the one canvas, mouth at the top of
// each band (v0) and tail at the bottom (v1); u wraps the body, u = 0/1 the back, 0.25 and 0.75 the flanks
// (eyes), 0.5 the belly.   v 0–.25 magoi · .25–.5 higoi · .5–.75 kogoi · .75–1 fukinagashi (5 stripes in u).
import { resetLights, dim, lin, unit, framing, frame, boneRotate, boneMul, boneApply } from './util.js';
import { noise3 } from '../core/noise.js';

const PX = -1.55, PZ = -0.35, TOP = 6.4;           // the pole
const HALYARD = 0.07;                               // rope offset from the pole axis
// name, mouth height, mouth radius, length, segs, rings, uv band, print band
const CARP = [
  { name: 'fukinagashi', y: 5.75, r: 0.2, len: 2.1, segs: 12, rings: 24, v: [0.75, 1.0], shape: 'streamer' },
  { name: 'magoi', y: 5.0, r: 0.3, len: 2.5, segs: 18, rings: 30, v: [0.0, 0.25], shape: 'carp' },
  { name: 'higoi', y: 4.2, r: 0.25, len: 2.05, segs: 16, rings: 26, v: [0.25, 0.5], shape: 'carp' },
  { name: 'kogoi', y: 3.5, r: 0.19, len: 1.55, segs: 14, rings: 20, v: [0.5, 0.75], shape: 'carp' },
];

const radiusFn = (c) => (c.shape === 'streamer'
  ? (t) => c.r * (1 - 0.25 * t)
  : (t) => c.r * (1 + 0.14 * Math.sin(Math.PI * Math.min(1, t * 1.25)) - 0.6 * Math.pow(t, 1.4) + 0.38 * Math.max(0, (t - 0.82) / 0.18) ** 2));

const PORTRAIT = framing([PX + 1.25, 3.7, -0.3], [0.12, 0.22, -1], 3.4, 7.4, 40, 1.03);
const LANDSCAPE = framing([PX + 1.55, 4.75, -0.3], [0.1, 0.14, -1], 4.9, 4.1, 38, 1.04);

// per-frame state (no allocation in update)
const st = { heading: 0, droop: 0, spinA: 0, spinB: 0, mouths: [], t: 0, lean: 0, pole: null };
const M1 = new Float32Array(16), M2 = new Float32Array(16), SW = new Float32Array(16), YW = new Float32Array(16), q3 = new Float32Array(3);

function yaguruma(P) {
  const hy = TOP - 0.08;                       // the axle height
  // the yoke (bone 3 turns it into the wind): built facing +x
  P.push({ type: 'box', c: [PX, hy, PZ], h: [0.2, 0.012, 0.012], col: 0xc8962e, mat: 'gold', bone: 3, floorAO: false });
  P.push({ type: 'box', c: [PX - 0.26, hy, PZ], h: [0.07, 0.035, 0.004], col: 0xc8962e, mat: 'gold', bone: 3, floorAO: false });
  // two arrow wheels on the axle, at ±0.13 along it (bones 1 and 2 spin them)
  for (const [k, ox] of [[1, 0.13], [2, 0.2]]) {
    const cx = PX + ox;
    P.push({ type: 'cyl', a: [cx - 0.02, hy, PZ], b: [cx + 0.02, hy, PZ], r: 0.03, seg: 10, col: 0xb8862a, mat: 'gold', bone: k, floorAO: false });
    for (let i = 0; i < 8; i++) {
      const g = (i / 8) * Math.PI * 2 + (k === 2 ? Math.PI / 8 : 0), cy = Math.cos(g), cz = Math.sin(g);
      const ay = [0, cy, cz];
      P.push({ type: 'box', c: [cx, hy + cy * 0.16, PZ + cz * 0.16], h: [0.004, 0.15, 0.006], ax: [1, 0, 0], ay, col: 0xe8e2d4, mat: 'lacquer', bone: k, floorAO: false });
      // the fletching: a vane tilted like a pinwheel blade
      const tilt = k === 1 ? 0.6 : -0.6;
      P.push({ type: 'box', c: [cx, hy + cy * 0.28, PZ + cz * 0.28], h: [0.05, 0.06, 0.003], ax: [Math.cos(tilt), -cz * Math.sin(tilt), cy * Math.sin(tilt)], ay, col: i % 2 ? 0xe2412a : 0xf4efe4, mat: 'paper', bone: k, floorAO: false });
    }
  }
  // the turning ball (kaiten-kyu) on top
  P.push({ type: 'cyl', a: [PX, TOP, PZ], b: [PX, TOP + 0.12, PZ], r: 0.012, col: 0xc8962e, mat: 'gold', floorAO: false });
  P.push({ type: 'sphere', c: [PX, TOP + 0.2, PZ], r: 0.085, seg: 16, col: 0xd9a63a, mat: 'gold', floorAO: false });
}

function sakura(P, x, z, s, seed) {
  const wood = { col: 0x3a2a24, mat: 'wood' };
  P.push({ type: 'cyl', a: [x, 0, z], b: [x + 0.15 * s, 1.4 * s, z + 0.05], r: 0.13 * s, r2: 0.09 * s, seg: 9, ...wood });
  P.push({ type: 'cyl', a: [x + 0.15 * s, 1.4 * s, z + 0.05], b: [x - 0.6 * s, 2.3 * s, z], r: 0.07 * s, r2: 0.035 * s, seg: 7, ...wood, floorAO: false });
  P.push({ type: 'cyl', a: [x + 0.15 * s, 1.4 * s, z + 0.05], b: [x + 0.85 * s, 2.25 * s, z - 0.1], r: 0.07 * s, r2: 0.035 * s, seg: 7, ...wood, floorAO: false });
  P.push({ type: 'cyl', a: [x + 0.1 * s, 1.9 * s, z], b: [x + 0.2 * s, 2.8 * s, z + 0.2], r: 0.05 * s, r2: 0.025 * s, seg: 6, ...wood, floorAO: false });
  let q = seed;
  const rnd = () => { q = (q * 16807) % 2147483647; return q / 2147483647; };
  // a dome of blossom: many small clusters, denser at the crown, a little translucent against the sun
  const pinks = [0xf8c8d4, 0xf4b6c6, 0xfbdde5, 0xefa8bc, 0xfff0f3];
  for (let i = 0; i < 58; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()), up = rnd();
    const cx = x + Math.cos(a) * rr * 1.35 * s, cz = z + Math.sin(a) * rr * 1.0 * s;
    const cy = (2.15 + up * 0.75 + (1 - rr * rr) * 0.55) * s;
    P.push({ type: 'sphere', c: [cx, cy, cz], r: (0.17 + rnd() * 0.14) * s, sy: 0.8, seg: 8, col: pinks[i % 5], mat: 'blossom', emi: 0x4a2430, floorAO: false, shadow: false });
  }
}

export default {
  id: 'koinobori', name: 'Koinobori', kanji: '鯉のぼり', blurb: 'Carp streamers that swim when the wind fills them.',
  print: 'koinobori',
  defaults: { material: 'silk', tool: 'grab', wind: 2, rain: false },
  windDir: [1, 0, 0.22],
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    const sun = unit([-0.42, 0.62, -0.66]);
    L.keyDir.set(sun); L.keyCol.set(lin(0xfff1dc, 3.1));
    L.sky.set(lin(0x9cc0ea, 0.85)); L.ground.set(lin(0x7a9a52, 0.38));
    L.shadow.type = 'dir'; L.shadow.dir.set([-sun[0], -sun[1], -sun[2]]);
    const aim = [PX + 1.3, 4.3, PZ];
    L.shadow.pos.set([aim[0] + sun[0] * 9, aim[1] + sun[1] * 9, aim[2] + sun[2] * 9]);
    L.fogCol.set(lin(0xcfe0ee, 0.95)); L.fogDensity = 0.006; L.exposure = 1.0;

    // the carp, each a tube from its mouth ring (pinned, animated) downwind
    const h = Math.atan2(-this.windDir[2], this.windDir[0]);
    st.heading = h; st.droop = 0.15; st.spinA = st.spinB = 0; st.mouths.length = 0;
    const ax = Math.cos(h), az = -Math.sin(h);
    for (const c of CARP) {
      const cx = PX + ax * (HALYARD + c.r), cz = PZ + az * (HALYARD + c.r);
      const segs = dim(c.segs, res, 8), rings = dim(c.rings, res, 8);
      const piece = b.tube({ name: c.name, segs, rings, origin: [cx, c.y, cz], axis: [ax * c.len, -0.12 * c.len, az * c.len], side: [0, 1, 0], radius: radiusFn(c), uv: [0, c.v[0], 1, c.v[1]], pin: (s, r) => r === 0 });
      // the ring's angles never change: keep their cos/sin, and the first master index
      const cs = new Float32Array(segs), sn = new Float32Array(segs);
      for (let q = 0; q < segs; q++) { cs[q] = Math.cos((q / segs) * Math.PI * 2); sn[q] = Math.sin((q / segs) * Math.PI * 2); }
      st.mouths.push({ c, start: piece.id(0, 0), segs, cs, sn });
    }
    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    st.pole = { ax: PX, ay: 0, az: PZ, bx: PX, by: TOP, bz: PZ, r: 0.05 };
    C.capsules.push(st.pole);
    st.lean = 0;
    frame(world, PORTRAIT, LANDSCAPE);

    const props = [];
    props.push({ type: 'cyl', a: [PX, 0.3, PZ], b: [PX, TOP, PZ], r: 0.072, r2: 0.04, seg: 14, col: 0xece6d8, mat: 'lacquer', bone: 3 });
    props.push({ type: 'cyl', a: [PX, 0, PZ], b: [PX, 0.32, PZ], r: 0.075, seg: 14, col: 0xece6d8, mat: 'lacquer' });
    props.push({ type: 'cyl', a: [PX, 0, PZ], b: [PX, 0.35, PZ], r: 0.12, r2: 0.1, seg: 14, col: 0x5a5650, mat: 'stone' });
    props.push({ type: 'cyl', a: [PX + HALYARD * 0.7, 0.4, PZ + 0.02], b: [PX + HALYARD * 0.7, TOP - 0.15, PZ + 0.02], r: 0.006, seg: 5, cap: false, col: 0xf0ebe0, mat: 'rope', floorAO: false, bone: 3 });
    yaguruma(props);
    sakura(props, 5.4, -7.0, 1.0, 7);
    sakura(props, -6.2, -8.5, 1.15, 19);
    sakura(props, 1.9, -12.5, 0.95, 31);
    this.env = {
      sky: {
        zenith: 0x2a62c4, mid: 0x6a9ad8, midAt: 0.32, horizon: 0xbcd6ec, haze: 0xd2e2ee, curve: 0.45, hazeAmt: 0.55, hazeK: 24,
        sun: { dir: sun, col: 0xfff2d8, k: 1.4, r: 0.028, pow: 900, tight: 1.2, wide: 0.25 },
        clouds: { cover: 0.56, soft: 0.13, scale: 0.26, stretch: 1.4, drift: [0.012, 0.004], lit: 0xffffff, shade: 0xa8b4c8, opacity: 0.95, silver: 1.1, k: 1.15 },
        hills: [
          { y: 0.035, amp: 0.05, freq: 2.2, col: 0x7d9cbc, haze: 0.62, row: 0.11 },
          { y: 0.02, amp: 0.04, freq: 3.5, col: 0x4f7452, haze: 0.55, bump: 0.008, bumpFreq: 60, bumpSharp: 2, row: 0.47 },
        ],
        glow: { k: 0.6, halo: 3 },
      },
      floor: { y: 0, kind: 'grass', a: 0x6f9a3e, b: 0x4d7a2e, scale: 1, bump: 0.05, fade: 18, horizon: 32, cloudShadow: true, rainWet: 0.25, ripples: false },
      reflect: false,
      props,
      aoRect: [-6, -7, 12, 12],
      emiK: 0.5,
    };
    this.env.gains = new Float32Array([1, 1, 1, 1]);
  },
  update(world, dt) {
    frame(world, PORTRAIT, LANDSCAPE);
    const W = world.wind, cl = world.cloth;
    st.t += dt;
    // heading follows the wind (smoothed); light wind lets the carp droop
    const sp = Math.hypot(W.x, W.z);
    if (sp > 0.3) {
      const target = Math.atan2(-W.z, W.x);
      let d = target - st.heading; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      st.heading += d * Math.min(1, dt * 1.6);
    }
    const droopT = 1.25 - 1.1 * Math.min(1, sp / 6);
    st.droop += (droopT - st.droop) * Math.min(1, dt * 1.2);
    const wob = noise3(st.t * 0.6, 4.2, 0) * 0.16 * Math.min(1, sp / 3);
    const h = st.heading + wob;
    const hx = Math.cos(h), hz = -Math.sin(h);
    // the pole leans downwind with the gusts (about 8 cm at the top in a gale), pivoting at its foot
    const leanT = Math.min(0.016, sp * 0.0016) * (0.7 + 0.3 * noise3(st.t * 1.7, 9.1, 3));
    st.lean += (leanT - st.lean) * Math.min(1, dt * 3);
    boneRotate(SW, PX, 0, PZ, hz, 0, -hx, st.lean);
    boneApply(q3, SW, PX, TOP, PZ);
    st.pole.bx = q3[0]; st.pole.by = q3[1]; st.pole.bz = q3[2];
    // each mouth ring: centre beside the halyard, axis downwind and drooping, bobbing a little
    for (let k = 0; k < st.mouths.length; k++) {
      const M = st.mouths[k], c = M.c, segs = M.segs, cs = M.cs, sn = M.sn, start = M.start;
      const dr = st.droop + noise3(st.t * 0.9, k * 3.1, 1) * 0.12 * Math.min(1, sp / 3);
      const cd = Math.cos(dr), sd = Math.sin(dr);
      const nx = hx * cd, ny = -sd, nz = hz * cd;             // the body axis
      // ring basis: side = up made perpendicular to the axis, w = axis × side
      let sx = -ny * nx, sy = 1 - ny * ny, sz = -ny * nz;
      const sl = Math.hypot(sx, sy, sz) || 1; sx /= sl; sy /= sl; sz /= sl;
      const wx = ny * sz - nz * sy, wy = nz * sx - nx * sz, wz = nx * sy - ny * sx;
      const bob = noise3(st.t * 1.3, k * 1.7, 2) * 0.03;
      const ox = PX + hx * (HALYARD + c.r * cd), oy = c.y + bob - c.r * sd * 0.5, oz = PZ + hz * (HALYARD + c.r * cd);
      for (let s = 0; s < segs; s++) {
        const ca = cs[s], sa = sn[s], o = (start + s) * 3;
        boneApply(q3, SW, ox + (sx * ca + wx * sa) * c.r, oy + (sy * ca + wy * sa) * c.r, oz + (sz * ca + wz * sa) * c.r);
        cl.anchor[o] = q3[0]; cl.anchor[o + 1] = q3[1]; cl.anchor[o + 2] = q3[2];
      }
    }
    // the yaguruma: the yoke turns into the wind, the wheels spin with it (opposite ways)
    const spin = Math.min(14, W.speed * 1.6 + 0.2);
    st.spinA += spin * dt; st.spinB -= spin * 0.85 * dt;
    const B = this.env.bones;
    if (!B) return;   // the props are drawn by render/env.js; a Node test harness never builds them
    boneRotate(YW, PX, 0, PZ, 0, 1, 0, h);
    boneMul(B[2], SW, YW);
    boneRotate(M1, PX + 0.13, TOP - 0.08, PZ, 1, 0, 0, st.spinA);
    boneMul(B[0], B[2], M1);
    boneRotate(M2, PX + 0.2, TOP - 0.08, PZ, 1, 0, 0, st.spinB);
    boneMul(B[1], B[2], M2);
  },
};
