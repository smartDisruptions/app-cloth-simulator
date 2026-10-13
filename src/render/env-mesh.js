// Prop meshes and the baked floor map for render/env.js. Runs at scene load only (allocation is fine here).
//
// A scene describes props declaratively in scene.env.props; bakeProps() turns them into one interleaved
// vertex array (non-indexed triangles). Vertex: pos3 · nrm3 · col4 (sRGB albedo + AO) · emi4 (sRGB glow +
// glow group) · mat4 (grain, mottle, gloss, rib frequency) · uvb3 (surface coords in metres + bone).
//
// Prop types (every one takes the common options below):
//   { type: 'box', min: [x,y,z], max: [x,y,z] }                       axis-aligned box
//   { type: 'box', c: [x,y,z], h: [hx,hy,hz], rotY? | ax?, ay? }       oriented box (half sizes; axes unit ⟂)
//   { type: 'cyl', a: [..], b: [..], r, r2?, seg?, cap? }               cylinder / cone frustum
//   { type: 'sphere', c: [..], r, seg?, sy? }                           sphere (sy squashes it vertically)
//   { type: 'lathe', c: [..], prof: [[r, y], ...], seg?, cap? }         profile revolved about the vertical
// Common: col (0xRRGGBB or [r,g,b] sRGB), mat ('wood' | 'stone' | ... see MATS), emi (glow colour), group
// (glow group 0..3: per-frame gain, e.g. a flickering lamp), bone (0 static, 1..3), ao (0..1), ribs (lines
// per metre along the surface's v, for paper lanterns), floorAO (false: don't darken near the floor),
// shadow (false: no contact-shadow blob on the floor map).
import { noise3 } from '../core/noise.js';

export const STRIDE = 21;

//              grain  mottle gloss  ribs
export const MATS = {
  plain:   [0.0, 0.12, 0.0, 0],
  wood:    [1.0, 0.38, 0.05, 0],
  stone:   [0.0, 0.62, 0.04, 0],
  plaster: [0.0, 0.22, 0.0, 0],
  paper:   [0.15, 0.14, 0.0, 0],
  metal:   [0.0, 0.16, 0.75, 0],
  gold:    [0.0, 0.22, 0.9, 0],
  lacquer: [0.0, 0.06, 0.7, 0],
  tile:    [0.0, 0.4, 0.35, 0],
  bamboo:  [0.55, 0.25, 0.4, 0],
  rope:    [0.8, 0.3, 0.0, 0],
  moon:    [-1.0, 0.95, 0.0, 0],   // grain < 0: limb shading on glowing spheres
  blossom: [0.0, 0.7, 0.0, 0],
  fabric:  [0.35, 0.22, 0.0, 0],
};

export const rgb = (c) => (Array.isArray(c) ? c : [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function centreOf(p) {
  if (p.type === 'box') return p.min ? [0, 1, 2].map((k) => (p.min[k] + p.max[k]) / 2) : p.c;
  if (p.type === 'cyl') return [0, 1, 2].map((k) => (p.a[k] + p.b[k]) / 2);
  if (p.type === 'lathe') return [p.c[0], p.c[1] + (p.prof[0][1] + p.prof[p.prof.length - 1][1]) / 2, p.c[2]];
  return p.c;
}

/** Props → { data: Float32Array, count } (non-indexed triangles), sorted near → far from `eye` when given. */
export function bakeProps(props, floorY, eye) {
  if (eye) {
    const d = (p) => { const c = centreOf(p); return Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]); };
    props = props.map((p) => [d(p), p]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }
  const out = [];
  let P = null, col, emi, mat, bone, ao, floorAO;
  const vert = (p, n, u, v) => {
    const a = floorAO ? ao * (0.5 + 0.5 * sstep(0, 0.45, p[1] - floorY)) : ao;
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], a, emi[0], emi[1], emi[2], P.group || 0,
      mat[0], mat[1], mat[2], P.ribs || mat[3], u, v, bone);
  };
  const tri = (a, b, c) => { vert(...a); vert(...b); vert(...c); };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  // oriented box: centre c, half sizes h, unit axes X, Y, Z
  function obox(c, h, X, Y, Z) {
    const axes = [X, Y, Z];
    const longest = h[0] >= h[1] && h[0] >= h[2] ? 0 : h[1] >= h[2] ? 1 : 2;
    for (let k = 0; k < 3; k++) for (const s of [1, -1]) {
      const n = axes[k].map((x) => x * s);
      const i = (k + 1) % 3, j = (k + 2) % 3;
      const pt = (si, sj) => [0, 1, 2].map((q) => c[q] + n[q] * h[k] + axes[i][q] * h[i] * si + axes[j][q] * h[j] * sj);
      // surface coords: v along the grain (the box's longest axis) when it lies in this face
      const uvOf = (si, sj) => {
        const ci = h[i] * si, cj = h[j] * sj;
        if (longest === i) return [cj, ci + c[1] * 0.37 + k * 1.3];
        if (longest === j) return [ci, cj + c[0] * 0.41 + k * 1.7];
        return [ci + c[2] * 0.3, cj + c[0] * 0.3];
      };
      const corners = s > 0 ? [[-1, -1], [1, -1], [1, 1], [-1, 1]] : [[-1, -1], [-1, 1], [1, 1], [1, -1]];
      const v = corners.map(([a, b]) => [pt(a, b), n, ...uvOf(a, b)]);
      quad(v[0], v[1], v[2], v[3]);
    }
  }

  function cyl(a, b, r, r2, seg, cap) {
    const ax = sub(b, a), len = Math.hypot(...ax), n = unit(ax);
    const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(n, t)), w = cross(n, u);
    const slope = (r - r2) / len;
    const ring = (k) => { const g = (k / seg) * Math.PI * 2; return [u[0] * Math.cos(g) + w[0] * Math.sin(g), u[1] * Math.cos(g) + w[1] * Math.sin(g), u[2] * Math.cos(g) + w[2] * Math.sin(g)]; };
    const rm = Math.max(r, r2);
    for (let k = 0; k < seg; k++) {
      const d0 = ring(k), d1 = ring(k + 1);
      const nn = (d) => unit([d[0] + n[0] * slope, d[1] + n[1] * slope, d[2] + n[2] * slope]);
      const p = (base, d, rr) => [base[0] + d[0] * rr, base[1] + d[1] * rr, base[2] + d[2] * rr];
      const u0 = (k / seg) * Math.PI * 2 * rm, u1 = ((k + 1) / seg) * Math.PI * 2 * rm;
      quad([p(a, d0, r), nn(d0), u0, 0], [p(a, d1, r), nn(d1), u1, 0], [p(b, d1, r2), nn(d1), u1, len], [p(b, d0, r2), nn(d0), u0, len]);
      if (cap) {
        const m = n.map((x) => -x);
        tri([a, m, 0, 0], [p(a, d1, r), m, d1[0] * r, d1[2] * r], [p(a, d0, r), m, d0[0] * r, d0[2] * r]);
        if (r2 > 0) tri([b, n, 0, 0], [p(b, d0, r2), n, d0[0] * r2, d0[2] * r2], [p(b, d1, r2), n, d1[0] * r2, d1[2] * r2]);
      }
    }
  }

  function lathe(c, prof, seg, cap, sharp) {
    const ang = (k) => (k / seg) * Math.PI * 2;
    const rm = Math.max(...prof.map((q) => q[0]));
    // outward normal of each profile segment in (r, y); the profile runs bottom → top
    const sn = [];
    for (let i = 0; i < prof.length - 1; i++) {
      const dr = prof[i + 1][0] - prof[i][0], dy = prof[i + 1][1] - prof[i][1], l = Math.hypot(dr, dy) || 1;
      sn.push([dy / l, -dr / l]);
    }
    // smooth normals at profile points unless the turn is sharp (> ~50°) or `sharp` is set
    const pn = (i, seg0) => {
      const a = sn[seg0], b = i === seg0 ? sn[i - 1] : sn[i];
      if (sharp || !b || a[0] * b[0] + a[1] * b[1] < 0.64) return a;
      const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    };
    for (let i = 0; i < prof.length - 1; i++) {
      const [r0, y0] = prof[i], [r1, y1] = prof[i + 1];
      const na = pn(i, i), nb = pn(i + 1, i);
      for (let k = 0; k < seg; k++) {
        const g0 = ang(k), g1 = ang(k + 1);
        const P0 = (r, y, g) => [c[0] + Math.cos(g) * r, c[1] + y, c[2] + Math.sin(g) * r];
        const N0 = (g, q) => [Math.cos(g) * q[0], q[1], Math.sin(g) * q[0]];
        const u0 = g0 * rm, u1 = g1 * rm;
        quad([P0(r0, y0, g0), N0(g0, na), u0, y0], [P0(r0, y0, g1), N0(g1, na), u1, y0], [P0(r1, y1, g1), N0(g1, nb), u1, y1], [P0(r1, y1, g0), N0(g0, nb), u0, y1]);
      }
    }
    if (cap) {
      const [rt, yt] = prof[prof.length - 1], [rb, yb] = prof[0];
      for (let k = 0; k < seg; k++) {
        const g0 = ang(k), g1 = ang(k + 1);
        if (rt > 0) tri([[c[0], c[1] + yt, c[2]], [0, 1, 0], 0, 0], [[c[0] + Math.cos(g1) * rt, c[1] + yt, c[2] + Math.sin(g1) * rt], [0, 1, 0], 0, 0], [[c[0] + Math.cos(g0) * rt, c[1] + yt, c[2] + Math.sin(g0) * rt], [0, 1, 0], 0, 0]);
        if (rb > 0) tri([[c[0], c[1] + yb, c[2]], [0, -1, 0], 0, 0], [[c[0] + Math.cos(g0) * rb, c[1] + yb, c[2] + Math.sin(g0) * rb], [0, -1, 0], 0, 0], [[c[0] + Math.cos(g1) * rb, c[1] + yb, c[2] + Math.sin(g1) * rb], [0, -1, 0], 0, 0]);
      }
    }
  }

  function sphere(c, r, seg, sy) {
    const rings = Math.max(6, seg >> 1);
    const pt = (i, j) => { const th = (i / rings) * Math.PI, ph = (j / seg) * Math.PI * 2; return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]; };
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
      const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
      const v = q.map((d, k) => {
        const jj = k === 2 || k === 3 ? j + 1 : j, ii = k === 1 || k === 2 ? i + 1 : i;
        return [[c[0] + d[0] * r, c[1] + d[1] * r * sy, c[2] + d[2] * r], unit([d[0], d[1] / sy, d[2]]), (jj / seg) * Math.PI * 2 * r, (ii / rings) * Math.PI * r];
      });
      quad(v[0], v[3], v[2], v[1]);
    }
  }

  for (const p of props) {
    P = p;
    col = rgb(p.col == null ? 0x808080 : p.col);
    emi = rgb(p.emi == null ? 0 : p.emi);
    mat = MATS[p.mat || 'plain'] || MATS.plain;
    bone = p.bone || 0; ao = p.ao == null ? 1 : p.ao; floorAO = p.floorAO !== false;
    if (p.type === 'box') {
      if (p.min) {
        const c = [0, 1, 2].map((k) => (p.min[k] + p.max[k]) / 2), h = [0, 1, 2].map((k) => (p.max[k] - p.min[k]) / 2);
        obox(c, h, [1, 0, 0], [0, 1, 0], [0, 0, 1]);
      } else {
        let X = p.ax || [1, 0, 0], Y = p.ay || [0, 1, 0];
        if (p.rotY) { const cs = Math.cos(p.rotY), sn = Math.sin(p.rotY); X = [cs, 0, -sn]; Y = [0, 1, 0]; }
        X = unit(X); Y = unit(sub(Y, X.map((x) => x * dot(Y, X))));
        obox(p.c, p.h, X, Y, cross(X, Y));
      }
    } else if (p.type === 'cyl') cyl(p.a, p.b, p.r, p.r2 == null ? p.r : p.r2, p.seg || 14, p.cap !== false);
    else if (p.type === 'sphere') sphere(p.c, p.r, p.seg || 20, p.sy || 1);
    else if (p.type === 'lathe') lathe(p.c, p.prof, p.seg || 20, p.cap !== false, !!p.sharp);
  }
  const data = new Float32Array(out);
  return { data, count: data.length / STRIDE };
}

/** Footprint of a prop on the floor (for contact shadows), or null when it doesn't touch the floor. */
function footprint(p, floorY) {
  if (p.shadow === false || (p.bone | 0) !== 0) return null;
  if (p.type === 'box' && p.min) return p.min[1] <= floorY + 0.06 ? { kind: 'rect', x0: p.min[0], x1: p.max[0], z0: p.min[2], z1: p.max[2] } : null;
  if (p.type === 'box') {
    const ext = Math.max(p.h[0], p.h[2]);
    return p.c[1] - p.h[1] <= floorY + 0.06 ? { kind: 'circle', x: p.c[0], z: p.c[2], r: ext * 0.85 } : null;
  }
  if (p.type === 'cyl') {
    const lo = Math.min(p.a[1], p.b[1]);
    if (lo > floorY + 0.06) return null;
    const base = p.a[1] <= p.b[1] ? p.a : p.b;
    return { kind: 'circle', x: base[0], z: base[2], r: Math.max(p.r, p.r2 || 0) };
  }
  if (p.type === 'lathe') return p.c[1] + p.prof[0][1] <= floorY + 0.06 ? { kind: 'circle', x: p.c[0], z: p.c[2], r: p.prof[0][0] } : null;
  if (p.type === 'sphere') return p.c[1] - p.r <= floorY + 0.06 ? { kind: 'circle', x: p.c[0], z: p.c[2], r: p.r * 0.7 } : null;
  return null;
}

/**
 * The floor map: RGBA8 size², covering rect [x0, z0, w, d] of the floor.
 *   r: ambient occlusion (contact shadows under props and env.ao blobs)
 *   g: puddle mask (low spots where water collects; env.floor.puddles and env.puddles)
 *   b: wear (1 clean … darker paths; env.wear blobs)
 *   a: shelter (1 open sky … 0 under a roof or a tarp: rain doesn't wet it; env.shelter rects, minus
 *      env.drips circles where water runs off the cover)
 */
export function bakeFloorMap(env, floorY, size = 128) {
  const rect = env.aoRect || [-6, -6, 12, 12];
  const fl = env.floor || {};
  const blobs = [];
  for (const p of env.props || []) {
    const f = footprint(p, floorY);
    if (f) blobs.push({ ...f, k: p.contact == null ? 0.65 : p.contact, s: p.spread || 0.22 });
  }
  for (const a of env.ao || []) blobs.push({ kind: 'circle', x: a.x, z: a.z, r: a.r || 0.1, k: a.k == null ? 0.5 : a.k, s: a.s || 0.3, sx: a.sx || 1 });
  const pud = env.puddles || [], wear = env.wear || [], shel = env.shelter || [], drips = env.drips || [];
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = rect[0] + ((i + 0.5) / size) * rect[2], z = rect[1] + ((j + 0.5) / size) * rect[3];
    let ao = 1;
    for (const b of blobs) {
      let d;
      if (b.kind === 'rect') d = Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
      else d = Math.max(0, Math.hypot((x - b.x) / (b.sx || 1), z - b.z) - b.r);
      ao *= 1 - b.k * Math.exp(-d / b.s);
    }
    // edges of the map fade to neutral so nothing shows where it clamps
    const ex = Math.min(i, size - 1 - i, j, size - 1 - j) / (size * 0.08);
    const edge = Math.min(1, ex);
    ao = 1 - (1 - ao) * edge;
    let g = 0;
    if (fl.puddles) g = 0.5 + 0.55 * (noise3(x * 0.55, z * 0.55, 3.7) * 0.7 + noise3(x * 1.4, z * 1.4, 9.1) * 0.3) - 0.5 * (1 - fl.puddles);
    for (const q of pud) g += q.k * Math.exp(-((x - q.x) ** 2 / (q.rx * q.rx) + (z - q.z) ** 2 / (q.rz * q.rz)));
    g *= edge;
    let w = 1;
    for (const q of wear) w *= 1 - q.k * Math.exp(-((x - q.x) ** 2 / (q.rx * q.rx) + (z - q.z) ** 2 / (q.rz * q.rz)));
    let open = 1;
    for (const q of shel) {
      const dx = Math.max(q.x0 - x, 0, x - q.x1), dz = Math.max(q.z0 - z, 0, z - q.z1);
      open *= 1 - (q.k == null ? 1 : q.k) * (1 - sstep(0, q.soft || 0.25, Math.hypot(dx, dz)));
    }
    for (const q of drips) open = Math.max(open, 1 - sstep(q.r * 0.5, q.r, Math.hypot(x - q.x, z - q.z)));
    const o = (j * size + i) * 4;
    data[o] = Math.round(Math.min(1, Math.max(0, ao)) * 255);
    data[o + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
    data[o + 2] = Math.round(Math.min(1, Math.max(0, w)) * 255);
    data[o + 3] = Math.round(Math.min(1, Math.max(0, open)) * 255);
  }
  return { data, size, rect };
}

/** Light beams → { data: Float32Array (pos3 nrm3 t1), count }: open cones from apex a (radius r0) to b (r1). */
export function bakeBeams(beams) {
  const out = [];
  for (const B of beams || []) {
    const seg = B.seg || 24, ax = sub(B.b, B.a), len = Math.hypot(...ax), n = unit(ax);
    const t = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(n, t)), w = cross(n, u);
    const slope = (B.r0 - B.r1) / len;
    const v = (k, end) => {
      const g = (k / seg) * Math.PI * 2, c = Math.cos(g), s = Math.sin(g);
      const d = [u[0] * c + w[0] * s, u[1] * c + w[1] * s, u[2] * c + w[2] * s];
      const r = end ? B.r1 : B.r0, base = end ? B.b : B.a;
      const nn = unit([d[0] + n[0] * slope, d[1] + n[1] * slope, d[2] + n[2] * slope]);
      out.push(base[0] + d[0] * r, base[1] + d[1] * r, base[2] + d[2] * r, nn[0], nn[1], nn[2], end ? 1 : 0);
    };
    for (let k = 0; k < seg; k++) { v(k, 0); v(k + 1, 0); v(k + 1, 1); v(k, 0); v(k + 1, 1); v(k, 1); }
  }
  const data = new Float32Array(out);
  return { data, count: data.length / 7 };
}
