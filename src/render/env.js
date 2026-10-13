// Environment: sky, floor, props, reflections and their glow. Owned by the scenes+environment agent.
//
// A frame (draw):
//   1. props: one static mesh, sorted near → far; up to three bones (world.scene.env.bones) animate parts.
//   2. sky + floor, one full-screen pass drawn at the far plane behind the props, so it only shades what they
//      leave uncovered. The floor is ray-traced (infinite, seamless horizon) and lit by key/point/fire light,
//      the cloth's coloured shadow (shadowAt), contact AO and a wet sheen with rain ripples.
//   3. reflections, when the floor is wet or polished: the cloth, then the props, mirrored in the floor and
//      blended by the floor's per-pixel reflectivity (props get a depth pre-pass so only the nearest layer shows).
// drawEmissive: glowing props (lamps, the moon) and black occluders, then the sun or moon glow behind them.
//   4. light beams (a spotlight's cone in dusty air), additive, when the scene has them.
// That is 2 draw calls on a dry floor, 6 on a reflective one (+1 for a beam), plus 1–2 into the bloom buffer.
//
// world.scene.env (written by the scene in build(); see scenes/util.js for the helpers and the field list):
//   sky:   { zenith, mid, midAt, horizon, nadir, haze, curve, hazeAmt, hazeK, k, sun, moon, clouds, stars, hills, glow }
//   floor: { y, kind: 'pavers'|'boards'|'grass'|'polished'|'earth', a, b, joint, scale, bump, fade, horizon,
//            polish, wet, rainWet, puddles, ripples, cloudShadow }
//   props: [...] (render/env-mesh.js), ao/puddles/wear blobs, aoRect, aperture, spot, casters, beams,
//   lamp2: { pos, col, k } (a second lamp that lights only the environment, e.g. a lantern off to the side),
//   bones: [mat4 × 3], gains: Float32Array(4), birdPos: Float32Array(4 × sky.birds)   ← the scene's update()
//   animates these (birdPos: azimuth, elevation, size, wing phase per bird)
import { program, buffer, texture, useAttribs, attrib, drawFullscreen, UNIT } from './gl.js';
import { COMMON, SHADOW, setCommon, setShadow } from './glsl.js';
import { SKY_VS, skyFS, glowFS, PROP_VS, propFS, propEmiFS, MCLOTH_VS, MCLOTH_DEPTH_FS, mclothFS, DEPTH_FS, BEAM_VS, beamFS } from './env-glsl.js';
import { bakeProps, bakeFloorMap, bakeBeams, STRIDE, rgb } from './env-mesh.js';

const FLOORS = { none: 0, pavers: 1, boards: 2, grass: 3, polished: 4, earth: 5 };
// rough colour of each material for the cloth's reflection (the cloth renderer owns the real look)
const MIRROR_TINT = { cotton: [1, 1, 1], silk: [1, 1, 1], denim: [0.55, 0.68, 1], velvet: [0.8, 0.75, 0.8], chainmail: [0.5, 0.52, 0.55], aurora: [0.9, 0.95, 1] };

/** Prop vertex count (tests). */
export const propVerts = () => propCount;
/** Test switches (tests/scenes-diag.mjs times each pass; tests/scenes-mirror.mjs checks the cloth's reflection). */
export const debug = { sky: true, mirror: true, mirrorCloth: true, props: true, emissive: true, propsTrivial: false };

const cache = new Map();
let glx = null, E = null, Qname = '', Q = 0, floorY = 0;
let PSKY = null, PGLOW = null, PPROP = null, PMIR = null, PEMI = null, PMCL = null, PMCD = null, PDEP = null, PBEAM = null;
let beamBuf = null, beamCount = 0;
let propBuf = null, propCount = 0, floorTex = null, dummyDye = null, hasGlow = false;
let wet = 0, lastSceneKey = '', animated = false, glowing = false;

const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const ONES = new Float32Array([1, 1, 1, 1]);
const U = {
  zenith: new Float32Array(3), horizon: new Float32Array(3), skyMid: new Float32Array(4), nadir: new Float32Array(3), skyK: new Float32Array(4), haze: new Float32Array(3),
  sunDir: new Float32Array(3), sunCol: new Float32Array(3), sunG: new Float32Array(4),
  moonDir: new Float32Array(3), moonCol: new Float32Array(3), moonB: new Float32Array(4), moonC: new Float32Array(4), moonPh: new Float32Array(2),
  cloudA: new Float32Array(4), cloudB: new Float32Array(4), cloudLit: new Float32Array(3), cloudShade: new Float32Array(3), stars: 0,
  hillA: new Float32Array(12), hillB: new Float32Array(12), hillC: new Float32Array(12), hillTop: 0,
  floor: new Float32Array(4), floorA: new Float32Array(3), floorB: new Float32Array(3), floorJ: new Float32Array(3), floorK: new Float32Array(4),
  aoRect: new Float32Array(4), aper: new Float32Array(4), aperZ: new Float32Array(2), spotA: new Float32Array(4), spotB: new Float32Array(4),
  shSel: new Float32Array(2), cast: new Float32Array(16),
  mirror: new Float32Array(2), eyeM: new Float32Array(3),
  glowDir: new Float32Array(3), glowCol: new Float32Array(3), glowR: new Float32Array(2), emiK: 0.5,
  tint: new Float32Array(3), beamCol: new Float32Array(3), birdCol: new Float32Array(3), l2Pos: new Float32Array(3), l2Col: new Float32Array(3),
};
const beamLocs = [0, 0, 0];
const propLocs = [0, 0, 0, 0, 0, 0];
const clothLocs = [0, 0, 0, 0];

// ---------------------------------------------------------------- helpers (load time only)
function lin3(out, c, k = 1) { const v = rgb(c); out[0] = v[0] * v[0] * k; out[1] = v[1] * v[1] * k; out[2] = v[2] * v[2] * k; return out; }
function unit3(out, v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; out[0] = v[0] / l; out[1] = v[1] / l; out[2] = v[2] / l; return out; }
const qualityOf = (w) => (w.q.name === 'low' ? 0 : w.q.name === 'mid' ? 1 : 2);

function getProgram(key, vs, fs, name) {
  let p = cache.get(key);
  if (!p) { p = program(glx, vs, fs, name); cache.set(key, p); }
  return p;
}

function variant(world) {
  const sk = E.sky || {}, fl = E.floor || {};
  const hills = Math.min(3, (sk.hills || []).length), casters = Math.min(4, (E.casters || []).length);
  const floorKind = fl.kind ? FLOORS[fl.kind] || 0 : 0;
  return {
    QUALITY: Q,
    FLOOR: floorKind,
    SUN: sk.sun ? 1 : 0,
    MOON: sk.moon ? 1 : 0,
    CLOUDS: sk.clouds ? 1 : 0,
    STARS: sk.stars ? 1 : 0,
    HILLS: hills,
    BIRDS: Math.min(6, (sk.birds | 0)),
    CASTERS: floorKind ? casters : 0,
    CLOUDSHADOW: floorKind && sk.clouds && fl.cloudShadow ? 1 : 0,
    RIPPLES: floorKind && Q > 0 && fl.ripples !== false ? 1 : 0,
    PUDDLES: floorKind && fl.puddles ? 1 : 0,
    APER: E.aperture ? 1 : 0,
    SPOT: E.spot ? 1 : 0,
  };
}

function fillUniforms(world) {
  const sk = E.sky || {}, fl = E.floor || {};
  lin3(U.zenith, sk.zenith == null ? 0x0d0f1c : sk.zenith);
  lin3(U.horizon, sk.horizon == null ? 0x2a2c3a : sk.horizon);
  lin3(U.nadir, sk.nadir == null ? (sk.horizon == null ? 0x1a1a22 : sk.horizon) : sk.nadir);
  lin3(U.haze, sk.haze == null ? (sk.horizon == null ? 0x2a2c3a : sk.horizon) : sk.haze, sk.hazeK2 || 1);
  U.skyK[0] = sk.curve == null ? 0.55 : sk.curve; U.skyK[1] = sk.hazeAmt == null ? 0.8 : sk.hazeAmt;
  U.skyK[2] = sk.hazeK == null ? 14 : sk.hazeK; U.skyK[3] = sk.k == null ? 1 : sk.k;
  if (sk.mid != null) { lin3(U.skyMid, sk.mid); U.skyMid[3] = sk.midAt == null ? 0.4 : sk.midAt; }
  else { for (let i = 0; i < 3; i++) U.skyMid[i] = (U.horizon[i] + U.zenith[i]) / 2; U.skyMid[3] = 0.5; }
  const s = sk.sun;
  if (s) { unit3(U.sunDir, s.dir); lin3(U.sunCol, s.col == null ? 0xfff0d0 : s.col, s.k == null ? 1 : s.k); U.sunG.set([s.r || 0.03, s.pow || 600, s.tight == null ? 0.6 : s.tight, s.wide == null ? 0.2 : s.wide]); }
  const m = sk.moon;
  if (m) {
    unit3(U.moonDir, m.dir); lin3(U.moonCol, m.col == null ? 0xf1e3c0 : m.col, m.k == null ? 1.6 : m.k);
    const d = U.moonDir, up = Math.abs(d[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    let rx = d[1] * up[2] - d[2] * up[1], ry = d[2] * up[0] - d[0] * up[2], rz = d[0] * up[1] - d[1] * up[0];
    const rl = Math.hypot(rx, ry, rz); rx /= rl; ry /= rl; rz /= rl;
    U.moonB.set([rx, ry, rz, m.r || 0.035]);
    U.moonC.set([ry * d[2] - rz * d[1], rz * d[0] - rx * d[2], rx * d[1] - ry * d[0], m.glow == null ? 1 : m.glow]);
    U.moonPh.set(m.phase || [0, 0]);
    if (!m.phase) { U.moonPh[0] = 9; }
  }
  const c = sk.clouds;
  if (c) {
    U.cloudA.set([c.cover == null ? 0.55 : c.cover, c.soft == null ? 0.18 : c.soft, c.scale == null ? 0.5 : c.scale, c.stretch || 1]);
    U.cloudB.set([(c.drift || [0.01, 0.003])[0], (c.drift || [0.01, 0.003])[1], c.opacity == null ? 1 : c.opacity, c.silver == null ? 0.6 : c.silver]);
    lin3(U.cloudLit, c.lit == null ? 0xffffff : c.lit, c.k == null ? 1 : c.k); lin3(U.cloudShade, c.shade == null ? 0x9aa3b5 : c.shade, c.k == null ? 1 : c.k);
  }
  U.stars = sk.stars || 0;
  U.hillA.fill(0); U.hillB.fill(0); U.hillC.fill(0); U.hillTop = -1;
  (sk.hills || []).slice(0, 3).forEach((h, i) => {
    U.hillTop = Math.max(U.hillTop, (h.y == null ? 0.02 : h.y) + (h.amp == null ? 0.04 : h.amp) * 0.7 + (h.bump || 0) + 0.01);
    U.hillA.set([h.y == null ? 0.02 : h.y, h.amp == null ? 0.04 : h.amp, h.freq || 3, h.row == null ? (i * 0.31 + 0.13) : h.row], i * 4);
    const col = lin3(new Float32Array(3), h.col == null ? 0x303040 : h.col, h.k == null ? 1 : h.k);
    U.hillB.set([col[0], col[1], col[2], h.bump || 0], i * 4);
    U.hillC.set([h.haze == null ? 0.6 : h.haze, h.rim || 0, h.bumpFreq || 40, h.bumpSharp || 1], i * 4);
  });
  floorY = fl.y || 0;
  U.floor.set([floorY, fl.polish || 0, 0, 0]);
  lin3(U.floorA, fl.a == null ? 0x6b6660 : fl.a); lin3(U.floorB, fl.b == null ? 0x58534d : fl.b); lin3(U.floorJ, fl.joint == null ? 0x2a2723 : fl.joint);
  U.floorK.set([fl.scale || 1, fl.bump == null ? 0.12 : fl.bump, fl.fade || 14, fl.horizon || 22]);
  const ap = E.aperture;
  if (ap) { U.aper.set([ap.x0, ap.x1, ap.y0, ap.y1]); U.aperZ.set([ap.z, 1]); } else { U.aper.fill(0); U.aperZ.set([0, 0]); }
  const sp = E.spot;
  if (sp) {
    const d = unit3(new Float32Array(3), sp.dir);
    U.spotA.set([sp.pos[0], sp.pos[1], sp.pos[2], Math.cos((sp.outer || 30) * Math.PI / 180)]);
    U.spotB.set([d[0], d[1], d[2], Math.cos((sp.inner || 15) * Math.PI / 180)]);
  } else { U.spotA.fill(0); U.spotB.fill(0); }
  U.cast.fill(0);
  (E.casters || []).slice(0, 4).forEach((c4, i) => U.cast.set(c4, i * 4));
  const g = sk.glow;
  hasGlow = !!(g && (s || m));
  if (hasGlow) {
    const src = g === 'moon' || (!s && m) ? m : s;
    unit3(U.glowDir, src.dir); lin3(U.glowCol, src.col == null ? 0xfff0d0 : src.col, g.k || 1);
    U.glowR.set([src.r || 0.03, g.halo || 2.5]);
  }
  U.emiK = E.emiK == null ? 0.55 : E.emiK;
  if (sk.birds) lin3(U.birdCol, sk.birdCol == null ? 0x1a1018 : sk.birdCol);
  const l2 = E.lamp2;
  if (l2) { U.l2Pos.set(l2.pos); lin3(U.l2Col, l2.col, l2.k == null ? 1 : l2.k); } else { U.l2Pos.fill(0); U.l2Col.fill(0); }
}

// ---------------------------------------------------------------- hooks
export function init(world) {
  glx = world.glx;
  dummyDye = texture(glx, { w: 1, h: 1, data: new Uint8Array([255, 255, 255, 0]) });
}

export function onScene(world) {
  const gl = world.gl;
  E = world.scene.env || {};
  Qname = world.q.name; Q = qualityOf(world);
  E.bones = E.bones || [new Float32Array(IDENT), new Float32Array(IDENT), new Float32Array(IDENT)];
  E.gains = E.gains || new Float32Array(ONES);
  fillUniforms(world);
  const D = variant(world), key = JSON.stringify(D);
  PSKY = getProgram('sky' + key, SKY_VS, skyFS(D, COMMON, SHADOW), 'env-sky');
  // every macro a chunk tests with #if must be defined (GLSL ES 1.00 makes undefined ones an error)
  const GD = { QUALITY: Q, HILLS: D.HILLS, SUN: 0, MOON: 0, CLOUDS: 0, STARS: 0, BIRDS: 0, APER: 0, SPOT: 0 };
  PGLOW = hasGlow ? getProgram('glow' + JSON.stringify(GD), SKY_VS, glowFS(GD, COMMON), 'env-glow') : null;
  const PD = { QUALITY: Q, APER: D.APER, SPOT: D.SPOT }, pk = JSON.stringify(PD);
  PPROP = getProgram('prop' + pk, PROP_VS, propFS(PD, COMMON, SHADOW, false), 'env-props');
  PMIR = getProgram('mirror' + pk, PROP_VS, propFS(PD, COMMON, SHADOW, true), 'env-props-mirror');
  PEMI = getProgram('emi', PROP_VS, propEmiFS(COMMON), 'env-emissive');
  PDEP = getProgram('depth', PROP_VS, DEPTH_FS, 'env-depth');
  PMCL = getProgram('mcloth' + pk, MCLOTH_VS, mclothFS(PD, COMMON), 'env-cloth-mirror');
  PMCD = getProgram('mcloth-depth', MCLOTH_VS, MCLOTH_DEPTH_FS, 'env-cloth-mirror-depth');

  // sort props near → far from where the camera will be, so early-z rejects hidden pixels
  const r = world.cameraRig, dl = Math.hypot(r.dir[0], r.dir[1], r.dir[2]) || 1;
  const eye = [r.target[0] - r.dir[0] / dl * 7, r.target[1] - r.dir[1] / dl * 7, r.target[2] - r.dir[2] / dl * 7];
  const mesh = bakeProps(E.props || [], floorY, eye);
  animated = (E.props || []).some((p) => (p.bone | 0) > 0);
  glowing = (E.props || []).some((p) => p.emi != null);
  const pt = world.lights.shadow.type === 'point';
  U.shSel[0] = pt ? 0 : 1; U.shSel[1] = pt ? 1 : 0;
  stamp++;
  if (propBuf) gl.deleteBuffer(propBuf);
  propBuf = mesh.count ? buffer(gl, gl.ARRAY_BUFFER, mesh.data) : null;
  propCount = mesh.count;

  const bm = bakeBeams(E.beams);
  if (beamBuf) gl.deleteBuffer(beamBuf);
  beamBuf = bm.count ? buffer(gl, gl.ARRAY_BUFFER, bm.data) : null;
  beamCount = bm.count;
  if (beamCount) {
    PBEAM = getProgram('beam', BEAM_VS, beamFS(COMMON), 'env-beam');
    const B = E.beams[0];
    lin3(U.beamCol, B.col == null ? 0xfff0d8 : B.col, B.k == null ? 0.08 : B.k);
  }

  const fm = bakeFloorMap(E, floorY, Q === 0 ? 64 : 128);
  if (floorTex) gl.deleteTexture(floorTex);
  floorTex = texture(glx, { w: fm.size, h: fm.size, data: fm.data, filter: 'linear', wrap: 'clamp' });
  U.aoRect.set([fm.rect[0], fm.rect[1], 1 / fm.rect[2], 1 / fm.rect[3]]);

  // a new scene starts as dry as its own floor; a reset of the same scene keeps the wetness
  const sk = world.sceneId + Qname;
  if (sk !== lastSceneKey) wet = Math.min(1, (E.floor && E.floor.wet) || 0);
  lastSceneKey = sk;
}

// ---------------------------------------------------------------- per frame
// Uniform values live in each program, so everything that only changes with the scene is uploaded once
// per program per scene build (stamped), and a frame sends only what moves: camera, lights (setCommon),
// the shadow map, wetness, rain, bones, glow gains, birds.
let stamp = 1;

/** Upload the scene's constant uniforms into program p (once per program per scene build). m: mirror flag. */
function constants(world, p, m) {
  if (p.envStamp === stamp) return;
  p.envStamp = stamp;
  const gl = world.gl, u = p.u;
  if (u.uAoRect) gl.uniform4fv(u.uAoRect, U.aoRect);
  if (u.uAo) gl.uniform1i(u.uAo, UNIT.A);
  if (u.uAper) gl.uniform4fv(u.uAper, U.aper);
  if (u.uAperZ) gl.uniform2fv(u.uAperZ, U.aperZ);
  if (u.uSpotA) gl.uniform4fv(u.uSpotA, U.spotA);
  if (u.uSpotB) gl.uniform4fv(u.uSpotB, U.spotB);
  if (u.uShSel) gl.uniform2fv(u.uShSel, U.shSel);
  if (u.uHaze) gl.uniform3fv(u.uHaze, U.haze);
  if (u.uL2Pos) { gl.uniform3fv(u.uL2Pos, U.l2Pos); gl.uniform3fv(u.uL2Col, U.l2Col); }
  if (u.uZenith) gl.uniform3fv(u.uZenith, U.zenith);
  if (u.uHorizon) gl.uniform3fv(u.uHorizon, U.horizon);
  if (u.uNadir) gl.uniform3fv(u.uNadir, U.nadir);
  if (u.uSkyK) gl.uniform4fv(u.uSkyK, U.skyK);
  if (u.uSkyMid) gl.uniform4fv(u.uSkyMid, U.skyMid);
  if (u.uSunDir) { gl.uniform3fv(u.uSunDir, U.sunDir); gl.uniform3fv(u.uSunCol, U.sunCol); gl.uniform4fv(u.uSunG, U.sunG); }
  if (u.uMoonDir) { gl.uniform3fv(u.uMoonDir, U.moonDir); gl.uniform3fv(u.uMoonCol, U.moonCol); gl.uniform4fv(u.uMoonB, U.moonB); gl.uniform4fv(u.uMoonC, U.moonC); gl.uniform2fv(u.uMoonPh, U.moonPh); }
  if (u.uCloudA) { gl.uniform4fv(u.uCloudA, U.cloudA); gl.uniform4fv(u.uCloudB, U.cloudB); }
  if (u.uCloudLit) { gl.uniform3fv(u.uCloudLit, U.cloudLit); gl.uniform3fv(u.uCloudShade, U.cloudShade); }
  if (u.uStars) gl.uniform1f(u.uStars, U.stars);
  if (u.uHillA) { gl.uniform4fv(u.uHillA, U.hillA); gl.uniform4fv(u.uHillB, U.hillB); gl.uniform4fv(u.uHillC, U.hillC); gl.uniform1f(u.uHillTop, U.hillTop); }
  if (u.uFloorA) { gl.uniform3fv(u.uFloorA, U.floorA); gl.uniform3fv(u.uFloorB, U.floorB); gl.uniform3fv(u.uFloorJ, U.floorJ); }
  if (u.uFloorK) gl.uniform4fv(u.uFloorK, U.floorK);
  if (u.uCast) gl.uniform4fv(u.uCast, U.cast);
  if (u.uBirdCol) gl.uniform3fv(u.uBirdCol, U.birdCol);
  if (u.uMirror) { U.mirror[0] = m; U.mirror[1] = floorY; gl.uniform2fv(u.uMirror, U.mirror); }
  if (u.uMirrorY) gl.uniform1f(u.uMirrorY, floorY);
  if (u.uEmiK) gl.uniform1f(u.uEmiK, U.emiK);
  if (u.uPrint) gl.uniform1i(u.uPrint, UNIT.PRINT);
  if (u.uDye) gl.uniform1i(u.uDye, UNIT.DYE);
  if (u.uBeamCol) gl.uniform3fv(u.uBeamCol, U.beamCol);
  if (u.uGlowDir) { gl.uniform3fv(u.uGlowDir, U.glowDir); gl.uniform3fv(u.uGlowCol, U.glowCol); gl.uniform2fv(u.uGlowR, U.glowR); }
  if (u.uB1 && !animated) { gl.uniformMatrix4fv(u.uB1, false, E.bones[0]); gl.uniformMatrix4fv(u.uB2, false, E.bones[1]); gl.uniformMatrix4fv(u.uB3, false, E.bones[2]); }
}

/** Per-frame environment uniforms: wetness, and the floor map bound to its unit. */
function dynamicEnv(world, p) {
  const gl = world.gl, u = p.u;
  if (u.uFloor) gl.uniform4fv(u.uFloor, U.floor);
  if (u.uAo) { gl.activeTexture(gl.TEXTURE0 + UNIT.A); gl.bindTexture(gl.TEXTURE_2D, floorTex); }
  if (u.uRain) gl.uniform1f(u.uRain, world.rain.intensity);
  if (u.uBird && E.birdPos) gl.uniform4fv(u.uBird, E.birdPos);
}

function bindProps(world, p) {
  const gl = world.gl, a = p.a, s = STRIDE * 4;
  propLocs[0] = a.aPos; propLocs[1] = a.aNrm; propLocs[2] = a.aCol; propLocs[3] = a.aEmi; propLocs[4] = a.aMat; propLocs[5] = a.aUvB;
  useAttribs(gl, propLocs);
  attrib(gl, a.aPos, propBuf, 3, gl.FLOAT, false, s, 0);
  attrib(gl, a.aNrm, propBuf, 3, gl.FLOAT, false, s, 12);
  attrib(gl, a.aCol, propBuf, 4, gl.FLOAT, false, s, 24);
  attrib(gl, a.aEmi, propBuf, 4, gl.FLOAT, false, s, 40);
  attrib(gl, a.aMat, propBuf, 4, gl.FLOAT, false, s, 56);
  attrib(gl, a.aUvB, propBuf, 3, gl.FLOAT, false, s, 72);
  const u = p.u;
  gl.uniformMatrix4fv(u.uViewProj, false, world.camera.viewProj);
  if (animated && u.uB1) { gl.uniformMatrix4fv(u.uB1, false, E.bones[0]); gl.uniformMatrix4fv(u.uB2, false, E.bones[1]); gl.uniformMatrix4fv(u.uB3, false, E.bones[2]); }
  if (glowing && u.uGain) gl.uniform4fv(u.uGain, E.gains);
}

/** The cloth's buffers (published by cloth-render) for a mirrored-cloth program. */
function bindMirrorCloth(world, p, gc) {
  const gl = world.gl, a = p.a;
  clothLocs[0] = a.aPos; clothLocs[1] = a.aNrm; clothLocs[2] = a.aUV; clothLocs[3] = a.aFx;
  useAttribs(gl, clothLocs);
  attrib(gl, a.aPos, gc.pos, 3); attrib(gl, a.aNrm, gc.nrm, 3); attrib(gl, a.aUV, gc.uv, 2);
  // heat, fuel, char, wet: the first 4 of cloth-render's 8 normalised bytes (or 4 floats from a plain uploader)
  if (gc.fxStride) attrib(gl, a.aFx, gc.fx, 4, gl.UNSIGNED_BYTE, true, gc.fxStride, 0); else attrib(gl, a.aFx, gc.fx, 4);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gc.index);
  gl.uniformMatrix4fv(p.u.uViewProj, false, world.camera.viewProj);
}

/** Can the cloth's mirror image (its bounds reflected in the floor) reach the screen? Clip-space planes, so a
 *  corner behind the camera needs no special case; hidden only when all 8 corners are outside one plane. */
function mirrorOnScreen(m, b, fy) {
  let l = 0, r = 0, d = 0, u = 0;
  for (let k = 0; k < 8; k++) {
    const x = k & 1 ? b.max[0] : b.min[0], y = 2 * fy - (k & 2 ? b.max[1] : b.min[1]), z = k & 4 ? b.max[2] : b.min[2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    if (cx < -w) l++; if (cx > w) r++; if (cy < -w) d++; if (cy > w) u++;
  }
  return l < 8 && r < 8 && d < 8 && u < 8;
}

/** Ease the floor's wetness toward what the rain and the scene want (simulated time). */
function updateWet(world) {
  const fl = E.floor; if (!fl) return;
  const target = Math.min(1, (fl.wet || 0) + world.rain.intensity * (fl.rainWet == null ? 1 : fl.rainWet));
  const dt = world.dt;
  wet += (target - wet) * Math.min(1, dt * (target > wet ? 0.35 : 0.06));
  U.floor[2] = wet;
  U.floor[3] = (fl.puddles || 0) * Math.min(1, Math.max(0, wet * 1.5 - 0.25));
}

export function draw(world) {
  if (!PSKY) return;
  const gl = world.gl, cam = world.camera;
  updateWet(world);

  // 1. props first: they write depth, so the sky + floor pass skips every pixel they cover
  if (debug.propsTrivial && propCount) {
    gl.useProgram(PDEP.prog); bindProps(world, PDEP); U.mirror[0] = 0; U.mirror[1] = floorY; gl.uniform2fv(PDEP.u.uMirror, U.mirror); PDEP.envStamp = 0;
    gl.drawArrays(gl.TRIANGLES, 0, propCount);
  } else if (debug.props && propCount) {
    gl.useProgram(PPROP.prog);
    constants(world, PPROP, 0);
    setCommon(world, PPROP); setShadow(world, PPROP); dynamicEnv(world, PPROP);
    bindProps(world, PPROP);
    gl.uniform3fv(PPROP.u.uEyeS, cam.pos);
    gl.drawArrays(gl.TRIANGLES, 0, propCount);
    world.stats.drawCalls++;
  }

  // 2. sky + floor behind them (depth tested at the far plane, no depth write)
  if (debug.sky) {
    gl.depthMask(false);
    gl.useProgram(PSKY.prog);
    constants(world, PSKY, 0);
    setCommon(world, PSKY); setShadow(world, PSKY); dynamicEnv(world, PSKY);
    gl.uniformMatrix4fv(PSKY.u.uInvViewProj, false, cam.invViewProj);
    gl.uniform3fv(PSKY.u.uEye, cam.pos);
    drawFullscreen(gl, PSKY);
    gl.depthMask(true);
    world.stats.drawCalls++;
  }

  // 3. reflections in a wet or polished floor (real props in front already hide what they should)
  const reflective = E.floor && E.reflect !== false && (U.floor[1] > 0.02 || U.floor[2] > 0.04);
  if (debug.mirror && reflective && cam.pos[1] > floorY) {
    U.eyeM[0] = cam.pos[0]; U.eyeM[1] = 2 * floorY - cam.pos[1]; U.eyeM[2] = cam.pos[2];
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // the cloth first. Its depth goes in before its colour, so where the sheet folds over itself only the
    // nearest layer reflects, and a prop it covers (the moon under the sheet) stays hidden in the mirror.
    const gc = world.gpu.cloth, cb = world.cloth && world.cloth.bounds;
    if (debug.mirrorCloth && gc && gc.count && world.gpu.printTex && (!cb || mirrorOnScreen(cam.viewProj, cb, floorY))) {
      gl.useProgram(PMCD.prog);
      constants(world, PMCD, 1);
      bindMirrorCloth(world, PMCD, gc);
      gl.colorMask(false, false, false, false);
      gl.drawElements(gl.TRIANGLES, gc.count, gl.UNSIGNED_SHORT, 0);
      gl.colorMask(true, true, true, true);
      world.stats.drawCalls++;
      gl.useProgram(PMCL.prog);
      constants(world, PMCL, 1);
      setCommon(world, PMCL); dynamicEnv(world, PMCL);
      bindMirrorCloth(world, PMCL, gc);
      const t = MIRROR_TINT[world.materialId] || MIRROR_TINT.cotton;
      U.tint[0] = t[0]; U.tint[1] = t[1]; U.tint[2] = t[2];
      gl.uniform3fv(PMCL.u.uTint, U.tint);
      gl.activeTexture(gl.TEXTURE0 + UNIT.PRINT); gl.bindTexture(gl.TEXTURE_2D, world.gpu.printTex);
      gl.activeTexture(gl.TEXTURE0 + UNIT.DYE); gl.bindTexture(gl.TEXTURE_2D, world.gpu.dyeTex || dummyDye);
      gl.depthFunc(gl.EQUAL); gl.depthMask(false);
      gl.drawElements(gl.TRIANGLES, gc.count, gl.UNSIGNED_SHORT, 0);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      world.stats.drawCalls++;
    }
    if (propCount) {
      // a depth pre-pass (trivial shader) so overlapping props reflect once (skipped on the low tier)
      if (Q > 0) {
        gl.useProgram(PDEP.prog);
        constants(world, PDEP, 1);
        bindProps(world, PDEP);
        gl.colorMask(false, false, false, false);
        gl.drawArrays(gl.TRIANGLES, 0, propCount);
        gl.colorMask(true, true, true, true);
        gl.depthFunc(gl.EQUAL); gl.depthMask(false);
        world.stats.drawCalls++;
      }
      gl.useProgram(PMIR.prog);
      constants(world, PMIR, 1);
      setCommon(world, PMIR); setShadow(world, PMIR); dynamicEnv(world, PMIR);
      bindProps(world, PMIR);
      gl.uniform3fv(PMIR.u.uEyeS, U.eyeM);
      gl.drawArrays(gl.TRIANGLES, 0, propCount);
      gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
      world.stats.drawCalls++;
    }
    gl.disable(gl.BLEND);
  }

  // 4. light beams: dust in a spotlight, added over what is behind them (props in front hide them)
  if (beamCount) {
    gl.useProgram(PBEAM.prog);
    constants(world, PBEAM, 0);
    setCommon(world, PBEAM);
    const a = PBEAM.a, s = 28;
    beamLocs[0] = a.aPos; beamLocs[1] = a.aNrm; beamLocs[2] = a.aT;
    useAttribs(gl, beamLocs);
    attrib(gl, a.aPos, beamBuf, 3, gl.FLOAT, false, s, 0); attrib(gl, a.aNrm, beamBuf, 3, gl.FLOAT, false, s, 12); attrib(gl, a.aT, beamBuf, 1, gl.FLOAT, false, s, 24);
    gl.uniformMatrix4fv(PBEAM.u.uViewProj, false, cam.viewProj);
    gl.uniform3fv(PBEAM.u.uEyeS, cam.pos);
    gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.TRIANGLES, 0, beamCount);
    gl.disable(gl.BLEND); gl.depthMask(true);
    world.stats.drawCalls++;
  }
}

/** Glowing props (black where they only occlude), then the sun/moon glow behind them, into the bloom buffer. */
export function drawEmissive(world) {
  if (!PSKY || !debug.emissive) return;
  const gl = world.gl;
  if (propCount) {
    gl.useProgram(PEMI.prog);
    constants(world, PEMI, 0);
    setCommon(world, PEMI);
    bindProps(world, PEMI);
    if (PEMI.u.uEyeS) gl.uniform3fv(PEMI.u.uEyeS, world.camera.pos);
    gl.drawArrays(gl.TRIANGLES, 0, propCount);
    world.stats.drawCalls++;
  }
  if (hasGlow && PGLOW) {
    gl.depthMask(false);
    gl.useProgram(PGLOW.prog);
    constants(world, PGLOW, 0);
    setCommon(world, PGLOW);
    gl.uniformMatrix4fv(PGLOW.u.uInvViewProj, false, world.camera.invViewProj);
    gl.uniform3fv(PGLOW.u.uEye, world.camera.pos);
    drawFullscreen(gl, PGLOW);
    gl.depthMask(true);
    world.stats.drawCalls++;
  }
}
