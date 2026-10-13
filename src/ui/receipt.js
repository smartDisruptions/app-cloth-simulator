// The receipt (the Stats toggle): proof, not a claim. fps, frame ms and JS ms with a 2-second sparkline,
// the JS split by system against the 8 ms budget, p95, render scale and tier, cloth size, particles,
// substeps and draw calls. Monospace and aligned, like an instrument.
//
// Text changes at most 4×/s through cached strings (ui/fmt.js), only where a value changed. The canvas
// redraws at most 4×/s, on a different frame from the text. Nothing allocates per frame.
import { f1, f2, int } from './fmt.js';
import { ICON } from './icons.js';

const N = 120;                     // ~2 s of frames at 60 fps
const frameS = new Float32Array(N), jsS = new Float32Array(N);
let head = 0, filled = 0;
const SYS = ['sim', 'weather', 'fire', 'particles', 'render', 'other'];
const SYS_COL = ['#8796ff', '#69b9db', '#e2412a', '#d8a23c', '#f1e3c0', '#8d90aa'];
const SYS_KEYS = SYS.map((_, i) => 's' + i);
const ema = new Float32Array(SYS.length + 1);   // per system, then [SYS.length] = all JS
const JS = SYS.length;
const top6 = new Float32Array(6);

let box = null, ctx = null, cw = 0, ch = 0, px = 1, tierBtn = null, onTier = null, onCopy = null;
let lastTier = '', lastAuto = -1, lastWarn = -1;
const V = {}, last = {};   // value spans by key, and the string each one shows
const DASH = [3, 3], SOLID = [];
const CW = 210, CH = 46;   // canvas css size: the receipt's inner width

const WARN_CLS = ['rc-big', 'rc-big warn', 'rc-big bad'];

export function init(root, tierCb, copyCb) {
  onTier = tierCb; onCopy = copyCb;
  box = document.createElement('aside');
  box.className = 'receipt';
  box.hidden = true;
  box.setAttribute('aria-label', 'Receipt: live frame times and where they go');
  const sysRows = SYS.map((k, i) => `<span class="m"><span class="rc-k" style="--c:${SYS_COL[i]}"><i></i>${k}</span><b data-v="s${i}">0.00</b></span>`).join('');
  box.innerHTML =
    `<div class="rc-head"><span class="seal" aria-hidden="true">証</span><span class="rc-title">Receipt</span>` +
    `<button type="button" class="rc-copy" aria-label="Copy the receipt as text" title="Copy the receipt">${ICON.copy}</button>` +
    `<button type="button" class="rc-tier" aria-label="Quality tier. Tap to change it.">MID</button></div>` +
    `<div class="rc-big"><span><b data-v="fps">60</b><i>fps</i></span><span><b data-v="frame">16.7</b><i>ms</i></span><span><b data-v="js">0.0</b><i>js ms</i></span></div>` +
    `<canvas class="rc-spark" aria-hidden="true"></canvas>` +
    `<div class="rc-key" aria-hidden="true"><span><i class="ln"></i>frame</span><span><i class="ar"></i>js</span><span><i class="tk"></i>8 ms budget</span><span class="rc-2s">2 s</span></div>` +
    `<div class="rc-sys">${sysRows}</div>` +
    `<div class="rc-foot">` +
    `<span class="m"><span class="rc-k">js p95</span><span><b data-v="p95">0.0</b> ms</span></span>` +
    `<span class="m"><span class="rc-k">scale</span><span><b data-v="dpr">1.00</b>×</span></span>` +
    `<span class="m"><span class="rc-k">verts</span><b data-v="verts">0</b></span>` +
    `<span class="m"><span class="rc-k">links</span><span><b data-v="la">0</b>/<b data-v="lt">0</b></span></span>` +
    `<span class="m"><span class="rc-k">particles</span><span><b data-v="pn">0</b>/<b data-v="pc">0</b></span></span>` +
    `<span class="m"><span class="rc-k">draw calls</span><b data-v="calls">0</b></span>` +
    `<span class="m"><span class="rc-k">substeps</span><b data-v="sub">0</b></span>` +
    `<span class="m"><span class="rc-k">tris</span><b data-v="tris">0</b></span>` +
    `</div>`;
  const nodes = box.querySelectorAll('[data-v]');
  for (let i = 0; i < nodes.length; i++) { const k = nodes[i].getAttribute('data-v'); V[k] = nodes[i]; last[k] = nodes[i].textContent; }
  tierBtn = box.querySelector('.rc-tier');
  tierBtn.addEventListener('click', (e) => { e.stopPropagation(); if (onTier) onTier(); });
  box.querySelector('.rc-copy').addEventListener('click', (e) => { e.stopPropagation(); if (onCopy) onCopy(); });
  const cv = box.querySelector('canvas');
  px = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(CW * px); cv.height = Math.round(CH * px);
  cv.style.width = CW + 'px'; cv.style.height = CH + 'px';
  cw = cv.width; ch = cv.height;
  try { ctx = cv.getContext('2d', { alpha: true }); } catch (e) { ctx = null; }
  DASH[0] = DASH[1] = 3 * px;
  root.appendChild(box);
}

export function show(on) {
  if (!box) return;
  box.hidden = !on;
  if (on) { head = 0; filled = 0; }
}

/** Every frame while visible. own[ownIx] = the HUD's own ms last frame (folded into "other"). */
export function sample(world, own, ownIx) {
  const m = world.stats.ms;
  const other = m.input + m.scene + m.audio + own[ownIx];
  const js = m.sim + m.weather + m.fire + m.particles + m.render + other;
  frameS[head] = world.frameDt * 1000; jsS[head] = js;
  head = (head + 1) % N; if (filled < N) filled++;
  const k = 0.1;
  ema[0] += (m.sim - ema[0]) * k; ema[1] += (m.weather - ema[1]) * k; ema[2] += (m.fire - ema[2]) * k;
  ema[3] += (m.particles - ema[3]) * k; ema[4] += (m.render - ema[4]) * k; ema[5] += (other - ema[5]) * k;
  ema[JS] += (js - ema[JS]) * k;
}

function set(key, s) { if (last[key] !== s) { V[key].textContent = s; last[key] = s; } }

/** JS p95 over the window: the ceil(5%)-th largest sample, without sorting or allocating. */
function p95() {
  const n = filled; if (!n) return 0;
  const want = Math.min(6, Math.max(1, Math.ceil(n * 0.05)));
  for (let i = 0; i < want; i++) top6[i] = -1;
  for (let i = 0; i < n; i++) {
    const v = jsS[i];
    if (v <= top6[want - 1]) continue;
    let j = want - 1;
    while (j > 0 && top6[j - 1] < v) { top6[j] = top6[j - 1]; j--; }
    top6[j] = v;
  }
  return top6[want - 1];
}

/** Refresh the text (≤ 4×/s). */
export function paint(world) {
  if (!box) return;
  const s = world.stats, q = world.q;
  const fps = s.fps;
  set('fps', int(fps)); set('frame', f1(s.frameMs)); set('js', f1(s.jsMs > 0 ? s.jsMs : ema[JS]));
  for (let i = 0; i < SYS.length; i++) set(SYS_KEYS[i], f2(ema[i]));
  set('p95', f1(p95()));
  set('dpr', f2(world.dpr));
  set('verts', int(s.verts)); set('la', int(s.constraintsAlive)); set('lt', int(s.constraints));
  set('pn', int(s.particles)); set('pc', int(q ? Math.floor(q.particles * q.particleScale) : 0));
  set('sub', int(s.substeps)); set('calls', int(s.drawCalls)); set('tris', int(s.trisAlive));
  const warn = fps < 30 ? 2 : fps < 50 ? 1 : 0;
  if (warn !== lastWarn) { V.fps.parentNode.parentNode.className = WARN_CLS[warn]; lastWarn = warn; }
  const tier = s.tier || (q && q.name) || '', auto = q && q.auto ? 1 : 0;
  if (tier !== lastTier || auto !== lastAuto) {
    lastTier = tier; lastAuto = auto;
    tierBtn.textContent = tier.toUpperCase() + (auto ? ' · AUTO' : '');
    tierBtn.setAttribute('aria-label', `Quality tier ${tier}${auto ? ', automatic' : ''}. Tap to change it.`);
  }
}

/** Redraw the sparkline and the budget bar (≤ 4×/s). */
export function draw() {
  const c = ctx; if (!c) return;
  const w = cw, h = ch, sh = h - 12 * px, n = filled;
  c.clearRect(0, 0, w, h);
  // 16.7 ms: one frame at 60 fps (the chart tops out at 33.3 ms)
  const y60 = sh - (16.7 / 33.3) * sh;
  c.lineWidth = px; c.strokeStyle = 'rgba(214,162,60,.6)';
  c.setLineDash(DASH); c.beginPath(); c.moveTo(0, y60); c.lineTo(w, y60); c.stroke(); c.setLineDash(SOLID);
  c.fillStyle = 'rgba(241,227,192,.07)'; c.fillRect(0, sh, w, px);
  if (n > 1) {
    const dx = w / (N - 1), x0 = (N - n) * dx, start = filled < N ? 0 : head;
    // JS ms: a filled area
    c.fillStyle = 'rgba(135,150,255,.5)';
    c.beginPath(); c.moveTo(x0, sh);
    for (let i = 0; i < n; i++) { const v = jsS[(start + i) % N]; c.lineTo(x0 + i * dx, sh - (v > 33.3 ? 33.3 : v) / 33.3 * sh); }
    c.lineTo(x0 + (n - 1) * dx, sh); c.closePath(); c.fill();
    // frame ms: a line
    c.strokeStyle = 'rgba(241,227,192,.95)'; c.lineWidth = 1.3 * px; c.lineJoin = 'round';
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const v = frameS[(start + i) % N], y = sh - (v > 33.3 ? 33.3 : v) / 33.3 * sh;
      if (i) c.lineTo(x0 + i * dx, y); else c.moveTo(x0, y);
    }
    c.stroke();
  }
  // where this frame's JS goes, against one 16.7 ms frame; the tick marks the 8 ms budget
  const by = h - 6 * px, bh = 5 * px;
  c.fillStyle = 'rgba(241,227,192,.1)'; c.fillRect(0, by, w, bh);
  let x = 0;
  for (let i = 0; i < SYS.length; i++) {
    let wk = (ema[i] / 16.7) * w; if (x + wk > w) wk = w - x;
    if (wk > 0) { c.fillStyle = SYS_COL[i]; c.fillRect(x, by, wk, bh); x += wk; }
  }
  const bx = (8 / 16.7) * w;
  c.fillStyle = '#ff6a4d'; c.fillRect(bx - px, by - 3 * px, 2 * px, bh + 6 * px);
}

/** The receipt as plain text, for pasting into notes (built on demand, not per frame). */
export function text(world) {
  const s = world.stats, q = world.q, d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ms = (v) => (Math.round(v * 100) / 100).toFixed(2);
  return [
    `Cloth Simulator receipt · ${day} · ${world.sceneId} · ${world.materialId} · tier ${s.tier || (q && q.name)}${q && q.auto ? ' (auto)' : ''}`,
    `${Math.round(s.fps)} fps · ${s.frameMs.toFixed(1)} ms a frame · ${(s.jsMs > 0 ? s.jsMs : ema[JS]).toFixed(1)} ms of JS (p95 ${p95().toFixed(1)} over 2 s)`,
    `JS by system, ms: ${SYS.map((k, i) => `${k} ${ms(ema[i])}`).join(' · ')}`,
    `${world.dpr.toFixed(2)}× render scale · ${s.verts} verts · ${s.constraintsAlive}/${s.constraints} links · ${s.trisAlive} tris · ` +
      `${s.particles}/${q ? Math.floor(q.particles * q.particleScale) : 0} particles · ${s.substeps} substeps · ${s.drawCalls} draw calls`,
    `${navigator.userAgent}`,
  ].join('\n');
}
