// Monsoon 梅雨: a canvas tarp strung between four posts in the rainy season, a barrel and a crate sheltering
// under it, bamboo fading into the mist. The tarp is cut a little larger than the posts' spacing and its
// edges are tied along taut ropes, so it hangs as a dish: rain gathers in the middle, and when the pool is
// full it spills over the low front-left corner.
// The ground is wet earth; its puddles mirror the tarp, the posts and the sky, and ripple with every drop.
import { resetLights, dim, lin, unit, framing, frame, flicker } from './util.js';

const PW = 2.1, PD = 1.5;                 // post spacing (x, z)
const RW = 2.17, RD = 1.6;                // the tarp's own size: 3.5% and 6.7% slack, the arc of a 0.25 m dish
// post heights: back-left, back-right, front-left (the low corner the pool overflows from), front-right
const H = { bl: 1.92, br: 1.92, fl: 1.66, fr: 1.78 };
// QA 2026-10-13: steeper than first built (−0.5 → −0.8) so you look INTO the dish and see the pool form
const PORTRAIT = framing([0.05, 1.1, 0.05], [0.34, -0.8, -1], 3.0, 3.2, 40, 1.03);
const LANDSCAPE = framing([0.1, 1.05, -0.05], [0.4, -0.66, -1], 4.6, 2.7, 38, 1.03);
const st = { piece: null, cols: 0, rows: 0 };
const LAMP = [0.86, 1.36, 0.62];          // a paper lantern hung from the front-right post, under the tarp
const LAMP_COL = lin(0xffa860, 2.6);

const postTop = (sx, sz) => [sx * PW / 2, sz < 0 ? (sx < 0 ? H.bl : H.br) : (sx < 0 ? H.fl : H.fr), sz * PD / 2];
/** The rope height around the edge at grid fractions (s across x, t across z): bilinear between the posts. */
const edgeY = (s, t) => (H.bl * (1 - s) + H.br * s) * (1 - t) + (H.fl * (1 - s) + H.fr * s) * t;

export default {
  id: 'monsoon', name: 'Monsoon', kanji: '梅雨', blurb: 'A tarp in the rainy season, slowly filling with rain.',
  // the picker card: grey-green mist with the lantern's warm glow (the UI's built-in one is blue-grey)
  ui: { gradient: 'radial-gradient(26px 22px at calc(100% - 46px) 58px, rgba(255,200,130,.75), rgba(255,170,90,0) 100%), radial-gradient(120% 70% at 50% 110%, rgba(64,74,58,.9) 0%, rgba(64,74,58,0) 70%), linear-gradient(180deg, #5d6c67 0%, #8a9a93 55%, #aebbb5 100%)' },
  print: 'monsoon',
  defaults: { material: 'cotton', tool: 'grab', wind: 1, rain: true },
  windDir: [0.7, 0, 0.4],
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    const key = unit([0.3, 1, 0.25]);
    L.keyDir.set(key); L.keyCol.set(lin(0xd8e2dc, 1.05));
    L.sky.set(lin(0xa8bab4, 0.72)); L.ground.set(lin(0x485244, 0.22));
    L.shadow.type = 'dir'; L.shadow.dir.set([-key[0], -key[1], -key[2]]);
    const aim = [0, 1.3, 0];
    L.shadow.pos.set([aim[0] + key[0] * 8, aim[1] + key[1] * 8, aim[2] + key[2] * 8]);
    L.pointPos.set(LAMP); L.pointCol.set(LAMP_COL);
    L.fogCol.set(lin(0x92a09a, 0.8)); L.fogDensity = 0.05; L.exposure = 0.95;

    const cols = dim(40, res, 12), rows = dim(30, res, 10);
    st.cols = cols; st.rows = rows;
    // tied around its whole edge: every sixth grommet to a taut rope between the posts, so the middle is the
    // lowest point and rain pools there
    st.piece = b.grid({ name: 'tarp', cols, rows, origin: [-RW / 2, H.bl, -RD / 2], u: [RW, 0, 0], v: [0, 0, RD],
      pin: (c, r) => ((r === 0 || r === rows - 1) && (c % 6 === 0 || c === cols - 1)) || ((c === 0 || c === cols - 1) && (r % 6 === 0 || r === rows - 1)) });
    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = postTop(sx, sz);
      C.capsules.push({ ax: p[0], ay: 0, az: p[2], bx: p[0], by: p[1] - 0.04, bz: p[2], r: 0.05 });
    }
    // what shelters under the tarp: a barrel and a crate
    C.capsules.push({ ax: -0.35, ay: 0, az: -0.15, bx: -0.35, by: 0.62, bz: -0.15, r: 0.25 });
    C.capsules.push({ ax: 0.38, ay: 0.2, az: 0.18, bx: 0.38, by: 0.2, bz: 0.18, r: 0.22 });
    frame(world, PORTRAIT, LANDSCAPE);

    const props = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = postTop(sx, sz);
      props.push({ type: 'box', c: [p[0], p[1] / 2 + 0.02, p[2]], h: [0.045, p[1] / 2 + 0.02, 0.045], rotY: 0.2 * sx * sz, col: 0x5a4a38, mat: 'wood' });
      // a guy rope out to a stake
      const gx = p[0] + sx * 0.75, gz = p[2] + sz * 0.6;
      props.push({ type: 'cyl', a: [p[0], p[1] - 0.02, p[2]], b: [gx, 0.1, gz], r: 0.006, seg: 5, cap: false, col: 0xc8b890, mat: 'rope', floorAO: false });
      props.push({ type: 'box', c: [gx, 0.08, gz], h: [0.02, 0.1, 0.02], col: 0x4a3a28, mat: 'wood' });
    }
    // the ropes the edges are tied to
    for (const [p, q] of [[postTop(-1, -1), postTop(1, -1)], [postTop(-1, 1), postTop(1, 1)], [postTop(-1, -1), postTop(-1, 1)], [postTop(1, -1), postTop(1, 1)]]) {
      props.push({ type: 'cyl', a: [p[0], p[1] - 0.01, p[2]], b: [q[0], q[1] - 0.01, q[2]], r: 0.007, seg: 5, cap: false, col: 0xc8b890, mat: 'rope', floorAO: false });
    }
    props.push({ type: 'lathe', c: [-0.35, 0, -0.15], col: 0x6a4a30, mat: 'wood', seg: 16, prof: [[0.21, 0], [0.24, 0.12], [0.255, 0.31], [0.24, 0.5], [0.21, 0.62]] });
    props.push({ type: 'cyl', a: [-0.35, 0.14, -0.15], b: [-0.35, 0.17, -0.15], r: 0.243, seg: 16, col: 0x2a2a2c, mat: 'metal', floorAO: false });
    props.push({ type: 'cyl', a: [-0.35, 0.46, -0.15], b: [-0.35, 0.49, -0.15], r: 0.243, seg: 16, col: 0x2a2a2c, mat: 'metal', floorAO: false });
    props.push({ type: 'box', c: [0.4, 0.17, 0.2], h: [0.25, 0.17, 0.19], rotY: 0.35, col: 0x8a7050, mat: 'wood' });
    // bamboo standing in the mist, with nodes
    let q = 11;
    const rnd = () => { q = (q * 16807) % 2147483647; return q / 2147483647; };
    for (let i = 0; i < 26; i++) {
      const side = i % 2 ? 1 : -1, x = side * (2.2 + rnd() * 2.2), z = -1.2 - rnd() * 3.6, h = 4.2 + rnd() * 1.8, r = 0.028 + rnd() * 0.02;
      const lean = (rnd() - 0.5) * 0.4;
      props.push({ type: 'cyl', a: [x, 0, z], b: [x + lean, h, z], r, r2: r * 0.7, seg: 6, col: [0x5f7f4a, 0x6a8a52, 0x56744a][i % 3], mat: 'bamboo', contact: 0.35, spread: 0.12 });
      for (let y = 0.35 + rnd() * 0.2; y < 2.6; y += 0.42) props.push({ type: 'cyl', a: [x + lean * y / h, y, z], b: [x + lean * (y + 0.02) / h, y + 0.02, z], r: r * 1.15, seg: 6, col: 0x4a6038, mat: 'bamboo', floorAO: false });
    }
    // the lantern on its hook
    const [lx, ly, lz] = LAMP;
    props.push({ type: 'box', min: [lx - 0.01, 1.72, lz - 0.01], max: [1.06, 1.74, lz + 0.01], col: 0x1c1c1e, mat: 'metal', floorAO: false });
    props.push({ type: 'cyl', a: [lx, ly + 0.16, lz], b: [lx, 1.72, lz], r: 0.004, seg: 4, cap: false, col: 0x111111, floorAO: false });
    props.push({ type: 'cyl', a: [lx, ly + 0.13, lz], b: [lx, ly + 0.165, lz], r: 0.06, seg: 12, col: 0x0e0d0c, mat: 'lacquer', floorAO: false });
    props.push({ type: 'cyl', a: [lx, ly - 0.165, lz], b: [lx, ly - 0.13, lz], r: 0.06, seg: 12, col: 0x0e0d0c, mat: 'lacquer', floorAO: false });
    props.push({ type: 'lathe', c: [lx, ly, lz], prof: [[0.065, -0.13], [0.1, -0.085], [0.112, 0], [0.1, 0.085], [0.065, 0.13]], seg: 16, cap: false, col: 0xf0d8b0, mat: 'paper', emi: 0xffa860, group: 1, ribs: 30, floorAO: false });
    // a few stones half sunk in the mud
    for (const [x, z, r] of [[1.6, 0.9, 0.16], [-1.5, 1.1, 0.12], [1.9, -0.6, 0.1], [-0.9, 1.6, 0.09]]) {
      props.push({ type: 'sphere', c: [x, 0.0, z], r, sy: 0.55, seg: 10, col: 0x5a5a56, mat: 'stone' });
    }
    this.env = {
      sky: {
        zenith: 0x75847f, horizon: 0xb7c4be, haze: 0xa9b8b2, nadir: 0x6a7672, curve: 0.6, hazeAmt: 0.95, hazeK: 9,
        clouds: { cover: 0.42, soft: 0.42, scale: 0.4, stretch: 1.6, drift: [0.02, 0.008], lit: 0xc4cec9, shade: 0x5e6a66, opacity: 0.85, silver: 0, k: 1 },
        hills: [
          { y: 0.04, amp: 0.035, freq: 3.0, col: 0x7e8e86, haze: 0.85, row: 0.3, bump: 0.035, bumpFreq: 220, bumpSharp: 6 },
          { y: 0.025, amp: 0.03, freq: 5.0, col: 0x5c6e62, haze: 0.6, row: 0.62, bump: 0.05, bumpFreq: 160, bumpSharp: 8 },
        ],
      },
      floor: { y: 0, kind: 'earth', a: 0x4e4a3c, b: 0x3a382e, scale: 1, bump: 0.08, fade: 12, horizon: 14, wet: 0.55, rainWet: 0.4, puddles: 0.62 },
      props,
      aoRect: [-4, -4, 8, 8],
      ao: [{ x: 0, z: 0, r: 0.9, k: 0.25, s: 0.6, sx: 1.3 }],
      puddles: [{ x: -0.1, z: 0.12, rx: 0.32, rz: 0.26, k: 0.45 }, { x: -1.15, z: 0.88, rx: 0.5, rz: 0.4, k: 0.5 }, { x: 0.9, z: 1.3, rx: 0.7, rz: 0.35, k: 0.25 }],
      // dry under the tarp, except where it drips from its lowest point
      shelter: [{ x0: -1.0, z0: -0.7, x1: 1.0, z1: 0.7, soft: 0.35 }],
      drips: [{ x: -0.1, z: 0.12, r: 0.32 }],
      emiK: 0.55,
    };
    this.env.gains = new Float32Array([1, 1, 1, 1]);
  },
  afterBuild(world) {
    // pre-sag the tarp into its dish so the first frame doesn't jolt: corners and ties go to the posts and
    // ropes, the rest hangs as a smooth bowl below them
    const cl = world.cloth, { piece, cols, rows } = st;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const s = c / (cols - 1), t = r / (rows - 1), i = piece.id(c, r), o = i * 3;
      const x = (s - 0.5) * PW, z = (t - 0.5) * PD;
      const yEdge = edgeY(s, t);
      // a gentle membrane dish, 0.25 m deep in the middle (its arc matches the rest size both ways); the
      // water's weight deepens it as it fills
      const sag = 0.25 * Math.sin(Math.PI * t) * Math.sin(Math.PI * s);
      const y = yEdge - sag;
      cl.pos[o] = x; cl.pos[o + 1] = y; cl.pos[o + 2] = z;
      cl.prev[o] = x; cl.prev[o + 1] = y; cl.prev[o + 2] = z;
      cl.anchor[o] = x; cl.anchor[o + 1] = y; cl.anchor[o + 2] = z;
    }
  },
  update(world) {
    frame(world, PORTRAIT, LANDSCAPE);
    const f = flicker(world.time, 5.5, 0.05, 5);
    const c = world.lights.pointCol;
    c[0] = LAMP_COL[0] * f; c[1] = LAMP_COL[1] * f; c[2] = LAMP_COL[2] * f;
    this.env.gains[1] = f;
  },
};
