// Unveiling 除幕: a dark gallery, a glowing moon on a stone plinth, and a silk sheet that comes down over it.
// The opening is a small ceremony: the sheet hangs high, held at its four corners, is lowered until it
// settles over the moon, and the strings let go. The moon lights the silk from beneath and its glow leaks
// through; the polished floor mirrors all of it. Pull the sheet off to reveal it.
import { resetLights, dim, lin, unit, framing, frame, flicker } from './util.js';
import { togglePin } from '../sim/cloth.js';

const MOON = [0, 1.24, 0], MOON_R = 0.4;
const MOON_COL = lin(0xf1e3c0, 1.8);   // QA 2026-10-13: 5.5 blew the silk out to a white blob; at 1.8 the folds read
const S = 2.5;                                  // sheet size
const DROP = { t0: 0.25, t1: 2.3, release: 2.45 };

const PORTRAIT = framing([0, 1.12, 0.1], [0, -0.3, -1], 2.6, 3.1, 38, 1.03);
const LANDSCAPE = framing([0, 1.05, 0.1], [0.12, -0.26, -1], 3.7, 2.55, 36, 1.03);

const st = { t: 0, released: false, corners: [], start: [], end: [] };

export default {
  id: 'unveil', name: 'Unveiling', kanji: '除幕', blurb: 'A silk sheet over something that glows, waiting to be pulled off.',
  print: 'unveil',
  defaults: { material: 'silk', tool: 'grab', wind: 0, rain: false },
  windDir: [0.3, 0, -1],
  build(world, b, res) {
    resetLights(world);
    const L = world.lights;
    // a gallery spot from above and in front (env shaders keep it to a cone; the cloth sees all of it)
    L.keyDir.set(unit([0.18, 1, 0.42])); L.keyCol.set(lin(0xfff0dc, 1.7));
    L.sky.set(lin(0x2a2c3a, 0.16)); L.ground.set(lin(0x1a1614, 0.05));
    L.pointPos.set(MOON); L.pointCol.set(MOON_COL);
    L.shadow.type = 'point'; L.shadow.pos.set(MOON); L.shadow.dir.set([0, -1, 0]); L.shadow.fov = 150;
    L.fogCol.set(lin(0x0a0b10)); L.fogDensity = 0.02; L.exposure = 1.0;

    const n = dim(44, res, 14);
    const piece = b.grid({ name: 'sheet', cols: n, rows: n, origin: [-S / 2, 3.1, -S / 2], u: [S, 0, 0], v: [0, 0, S],
      pin: (c, r) => (c === 0 || c === n - 1) && (r === 0 || r === n - 1) });
    st.corners = [piece.id(0, 0), piece.id(n - 1, 0), piece.id(0, n - 1), piece.id(n - 1, n - 1)];
    st.t = 0; st.released = false;
    // the corners start high and a little turned, and come down spread wide around the plinth
    st.start = [[-1.0, 3.0, -1.12], [1.12, 3.15, -0.98], [-1.14, 3.1, 1.0], [0.98, 2.95, 1.12]];
    st.end = [[-1.18, 0.95, -1.12], [1.14, 1.05, -1.18], [-1.1, 1.0, 1.16], [1.16, 0.9, 1.1]];
    const C = world.colliders;
    C.planes.push({ nx: 0, ny: 1, nz: 0, d: 0 });
    C.spheres.push({ x: MOON[0], y: MOON[1], z: MOON[2], r: MOON_R + 0.01 });
    C.capsules.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0.72, bz: 0, r: 0.21 });
    C.capsules.push({ ax: 0, ay: 0.8, az: 0, bx: 0, by: 0.83, bz: 0, r: 0.3 });
    C.capsules.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0.05, bz: 0, r: 0.35 });
    frame(world, PORTRAIT, LANDSCAPE);

    const props = [];
    // the plinth: a turned stone pedestal with a cup for the moon
    props.push({ type: 'lathe', c: [0, 0, 0], col: 0x8a837a, mat: 'stone', seg: 28, contact: 0.7, spread: 0.3,
      prof: [[0.36, 0], [0.36, 0.05], [0.32, 0.07], [0.3, 0.1], [0.26, 0.13], [0.21, 0.17], [0.19, 0.45], [0.2, 0.68], [0.23, 0.72], [0.27, 0.75], [0.31, 0.79], [0.31, 0.86], [0.24, 0.885], [0.1, 0.87]] });
    props.push({ type: 'sphere', c: MOON, r: MOON_R, seg: 30, col: 0x262420, mat: 'moon', emi: 0xdccaa2, group: 1, floorAO: false });
    // the room: a dark back wall with panel seams, a side wall, a baseboard
    props.push({ type: 'box', min: [-5, 0, -3.3], max: [5, 4.5, -3.0], col: 0x2c2a28, mat: 'plaster' });
    for (let x = -4.5; x <= 4.5; x += 1.5) props.push({ type: 'box', min: [x - 0.006, 0.12, -3.0], max: [x + 0.006, 4.5, -2.995], col: 0x141312, mat: 'plain', floorAO: false });
    props.push({ type: 'box', min: [-5, 0, -3.0], max: [5, 0.12, -2.96], col: 0x161514, mat: 'lacquer' });
    props.push({ type: 'box', min: [-4.3, 0, -3.3], max: [-4.0, 4.5, 4], col: 0x262422, mat: 'plaster' });
    // a second, empty plinth far back in the dark
    props.push({ type: 'lathe', c: [-2.6, 0, -2.2], col: 0x4a4540, mat: 'stone', seg: 18, prof: [[0.3, 0], [0.3, 0.06], [0.22, 0.1], [0.2, 0.95], [0.25, 1.0], [0.25, 1.05]] });
    this.env = {
      sky: { zenith: 0x08080c, horizon: 0x101014, haze: 0x0c0c10, nadir: 0x0a0a0d, curve: 0.6, hazeAmt: 0.3, hazeK: 8 },
      floor: { y: 0, kind: 'polished', a: 0x302e34, b: 0x3e3b40, joint: 0x141316, scale: 1, bump: 0.02, fade: 12, horizon: 18, polish: 0.55, rainWet: 0 },
      props,
      ao: [{ x: 0, z: 0, r: 0.5, k: 0.5, s: 0.5 }],
      aoRect: [-5, -4, 10, 9],
      spot: { pos: [0.7, 4.6, 1.8], dir: [-0.15, -1, -0.38], inner: 11, outer: 24 },
      beams: [{ a: [0.7, 4.6, 1.8], b: [0.0, 0.0, 0.05], r0: 0.07, r1: 1.05, col: 0xfff0d8, k: 0.13 }],
      emiK: 0.62,
    };
    this.env.gains = new Float32Array([1, 1, 1, 1]);
  },
  afterBuild(world) {
    const cl = world.cloth;
    for (let k = 0; k < 4; k++) {
      const o = st.corners[k] * 3, p = st.start[k];
      cl.anchor[o] = p[0]; cl.anchor[o + 1] = p[1]; cl.anchor[o + 2] = p[2];
    }
  },
  update(world, dt) {
    frame(world, PORTRAIT, LANDSCAPE);
    st.t += dt;
    const cl = world.cloth;
    if (!st.released) {
      // ease the corners down, then let go
      const u = Math.min(1, Math.max(0, (st.t - DROP.t0) / (DROP.t1 - DROP.t0))), e = u * u * (3 - 2 * u);
      for (let k = 0; k < 4; k++) {
        const v = st.corners[k], o = v * 3, a = st.start[k], z = st.end[k];
        if (!cl.pinned[v]) continue;
        cl.anchor[o] = a[0] + (z[0] - a[0]) * e; cl.anchor[o + 1] = a[1] + (z[1] - a[1]) * e; cl.anchor[o + 2] = a[2] + (z[2] - a[2]) * e;
      }
      if (st.t >= DROP.release) {
        st.released = true;
        for (let k = 0; k < 4; k++) if (cl.pinned[st.corners[k]]) togglePin(world, st.corners[k]);
      }
    }
    // the moon breathes, very slowly
    const f = flicker(world.time, 9.1, 0.035, 0.6);
    const c = world.lights.pointCol;
    c[0] = MOON_COL[0] * f; c[1] = MOON_COL[1] * f; c[2] = MOON_COL[2] * f;
    this.env.gains[1] = f;
  },
};
