// WebGL1 helpers shared by every render module. WebGL1 + GLSL ES 1.00 on purpose: it runs on every phone
// that has WebGL at all, and on modern GPUs it is the same driver path as WebGL2.
//
// Texture units (bind only what you use, every draw):  0 print · 1 dye · 2 shadow · 3–6 module-specific · 7 noise
export const UNIT = { PRINT: 0, DYE: 1, SHADOW: 2, A: 3, B: 4, C: 5, D: 6, NOISE: 7 };

export function createGL(canvas) {
  const attrs = { alpha: false, antialias: true, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false };
  const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  if (!gl) return null;
  const ext = {
    deriv: gl.getExtension('OES_standard_derivatives'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic'),
    uint: gl.getExtension('OES_element_index_uint'),
  };
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const pr = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  const caps = { highp: !!(hp && hp.precision > 0), maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxPoint: pr ? pr[1] : 64 };
  return { gl, ext, caps };
}

/**
 * Compile + link. Both shaders get a prelude: the fragment one enables standard derivatives (when present,
 * and defines HAS_DERIV) and picks highp if the GPU has it, else mediump. Attribute and uniform locations
 * are collected into p.a / p.u by name (arrays as `name[0]`).
 */
export function program(glx, vsSrc, fsSrc, name = 'program') {
  const { gl, ext, caps } = glx;
  const fsPre = (ext.deriv ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIV 1\n' : '') + `precision ${caps.highp ? 'highp' : 'mediump'} float;\n`;
  const vsPre = 'precision highp float;\n';
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join('\n');
      throw new Error(`[${name}] ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader: ${log}\n${lines}`);
    }
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsPre + vsSrc));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsPre + fsSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`[${name}] link: ${gl.getProgramInfoLog(prog)}`);
  const p = { prog, a: {}, u: {}, name };
  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(prog, i); p.a[info.name] = gl.getAttribLocation(prog, info.name); }
  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(prog, i); p.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name); }
  return p;
}

// ---- attribute state: enable exactly the attributes a draw uses ----
let enabled = 0;
const MAXA = 16;
/** Enable exactly these attribute locations (array of ints, -1/undefined ignored), disable the rest. */
export function useAttribs(gl, locs) {
  let mask = 0;
  for (let i = 0; i < locs.length; i++) { const l = locs[i]; if (l >= 0) mask |= 1 << l; }
  const diff = mask ^ enabled;
  if (diff) for (let i = 0; i < MAXA; i++) if (diff & (1 << i)) { if (mask & (1 << i)) gl.enableVertexAttribArray(i); else gl.disableVertexAttribArray(i); }
  enabled = mask;
}
/** Bind a float attribute (or skip when the program optimised it out). */
export function attrib(gl, loc, buf, size, type = gl.FLOAT, normalized = false, stride = 0, offset = 0) {
  if (loc === undefined || loc < 0) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
}

export function buffer(gl, target, dataOrSize, usage) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, dataOrSize, usage || gl.STATIC_DRAW);
  return b;
}

/**
 * Texture. opts: { w, h, data (ArrayBufferView | null), source (canvas/image), format = RGBA, type = UNSIGNED_BYTE,
 * filter: 'nearest' | 'linear' | 'mip', wrap: 'clamp' | 'repeat', aniso }. Mipmaps need power-of-two sizes.
 */
export function texture(glx, o) {
  const { gl, ext } = glx;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const fmt = o.format || gl.RGBA, type = o.type || gl.UNSIGNED_BYTE;
  if (o.source) gl.texImage2D(gl.TEXTURE_2D, 0, fmt, fmt, type, o.source);
  else gl.texImage2D(gl.TEXTURE_2D, 0, fmt, o.w, o.h, 0, fmt, type, o.data || null);
  const mip = o.filter === 'mip';
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : o.filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, o.filter === 'nearest' ? gl.NEAREST : gl.LINEAR);
  const wrap = o.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  if (o.aniso && ext.aniso) gl.texParameterf(gl.TEXTURE_2D, ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(o.aniso, gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return t;
}

/** Render target with an RGBA8 colour texture and (optionally) a depth renderbuffer. */
export function target(gl, w, h, { depth = false, filter = 'linear' } = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  let rb = null;
  if (depth) {
    rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, rb, w, h, depth };
}

export function deleteTarget(gl, t) {
  if (!t) return;
  gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); if (t.rb) gl.deleteRenderbuffer(t.rb);
}

/** Bind a target (or null = the screen) and set the viewport to match. */
export function bindTarget(world, t) {
  const gl = world.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  if (t) gl.viewport(0, 0, t.w, t.h); else gl.viewport(0, 0, world.pxWidth, world.pxHeight);
}

// ---- one big triangle that covers the screen ----
let fsBuf = null;
export const FS_VERT = `attribute vec2 aPos; varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const fsLocs = [0];
/** Draw the full-screen triangle with program p (which must use FS_VERT's aPos). */
export function drawFullscreen(gl, p) {
  if (!fsBuf) fsBuf = buffer(gl, gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]));
  fsLocs[0] = p.a.aPos;
  useAttribs(gl, fsLocs);
  attrib(gl, p.a.aPos, fsBuf, 2);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Reset the state every module may assume at the start of its draw (see CONTRACT.md § GL state). */
export function resetState(gl) {
  gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
  gl.disable(gl.CULL_FACE); gl.colorMask(true, true, true, true);
}
