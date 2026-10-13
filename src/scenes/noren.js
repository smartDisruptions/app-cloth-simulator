// Noren 暖簾: a split indigo shop curtain in a machiya doorway at dusk. A paper lamp hangs inside; its light
// glows through the cloth, pours through the slits and spills the curtain's colours across a damp street.
import { resetLights, dim, lin, unit, framing, frame, flicker } from './util.js';

const WOOD = 0x3b2a1d, WOOD_D = 0x2a1d14, WOOD_L = 0x5a4130, PLASTER = 0xd8cfbd, PLASTER_IN = 0x9c7c58;
const STONE = 0x8f8b84, TILE = 0x3c3f46, LACQUER = 0x121010, PAPER = 0xf6e6c8;
const LAMP = [0.3, 2.32, -1.3];
const LAMP_COL = lin(0xffb36b, 13);
const AKA = [1.42, 1.98, 0.32];            // the red lantern's centre

// framings: portrait shows the eaves and the street; landscape the lattice either side
const PORTRAIT = framing([0, 1.6, 0.2], [0.08, -0.03, -1], 2.0, 3.6, 36, 1.02);
const LANDSCAPE = framing([0, 1.25, 0.3], [0.13, -0.09, -1], 3.3, 3.0, 34, 1.02);

function box(out, x0, y0, z0, x1, y1, z1, col, mat, o) { out.push({ type: 'box', min: [x0, y0, z0], max: [x1, y1, z1], col, mat, ...o }); }

function facade(P) {
  // the doorway: posts, lintel, threshold
  box(P, -1.03, 0, -0.15, -0.9, 2.9, 0.0, WOOD, 'wood');
  box(P, 0.9, 0, -0.15, 1.03, 2.9, 0.0, WOOD, 'wood');
  box(P, -1.03, 2.05, -0.16, 1.03, 2.21, 0.01, WOOD, 'wood');
  box(P, -1.08, 0, -0.16, 1.08, 0.1, 0.38, STONE, 'stone', { contact: 0.5, spread: 0.12 });
  // lattice (koshi) either side, with a lit paper screen behind
  for (const s of [-1, 1]) {
    const xa = s < 0 ? -3.7 : 1.03, xb = s < 0 ? -1.03 : 3.7;
    box(P, xa, 0, -0.16, xb, 0.2, 0.02, STONE, 'stone', { contact: 0.55, spread: 0.1 });
    box(P, xa, 0.2, -0.16, xb, 2.05, -0.12, PAPER, 'paper', { emi: 0x9a6a3a, group: 1, floorAO: false });
    box(P, xa, 0.2, -0.09, xb, 0.27, -0.01, WOOD, 'wood');
    box(P, xa, 1.98, -0.09, xb, 2.05, -0.01, WOOD, 'wood');
    box(P, xa, 1.02, -0.11, xb, 1.06, -0.08, WOOD_D, 'wood');
    for (let x = xa + 0.03; x < xb - 0.02; x += 0.056) box(P, x, 0.27, -0.065, x + 0.026, 1.98, -0.02, WOOD, 'wood', { floorAO: false });
    box(P, s * 3.55 - 0.08, 0, -0.18, s * 3.55 + 0.08, 4.9, 0.03, WOOD, 'wood');
  }
  // transom between the lintel and the eaves
  box(P, -3.7, 2.21, -0.12, 3.7, 2.98, -0.04, PLASTER, 'plaster', { ao: 0.35, floorAO: false });
  for (const s of [-1, 1]) box(P, s < 0 ? -3.7 : 1.03, 2.05, -0.13, s < 0 ? -1.03 : 3.7, 2.21, -0.02, WOOD_D, 'wood', { floorAO: false });
  box(P, -3.7, 2.21, -0.14, 3.7, 2.29, 0.02, WOOD, 'wood', { floorAO: false });
  box(P, -3.7, 2.62, -0.14, 3.7, 2.7, 0.0, WOOD_L, 'wood', { ao: 0.6, floorAO: false });
  // the eaves (hisashi): a sloped board, half-round tile rows, rafters below, a fascia
  const sl = Math.atan2(0.24, 0.86), ay = [0, Math.cos(sl), Math.sin(sl)];
  P.push({ type: 'box', c: [0, 2.9, 0.4], h: [3.75, 0.025, 0.46], ax: [1, 0, 0], ay, col: WOOD_D, mat: 'wood' });
  for (let x = -3.7; x <= 3.7; x += 0.16) P.push({ type: 'cyl', a: [x, 3.06, -0.04], b: [x, 2.82, 0.86], r: 0.05, seg: 7, col: TILE, mat: 'tile' });
  for (let x = -3.6; x <= 3.6; x += 0.3) box(P, x, 2.78, -0.02, x + 0.045, 2.84, 0.82, WOOD_D, 'wood');
  box(P, -3.75, 2.74, 0.82, 3.75, 2.86, 0.87, WOOD, 'wood');
  // upper storey: plaster with a slit window (mushiko-mado) glowing faintly
  box(P, -3.7, 2.98, -0.12, 3.7, 4.75, -0.02, PLASTER, 'plaster');
  box(P, -1.05, 3.42, -0.06, 1.05, 4.02, 0.0, 0x1a1410, 'plain', { emi: 0x2a1a0c, group: 1 });
  for (let x = -1.0; x <= 1.0; x += 0.105) box(P, x, 3.42, -0.04, x + 0.055, 4.02, 0.04, PLASTER, 'plaster');
  box(P, -1.1, 3.36, -0.05, 1.1, 3.42, 0.05, PLASTER, 'plaster');
  box(P, -1.1, 4.02, -0.05, 1.1, 4.08, 0.05, PLASTER, 'plaster');
  // the main roof edge
  const sl2 = Math.atan2(0.3, 1.0), ay2 = [0, Math.cos(sl2), Math.sin(sl2)];
  P.push({ type: 'box', c: [0, 4.88, 0.45], h: [3.9, 0.03, 0.55], ax: [1, 0, 0], ay: ay2, col: WOOD_D, mat: 'wood' });
  for (let x = -3.8; x <= 3.8; x += 0.17) P.push({ type: 'cyl', a: [x, 5.07, -0.08], b: [x, 4.76, 1.0], r: 0.055, seg: 7, col: TILE, mat: 'tile' });
  box(P, -3.9, 4.64, 0.96, 3.9, 4.8, 1.02, WOOD, 'wood');
  // a red lantern (akachochin) on a bracket right of the door
  const [kx, ky, kz] = AKA;
  box(P, 1.05, 2.3, -0.03, 1.09, 2.33, kz + 0.03, 0x1c1c1e, 'metal', { floorAO: false });
  box(P, kx - 0.01, 2.3, kz - 0.01, 1.09, 2.33, kz + 0.01, 0x1c1c1e, 'metal', { floorAO: false });
  P.push({ type: 'cyl', a: [kx, ky + 0.3, kz], b: [kx, 2.3, kz], r: 0.005, seg: 5, cap: false, col: 0x111111, floorAO: false });
  P.push({ type: 'cyl', a: [kx, ky + 0.25, kz], b: [kx, ky + 0.3, kz], r: 0.1, seg: 14, col: LACQUER, mat: 'lacquer', floorAO: false });
  P.push({ type: 'cyl', a: [kx, ky - 0.3, kz], b: [kx, ky - 0.25, kz], r: 0.1, seg: 14, col: LACQUER, mat: 'lacquer', floorAO: false });
  P.push({ type: 'lathe', c: [kx, ky, kz], prof: [[0.1, -0.25], [0.155, -0.17], [0.17, 0], [0.155, 0.17], [0.1, 0.25]], seg: 18, col: 0xc8402c, mat: 'paper', emi: 0xff5a30, group: 2, ribs: 22, cap: false, floorAO: false });
  // salt cones (morijio) on small dishes by the door
  for (const s of [-1, 1]) {
    P.push({ type: 'cyl', a: [s * 1.3, 0, 0.24], b: [s * 1.3, 0.018, 0.24], r: 0.075, col: 0xe9e4da, mat: 'lacquer' });
    P.push({ type: 'lathe', c: [s * 1.3, 0.018, 0.24], prof: [[0.05, 0], [0.034, 0.05], [0.004, 0.105]], seg: 14, col: 0xfaf8f2, mat: 'plaster' });
  }
}

function interior(P) {
  box(P, -2.0, 0, -2.8, 2.0, 2.75, -2.62, PLASTER_IN, 'plaster', { contact: 0.4 });
  box(P, -2.0, 0, -2.8, -1.85, 2.75, -0.16, PLASTER_IN, 'plaster');
  box(P, 1.85, 0, -2.8, 2.0, 2.75, -0.16, PLASTER_IN, 'plaster');
  box(P, -2.0, 2.6, -2.8, 2.0, 2.75, -0.16, WOOD_D, 'wood', { floorAO: false });
  for (let x = -1.7; x <= 1.7; x += 0.55) box(P, x, 2.5, -2.8, x + 0.08, 2.6, -0.16, WOOD, 'wood', { floorAO: false });
  // the back wall: posts and a rail, a dark doorway to the back room, a hanging scroll
  for (const x of [-1.85, -0.62, 0.62, 1.85]) box(P, x - 0.06, 0, -2.62, x + 0.06, 2.6, -2.5, WOOD, 'wood');
  box(P, -1.9, 1.86, -2.62, 1.9, 1.94, -2.5, WOOD, 'wood', { floorAO: false });
  box(P, -0.56, 0.42, -2.66, 0.56, 1.86, -2.6, 0x120c08, 'plain', { floorAO: false });
  box(P, -0.56, 1.25, -2.6, 0.56, 1.86, -2.58, 0x6a3a2a, 'fabric', { floorAO: false });
  box(P, -1.42, 0.75, -2.6, -1.02, 1.75, -2.58, 0xd8cbb0, 'paper', { floorAO: false });
  box(P, -1.36, 0.95, -2.59, -1.08, 1.55, -2.575, 0x3a3630, 'paper', { floorAO: false });
  // raised floor (agari-kamachi) and a counter with jars on a shelf
  box(P, -1.85, 0, -2.62, 1.85, 0.42, -1.75, WOOD_L, 'wood');
  box(P, -1.85, 0.36, -1.8, 1.85, 0.45, -1.7, WOOD, 'wood');
  box(P, -1.6, 1.25, -2.62, 1.6, 1.29, -2.4, WOOD, 'wood', { floorAO: false });
  const jars = [[-1.2, 0.11, 0x6b3b22], [-0.85, 0.08, 0x2c2c34], [-0.55, 0.1, 0x8a6a3a], [0.6, 0.12, 0x3a2a20], [0.95, 0.08, 0x6b3b22], [1.25, 0.09, 0x23303a]];
  for (const [x, r, c] of jars) P.push({ type: 'lathe', c: [x, 1.29, -2.5], prof: [[r * 0.6, 0], [r, r * 0.6], [r * 0.95, r * 1.6], [r * 0.45, r * 2.1], [r * 0.38, r * 2.3]], seg: 14, col: c, mat: 'lacquer' });
  // the lamp: a paper chochin on a cord
  const [lx, ly, lz] = LAMP;
  P.push({ type: 'cyl', a: [lx, ly + 0.2, lz], b: [lx, 2.6, lz], r: 0.006, col: 0x1a1410, seg: 5, cap: false });
  P.push({ type: 'cyl', a: [lx, ly + 0.15, lz], b: [lx, ly + 0.2, lz], r: 0.07, col: LACQUER, mat: 'lacquer' });
  P.push({ type: 'cyl', a: [lx, ly - 0.2, lz], b: [lx, ly - 0.15, lz], r: 0.07, col: LACQUER, mat: 'lacquer' });
  P.push({ type: 'lathe', c: [lx, ly, lz], prof: [[0.075, -0.15], [0.125, -0.1], [0.14, 0], [0.125, 0.1], [0.075, 0.15]], seg: 18, col: PAPER, mat: 'paper', emi: 0xffc070, group: 1, ribs: 26, cap: false, floorAO: false });
}

export default {
  id: 'noren', name: 'Noren', kanji: '暖簾', blurb: 'A shop curtain at dusk with the lamps lit behind it.',
  print: 'noren',
  // the app opens here, in still air (Josh, 2026-10-13): the curtain hangs at rest until you touch it
  defaults: { material: 'cotton', tool: 'grab', wind: 0, rain: false },
  // with the wind on, a breeze running along the street, a little out of the shop: the panels sway and ripple
  // rather than fly
  // (face-on, even a 2.8 m/s breeze outweighs light cotton three to one)
  windDir: [1, 0, 0.25],
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    L.keyDir.set(unit([-0.35, 0.8, 0.55])); L.keyCol.set(lin(0x8fa0ff, 0.3));
    L.sky.set(lin(0x6a78b8, 0.3)); L.ground.set(lin(0x5a4030, 0.1));
    L.pointPos.set(LAMP); L.pointCol.set(LAMP_COL);
    L.shadow.type = 'point'; L.shadow.pos.set(LAMP); L.shadow.dir.set(unit([-0.12, -0.5, 1]));
    L.fogCol.set(lin(0x2a2c4a, 0.6)); L.fogDensity = 0.03; L.exposure = 1.3;

    // three panels split by narrow slits; the print runs across all three (u = k/3 … (k+1)/3)
    const panels = 3, W = 0.56, H = 1.24, gap = 0.014, top = 1.99, z = 0.07;
    const cols = dim(16, res, 6), rows = dim(36, res, 12);
    for (let k = 0; k < panels; k++) {
      const x0 = -((panels * W + (panels - 1) * gap) / 2) + k * (W + gap);
      b.grid({ name: 'panel' + k, cols, rows, origin: [x0, top, z], u: [W, 0, 0], v: [0, -H, 0], uv: [k / panels, 0, (k + 1) / panels, 1], pin: (c, r) => r === 0 });
    }
    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    C.capsules.push({ ax: -0.965, ay: 0, az: -0.07, bx: -0.965, by: 2.1, bz: -0.07, r: 0.075 });
    C.capsules.push({ ax: 0.965, ay: 0, az: -0.07, bx: 0.965, by: 2.1, bz: -0.07, r: 0.075 });
    C.capsules.push({ ax: -1.1, ay: top + 0.02, az: z, bx: 1.1, by: top + 0.02, bz: z, r: 0.018 });
    frame(world, PORTRAIT, LANDSCAPE);

    const props = [];
    // the rod the curtain hangs from (noren-bō), on two iron hooks
    props.push({ type: 'cyl', a: [-1.12, top + 0.02, z], b: [1.12, top + 0.02, z], r: 0.017, col: 0x6a4a2c, mat: 'bamboo', floorAO: false });
    for (const s of [-1, 1]) props.push({ type: 'box', min: [s * 1.06 - 0.012, top, -0.01], max: [s * 1.06 + 0.012, top + 0.07, z + 0.02], col: 0x1c1c1e, mat: 'metal', floorAO: false });
    facade(props);
    interior(props);
    this.env = {
      sky: {
        zenith: 0x121a3f, mid: 0x3e3a6c, midAt: 0.35, horizon: 0x8d6a86, haze: 0x5e5578, nadir: 0x2a2840, curve: 0.5, hazeAmt: 0.5, hazeK: 9,
        clouds: { cover: 0.58, soft: 0.22, scale: 0.35, stretch: 3.2, drift: [0.004, 0.001], lit: 0xe8a0a0, shade: 0x4a4a78, opacity: 0.8, k: 0.9 },
        stars: 0.5,
      },
      floor: { y: 0, kind: 'pavers', a: 0x6e6b6a, b: 0x4d4b50, joint: 0x1e1c1c, scale: 1, bump: 0.16, fade: 12, horizon: 20, wet: 0.6, rainWet: 0.5, puddles: 0.6 },
      props,
      aoRect: [-4.5, -3.5, 9, 9],
      ao: [{ x: 0, z: -0.12, r: 3.6, k: 0.25, s: 0.35, sx: 0.08 }],
      wear: [{ x: 0, z: 0.9, rx: 0.9, rz: 1.0, k: 0.16 }],
      // the eaves keep a strip of street dry; the shop is roofed
      shelter: [{ x0: -3.8, z0: -3.5, x1: 3.8, z1: 0.8, soft: 0.22 }],
      aperture: { z: -0.075, x0: -0.9, x1: 0.9, y0: -1, y1: 2.05 },
      lamp2: { pos: AKA, col: 0xff6a3a, k: 0.45 },
      emiK: 0.5,
    };
    this.env.gains = new Float32Array([1, 1, 1, 1]);
  },
  update(world) {
    frame(world, PORTRAIT, LANDSCAPE);
    const f = flicker(world.time, 1.7, 0.06, 6);
    const c = world.lights.pointCol;
    c[0] = LAMP_COL[0] * f; c[1] = LAMP_COL[1] * f; c[2] = LAMP_COL[2] * f;
    this.env.gains[1] = f;
    this.env.gains[2] = flicker(world.time, 4.4, 0.05, 4);
  },
};
