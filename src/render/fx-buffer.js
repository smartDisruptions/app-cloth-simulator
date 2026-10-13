// The one dynamic vertex buffer every particle and the slash trail are written into, once per frame.
// 4 vertices per quad, 36 bytes per vertex (layout in fx-shaders.js); typed views over one ArrayBuffer,
// sized once at module load: nothing here allocates per frame.
//
//   byte  0  aPos    3 × float32   centre (or the corner itself, for prebuilt quads)
//   byte 12  aAxis   3 × int16     streak vector, in 1/4096 m (±8 m)
//   byte 18  aShape  3 × uint16    half-width, half-length in 1/4096 m (≤ 16 m); screen angle in 1/65536 turn
//   byte 24  aColA   4 × uint8
//   byte 28  aColB   4 × uint8
//   byte 32  aMisc   4 × uint8
// Writing it: per vertex v, F[v·9 + 0..2] · I16[v·18 + 6..8] · U16[v·18 + 9..11] · U[v·9 + 6..8].

export const MAX_PARTICLES = 4096;     // ≥ the ultra tier's cap (4000)
export const MAX_TRAIL_QUADS = 448;    // the slash ribbon (96 points × 4 subdivisions) + head glints
export const MAX_QUADS = MAX_PARTICLES + MAX_TRAIL_QUADS; // × 4 vertices < 65 536: 16-bit indices
export const STRIDE = 36;              // bytes per vertex
export const WORDS = 9;                // 32-bit words per vertex
export const QUAD_WORDS = WORDS * 4;
export const UNIT_M = 4096;            // aAxis / aShape units per metre
export const UNIT_TURN = 65536 / (Math.PI * 2); // aShape.z units per radian

const data = new ArrayBuffer(MAX_QUADS * 4 * STRIDE);
export const F = new Float32Array(data);
export const U = new Uint32Array(data);
export const I16 = new Int16Array(data);
export const U16 = new Uint16Array(data);

/** mode bits (aMisc.x). The corner (0..3) rides in aMisc.y above the cell: add CORNER[c] per vertex. */
export const MODE = { LIT: 1, VOL: 2, ADD: 4, DOF: 8, PRE: 16, SCAT: 32 };

const b8 = (x) => (x <= 0 ? 0 : x >= 1 ? 255 : (x * 255 + 0.5) | 0);
/** Four 0..1 floats → one little-endian RGBA8 word (as an int32: the sign bit is just the alpha's top bit). */
export const rgba = (r, g, b, a) => b8(r) | (b8(g) << 8) | (b8(b) << 16) | (b8(a) << 24);
/** aMisc without the corner: mode bits, atlas cell, erosion 0..255, shadow receive 0..255. */
export const misc = (mode, cell, ero, shadow) => mode | (cell << 8) | (ero << 16) | (shadow << 24);
/** What each corner adds to aMisc (corner · 16 in the cell byte). */
export const CORNER = [0, 1 << 12, 2 << 12, 3 << 12];

/** Preallocated views for buffer uploads, in 64-quad steps (WebGL1 has no srcOffset/length overload). */
export const STEP = 64;
export const VIEWS = [];
for (let q = STEP; q < MAX_QUADS + STEP; q += STEP) VIEWS.push(new Uint8Array(data, 0, Math.min(q, MAX_QUADS) * 4 * STRIDE));
export const viewFor = (quads) => VIEWS[Math.max(0, Math.ceil(quads / STEP) - 1)];
