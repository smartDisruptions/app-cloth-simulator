// The HUD: quiet until needed, phone-first, Japanese-modern. Built once from JS into #ui.
//
//   top      the scene (kanji + name → a picker of six cards), the material (→ six swatches), reset,
//            and the toggles: wind (still / breeze / gale), rain, slow-mo, tilt, sound, the receipt
//   bottom   the five tools in a thumb-zone dock with a sliding indicator; ink swatches when Dye is up
//   overlay  finger rings, ripples and pin markers (ui/fx.js), the katana beat's letterbox, a title card
//            on scene change, captions that teach once and then stay short, and the first-run hint
// Landscape turns the bars into side rails (style.css). DOM writes happen on change (sync) or ≤ 4×/s
// (the receipt), except the pin markers' transforms. Nothing allocates per frame.
import { SCENES } from '../scenes/index.js';
import { MATERIALS } from '../core/materials.js';
import { TOOLS, DYES } from '../core/world.js';
import { ORDER } from '../core/quality.js';
import { ICON, MOTIF, SCENE_BG, SCENE_BG_FALLBACK } from './icons.js';
import { prefs, load as loadPrefs, save as savePrefs, teach, taughtCount } from './store.js';
import { bus } from './bus.js';
import * as fx from './fx.js';
import * as receipt from './receipt.js';
import * as tilt from './tilt.js';
import { feel } from './input.js';

/** Codes in world.events.ui. main.js pushes tool/scene/material/toggle/reset; the HUD pushes the rest. */
export const UI_SFX = { tool: 1, scene: 2, material: 3, toggle: 4, tap: 5, reset: 6, open: 7, close: 8 };

const TOOL = {
  grab: { name: 'Grab', kanji: '掴', hint: 'Pull it. Every finger grabs its own patch.', aria: 'Grab: drag to pull the cloth, one patch per finger.' },
  slice: { name: 'Slice', kanji: '斬', hint: 'Swipe through it. A long, fast cut slows time.', aria: 'Slice: swipe across the cloth to cut it.' },
  burn: { name: 'Burn', kanji: '燃', hint: 'Tap to light it. Hold to keep the flame on it.', aria: 'Burn: tap the cloth to light it, hold to keep burning.' },
  pin: { name: 'Pin', kanji: '留', hint: 'Tap to pin. Drag a point and let go to pin it there.', aria: 'Pin: tap to pin or free a point, or drag a point and let go to pin it there.' },
  dye: { name: 'Dye', kanji: '染', hint: 'Touch to drop ink. Drag to lay a line of it.', aria: 'Dye: touch the cloth to drop ink, drag to paint a line.' },
};
const INK_KANJI = { ai: '藍', shu: '朱', kin: '金', sumi: '墨' };
// The first-run hint, in my voice. Keyed by the tool the scene starts with.
const FIRST = {
  grab: ['Pull the cloth.', 'Swipe with the blade to cut it. Pick the flame, then touch the cloth to burn it.'],
  slice: ['Swipe to cut.', 'A long, fast stroke slows time for a beat. The hand pulls, the flame burns.'],
  burn: ['Touch the cloth.', 'The flame’s already in your hand. Tap to light it, hold to keep it burning.'],
  pin: ['Tap to pin.', 'Drag a point and let go to pin it there. Tap a pin to free it.'],
  dye: ['Touch to drop ink.', 'Drag to lay a line of it. Wet cloth spreads it faster.'],
};
const FIRST_FOOT = 'I’ll get out of the way once you start.';
const GHOST = { grab: 'ghost on g-pull', slice: 'ghost on g-swipe', burn: 'ghost on g-hold', pin: 'ghost on g-tap', dye: 'ghost on g-tap' };
const WIND_NOTE = ['Still air', 'A breeze', 'A gale'];
const WIND_ARIA = ['Wind: still. Tap for a breeze.', 'Wind: a breeze. Tap for a gale.', 'Wind: a gale. Tap for still air.'];
const WIND_LVL = ['0', '1', '2'];
const IDX = ['0', '1', '2', '3', '4', '5', '6', '7'];

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
/** Text from other modules (scene names, blurbs) goes into markup escaped. */
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let W = null, root = null, built = false, synced = false;
const E = {};                      // elements
const toolBtn = {}, toggleBtn = {}, cardBtn = {}, matBtn = {}, inkBtn = [];
const INK_CSS = DYES.map((d) => `rgb(${Math.round(d.rgb[0] * 255)},${Math.round(d.rgb[1] * 255)},${Math.round(d.rgb[2] * 255)})`);
const last = { scene: '', material: '', tool: '', dye: -1, wind: -1, rain: -1, slowmo: -1, tilt: -1, sound: -1, stats: -1 };
let titleFlip = 0, spinFlip = 0, cutFlip = 0, beating = false, touching = false, hintOn = false;
let openSheet = null, opener = null, rcDraw = false, tiltNA = 0;
// Mutable floats live in a typed array: a module-level `let` holding a double makes V8 box it per write.
const F = new Float64Array(4);
const CAP_TOP = 0, CAP_TOOL = 1, RC_T = 2, OWN_MS = 3;

// ---------------------------------------------------------------- build
export function init(world) {
  W = world;
  root = document.getElementById('ui');
  if (!root) return;
  loadPrefs();
  root.classList.add('hud');
  if (world.touch) root.classList.add('touch');

  const tools = TOOLS.map((t, i) => {
    const m = TOOL[t] || { name: t, kanji: '', hint: '' };
    return `<button type="button" class="tool" data-tool="${t}" aria-pressed="false" aria-keyshortcuts="${i + 1}" aria-label="${m.name}" title="${m.name} (${i + 1})">${ICON[t] || ''}<span class="lbl" aria-hidden="true">${m.name}</span></button>`;
  }).join('');
  const inks = DYES.map((d, i) => `<button type="button" class="inkb" data-i="${i}" aria-pressed="false" aria-label="${esc(d.name)} ink" title="${esc(d.name)}"><span class="drop" style="--c:${INK_CSS[i]}"></span><span class="ik" aria-hidden="true">${esc(INK_KANJI[d.id] || d.name.slice(0, 1))}</span></button>`).join('');
  const cards = SCENES.map((s) => `<button type="button" class="card" data-id="${esc(s.id)}" aria-current="false">${MOTIF[s.id] || ''}` +
    `<span class="card-k" aria-hidden="true">${esc(s.kanji)}</span><span class="card-n">${esc(s.name)}</span><span class="card-b">${esc(s.blurb)}</span></button>`).join('');
  const mats = MATERIALS.map((m) => `<button type="button" class="matb" data-m="${esc(m.id)}" aria-pressed="false" aria-label="${esc(m.name)}"><span class="sw" data-m="${esc(m.id)}"></span><span class="mat-n">${esc(m.name)}</span></button>`).join('');

  root.innerHTML =
    `<div class="lb lb-t" aria-hidden="true"></div><div class="lb lb-b" aria-hidden="true"></div><div class="cut" aria-hidden="true"></div>` +
    `<div class="title" aria-hidden="true"><span class="title-k"></span><span class="title-n"></span><span class="title-b"></span></div>` +
    `<div class="hint" role="note"><p class="hint-h"></p><p class="hint-p"></p><p class="hint-f"></p></div>` +
    `<header class="top chrome">` +
      `<button type="button" class="scene" aria-haspopup="dialog" aria-expanded="false" title="Scenes ([ and ])"><span class="scene-k" aria-hidden="true"></span><span class="scene-n"></span>${ICON.chev}</button>` +
      `<div class="acts">` +
        `<button type="button" class="mat ib" aria-haspopup="dialog" aria-expanded="false" aria-keyshortcuts="M" title="Material (M cycles)"><span class="sw"></span></button>` +
        (fsAble() ? `<button type="button" class="ib tg-fs fs-alt" aria-pressed="false" aria-label="Full screen" title="Full screen (F)">${ICON.fsIn}${ICON.fsOut}</button>` : '') +
        `<button type="button" class="reset ib" aria-label="Reset the cloth" aria-keyshortcuts="R" title="Reset (R)">${ICON.reset}</button>` +
      `</div>` +
      `<div class="tgl" role="toolbar" aria-label="Wind, weather and view">` +
        `<button type="button" class="ib tg tg-wind" data-t="wind" data-level="1" aria-pressed="true" aria-keyshortcuts="W" title="Wind (W)">${ICON.wind0}${ICON.wind1}${ICON.wind2}</button>` +
        `<button type="button" class="ib tg" data-t="rain" aria-pressed="false" aria-label="Rain" title="Rain">${ICON.rain}</button>` +
        `<button type="button" class="ib tg" data-t="slowmo" aria-pressed="false" aria-label="Slow motion" aria-keyshortcuts="Space" title="Slow motion (Space)">${ICON.slowmo}</button>` +
        `<button type="button" class="ib tg" data-t="tilt" aria-pressed="false" aria-label="Tilt: gravity follows the phone" title="Tilt">${ICON.tilt}</button>` +
        `<button type="button" class="ib tg tg-sound" data-t="sound" aria-pressed="true" aria-label="Sound" title="Sound">${ICON.soundOn}${ICON.soundOff}</button>` +
        `<button type="button" class="ib tg" data-t="stats" aria-pressed="false" aria-label="Receipt: frame times and where they go" aria-keyshortcuts="S" title="Receipt (S)">${ICON.stats}</button>` +
        (fsAble() ? `<button type="button" class="ib tg tg-fs" data-t="fs" aria-pressed="false" aria-label="Full screen" aria-keyshortcuts="F" title="Full screen (F)">${ICON.fsIn}${ICON.fsOut}</button>` : '') +
      `</div>` +
    `</header>` +
    `<p class="cap cap-top" role="status" aria-live="polite"></p>` +
    `<nav class="dock chrome" aria-label="Tools">` +
      `<p class="cap cap-tool" aria-live="polite"><span class="cap-k" aria-hidden="true"></span><span class="cap-n"></span><span class="cap-t"></span></p>` +
      `<div class="ink" role="group" aria-label="Ink colour">${inks}</div>` +
      `<div class="tools" role="toolbar" aria-label="Tools"><span class="ind" aria-hidden="true"></span>${tools}</div>` +
    `</nav>` +
    `<div class="sheet sheet-scene" role="dialog" aria-modal="true" aria-labelledby="sh-scene-h" aria-hidden="true">` +
      `<div class="scrim"></div>` +
      `<div class="panel"><div class="sh-head"><div><h2 id="sh-scene-h">Scenes</h2><p>${COUNT[SCENES.length] || SCENES.length} places I built for this cloth.</p></div>` +
      `<button type="button" class="ib close" aria-label="Close">${ICON.close}</button></div><div class="cards">${cards}</div></div>` +
    `</div>` +
    `<div class="sheet sheet-mat" role="dialog" aria-modal="true" aria-labelledby="sh-mat-h" aria-hidden="true">` +
      `<div class="scrim"></div>` +
      `<div class="panel"><div class="sh-head"><div><h2 id="sh-mat-h">Material</h2><p>What the cloth is made of.</p></div>` +
      `<button type="button" class="ib close" aria-label="Close">${ICON.close}</button></div><div class="mats">${mats}</div><p class="mat-blurb"></p></div>` +
    `</div>`;

  const q = (s) => root.querySelector(s);
  E.top = q('.top'); E.dock = q('.dock'); E.tools = q('.tools'); E.ink = q('.ink');
  E.scene = q('.scene'); E.sceneK = q('.scene-k'); E.sceneN = q('.scene-n');
  E.mat = q('.mat'); E.matSw = q('.mat .sw'); E.reset = q('.reset');
  E.capTop = q('.cap-top'); E.capTool = q('.cap-tool'); E.capK = q('.cap-k'); E.capN = q('.cap-n'); E.capT = q('.cap-t');
  E.title = q('.title'); E.titleK = q('.title-k'); E.titleN = q('.title-n'); E.titleB = q('.title-b');
  E.hint = q('.hint'); E.hintH = q('.hint-h'); E.hintP = q('.hint-p'); E.hintF = q('.hint-f');
  E.sheetScene = q('.sheet-scene'); E.sheetMat = q('.sheet-mat'); E.matBlurb = q('.mat-blurb'); E.cut = q('.cut');

  // overlays sit under the chrome: insert them right after the letterbox
  fx.init(root);
  root.insertBefore(root.querySelector('.fx'), E.title);
  receipt.init(root, cycleTier, copyReceipt);
  root.insertBefore(root.querySelector('.receipt'), E.top);

  for (const b of root.querySelectorAll('.tool')) { toolBtn[b.dataset.tool] = b; press(b, () => pickTool(b.dataset.tool)); }
  for (const b of root.querySelectorAll('.inkb')) { const i = Number(b.dataset.i); inkBtn[i] = b; press(b, () => pickInk(i)); }
  for (const b of root.querySelectorAll('.tg')) { toggleBtn[b.dataset.t] = b; b.addEventListener('click', () => onToggle(b.dataset.t)); }
  const alt = root.querySelector('.fs-alt'); if (alt) alt.addEventListener('click', () => onToggle('fs'));
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  for (const b of root.querySelectorAll('.card')) {
    const id = b.dataset.id, s = SCENES.find((x) => x.id === id);
    cardBtn[id] = b;
    b.style.setProperty('--bg', (s && s.ui && s.ui.gradient) || SCENE_BG[id] || SCENE_BG_FALLBACK);
    b.addEventListener('click', () => pickScene(id));
  }
  for (const b of root.querySelectorAll('.matb')) {
    const m = MATERIALS.find((x) => x.id === b.dataset.m);
    if (m) b.querySelector('.sw').style.setProperty('--sw', m.swatch);
    matBtn[b.dataset.m] = b;
    b.addEventListener('click', () => pickMaterial(b.dataset.m));
    b.addEventListener('pointerenter', () => showBlurb(b.dataset.m));
    b.addEventListener('focus', () => showBlurb(b.dataset.m));
  }
  E.scene.addEventListener('click', () => toggleSheet(E.sheetScene, E.scene));
  E.mat.addEventListener('click', () => toggleSheet(E.sheetMat, E.mat));
  E.reset.addEventListener('click', onReset);
  for (const s of [E.sheetScene, E.sheetMat]) {
    s.querySelector('.scrim').addEventListener('click', closeSheet);
    s.querySelector('.close').addEventListener('click', closeSheet);
  }
  window.addEventListener('keydown', onKey);

  bus.touchStart = onTouchStart;
  bus.touchEnd = onTouchEnd;
  bus.beat = onBeat;
  bus.note = (t) => note(t, 2.6);
  bus.tiltState = onTiltState;

  if (tilt.supported() === false || (!world.touch && !('ontouchstart' in window))) markTilt(-3);
  E.dock.classList.toggle('compact', !!prefs.compact);
  built = true;
}

/** A button that acts on pointerdown (snappy for tools) and still works from the keyboard. */
function press(el, fn) {
  let t = -1e9;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; t = performance.now(); fn(); });
  el.addEventListener('click', () => { W.api.audioUnlock(); if (performance.now() - t < 900) return; fn(); });
}

// ---------------------------------------------------------------- sync (main.js calls it after api changes)
export function sync(world) {
  if (!built) return;
  W = world;
  const first = !synced; synced = true;
  const T = world.toggles;
  const sceneChanged = world.sceneId !== last.scene;
  const quiet = first || sceneChanged;           // a scene brings its own defaults: no captions for those

  if (sceneChanged) {
    last.scene = world.sceneId;
    const s = world.scene;
    E.sceneK.textContent = (s && s.kanji) || '';
    E.sceneN.textContent = (s && s.name) || world.sceneId;
    E.scene.setAttribute('aria-label', `Scene: ${s ? s.name : world.sceneId}. Choose another scene.`);
    for (const id in cardBtn) cardBtn[id].setAttribute('aria-current', id === world.sceneId ? 'true' : 'false');
    if (!first || prefs.seen) showTitle(s);
    if (!first) { cutFlip ^= 1; E.cut.className = cutFlip ? 'cut a' : 'cut b'; }
  }
  if (world.materialId !== last.material) {
    last.material = world.materialId;
    E.matSw.setAttribute('data-m', world.materialId);
    const m = MATERIALS.find((x) => x.id === world.materialId);
    E.matSw.style.setProperty('--sw', m ? m.swatch : '#999');
    E.mat.setAttribute('aria-label', `Material: ${m ? m.name : world.materialId}. Choose another material.`);
    for (const id in matBtn) matBtn[id].setAttribute('aria-pressed', id === world.materialId ? 'true' : 'false');
    showBlurb(world.materialId);
    if (!quiet && m) note(`${m.name}. ${m.blurb}.`, 3.2);
  }
  if (world.tool !== last.tool) {
    const prev = last.tool;
    last.tool = world.tool;
    const i = TOOLS.indexOf(world.tool);
    for (const t in toolBtn) toolBtn[t].setAttribute('aria-pressed', t === world.tool ? 'true' : 'false');
    E.tools.style.setProperty('--i', IDX[i < 0 ? 0 : i]);
    E.dock.classList.toggle('dye', world.tool === 'dye');
    root.classList.toggle('dye', world.tool === 'dye');
    document.body.setAttribute('data-tool', world.tool);
    const m = TOOL[world.tool];
    if (m && world.canvas) world.canvas.setAttribute('aria-label', 'Cloth simulation. ' + m.aria);
    if (!first) toolCaption(world.tool, prev !== '');
    if (hintOn) showHint(world);
  }
  if (world.dyeColor !== last.dye) {
    last.dye = world.dyeColor;
    E.tools.style.setProperty('--ink', INK_CSS[world.dyeColor] || INK_CSS[0]);
    for (let i = 0; i < inkBtn.length; i++) inkBtn[i].setAttribute('aria-pressed', i === world.dyeColor ? 'true' : 'false');
  }
  if (T.wind !== last.wind) {
    last.wind = T.wind;
    const b = toggleBtn.wind, w = T.wind < 0 ? 0 : T.wind > 2 ? 2 : T.wind;
    b.setAttribute('data-level', WIND_LVL[w]);
    b.setAttribute('aria-pressed', w > 0 ? 'true' : 'false');
    b.setAttribute('aria-label', WIND_ARIA[w]);
    if (!quiet) note(WIND_NOTE[w], 1.4);
  }
  flag('rain', T.rain, quiet, 'Rain. Watch it soak in.', 'The rain stops.');
  if (flag('slowmo', T.slowmo, quiet, 'Slow motion', 'Full speed')) root.classList.toggle('slowmo', !!T.slowmo);
  flag('sound', T.sound, quiet, 'Sound on', 'Sound off');
  flag('tilt', T.tilt, true, '', '');
  if ((T.stats ? 1 : 0) !== last.stats) {
    last.stats = T.stats ? 1 : 0;
    toggleBtn.stats.setAttribute('aria-pressed', T.stats ? 'true' : 'false');
    receipt.show(!!T.stats);
    root.classList.toggle('stats', !!T.stats);
    if (T.stats) { receipt.paint(world); receipt.draw(); F[RC_T] = 0; }
    if (!quiet && T.stats && teach('stats')) note('The receipt: where every millisecond goes.', 2.6);
  }
  if (first && !prefs.seen) showHint(world);
}

function flag(name, v, quiet, on, off) {
  const n = v ? 1 : 0;
  if (n === last[name]) return false;
  last[name] = n;
  toggleBtn[name].setAttribute('aria-pressed', n ? 'true' : 'false');
  if (!quiet) note(n ? on : off, 1.5);
  return true;
}

// ---------------------------------------------------------------- per frame
export function update(world) {
  if (!built) return;
  const t0 = performance.now();
  fx.update(world);
  feel(world);
  if (beating && world.slowmoPulse <= 0) { beating = false; root.classList.remove('beat'); }
  const now = world.realTime;
  if (F[CAP_TOP] > 0 && now > F[CAP_TOP]) { F[CAP_TOP] = 0; E.capTop.classList.remove('on'); }
  if (F[CAP_TOOL] > 0 && now > F[CAP_TOOL]) { F[CAP_TOOL] = 0; E.capTool.classList.remove('on'); }
  if (world.toggles.stats) {
    receipt.sample(world, F, OWN_MS);
    F[RC_T] += world.frameDt;
    if (F[RC_T] >= 0.25) { F[RC_T] -= 0.25; receipt.paint(world); rcDraw = true; }
    else if (rcDraw && F[RC_T] >= 0.12) { rcDraw = false; receipt.draw(); }
  }
  F[OWN_MS] = performance.now() - t0;
}

export function onScene(world) { fx.onScene(world); }
export function onResize(world) { fx.onResize(world); }

// ---------------------------------------------------------------- actions
function interacted() {
  if (!hintOn) return;
  hintOn = false;
  E.hint.classList.remove('on');
  fx.ghostAt(-999, -999, 'ghost');
  prefs.seen = 1; savePrefs();
}

function pickTool(t) {
  interacted();
  if (W.tool === t) { toolCaption(t, true); return; }
  W.api.setTool(t);
}

function pickInk(i) {
  interacted();
  if (W.tool !== 'dye') W.api.setTool('dye');
  W.api.setDye(i);
  W.events.ui.push(UI_SFX.tap, 0, 0, 0);
  const d = DYES[i];
  if (d) { E.capK.textContent = INK_KANJI[d.id] || ''; E.capN.textContent = d.name; E.capT.textContent = ''; showCapTool(1.1); }
}

function onToggle(name) {
  interacted();
  const T = W.toggles, api = W.api;
  api.audioUnlock();
  if (name === 'fs') { toggleFs(); return; }
  if (name === 'wind') api.setToggle('wind', ((T.wind | 0) + 1) % 3);
  else if (name === 'tilt') {
    if (T.tilt) { tilt.stop(); api.setToggle('tilt', false); note('Gravity’s back to normal.', 1.6); }
    else {
      // on first, so a sensor that fails right away (or later) can switch it back off
      api.setToggle('tilt', true);
      if (tiltNA) note('Looking for a tilt sensor…', 1.6);
      tilt.start();
    }
  } else api.setToggle(name, !T[name]);
}

function onTiltState(code) {
  if (code === 1) {
    markTilt(0);
    const fresh = teach('tilt');
    note(fresh ? 'Tilt the phone. Gravity follows. However you’re holding it now is level.' : 'Tilt on', fresh ? 3.6 : 1.4);
    return;
  }
  if (W.toggles.tilt) W.api.setToggle('tilt', false);
  markTilt(code);
  note(code === -2 ? 'Motion access is off for this page, so tilt can’t work here.' : 'No tilt readings here, so gravity stays put.', 3);
}

function markTilt(code) {
  tiltNA = code < 0 ? code : 0;
  const b = toggleBtn.tilt; if (!b) return;
  if (code === -1 || code === -2) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled');
  b.classList.toggle('na', code < 0);
  b.setAttribute('aria-label', code === -2 ? 'Tilt: motion access is off' : code === -1 ? 'Tilt: no tilt readings on this device' : 'Tilt: gravity follows the phone');
}

function onReset() {
  interacted();
  W.api.audioUnlock();
  spinFlip ^= 1;
  E.reset.className = spinFlip ? 'reset ib spin-a' : 'reset ib spin-b';
  W.api.reset();
  note('A fresh cloth.', 1.2);
}

function pickScene(id) {
  closeSheet();
  W.api.audioUnlock();
  if (id !== W.sceneId) W.api.setScene(id);
}

function pickMaterial(id) {
  W.api.audioUnlock();
  if (id !== W.materialId) W.api.setMaterial(id);
  closeSheet();
}

function showBlurb(id) {
  const m = MATERIALS.find((x) => x.id === id);
  if (m && E.matBlurb) E.matBlurb.textContent = `${m.name}. ${m.blurb}.`;
}

function cycleTier() {
  const q = W.q; if (!q) return;
  W.api.audioUnlock();
  if (q.auto) { W.api.setQuality(ORDER[0]); }
  else {
    const i = ORDER.indexOf(q.name);
    if (i >= ORDER.length - 1) W.api.setQuality('auto'); else W.api.setQuality(ORDER[i + 1]);
  }
  receipt.paint(W);
  note(W.q.auto ? `Quality: ${W.q.name}, and the governor may lower it to hold 60 fps` : `Quality: ${W.q.name}, fixed`, 2.2);
}

// ---------------------------------------------------------------- full screen (Android, desktop, iPad; not iPhone)
function fsAble() {
  const d = document;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) && !!(d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen);
}
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
function toggleFs() {
  interacted();
  const d = document, el = d.documentElement;
  try {
    if (fsEl()) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
    const p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
    if (p && p.catch) p.catch(() => note('Full screen isn’t allowed here.', 2));
  } catch (e) { note('Full screen isn’t allowed here.', 2); }
}
function onFsChange() {
  const on = fsEl() ? 'true' : 'false';
  for (const b of root.querySelectorAll('.tg-fs')) b.setAttribute('aria-pressed', on);
}

function copyReceipt() {
  W.api.audioUnlock();
  const t = receipt.text(W);
  const done = () => note('Copied the receipt. Paste it anywhere.', 2);
  const fail = () => note('This page can’t reach the clipboard.', 2.4);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fail);
    else fail();
  } catch (e) { fail(); }
}

// ---------------------------------------------------------------- sheets
function toggleSheet(sheet, btn) {
  interacted();
  W.api.audioUnlock();
  if (openSheet === sheet) { closeSheet(); return; }
  if (openSheet) closeSheet();
  openSheet = sheet; opener = btn;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  btn.setAttribute('aria-expanded', 'true');
  root.classList.add('sheeted');
  E.top.inert = true; E.dock.inert = true;
  W.events.ui.push(UI_SFX.open, 0, 0, 0);
  const cur = sheet === E.sheetScene ? cardBtn[W.sceneId] : matBtn[W.materialId];
  if (cur) { try { cur.focus({ preventScroll: true }); } catch (e) { cur.focus(); } }
}

function closeSheet() {
  if (!openSheet) return;
  const sheet = openSheet, btn = opener;
  openSheet = null; opener = null;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  root.classList.remove('sheeted');
  E.top.inert = false; E.dock.inert = false;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); try { btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
  W.events.ui.push(UI_SFX.close, 0, 0, 0);
}

// ---------------------------------------------------------------- captions, title, hint, beat
function note(text, secs) {
  if (!text) return;
  E.capTop.textContent = text;
  E.capTop.classList.add('on');
  F[CAP_TOP] = W.realTime + secs;
}

function toolCaption(t, user) {
  const m = TOOL[t]; if (!m) return;
  const long = user && teach(t);
  E.capK.textContent = m.kanji; E.capN.textContent = m.name; E.capT.textContent = long ? m.hint : '';
  showCapTool(long ? 3.4 : 1.1);
  if (!prefs.compact && taughtCount(TOOLS) >= 3) { prefs.compact = 1; savePrefs(); E.dock.classList.add('compact'); }
}
function showCapTool(secs) { E.capTool.classList.add('on'); F[CAP_TOOL] = W.realTime + secs; }

function showTitle(s) {
  if (!s) return;
  E.titleK.textContent = s.kanji || ''; E.titleN.textContent = s.name || ''; E.titleB.textContent = s.blurb || '';
  titleFlip ^= 1;
  E.title.className = titleFlip ? 'title show-a' : 'title show-b';
}

function showHint(world) {
  const t = FIRST[world.tool] || FIRST.grab;
  E.hintH.textContent = t[0]; E.hintP.textContent = t[1]; E.hintF.textContent = FIRST_FOOT;
  E.hint.classList.add('on');
  hintOn = true;
  // the ghost finger, over the middle of the cloth
  const cl = world.cloth, sc = world.screen;
  if (!cl) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < cl.n; i++) {
    if (!cl.vTri[i] || sc[i * 3 + 2] <= 0) continue;
    const x = sc[i * 3], y = sc[i * 3 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < x0) return;
  const cx = Math.max(40, Math.min(world.width - 40, (x0 + x1) / 2));
  const cy = Math.max(80, Math.min(world.height - 160, y0 + (y1 - y0) * 0.45));
  fx.ghostAt(cx, cy, GHOST[world.tool] || GHOST.grab);
}

function onTouchStart() {
  interacted();
  if (openSheet) closeSheet();
  if (!touching) { touching = true; root.classList.add('touching'); }
}
function onTouchEnd() { if (touching) { touching = false; root.classList.remove('touching'); } }
function onBeat() { if (!beating) { beating = true; root.classList.add('beat'); } }

// ---------------------------------------------------------------- keyboard (desktop)
function onKey(e) {
  if (!W || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key;
  if (k === 'Escape') { if (openSheet) { closeSheet(); e.preventDefault(); } return; }
  if (openSheet) { if (k === 'Tab') trapTab(e); return; }
  const tag = e.target && e.target.tagName;
  const onControl = tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  const api = W.api;
  if (k >= '1' && k <= '5') { const t = TOOLS[k - 1]; if (t) pickTool(t); }
  else if (k === 'r' || k === 'R') onReset();
  else if (k === 's' || k === 'S') { interacted(); api.setToggle('stats', !W.toggles.stats); }
  else if (k === 'w' || k === 'W') onToggle('wind');
  else if ((k === 'f' || k === 'F') && fsAble()) toggleFs();
  else if (k === ' ' || k === 'Spacebar') { if (onControl) return; interacted(); api.setToggle('slowmo', !W.toggles.slowmo); }
  else if (k === '[' || k === ']') {
    interacted();
    const i = SCENES.findIndex((s) => s.id === W.sceneId), n = SCENES.length;
    api.setScene(SCENES[(i + (k === ']' ? 1 : n - 1)) % n].id);
  } else if (k === 'm' || k === 'M') {
    interacted();
    const i = MATERIALS.findIndex((m) => m.id === W.materialId);
    api.setMaterial(MATERIALS[(i + 1) % MATERIALS.length].id);
  } else return;
  e.preventDefault();
}

/** Keep Tab inside the open sheet. */
function trapTab(e) {
  const f = openSheet.querySelectorAll('button');
  if (!f.length) return;
  const first = f[0], lastB = f[f.length - 1], a = document.activeElement;
  if (e.shiftKey && (a === first || !openSheet.contains(a))) { lastB.focus(); e.preventDefault(); }
  else if (!e.shiftKey && (a === lastB || !openSheet.contains(a))) { first.focus(); e.preventDefault(); }
}

// ---------------------------------------------------------------- fatal
/** Boot failed: say so plainly. Works before init() too. */
export function fatal(msg) {
  const host = document.getElementById('ui') || document.body;
  const webgl = /webgl/i.test(String(msg));
  const d = document.createElement('div');
  d.className = 'fatal';
  d.setAttribute('role', 'alert');
  d.innerHTML = `<div class="fatal-card"><span class="fatal-k" aria-hidden="true">布</span><h1>I couldn’t start the cloth here.</h1>` +
    `<p class="fatal-msg"></p><p class="fatal-tip">${webgl ? 'It draws with WebGL. A current Chrome, Safari or Firefox has it switched on.' : 'Something broke while it was starting. The line above is what it said.'}</p>` +
    `<button type="button">Try again</button></div>`;
  d.querySelector('.fatal-msg').textContent = String(msg);
  d.querySelector('button').addEventListener('click', () => location.reload());
  host.appendChild(d);
}
