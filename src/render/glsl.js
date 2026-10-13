// Shared GLSL. Every lit shader includes COMMON and calls setCommon(world, p) before drawing, so the whole
// scene agrees on light, fog, exposure and grading. Colours: textures are sRGB-ish, so shaders convert with
// toLinear() before lighting and finish with finish() (fog → tonemap → gamma).
import { UNIT } from './gl.js';

export const COMMON = `
uniform sampler2D uNoise;
uniform vec3 uCamPos;
uniform vec3 uKeyDir; uniform vec3 uKeyCol;
uniform vec3 uSkyCol; uniform vec3 uGndCol;
uniform vec3 uPtPos; uniform vec3 uPtCol;
uniform vec3 uFirePos; uniform vec3 uFireCol;
uniform vec3 uFogCol; uniform float uFogDen;
uniform float uExposure; uniform float uTime;

vec3 toLinear(vec3 c) { return c * c; }
vec3 toGamma(vec3 c) { return sqrt(max(c, 0.0)); }
// tileable noise from the shared texture: r/g fbm, b fibres, a white
vec4 noiseTex(vec2 p) { return texture2D(uNoise, p); }
float fbm(vec2 p) { return texture2D(uNoise, p).r * 0.62 + texture2D(uNoise, p * 2.13 + 0.31).g * 0.38; }
vec3 hemi(vec3 n) { return mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5); }
// point lights fall off with distance; returns colour × falloff × wrapped n·l
vec3 pointLight(vec3 pos, vec3 col, vec3 wp, vec3 n, float wrap) {
  vec3 d = pos - wp; float dd = dot(d, d);
  float ndl = (dot(n, d * inversesqrt(max(dd, 1e-6))) + wrap) / (1.0 + wrap);
  return col * max(ndl, 0.0) / (1.0 + dd);
}
vec3 tonemap(vec3 c) { c *= uExposure; return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0); }
vec3 fog(vec3 c, vec3 wp) { float f = 1.0 - exp(-uFogDen * length(wp - uCamPos)); return mix(c, uFogCol, clamp(f, 0.0, 1.0)); }
vec3 finish(vec3 c, vec3 wp) { return toGamma(tonemap(fog(c, wp))); }
`;

/** Sampling the coloured shadow map. Receivers include it and call shadowAt(worldPos). */
export const SHADOW = `
uniform sampler2D uShadow; uniform mat4 uShadowMat; uniform float uShadowOn;
// The map holds transmittance colour in rgb and the NEAREST cloth's depth (0..1) in alpha (0 when the GPU
// lacks EXT_blend_minmax, which turns the depth test off). A receiver behind a point light, or nearer the
// light than the nearest cloth, is fully lit.
vec3 shadowAt(vec3 wp) {
  if (uShadowOn < 0.5) return vec3(1.0);
  vec4 s = uShadowMat * vec4(wp, 1.0);
  if (s.w <= 0.0) return vec3(1.0);
  vec3 p = s.xyz / s.w;
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) return vec3(1.0);
  vec4 t = texture2D(uShadow, p.xy);
  return p.z < t.a - 0.01 ? vec3(1.0) : t.rgb;
}
`;

/** Set every COMMON uniform the program uses, and bind the noise texture to UNIT.NOISE. */
export function setCommon(world, p) {
  const gl = world.gl, u = p.u, L = world.lights;
  if (u.uNoise) { gl.activeTexture(gl.TEXTURE0 + UNIT.NOISE); gl.bindTexture(gl.TEXTURE_2D, world.gpu.noiseTex); gl.uniform1i(u.uNoise, UNIT.NOISE); }
  if (u.uCamPos) gl.uniform3fv(u.uCamPos, world.camera.pos);
  if (u.uKeyDir) gl.uniform3fv(u.uKeyDir, L.keyDir);
  if (u.uKeyCol) gl.uniform3fv(u.uKeyCol, L.keyCol);
  if (u.uSkyCol) gl.uniform3fv(u.uSkyCol, L.sky);
  if (u.uGndCol) gl.uniform3fv(u.uGndCol, L.ground);
  if (u.uPtPos) gl.uniform3fv(u.uPtPos, L.pointPos);
  if (u.uPtCol) gl.uniform3fv(u.uPtCol, L.pointCol);
  if (u.uFirePos) gl.uniform3fv(u.uFirePos, L.firePos);
  if (u.uFireCol) gl.uniform3fv(u.uFireCol, L.fireCol);
  if (u.uFogCol) gl.uniform3fv(u.uFogCol, L.fogCol);
  if (u.uFogDen) gl.uniform1f(u.uFogDen, L.fogDensity);
  if (u.uExposure) gl.uniform1f(u.uExposure, L.exposure);
  if (u.uTime) gl.uniform1f(u.uTime, world.time);
}

/** Set the SHADOW uniforms (binds the shadow map to UNIT.SHADOW). */
export function setShadow(world, p) {
  const gl = world.gl, u = p.u, g = world.gpu;
  if (u.uShadowOn) gl.uniform1f(u.uShadowOn, g.shadowTex && g.shadowOn ? 1 : 0);
  if (u.uShadowMat) gl.uniformMatrix4fv(u.uShadowMat, false, g.shadowMat);
  if (u.uShadow && g.shadowTex) { gl.activeTexture(gl.TEXTURE0 + UNIT.SHADOW); gl.bindTexture(gl.TEXTURE_2D, g.shadowTex); gl.uniform1i(u.uShadow, UNIT.SHADOW); }
}
