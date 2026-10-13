// Textile prints, painted once per scene with Canvas 2D (vector shapes only: never text glyphs, which a
// phone without CJK fonts would show as boxes) and uploaded as a mipmapped texture. No national or hero
// emblems; the patterns are traditional and public domain (seigaiha, asanoha, kikkō, uroko, chidori).
//
// Every painter draws in DESIGN SPACE: x ∈ [0, aspect], y ∈ [0, 1] over the whole texture, where aspect =
// metres per u ÷ metres per v, measured from the scene's rest mesh (render/cloth.js). So circles stay round
// whatever the cloth's proportions, and geo.mV (metres per design unit) lets repeating patterns keep a real
// size (a seigaiha fan is 10 cm across on any banner) while compositions (a crest, a carp) scale with
// the cloth. The texture itself need not be square: cloth.js picks w × h so texels are about square on the
// cloth (a tall nobori gets 512 × 2048).
//
// The print's ALPHA is a mask (opaque = plain cloth): `mask: 'damask'` turns the satin where it is set (the
// motif appears and vanishes with the sheen), `mask: 'gold'` makes it metallic gold thread or leaf.
// `shot` is the shot-silk colour silk shifts toward at grazing angles.
//
// Randomness comes from a private seeded generator, so a print is identical on every reload and painting
// never shifts the shared rand() sequence the simulation uses.

const TAU = Math.PI * 2;

/**
 * Print ids. 'koinobori' is the scenes' four-band atlas (v 0–.25 black magoi, .25–.5 red higoi, .5–.75 blue
 * kogoi, .75–1 the five-colour fukinagashi; each band: mouth at its top, tail at its bottom; u wraps the
 * body, u = 0 the back, 0.25 / 0.75 the flanks with the eyes, 0.5 the belly). One carp over the whole
 * texture: 'koinobori-single' (red), '-black', '-blue'; three side by side in u thirds: '-family'.
 */
export const PRINT_META = {
  noren: { shot: '#6d5ad0', mask: null },
  koinobori: { shot: '#f0b44c', mask: 'gold' },
  'koinobori-single': { shot: '#f0b44c', mask: 'gold' },
  'koinobori-black': { shot: '#c8962e', mask: 'gold' },
  'koinobori-blue': { shot: '#62c4d8', mask: 'gold' },
  'koinobori-family': { shot: '#f0b44c', mask: 'gold' },
  banner: { shot: '#e8a04a', mask: 'gold' },
  unveil: { shot: '#e6b88a', mask: 'damask' },
  embers: { shot: '#c97a4a', mask: null },
  monsoon: { shot: '#7a9ad0', mask: null },
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const mixHex = (a, b, t) => { const A = hex(a), B = hex(b); return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`; };
const rgba = (h, a) => { const c = hex(h); return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`; };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Design space over the whole texture: x ∈ [0, aspect], y ∈ [0, 1]. */
const design = (g, w, h, G) => g.setTransform(w / G.aspect, 0, 0, h, 0, 0);

/** Soft blooms of colour: the unevenness of hand dyeing. cols: hex colours to pick from. */
function mottle(g, R, W, H, n, cols, r0, r1, amax) {
  for (let i = 0; i < n; i++) {
    const x = R() * W, y = R() * H, r = r0 + R() * (r1 - r0), c = cols[(R() * cols.length) | 0], a = amax * (0.3 + 0.7 * R());
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rgba(c, a)); rg.addColorStop(1, rgba(c, 0));
    g.fillStyle = rg; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
}

/** Fine irregular streaks along a direction (yarn slubs, dye runs). vertical: streaks run along y. */
function streaks(g, R, W, H, n, cols, len, wid, amax, vertical) {
  for (let i = 0; i < n; i++) {
    const x = R() * W, y = R() * H, l = len * (0.3 + R()), w = wid * (0.4 + R());
    g.strokeStyle = rgba(cols[(R() * cols.length) | 0], amax * (0.3 + 0.7 * R()));
    g.lineWidth = w; g.beginPath();
    if (vertical) { g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * w * 3, y + l); } else { g.moveTo(x, y); g.lineTo(x + l, y + (R() - 0.5) * w * 3); }
    g.stroke();
  }
}

/** A filled ribbon of varying width along a sampled curve: pt(t) → [x, y], wid(t) → half-width. */
function ribbon(g, pt, wid, steps) {
  const L = [], Rr = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, p = pt(t), q = pt(Math.min(1, t + 1e-3)), p0 = pt(Math.max(0, t - 1e-3));
    let dx = q[0] - p0[0], dy = q[1] - p0[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const w = wid(t);
    L.push(p[0] - dy * w, p[1] + dx * w); Rr.push(p[0] + dy * w, p[1] - dx * w);
  }
  g.beginPath(); g.moveTo(L[0], L[1]);
  for (let i = 2; i < L.length; i += 2) g.lineTo(L[i], L[i + 1]);
  for (let i = Rr.length - 2; i >= 0; i -= 2) g.lineTo(Rr[i], Rr[i + 1]);
  g.closePath();
}

/** Seigaiha (blue-sea waves): rows of fans of radius rs, from y0 down past y1, filled by fill(y), lines by line(y). */
function seigaiha(g, x0, x1, y0, y1, rs, fill, line, lw) {
  for (let row = 0, y = y0; y < y1 + rs; row++, y += rs * 0.5) {
    for (let x = x0 + ((row & 1) ? rs : 0); x < x1 + rs; x += rs * 2) {
      g.fillStyle = fill(y);
      g.beginPath(); g.arc(x, y, rs, Math.PI, TAU); g.lineTo(x + rs, y + rs); g.lineTo(x - rs, y + rs); g.closePath(); g.fill();
      g.strokeStyle = line(y); g.lineWidth = lw;
      for (let k = 0; k < 4; k++) { g.beginPath(); g.arc(x, y, rs * (0.92 - k * 0.22), Math.PI, TAU); g.stroke(); }
    }
  }
}

// ------------------------------------------------------------------------------------------- noren 暖簾
/** A gust: a tapered brushstroke from (x0, y) to (x1, y) on a gentle wave, ending in a curl that winds
 *  up (dir -1) or down (dir 1). */
function gustStroke(g, x0, x1, y, amp, ph, th, rc, dir, grow, strokeOrFill) {
  const pt = (t) => [x0 + (x1 - x0) * t, y + amp * Math.sin(ph + t * TAU * 1.1)];
  ribbon(g, pt, (t) => th * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.04)), 0.55) + 0.0015 + grow, 90); strokeOrFill();
  const e = pt(1), s = Math.sign(x1 - x0) || 1;
  const cxx = e[0], cyy = e[1] + dir * rc;
  const cp = (t) => { const ang = -dir * Math.PI / 2 + s * dir * t * TAU * 1.05, r = rc * (1 - 0.7 * t); return [cxx + Math.cos(ang) * r * s, cyy + Math.sin(ang) * r]; };
  ribbon(g, cp, (t) => th * 0.75 * (1 - t) + 0.0015 + grow, 48); strokeOrFill();
}

// Aizome indigo, hand-dyed and uneven, with a resist-white wind crest across the panels: a ring holding three
// gusts that flow and curl like wind drawn by a brush, and long gust lines sweeping across every panel below.
// The composition scales with the curtain (a noren's crest is sized to it).
function windMotif(g, W, halo) {
  const cx = W * 0.5, cy = 0.4, R0 = 0.265, grow = halo ? 0.011 : 0;
  const strokeOrFill = () => { g.fill(); if (halo) g.stroke(); };
  g.lineWidth = 0.032 + grow * 2; g.beginPath(); g.arc(cx, cy, R0, 0, TAU); g.stroke();
  g.lineWidth = 0.008 + grow * 2; g.beginPath(); g.arc(cx, cy, R0 - 0.036, 0, TAU); g.stroke();
  const Ri = R0 - 0.07;
  for (const [dy, dir, sx, th] of [[-0.105, -1, 1, 0.016], [0.0, 1, -1, 0.021], [0.105, -1, 1, 0.016]]) {
    const half = Math.sqrt(Math.max(0, Ri * Ri - dy * dy)) - 0.03;
    gustStroke(g, cx - sx * half, cx + sx * (half - 0.07), cy + dy, 0.012, dy * 20, th, 0.034, dir, grow, strokeOrFill);
  }
  const gusts = [[0.035, 0.74, 0.715, 0.0, -1], [0.97, 0.22, 0.79, 1.7, 1], [0.08, 0.63, 0.862, 3.1, -1]];
  for (const [a, b, y, ph, dir] of gusts) gustStroke(g, a * W, b * W, y, 0.016, ph, 0.0125, 0.036, dir, grow, strokeOrFill);
  // the hem: two hairlines near the bottom, a stitched line under the top sleeve
  g.fillRect(0, 0.944 - grow, W, 0.006 + grow * 2);
  g.fillRect(0, 0.958 - grow, W, 0.0028 + grow * 2);
  g.fillRect(0, 0.083 - grow, W, 0.0035 + grow * 2);
}

function noren(g, w, h, G, R) {
  const W = G.aspect;
  design(g, w, h, G);
  const gr = g.createLinearGradient(0, 0, 0, 1);
  gr.addColorStop(0, '#0c1230'); gr.addColorStop(0.1, '#141c46'); gr.addColorStop(0.5, '#18224f'); gr.addColorStop(0.9, '#141c47'); gr.addColorStop(1, '#0c1230');
  g.fillStyle = gr; g.fillRect(0, 0, W, 1);
  mottle(g, R, W, 1, 170, ['#2a3a7e', '#22306c', '#070a1e', '#0e1538'], 0.02, 0.17, 0.12);
  streaks(g, R, W, 1, 90, ['#34468e', '#080c24'], 0.4, 0.004, 0.07, true);
  g.fillStyle = 'rgba(6,8,26,0.42)'; g.fillRect(0, 0, W, 0.075);
  // resist-dyed white: a pale bleed first, then the crisp motif
  g.fillStyle = 'rgba(110,128,190,0.2)'; g.strokeStyle = 'rgba(110,128,190,0.2)'; g.lineJoin = 'round';
  windMotif(g, W, true);
  g.fillStyle = '#efeadf'; g.strokeStyle = '#efeadf';
  windMotif(g, W, false);
  // the whites are not paper-perfect: indigo specks and a faint blue cast
  g.fillStyle = 'rgba(40,56,130,0.18)';
  for (let i = 0; i < 2600; i++) { const x = R() * W, y = R(); g.fillRect(x, y, 0.0025 + R() * 0.004, 0.0025 + R() * 0.004); }
  mottle(g, R, W, 1, 40, ['#8f9fd8'], 0.05, 0.2, 0.08);
}

// ------------------------------------------------------------------------------------- koinobori 鯉のぼり
// A carp in the texture rectangle u0..u1 × v0..v1: u wraps the body (u0 = the back, a quarter round the
// flanks with the eyes, half the belly), v runs from the mouth (v0) to the tail (v1). Everything is drawn in
// the carp's own physical frame (scales stay round as the tube tapers) and sized by the carp's length, so a
// child carp's scales are smaller than its father's.
const CARPS = {
  red:   { dorsal: '#6e130f', flank: '#d4392a', belly: '#f4e2c4', head: '#de4630', rim: '#f2c25c', light: '#ff8a5c', line: '#2a0907', fin: '#f6ead2', fin2: '#e2412a', iris: '#2a0907' },
  black: { dorsal: '#06070d', flank: '#1d2034', belly: '#ebe1ca', head: '#262a42', rim: '#c8962e', light: '#4a5070', line: '#000000', fin: '#f1e3c0', fin2: '#2b3a96', iris: '#10132a' },
  blue:  { dorsal: '#121852', flank: '#2b3a96', belly: '#eef0f6', head: '#3647aa', rim: '#f1e3c0', light: '#6f86e6', line: '#070a26', fin: '#f4efe4', fin2: '#e2412a', iris: '#070a26' },
};

/** Clip to and frame the rectangle: local x ∈ [0, 1] round the body, y ∈ [0, 1] mouth → tail. Returns helpers. */
function tubeFrame(g, w, h, G, u0, u1, v0, v1, m) {
  const UW = u1 - u0, VH = v1 - v0;
  const la = (y) => Math.max(0.05, G.aspectAt(v0 + y * VH) * UW / VH);  // metres around ÷ metres along, at y
  const base = (ctx) => ctx.setTransform(UW * w, 0, 0, VH * h, u0 * w, v0 * h);
  // physical frame at y: X ∈ [0, la(y)] round the body, y along (one unit = the tube's length)
  const at = (ctx, y) => { const L = la(y); ctx.setTransform((UW * w) / L, 0, 0, VH * h, u0 * w, v0 * h); return L; };
  const both = (fn) => { fn(g, false); if (m) fn(m, true); };
  for (const ctx of m ? [g, m] : [g]) { ctx.save(); base(ctx); ctx.beginPath(); ctx.rect(0, 0, 1, 1); ctx.clip(); }
  const done = () => { for (const ctx of m ? [g, m] : [g]) ctx.restore(); };
  return { la, base, at, both, done };
}

function carp(g, w, h, G, P, u0, u1, v0, v1, m) {
  const { base, at, both, done } = tubeFrame(g, w, h, G, u0, u1, v0, v1, m);
  const latCol = (x) => {   // body colour by position round the body
    const lat = Math.cos(TAU * x);
    return lat > 0 ? mixHex(P.flank, P.dorsal, Math.pow(lat, 1.6)) : mixHex(P.flank, P.belly, Math.pow(-lat, 1.4));
  };
  base(g);
  const body = g.createLinearGradient(0, 0, 1, 0);
  for (let k = 0; k <= 16; k++) body.addColorStop(k / 16, latCol(k / 16));
  g.fillStyle = body; g.fillRect(0, 0, 1, 1);

  // scales (uroko): tail rows first, each row toward the head overlapping the one behind it
  const r = 0.031, y0 = 0.215, y1 = 0.86;
  let row = 0;
  for (let y = y1; y >= y0; y -= r * 0.92, row++) {
    const L = at(g, y), n = Math.max(5, Math.round(L / (2 * r * 0.86))), dx = L / n, rx = dx / 1.72;
    for (let i = 0; i < n; i++) {
      const X = (i + (row & 1) * 0.5) * dx, x = X / L, lat = Math.cos(TAU * x);
      const vis = 1 - sstep(-0.35, -0.75, lat) * 0.85;
      for (const off of [0, -L, L]) {
        const X2 = X + off; if (X2 < -2 * r || X2 > L + 2 * r) continue;
        const c = latCol(x);
        const sg = g.createLinearGradient(0, y - r * 0.2, 0, y + r);
        sg.addColorStop(0, c); sg.addColorStop(0.62, c); sg.addColorStop(1, mixHex(lat > -0.3 ? P.flank : P.belly, P.light, 0.35));
        g.globalAlpha = vis; g.fillStyle = sg;
        g.beginPath(); g.ellipse(X2, y, rx, r, 0, 0, Math.PI); g.closePath(); g.fill();
        g.globalAlpha = vis * 0.55; g.strokeStyle = P.line; g.lineWidth = 0.0035;
        g.beginPath(); g.ellipse(X2, y, rx, r, 0, 0.05 * Math.PI, 0.95 * Math.PI); g.stroke();
        g.globalAlpha = 1;
      }
    }
    // gold rims: on the cloth and on the mask
    both((ctx, isMask) => {
      at(ctx, y);
      ctx.strokeStyle = isMask ? '#fff' : P.rim; ctx.lineWidth = 0.0055;
      for (let i = 0; i < n; i++) {
        const X = (i + (row & 1) * 0.5) * dx, lat = Math.cos(TAU * X / L);
        if (lat < -0.45) continue;
        ctx.globalAlpha = isMask ? 1 : 0.9 * (1 - sstep(-0.1, -0.45, lat));
        for (const off of [0, -L, L]) {
          const X2 = X + off; if (X2 < -2 * r || X2 > L + 2 * r) continue;
          ctx.beginPath(); ctx.ellipse(X2, y, rx * 0.8, r * 0.8, 0, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    });
  }

  // dorsal fin along the back line (it wraps: drawn at both edges), and a soft belly
  for (const fx of [0, 1]) {
    for (let y = 0.3; y < 0.66; y += 0.018) {
      const L = at(g, y), X = fx * L;
      g.strokeStyle = P.fin; g.globalAlpha = 0.75; g.lineWidth = 0.006;
      g.beginPath(); g.moveTo(X - 0.035, y - 0.012); g.quadraticCurveTo(X, y + 0.004, X + 0.035, y - 0.012); g.stroke();
    }
  }
  g.globalAlpha = 1;
  base(g);
  const bel = g.createLinearGradient(0.3, 0, 0.7, 0);
  bel.addColorStop(0, rgba(P.belly, 0)); bel.addColorStop(0.5, rgba(P.belly, 0.7)); bel.addColorStop(1, rgba(P.belly, 0));
  g.fillStyle = bel; g.fillRect(0.3, 0.2, 0.4, 0.66);

  // tail: fin rays all round the open end, behind a scalloped root
  const ty = 0.86;
  {
    const L = at(g, 0.93), n = Math.max(10, Math.round(L / 0.05));
    g.strokeStyle = rgba(P.line, 0.35); g.lineWidth = 0.003;
    for (let i = 0; i < n; i++) {
      const X = (i + 0.5) * L / n, wd = L / n;
      g.fillStyle = i % 3 === 2 ? P.fin2 : i % 3 === 1 ? P.fin : mixHex(P.fin, P.flank, 0.25);
      g.beginPath(); g.moveTo(X - wd * 0.5, ty); g.lineTo(X + wd * 0.5, ty); g.lineTo(X + wd * 0.62, 1.01); g.lineTo(X - wd * 0.38, 1.01); g.closePath();
      g.fill(); g.stroke();
    }
    const L2 = at(g, ty), n2 = Math.max(6, Math.round(L2 / 0.09));
    g.fillStyle = latCol(0.25);
    for (let i = 0; i <= n2; i++) { const X = i * L2 / n2; g.beginPath(); g.ellipse(X, ty, L2 / n2 * 0.55, 0.03, 0, 0, Math.PI); g.fill(); }
  }

  // head: from the mouth to the gill line, which bulges back toward the tail on each flank
  base(g);
  const gillY = (x) => { let best = 0.2; for (const fc of [0.25, 0.75]) { const d = Math.abs(x - fc); if (d < 0.22) best = Math.max(best, 0.2 + 0.04 * Math.cos(d / 0.22 * Math.PI / 2)); } return best; };
  const head = g.createLinearGradient(0, 0, 1, 0);
  for (let k = 0; k <= 16; k++) { const x = k / 16, lat = Math.cos(TAU * x); head.addColorStop(x, lat > 0 ? mixHex(P.head, P.dorsal, Math.pow(lat, 2)) : mixHex(P.head, P.belly, Math.pow(-lat, 1.2))); }
  g.fillStyle = head; g.beginPath(); g.moveTo(0, 0);
  for (let k = 0; k <= 64; k++) g.lineTo(k / 64, gillY(k / 64));
  g.lineTo(1, 0); g.closePath(); g.fill();
  // gill line: a gold crescent with a dark keyline
  both((ctx, isMask) => {
    base(ctx);
    for (const fc of [0.25, 0.75]) {
      for (const [lw, col] of isMask ? [[0.012, '#fff']] : [[0.02, P.line], [0.011, P.rim]]) {
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
        for (let k = 0; k <= 40; k++) { const x = fc - 0.2 + 0.4 * k / 40; ctx.lineTo(x, gillY(x) - 0.004); }
        ctx.stroke();
      }
    }
  });
  // pectoral fins behind the gill, low on each flank
  for (const fc of [0.25, 0.75]) {
    const dir = fc < 0.5 ? 1 : -1;
    const L = at(g, 0.25), X = (fc + dir * 0.09) * L;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI * 0.5 - dir * (0.25 + i * 0.13);
      g.fillStyle = i % 2 ? P.fin : P.fin2;
      g.beginPath(); g.moveTo(X, 0.235);
      g.lineTo(X + Math.cos(a - 0.07) * 0.09, 0.235 + Math.sin(a - 0.07) * 0.09);
      g.lineTo(X + Math.cos(a + 0.07) * 0.09, 0.235 + Math.sin(a + 0.07) * 0.09);
      g.closePath(); g.fill();
    }
  }
  // eyes: a gold ring, white, iris, pupil and a catchlight toward the mouth
  for (const fc of [0.25, 0.75]) {
    const y = 0.105, re = 0.06;
    both((ctx, isMask) => {
      const L = at(ctx, y), X = fc * L;
      if (isMask) { ctx.strokeStyle = '#fff'; ctx.lineWidth = re * 0.2; ctx.beginPath(); ctx.arc(X, y, re * 0.9, 0, TAU); ctx.stroke(); return; }
      ctx.fillStyle = P.line; ctx.beginPath(); ctx.arc(X, y, re * 1.08, 0, TAU); ctx.fill();
      ctx.fillStyle = P.rim; ctx.beginPath(); ctx.arc(X, y, re, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fbf6ea'; ctx.beginPath(); ctx.arc(X, y, re * 0.8, 0, TAU); ctx.fill();
      ctx.fillStyle = P.iris; ctx.beginPath(); ctx.arc(X, y, re * 0.55, 0, TAU); ctx.fill();
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(X, y, re * 0.36, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X - re * 0.2, y - re * 0.24, re * 0.13, 0, TAU); ctx.fill();
    });
  }
  // the mouth hoop: a cream band with a gold line
  base(g);
  g.fillStyle = P.belly; g.fillRect(0, 0, 1, 0.03);
  both((ctx, isMask) => { base(ctx); ctx.fillStyle = isMask ? '#fff' : P.rim; ctx.fillRect(0, 0.03, 1, 0.007); });
  done();
}

/** Fukinagashi: the five-colour streamer that flies above the carp. Five stripes run its length (round the
 *  tube), under a gold mouth band patterned with small white waves. */
function fukinagashi(g, w, h, G, u0, u1, v0, v1, m, R) {
  const { base, at, both, done } = tubeFrame(g, w, h, G, u0, u1, v0, v1, m);
  base(g);
  const cols = ['#2b3a96', '#e2412a', '#d9a640', '#f4efe4', '#10132a'];   // indigo, vermilion, gold, white, ink
  for (let i = 0; i < 5; i++) { g.fillStyle = cols[i]; g.fillRect(i / 5 - 0.001, 0, 0.2 + 0.002, 1); }
  // dye unevenness and the stitched seams between the stripes
  for (let i = 0; i < 70; i++) {
    const x = R(), y = R(), rr = 0.02 + R() * 0.06;
    const rg = g.createRadialGradient(x, y, 0, x, y, rr);
    const c = R() < 0.5 ? '#ffffff' : '#000000';
    rg.addColorStop(0, rgba(c, 0.06)); rg.addColorStop(1, rgba(c, 0));
    g.fillStyle = rg; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  g.strokeStyle = 'rgba(16,19,42,0.45)'; g.lineWidth = 0.003;
  for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(i / 5, 0.13); g.lineTo(i / 5, 1); g.stroke(); }
  // the mouth band in gold leaf, with a row of small seigaiha in white
  both((ctx, isMask) => { base(ctx); ctx.fillStyle = isMask ? '#fff' : '#c8962e'; ctx.fillRect(0, 0, 1, 0.12); });
  const L = at(g, 0.06), rs = 0.022;
  g.save(); g.beginPath(); g.rect(0, 0.012, L, 0.098); g.clip();
  seigaiha(g, 0, L, 0.035, 0.11, rs, () => '#c8962e', () => 'rgba(250,244,230,0.9)', 0.0032);
  g.restore();
  base(g);
  g.fillStyle = '#10132a'; g.fillRect(0, 0.12, 1, 0.011); g.fillRect(0, 0, 1, 0.008);
  done();
}

const koiSingle = (pal) => (g, w, h, G, R, m) => { void R; carp(g, w, h, G, CARPS[pal], 0, 1, 0, 1, m); };

/** The scenes' atlas: four bands in v (see PRINT_META's note). */
function koinoboriBands(g, w, h, G, R, m) {
  carp(g, w, h, G, CARPS.black, 0, 1, 0, 0.25, m);
  carp(g, w, h, G, CARPS.red, 0, 1, 0.25, 0.5, m);
  carp(g, w, h, G, CARPS.blue, 0, 1, 0.5, 0.75, m);
  fukinagashi(g, w, h, G, 0, 1, 0.75, 1, m, R);
}

/** koinobori-family: black magoi in u ∈ [0, ⅓], red higoi in [⅓, ⅔], blue kogoi in [⅔, 1], full length each. */
function carpsAcross(g, w, h, G, R, m) {
  void R;
  carp(g, w, h, G, CARPS.black, 0, 1 / 3, 0, 1, m);
  carp(g, w, h, G, CARPS.red, 1 / 3, 2 / 3, 0, 1, m);
  carp(g, w, h, G, CARPS.blue, 2 / 3, 1, 0, 1, m);
}

// --------------------------------------------------------------------------------------- banner 幟 (nobori)
// A dusk gradient, seigaiha waves rising from the foot, plovers (chidori) flying in gold thread, and a bold
// vermilion band down the hoist side where the banner is tied to its pole. Works tall (a nobori) or wide.
const DUSK = [[0, '#0e1230'], [0.28, '#26338a'], [0.55, '#6a3c7c'], [0.78, '#c4503e'], [1, '#e8a246']];
function duskAt(y) {
  for (let i = 1; i < DUSK.length; i++) if (y <= DUSK[i][0]) return mixHex(DUSK[i - 1][1], DUSK[i][1], (y - DUSK[i - 1][0]) / (DUSK[i][0] - DUSK[i - 1][0]));
  return DUSK[DUSK.length - 1][1];
}
/** A plover (chidori) in flight, the round-bodied bird of the classic textile pattern: a plump body, a
 *  small head and beak, and two wings swept up and back. Unit size ~2 across, facing −x. */
function chidori(ctx, x, y, s, flip) {
  ctx.save(); ctx.translate(x, y); ctx.scale(flip ? -s : s, s);
  ctx.beginPath(); ctx.ellipse(0.05, 0.1, 0.78, 0.5, -0.12, 0, TAU); ctx.fill();          // body
  ctx.beginPath(); ctx.arc(-0.62, -0.14, 0.36, 0, TAU); ctx.fill();                         // head
  ctx.beginPath(); ctx.moveTo(-0.92, -0.22); ctx.lineTo(-1.32, -0.1); ctx.lineTo(-0.9, -0.02); ctx.closePath(); ctx.fill();   // beak
  ctx.beginPath(); ctx.moveTo(0.75, 0.0); ctx.lineTo(1.25, -0.2); ctx.lineTo(0.8, 0.3); ctx.closePath(); ctx.fill();          // tail
  for (const [ox, sw] of [[-0.15, 1], [0.32, 0.8]]) {                                       // the two wings
    ctx.beginPath(); ctx.moveTo(ox - 0.18, -0.2);
    ctx.quadraticCurveTo(ox + 0.05, -0.85 * sw, ox + 0.7, -1.25 * sw);
    ctx.quadraticCurveTo(ox + 0.45, -0.55 * sw, ox + 0.38, -0.12);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}
function banner(g, w, h, G, R, m) {
  const W = G.aspect, M = 1 / G.mV;   // M: design units per metre
  design(g, w, h, G);
  const gr = g.createLinearGradient(0, 0, 0, 1);
  for (const [t, c] of DUSK) gr.addColorStop(t, c);
  g.fillStyle = gr; g.fillRect(0, 0, W, 1);
  mottle(g, R, W, 1, 60, ['#ffffff', '#000000'], 0.05 * Math.min(W, 1), 0.2 * Math.min(W, 1), 0.035);
  // seigaiha from the foot up, fading into the sky (fans 20 cm across)
  const top = 0.52;
  seigaiha(g, 0, W, top, 1, 0.1 * M, (y) => duskAt(Math.min(1, y + 0.02)), (y) => rgba('#f4efe4', 0.12 + 0.5 * sstep(top, top + 0.2, y)), 0.012 * M);
  // plovers flying over the waves, in gold thread (a loose flock, ~12 cm birds)
  const birds = [[0.36, 0.13, 1], [0.66, 0.09, 0.85], [0.84, 0.21, 0.95], [0.46, 0.27, 0.9], [0.74, 0.35, 0.8], [0.4, 0.43, 0.75]];
  for (const ctx of m ? [g, m] : [g]) {
    design(ctx, w, h, G);
    ctx.fillStyle = ctx === g ? '#e3b65a' : '#fff';
    for (const [bx, by, s] of birds) chidori(ctx, bx * W, by, 0.055 * M * s, false);
  }
  // the hoist band: vermilion, a gold line, and pale ties where it meets the pole
  const bw = Math.min(0.075 * M, 0.3 * W);
  g.fillStyle = '#d93d28'; g.fillRect(0, 0, bw, 1);
  mottle(g, R, bw, 1, 25, ['#ff6a4a', '#8a1a10'], 0.3 * bw, bw, 0.15);
  for (const ctx of m ? [g, m] : [g]) {
    design(ctx, w, h, G);
    ctx.fillStyle = ctx === g ? '#e3b65a' : '#fff';
    ctx.fillRect(bw, 0, 0.011 * M, 1); ctx.fillRect(bw * 0.72, 0, 0.004 * M, 1);
  }
  g.fillStyle = 'rgba(244,239,228,0.85)';
  for (let y = 0.2 * M; y < 1; y += 0.3 * M) g.fillRect(0, y, bw * 0.45, 0.025 * M);
  g.fillStyle = 'rgba(10,12,30,0.55)'; g.fillRect(0, 0, W, 0.035 * M);
}

// ----------------------------------------------------------------------------------------- unveil 除幕
// Ivory silk with a tone-on-tone kikkō (tortoiseshell) damask, shells ~30 cm across: barely there in colour;
// the satin turns inside each shell, so the pattern appears and vanishes as the sheen moves.
function unveil(g, w, h, G, R, m) {
  const W = G.aspect, M = 1 / G.mV;
  design(g, w, h, G);
  g.fillStyle = '#eee5d3'; g.fillRect(0, 0, W, 1);
  mottle(g, R, W, 1, 50, ['#f8f2e6', '#e2d6bf'], 0.06, 0.25, 0.3);
  streaks(g, R, W, 1, 160, ['#f9f4ea', '#ddd0b6'], 0.25 * M, 0.004 * M, 0.25, false);
  const a = 0.17 * M, hw = a * Math.sqrt(3) / 2;
  const hexPath = (ctx, cx, cy, r) => { ctx.beginPath(); for (let k = 0; k < 6; k++) { const t = k * TAU / 6; ctx.lineTo(cx + Math.cos(t) * r, cy + Math.sin(t) * r); } ctx.closePath(); };
  for (const ctx of m ? [g, m] : [g]) {
    design(ctx, w, h, G);
    for (let col = -1, x = 0; x < W + a * 2; col++, x = col * a * 1.5) {
      for (let y = (col & 1) ? hw : 0; y < 1 + a * 2; y += hw * 2) {
        // a small six-petalled flower in each shell (petals as circles round a centre)
        const flower = (fill) => {
          ctx.fillStyle = fill;
          for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.arc(x + Math.cos(k * TAU / 6 + TAU / 12) * a * 0.2, y + Math.sin(k * TAU / 6 + TAU / 12) * a * 0.2, a * 0.11, 0, TAU); ctx.fill(); }
          ctx.beginPath(); ctx.arc(x, y, a * 0.08, 0, TAU); ctx.fill();
        };
        if (ctx === g) {
          ctx.strokeStyle = 'rgba(250,246,238,0.85)'; ctx.lineWidth = 0.013 * M; hexPath(ctx, x, y, a); ctx.stroke();
          ctx.strokeStyle = 'rgba(214,200,172,0.55)'; ctx.lineWidth = 0.0055 * M; hexPath(ctx, x, y, a * 0.74); ctx.stroke();
          flower('rgba(214,200,172,0.42)');
          ctx.fillStyle = 'rgba(250,246,238,0.7)'; ctx.beginPath(); ctx.arc(x, y, a * 0.05, 0, TAU); ctx.fill();
        } else {
          ctx.fillStyle = '#fff'; hexPath(ctx, x, y, a * 0.74); ctx.fill();
          flower('#000');
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------------------- embers 火の粉
// Natural linen, almost washi: slubs and flecks in the yarn, and an asanoha (hemp leaf) lattice, 22 cm
// cells, drawn in a rust-brown line: the pattern for things that grow fast and strong.
function embers(g, w, h, G, R) {
  const W = G.aspect, M = 1 / G.mV;
  design(g, w, h, G);
  g.fillStyle = '#d8cbaf'; g.fillRect(0, 0, W, 1);
  mottle(g, R, W, 1, 70, ['#e6dcc4', '#c4b392', '#d0c09e'], 0.04, 0.22, 0.4);
  streaks(g, R, W, 1, 420, ['#b8a582', '#ece3cf', '#a8946f'], 0.12 * M, 0.005 * M, 0.45, false);
  g.fillStyle = 'rgba(70,52,30,0.5)';
  for (let i = 0; i < 500; i++) { const x = R() * W, y = R(); g.fillRect(x, y, (0.002 + R() * 0.007) * M, (0.0015 + R() * 0.0025) * M); }
  // asanoha: a triangular lattice, every triangle joined from its corners to its centre
  const a = 0.22 * M, hh = a * Math.sqrt(3) / 2;
  g.strokeStyle = 'rgba(112,72,44,0.62)'; g.lineWidth = 0.006 * M; g.lineCap = 'round';
  g.beginPath();
  for (let row = -1; row * hh < 1 + hh; row++) {
    const y0 = row * hh, y1 = y0 + hh, off = (row & 1) ? a / 2 : 0;
    for (let x = -a + off; x < W + a; x += a) {
      const up = [[x, y1], [x + a, y1], [x + a / 2, y0]], dn = [[x + a / 2, y0], [x + 1.5 * a, y0], [x + a, y1]];
      for (const T of [up, dn]) {
        const cx = (T[0][0] + T[1][0] + T[2][0]) / 3, cy = (T[0][1] + T[1][1] + T[2][1]) / 3;
        for (let k = 0; k < 3; k++) { g.moveTo(T[k][0], T[k][1]); g.lineTo(T[(k + 1) % 3][0], T[(k + 1) % 3][1]); g.moveTo(T[k][0], T[k][1]); g.lineTo(cx, cy); }
      }
    }
  }
  g.stroke();
  const vg = g.createRadialGradient(W / 2, 0.5, 0.2, W / 2, 0.5, Math.max(W, 1) * 0.75);
  vg.addColorStop(0, 'rgba(90,60,30,0)'); vg.addColorStop(1, 'rgba(90,60,30,0.22)');
  g.fillStyle = vg; g.fillRect(0, 0, W, 1);
}

// ---------------------------------------------------------------------------------------- monsoon 梅雨
// A two-tone striped canvas awning (20 cm stripes) that has seen a few rainy seasons: sun-bleached,
// tide-marked, specked with mildew, with a stitched hem and brass grommets at the corners.
function monsoon(g, w, h, G, R) {
  const W = G.aspect, M = 1 / G.mV;
  design(g, w, h, G);
  const sw = 0.2 * M;
  for (let i = 0, x = 0; x < W; i++, x += sw) {
    g.fillStyle = i % 2 ? '#e7dec9' : '#2e3d7c';
    g.beginPath(); g.moveTo(x, 0);
    for (let y = 0; y <= 1.0001; y += 0.05) g.lineTo(x + (R() - 0.5) * 0.004 * M, y);
    g.lineTo(x + sw + 0.002 * M, 1); g.lineTo(x + sw + 0.002 * M, 0); g.closePath(); g.fill();
  }
  // canvas grain
  const st = 0.01 * M;
  g.globalAlpha = 0.08;
  g.strokeStyle = '#000'; g.lineWidth = 0.002 * M;
  g.beginPath(); for (let y = 0; y < 1; y += st) { g.moveTo(0, y); g.lineTo(W, y); } g.stroke();
  g.strokeStyle = '#fff';
  g.beginPath(); for (let x = 0; x < W; x += st) { g.moveTo(x, 0); g.lineTo(x, 1); } g.stroke();
  g.globalAlpha = 1;
  // sun-bleached toward one side
  const sb = g.createLinearGradient(0, 0, W, 1);
  sb.addColorStop(0, 'rgba(255,248,230,0.28)'); sb.addColorStop(0.6, 'rgba(255,248,230,0.04)'); sb.addColorStop(1, 'rgba(255,248,230,0)');
  g.fillStyle = sb; g.fillRect(0, 0, W, 1);
  mottle(g, R, W, 1, 60, ['#ffffff', '#6b5a3a'], 0.07 * M, 0.3 * M, 0.09);
  // tide marks where water stood and dried
  for (let i = 0; i < 9; i++) {
    const x = R() * W, y = R(), r = (0.08 + R() * 0.18) * M;
    g.strokeStyle = 'rgba(96,74,40,0.22)'; g.lineWidth = (0.006 + R() * 0.006) * M;
    g.beginPath();
    for (let k = 0; k <= 48; k++) { const t = k / 48 * TAU, rr = r * (1 + 0.12 * Math.sin(t * 3 + i) + 0.06 * Math.sin(t * 7 + i * 2)); g.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
    g.stroke();
    const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, 'rgba(120,100,60,0.0)'); rg.addColorStop(0.85, 'rgba(120,100,60,0.08)'); rg.addColorStop(1, 'rgba(120,100,60,0)');
    g.fillStyle = rg; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // mildew specks, clustered
  for (let c = 0; c < 14; c++) {
    const cx = R() * W, cy = R(), sp = (0.03 + R() * 0.1) * M;
    g.fillStyle = 'rgba(40,46,34,0.35)';
    for (let i = 0; i < 40; i++) { const x = cx + (R() - 0.5) * sp * 2, y = cy + (R() - 0.5) * sp * 2, s = (0.0015 + R() * 0.004) * M; g.fillRect(x, y, s, s); }
  }
  // hem with stitching, grommets at the corners
  const hem = 0.055 * M;
  g.fillStyle = 'rgba(30,28,24,0.28)';
  g.fillRect(0, 0, W, hem); g.fillRect(0, 1 - hem, W, hem); g.fillRect(0, 0, hem, 1); g.fillRect(W - hem, 0, hem, 1);
  g.strokeStyle = 'rgba(244,239,228,0.7)'; g.lineWidth = 0.004 * M; g.setLineDash([0.018 * M, 0.012 * M]);
  g.strokeRect(hem * 0.6, hem * 0.6, W - hem * 1.2, 1 - hem * 1.2);
  g.setLineDash([]);
  const gr = 0.038 * M;
  for (const [x, y] of [[hem, hem], [W - hem, hem], [hem, 1 - hem], [W - hem, 1 - hem]]) {
    g.fillStyle = '#3a2c14'; g.beginPath(); g.arc(x, y, gr, 0, TAU); g.fill();
    g.strokeStyle = '#c8962e'; g.lineWidth = gr * 0.38; g.beginPath(); g.arc(x, y, gr * 0.7, 0, TAU); g.stroke();
    g.strokeStyle = 'rgba(255,240,200,0.6)'; g.lineWidth = gr * 0.12; g.beginPath(); g.arc(x - gr * 0.08, y - gr * 0.08, gr * 0.66, Math.PI * 1.1, Math.PI * 1.7); g.stroke();
  }
}

const PAINTERS = {
  noren, banner, unveil, embers, monsoon,
  koinobori: koinoboriBands, 'koinobori-single': koiSingle('red'), 'koinobori-black': koiSingle('black'), 'koinobori-blue': koiSingle('blue'),
  'koinobori-family': carpsAcross,
};

const flatGeo = (aspect) => ({ aspect, mV: 1, aspectAt: () => aspect });

/**
 * Paint print `id` at w × h texels (powers of two) for the given cloth geometry and return
 * { w, h, data: Uint8ClampedArray RGBA, shot: [r, g, b] linear, mask: [damask, gold] }.
 * geo: { aspect, mV (metres per design unit along v), aspectAt(v) } from the rest mesh (render/cloth.js
 * measures it); default a 1 m square.
 */
export function makePrint(id, w = 512, h = w, geo = null) {
  const key = PAINTERS[id] ? id : 'unveil';
  const meta = PRINT_META[key] || PRINT_META.unveil;
  const G = geo || flatGeo(1);
  const mk = () => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const c = mk(), g = c.getContext('2d', { willReadFrequently: true });
  let m = null;
  if (meta.mask) { m = mk().getContext('2d', { willReadFrequently: true }); m.fillStyle = '#000'; m.fillRect(0, 0, w, h); }
  let seed = 0; for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) | 0;
  PAINTERS[key](g, w, h, G, rng(seed ^ 0x51ed), m);
  const data = g.getImageData(0, 0, w, h).data;
  if (m) {
    const md = m.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255 - md[i - 3];
  }
  const s = hex(meta.shot);
  return {
    w, h, data,
    shot: [(s[0] / 255) ** 2, (s[1] / 255) ** 2, (s[2] / 255) ** 2],
    mask: [meta.mask === 'damask' ? 1 : 0, meta.mask === 'gold' ? 1 : 0],
  };
}

/** Every print id (tests and contact sheets). */
export const PRINT_IDS = Object.keys(PAINTERS);
