// Embers 火の粉: a dyer's courtyard at night. One dyed cloth hangs to dry on a bamboo pole; a paper lantern
// hangs in front of it, so the cloth's shadow (and every hole you burn) lands on the white plaster of the
// storehouse wall behind. Charred timber below the plaster, a tiled cap, a pine and a crescent moon above,
// fireflies in the dark. The cloth wants a match.
import { resetLights, dim, lin, unit, framing, frame, flicker, boneRotate } from './util.js';
import { noise3 } from '../core/noise.js';

const WALL_Z = -1.6;   // far enough back that the cloth billows in the air, close enough to take its shadow
const LANTERN = [-1.22, 1.78, 0.62];     // the paper lantern's centre (the point light)
const HOOK = [-1.22, 2.42, 0.62];        // where it hangs from (bone pivot)
const LANTERN_COL = lin(0xffaa62, 3.6);
const M0 = new Float32Array(16);
const PORTRAIT = framing([-0.15, 1.42, 0.05], [-0.14, -0.1, -1], 2.6, 3.05, 38, 1.03);
const LANDSCAPE = framing([-0.2, 1.62, -0.05], [-0.16, -0.06, -1], 3.7, 3.35, 36, 1.03);
const lpos = new Float32Array(3);
let swing = 0;

function wall(P) {
  // charred cedar boards below, plaster above, a tiled cap
  P.push({ type: 'box', min: [-4.5, 0, WALL_Z - 0.3], max: [4.5, 0.95, WALL_Z], col: 0x1a1612, mat: 'wood', contact: 0.6 });
  for (let x = -4.4; x < 4.5; x += 0.24) P.push({ type: 'box', min: [x, 0.02, WALL_Z], max: [x + 0.012, 0.95, WALL_Z + 0.012], col: 0x0e0c0a, mat: 'wood', floorAO: false });
  P.push({ type: 'box', min: [-4.5, 0.95, WALL_Z - 0.3], max: [4.5, 0.99, WALL_Z + 0.02], col: 0x2a2018, mat: 'wood', floorAO: false });
  P.push({ type: 'box', min: [-4.5, 0.99, WALL_Z - 0.3], max: [4.5, 2.78, WALL_Z - 0.01], col: 0xc9c1b2, mat: 'plaster', floorAO: false });
  const sl = Math.atan2(0.1, 0.42);
  P.push({ type: 'box', c: [0, 2.86, WALL_Z - 0.15], h: [4.6, 0.04, 0.3], ax: [1, 0, 0], ay: [0, Math.cos(sl), Math.sin(sl)], col: 0x262626, mat: 'tile', floorAO: false });
  for (let x = -4.5; x <= 4.5; x += 0.17) P.push({ type: 'cyl', a: [x, 2.98, WALL_Z - 0.38], b: [x, 2.84, WALL_Z + 0.16], r: 0.045, seg: 6, col: 0x2e3034, mat: 'tile', floorAO: false });
  P.push({ type: 'cyl', a: [-4.6, 3.0, WALL_Z - 0.25], b: [4.6, 3.0, WALL_Z - 0.25], r: 0.06, seg: 8, col: 0x2a2c30, mat: 'tile', floorAO: false });
}

function pine(P, x, z) {
  // a black pine: a leaning trunk and layered, horizontal cloud-pads of needles
  P.push({ type: 'cyl', a: [x, 0, z], b: [x + 0.35, 2.4, z], r: 0.16, r2: 0.11, seg: 8, col: 0x2a201a, mat: 'wood' });
  P.push({ type: 'cyl', a: [x + 0.35, 2.4, z], b: [x - 0.25, 3.9, z + 0.1], r: 0.11, r2: 0.06, seg: 8, col: 0x2a201a, mat: 'wood', floorAO: false });
  P.push({ type: 'cyl', a: [x + 0.3, 2.9, z], b: [x + 1.3, 3.25, z + 0.2], r: 0.06, r2: 0.03, seg: 6, col: 0x2a201a, mat: 'wood', floorAO: false });
  const pads = [[1.25, 3.25, 0.7], [0.8, 3.35, 0.55], [-0.6, 3.05, 0.6], [-0.2, 3.6, 0.55], [0.35, 3.75, 0.6], [-0.5, 4.05, 0.5], [0.05, 4.2, 0.42], [1.6, 3.15, 0.4], [-1.0, 3.2, 0.38]];
  for (const [dx, y, r] of pads) P.push({ type: 'sphere', c: [x + dx, y, z + (dx * 0.3) % 0.25], r, sy: 0.32, seg: 12, col: 0x16241a, mat: 'stone', floorAO: false, shadow: false });
}

export default {
  id: 'embers', name: 'Embers', kanji: '火の粉', blurb: 'Night, one lantern, and a cloth that wants a match.',
  print: 'embers',
  defaults: { material: 'cotton', tool: 'burn', wind: 0, rain: false }, // still night air: the cloth hangs ready and the fire's own plume moves it
  windDir: [0.5, 0, -0.87],   // mostly into the cloth's face: rain drives onto it (and hisses on a burn)
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    L.keyDir.set(unit([0.45, 0.62, -0.65])); L.keyCol.set(lin(0x8ea4d8, 0.34));
    L.sky.set(lin(0x34406a, 0.2)); L.ground.set(lin(0x1c1814, 0.05));
    L.pointPos.set(LANTERN); L.pointCol.set(LANTERN_COL);
    L.shadow.type = 'point'; L.shadow.pos.set(LANTERN); L.shadow.dir.set(unit([0.62, -0.22, -1]));
    L.fogCol.set(lin(0x0c1020)); L.fogDensity = 0.035; L.exposure = 1.2;
    swing = 0;

    const W = 1.55, H = 1.85, top = 2.32;
    const cols = dim(34, res, 10), rows = dim(40, res, 12);
    // pegged to the pole every few threads: the top edge scallops between pegs
    b.grid({ name: 'cloth', cols, rows, origin: [-W / 2, top, 0], u: [W, 0, 0], v: [0, -H, 0], pin: (c, r) => r === 0 && (c % 3 === 0 || c === cols - 1) });
    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    C.planes.push({ nx: 0, ny: 0, nz: 1, d: -WALL_Z - 0.02 });
    C.capsules.push({ ax: -1.0, ay: 0, az: 0, bx: -1.0, by: 2.5, bz: 0, r: 0.06 });
    C.capsules.push({ ax: 1.0, ay: 0, az: 0, bx: 1.0, by: 2.5, bz: 0, r: 0.06 });
    C.capsules.push({ ax: -1.1, ay: top + 0.03, az: 0, bx: 1.1, by: top + 0.03, bz: 0, r: 0.025 });
    frame(world, PORTRAIT, LANDSCAPE);

    const props = [];
    // drying frame: two posts and a bamboo pole
    for (const x of [-1.0, 1.0]) {
      props.push({ type: 'box', min: [x - 0.045, 0, -0.045], max: [x + 0.045, 2.5, 0.045], col: 0x3a2a1c, mat: 'wood' });
      props.push({ type: 'box', min: [x - 0.09, 0, -0.09], max: [x + 0.09, 0.08, 0.09], col: 0x4a443c, mat: 'stone' });
    }
    props.push({ type: 'cyl', a: [-1.25, top + 0.03, 0], b: [1.25, top + 0.03, 0], r: 0.022, seg: 8, col: 0x8a7a48, mat: 'bamboo', floorAO: false });
    // the lantern: an iron bracket on the left post, a cord, a paper chochin (bone 1 swings it)
    props.push({ type: 'box', min: [-1.24, 2.4, -0.02], max: [-1.2, 2.44, 0.66], col: 0x1a1a1c, mat: 'metal', floorAO: false });
    props.push({ type: 'box', min: [-1.2, 2.4, -0.02], max: [-1.0, 2.44, 0.02], col: 0x1a1a1c, mat: 'metal', floorAO: false });
    const [lx, ly, lz] = LANTERN;
    props.push({ type: 'cyl', a: [lx, ly + 0.24, lz], b: [lx, HOOK[1], lz], r: 0.005, seg: 5, cap: false, col: 0x111111, bone: 1, floorAO: false });
    props.push({ type: 'cyl', a: [lx, ly + 0.2, lz], b: [lx, ly + 0.25, lz], r: 0.085, seg: 14, col: 0x0e0d0c, mat: 'lacquer', bone: 1, floorAO: false });
    props.push({ type: 'cyl', a: [lx, ly - 0.25, lz], b: [lx, ly - 0.2, lz], r: 0.085, seg: 14, col: 0x0e0d0c, mat: 'lacquer', bone: 1, floorAO: false });
    props.push({ type: 'lathe', c: [lx, ly, lz], prof: [[0.09, -0.2], [0.15, -0.13], [0.17, 0], [0.15, 0.13], [0.09, 0.2]], seg: 18, cap: false, col: 0xf0d8b0, mat: 'paper', emi: 0xffa050, group: 1, ribs: 24, bone: 1, floorAO: false });
    wall(props);
    pine(props, -3.0, -2.4);
    // a stone water basin with a bamboo spout, front right
    props.push({ type: 'lathe', c: [1.42, 0, 0.55], col: 0x55504a, mat: 'stone', seg: 18, prof: [[0.22, 0], [0.27, 0.1], [0.28, 0.26], [0.25, 0.31], [0.18, 0.31], [0.16, 0.26]] });
    props.push({ type: 'cyl', a: [1.9, 0.56, 0.44], b: [1.52, 0.45, 0.52], r: 0.022, seg: 7, col: 0x7a6a40, mat: 'bamboo', floorAO: false });
    props.push({ type: 'box', min: [1.86, 0, 0.39], max: [1.95, 0.6, 0.48], col: 0x3a2a1c, mat: 'wood' });
    this.env = {
      sky: {
        zenith: 0x060814, horizon: 0x1a2038, haze: 0x141a2c, nadir: 0x0a0c14, curve: 0.5, hazeAmt: 0.6, hazeK: 10,
        moon: { dir: unit([-0.05, 0.2, -1]), col: 0xf1e3c0, k: 2.2, r: 0.024, phase: [0.62, 0.12], glow: 1.2 },
        stars: 1.0,
        clouds: { cover: 0.62, soft: 0.25, scale: 0.3, stretch: 3, drift: [0.004, 0.0], lit: 0x3a4466, shade: 0x0c1020, opacity: 0.6, k: 1 },
        glow: { k: 0.5, halo: 2 },
      },
      floor: { y: 0, kind: 'pavers', a: 0x4a4644, b: 0x34322f, joint: 0x121110, scale: 1.25, bump: 0.14, fade: 10, horizon: 18, wet: 0.12, rainWet: 0.7, puddles: 0.3 },
      props,
      aoRect: [-4, -3, 8, 8],
      ao: [{ x: 0, z: WALL_Z + 0.05, r: 4.5, k: 0.35, s: 0.3, sx: 0.06 }],
      emiK: 0.6,
    };
    this.env.gains = new Float32Array([1, 1, 1, 1]);
  },
  update(world, dt) {
    frame(world, PORTRAIT, LANDSCAPE);
    // the lantern swings a little with the wind; its light (and the cloth's shadow) swing with it
    const W = world.wind, t = world.time;
    const target = Math.max(-0.35, Math.min(0.35, (W.x * 0.05 + noise3(t * 0.8, 2.2, 0) * (0.03 + 0.012 * W.speed) * (0.4 + W.gust))));
    swing += (target - swing) * Math.min(1, dt * 2.5);
    const B = this.env.bones, m = B ? B[0] : M0;   // (no bones in a Node test harness: swing a scratch matrix)
    boneRotate(m, HOOK[0], HOOK[1], HOOK[2], 0, 0, 1, -swing);
    const ox = LANTERN[0], oy = LANTERN[1], oz = LANTERN[2];
    lpos[0] = m[0] * ox + m[4] * oy + m[8] * oz + m[12];
    lpos[1] = m[1] * ox + m[5] * oy + m[9] * oz + m[13];
    lpos[2] = m[2] * ox + m[6] * oy + m[10] * oz + m[14];
    const L = world.lights;
    L.pointPos[0] = lpos[0]; L.pointPos[1] = lpos[1]; L.pointPos[2] = lpos[2];
    L.shadow.pos[0] = lpos[0]; L.shadow.pos[1] = lpos[1]; L.shadow.pos[2] = lpos[2];
    const f = flicker(t, 3.3, 0.09, 8);
    L.pointCol[0] = LANTERN_COL[0] * f; L.pointCol[1] = LANTERN_COL[1] * f; L.pointCol[2] = LANTERN_COL[2] * f;
    this.env.gains[1] = f;
  },
};
