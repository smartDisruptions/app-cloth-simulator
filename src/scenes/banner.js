// Banner 幟: a row of nobori whipping in a gale at the end of the day. The sun sits on the horizon behind
// them, so the silk glows and their shadows run long across the dry grass toward you. Three hill lines fade
// into the haze. Each banner hangs from a crossbar and is tied to its pole by loops (every third vertex),
// so the free edge and the tail whip.
import { resetLights, dim, lin, unit, framing, frame } from './util.js';
import { noise3 } from '../core/noise.js';

// pole x, pole z, banner width, banner height, crossbar height, cols, rows
const NOBORI = [
  { x: -0.55, z: 0.0, w: 0.66, h: 2.7, top: 3.75, cols: 16, rows: 52 },
  { x: 1.05, z: -2.4, w: 0.6, h: 2.45, top: 3.45, cols: 12, rows: 38 },
  { x: 2.55, z: -4.9, w: 0.56, h: 2.3, top: 3.25, cols: 10, rows: 30 },
];
const SUN = unit([0.035, 0.075, -1]);
// a few birds crossing the sunset: start azimuth, elevation, size, speed (rad/s), wingbeat (Hz)
const BIRDS = [[0.2, 0.19, 0.0075, -0.012, 2.6], [0.25, 0.205, 0.006, -0.0125, 2.9], [0.17, 0.215, 0.0055, -0.0118, 3.1], [0.28, 0.18, 0.005, -0.013, 2.7]];

const PORTRAIT = framing([0.1, 2.25, -0.4], [0.06, 0.14, -1], 2.3, 4.9, 40, 1.03);
const LANDSCAPE = framing([0.85, 2.05, -1.1], [0.1, 0.1, -1], 5.2, 3.5, 38, 1.04);

export default {
  id: 'banner', name: 'Banner', kanji: '幟', blurb: 'A row of banners in a gale at the end of the day.',
  print: 'banner',
  defaults: { material: 'silk', tool: 'grab', wind: 2, rain: false },
  windDir: [0.82, 0, 0.55],
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    L.keyDir.set(SUN); L.keyCol.set(lin(0xffa45c, 3.4));
    L.sky.set(lin(0x8a74b0, 0.42)); L.ground.set(lin(0x6a4a32, 0.16));
    L.shadow.type = 'dir'; L.shadow.dir.set([-SUN[0], -SUN[1], -SUN[2]]);
    const aim = [0.2, 1.4, -1.0];
    L.shadow.pos.set([aim[0] + SUN[0] * 10, aim[1] + SUN[1] * 10, aim[2] + SUN[2] * 10]);
    L.fogCol.set(lin(0xd88a62, 0.85)); L.fogDensity = 0.014; L.exposure = 1.05;

    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    const props = [], casters = [];
    NOBORI.forEach((n, k) => {
      const cols = dim(n.cols, res, 6), rows = dim(n.rows, res, 12);
      const x0 = n.x + 0.05;
      b.grid({ name: 'nobori' + k, cols, rows, origin: [x0, n.top, n.z], u: [n.w, 0, 0], v: [0, -n.h, 0],
        pin: (c, r) => r === 0 || (c === 0 && r % 3 === 0 && r < rows - 2) });
      C.capsules.push({ ax: n.x, ay: 0, az: n.z, bx: n.x, by: n.top + 0.5, bz: n.z, r: 0.04 });
      // bamboo pole with nodes, the crossbar, a stone foot
      props.push({ type: 'cyl', a: [n.x, 0, n.z], b: [n.x, n.top + 0.45, n.z], r: 0.032, r2: 0.022, seg: 9, col: 0x8a7a4a, mat: 'bamboo' });
      for (let y = 0.6; y < n.top; y += 0.55) props.push({ type: 'cyl', a: [n.x, y, n.z], b: [n.x, y + 0.025, n.z], r: 0.036, seg: 9, col: 0x6a5a34, mat: 'bamboo', floorAO: false });
      props.push({ type: 'cyl', a: [n.x - 0.02, n.top + 0.015, n.z], b: [x0 + n.w + 0.05, n.top + 0.015, n.z], r: 0.012, seg: 6, col: 0x7a6a40, mat: 'bamboo', floorAO: false });
      props.push({ type: 'cyl', a: [n.x, 0, n.z], b: [n.x, 0.22, n.z], r: 0.11, r2: 0.09, seg: 10, col: 0x4a4440, mat: 'stone', contact: 0.6 });
      casters.push([n.x, n.z, n.top + 0.45, 0.035]);
    });
    frame(world, PORTRAIT, LANDSCAPE);
    this.env = {
      sky: {
        zenith: 0x161a4c, mid: 0x6e4670, midAt: 0.6, horizon: 0xf4923e, haze: 0xf2a066, nadir: 0x5a3a40, curve: 0.55, hazeAmt: 0.75, hazeK: 26,
        sun: { dir: SUN, col: 0xffb070, k: 2.4, r: 0.042, pow: 300, tight: 1.6, wide: 0.28 },
        clouds: { cover: 0.66, soft: 0.16, scale: 0.42, stretch: 4.5, drift: [0.03, 0.002], lit: 0xd06a4a, shade: 0x2a1e3c, opacity: 0.8, silver: 1.6, k: 0.85 },
        hills: [
          { y: 0.045, amp: 0.07, freq: 1.6, col: 0x7a4e6e, haze: 0.55, row: 0.21, rim: 0.25 },
          { y: 0.024, amp: 0.05, freq: 3.1, col: 0x45284a, haze: 0.3, row: 0.55, rim: 0.3, bump: 0.002, bumpFreq: 90, bumpSharp: 2 },
          { y: 0.008, amp: 0.022, freq: 5.5, col: 0x22162a, haze: 0.08, row: 0.83, rim: 0.0, bump: 0.004, bumpFreq: 160, bumpSharp: 3 },
        ],
        glow: { k: 0.9, halo: 3.5 },
        birds: BIRDS.length, birdCol: 0x1e1220,
      },
      floor: { y: 0, kind: 'grass', a: 0x5e4a26, b: 0x3a2c18, scale: 1, bump: 0.06, fade: 16, horizon: 30, rainWet: 0.25, ripples: false },
      reflect: false,
      props,
      casters,
      aoRect: [-4, -6, 9, 9],
      emiK: 0.5,
    };
    this.env.birdPos = new Float32Array(BIRDS.length * 4);
  },
  update(world) {
    frame(world, PORTRAIT, LANDSCAPE);
    // the birds drift right to left across the sky, wrapping round, bobbing as they beat their wings
    const t = world.time, P = this.env.birdPos;
    for (let i = 0; i < BIRDS.length; i++) {
      const b = BIRDS[i];
      let az = b[0] + b[3] * t; az = ((az + 0.6) % 1.2 + 1.2) % 1.2 - 0.6;
      P[i * 4] = az; P[i * 4 + 1] = b[1] + noise3(t * 0.3, i * 2.3, 0) * 0.012; P[i * 4 + 2] = b[2]; P[i * 4 + 3] = t * b[4] * 6.283;
    }
  },
};
