// Cloth-render contact sheet: many scene × material states in ONE page (scene and material switch through
// world.api, no reloads), assembled into a single PNG.
//   node tests/cloth-render-sheet.mjs [--quality mid] [--frames 90] [--out cr-sheet.png] [--cols 4]
//     [--cases "noren:cotton|embers:cotton@burn:0.5,0.75;frames:60|monsoon:denim@rain:1|unveil:silk@dye:0.5,0.4"]
//     [--compile]   also compile every material × quality × pass first (fails on any shader error)
//     [--device shot] [--scale 0.5]  (thumbnail scale in the sheet)
// A case is scene:material[@action;action...] with the shot.mjs actions (coords are fractions of the
// cloth's on-screen box): grab:x,y,dx,dy  slice:x0,y0,x1,y1  burn:x,y  dye:x,y  pin:x,y  rain:1  wind:0..2
// torch:x,y,seconds (hold the burn tool)  frames:n (advance n more frames)  dyecolor:i
import { launch, open, build, advance, drag, clothRect, OUT } from './lib.mjs';
import { join, isAbsolute } from 'node:path';
import { writeFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const quality = arg('--quality', 'mid'), frames = Number(arg('--frames', '90')), cols = Number(arg('--cols', '4'));
const out = arg('--out', 'cr-sheet.png'), path = isAbsolute(out) ? out : join(OUT, out);
const device = arg('--device', 'shot'), scale = Number(arg('--scale', '0.5'));
const DEFAULT = 'noren:cotton|koinobori:silk|banner:silk|unveil:silk|embers:cotton|monsoon:cotton';
const cases = arg('--cases', DEFAULT).split('|').filter(Boolean);

const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device, query: `quality=${quality}&nogov=1` });

if (process.argv.includes('--compile')) {
  const t0 = Date.now();
  const n = await page.evaluate(() => {
    const C = window.__cloth, W = C.world, cr = C.modules.clothR;
    let k = 0;
    for (const q of ['low', 'mid', 'high']) {
      C.api.setQuality(q);
      for (const m of ['cotton', 'silk', 'denim', 'velvet', 'chainmail', 'aurora']) { C.api.setMaterial(m); for (const p of ['main', 'emissive', 'shadow']) { cr.getProgram(W, p); k++; } C.advance(1); }
    }
    C.api.setQuality(new URLSearchParams(location.search).get('quality') || 'mid');
    return k;
  });
  console.log(`compiled ${n} programs in ${Date.now() - t0} ms${errors.length ? '  ✗' : '  ✓'}`);
}

const shots = [];
for (const c of cases) {
  const [head, ...acts] = c.split('@');
  const [scene, material] = head.split(':');
  const actions = acts.join('@').split(';').filter(Boolean);
  // scene[+print]:material — an optional print id overrides the scene's (e.g. koinobori+koinobori-single
  // on the baseline's one-tube koinobori, which the integration scene's four-band atlas doesn't fit)
  const [sceneId, printId] = scene.split('+');
  await page.evaluate(([s, m, p]) => {
    const C = window.__cloth, S = C.modules.scenes.sceneById(s);
    if (!S.basePrint) S.basePrint = S.print;
    S.print = p || S.basePrint;
    C.api.setScene(s); if (m) C.api.setMaterial(m);
  }, [sceneId, material, printId || null]);
  await advance(page, Math.ceil(frames / 2));
  const r = await clothRect(page);
  const X = (f) => r.x0 + r.w * f, Y = (f) => r.y0 + r.h * f;
  for (const a of actions) {
    const [name, rest = ''] = a.split(':'); const v = rest.split(',').map(Number);
    if (name === 'grab') await drag(page, [[X(v[0]), Y(v[1])], [X(v[0]) + v[2] / 2, Y(v[1]) + v[3] / 2], [X(v[0]) + v[2], Y(v[1]) + v[3]]], { tool: 'grab', framesPerStep: 4 });
    else if (name === 'slice') await drag(page, [[X(v[0]), Y(v[1])], [(X(v[0]) + X(v[2])) / 2, (Y(v[1]) + Y(v[3])) / 2], [X(v[2]), Y(v[3])]], { tool: 'slice', framesPerStep: 1 });
    else if (name === 'torch') await drag(page, [[X(v[0]), Y(v[1])], [X(v[0]) + 1, Y(v[1])]], { tool: 'burn', framesPerStep: Math.round((v[2] || 0.5) * 60) });
    else if (['burn', 'pin', 'dye'].includes(name)) await drag(page, [[X(v[0]), Y(v[1])]], { tool: name, framesPerStep: 3 });
    else if (name === 'rain') await page.evaluate((v) => window.__cloth.api.setToggle('rain', !!v), v[0]);
    else if (name === 'wind') await page.evaluate((v) => window.__cloth.api.setToggle('wind', v), v[0]);
    else if (name === 'dyecolor') await page.evaluate((v) => window.__cloth.api.setDye(v), v[0]);
    else if (name === 'frames') await advance(page, v[0]);
    else if (name === 'wet') await page.evaluate((v) => { const c = window.__cloth.world.cloth; c.wet.fill(v); }, v[0]);
    // stand-in for fx/wet.js pooling: soaked at v[0], and water standing (cloth.pool, metres) up to a level
    // v[1] of the way from the cloth's lowest point to its highest
    else if (name === 'pool') await page.evaluate((v) => {
      const c = window.__cloth.world.cloth; let lo = 1e9, hi = -1e9;
      for (let i = 0; i < c.n; i++) { const y = c.pos[i * 3 + 1]; if (y < lo) lo = y; if (y > hi) hi = y; }
      if (!c.pool) c.pool = new Float32Array(c.n);
      const level = lo + (hi - lo) * v[1];
      for (let i = 0; i < c.n; i++) { const d = level - c.pos[i * 3 + 1]; c.pool[i] = Math.max(0, d); c.wet[i] = d > 0 ? 1 : v[0]; }
    }, v);
    // test-only camera poke: margin < 1 moves in (scenes reset it on load); optional target shift x,y
    else if (name === 'zoom') await page.evaluate((v) => { const r = window.__cloth.world.cameraRig; r.margin = v[0]; if (v.length > 2) { r.target[0] += v[1]; r.target[1] += v[2]; } }, v);
    else if (name === 'heat') await page.evaluate((v) => { const c = window.__cloth.world.cloth; c.heat.fill(v); }, v[0]);
    // test-only relight: key light FROM direction (x, y, z) with colour (r, g, b); the coloured shadow
    // follows it (type 'dir'), so the baseline env (which filters only the key light) shows light through cloth
    else if (name === 'light') await page.evaluate((v) => {
      const L = window.__cloth.world.lights, n = Math.hypot(v[0], v[1], v[2]) || 1;
      L.keyDir[0] = v[0] / n; L.keyDir[1] = v[1] / n; L.keyDir[2] = v[2] / n;
      if (v.length > 5) { L.keyCol[0] = v[3]; L.keyCol[1] = v[4]; L.keyCol[2] = v[5]; }
      L.shadow.type = 'dir'; L.shadow.dir[0] = -L.keyDir[0]; L.shadow.dir[1] = -L.keyDir[1]; L.shadow.dir[2] = -L.keyDir[2];
    }, v);
    // the point light casts (as the integration scenes set it): pshadow:x,y,z[,fov] with dir down
    else if (name === 'pshadow') await page.evaluate((v) => {
      const L = window.__cloth.world.lights;
      L.shadow.type = 'point'; L.shadow.pos[0] = v[0]; L.shadow.pos[1] = v[1]; L.shadow.pos[2] = v[2];
      L.shadow.dir[0] = 0; L.shadow.dir[1] = -1; L.shadow.dir[2] = 0; L.shadow.fov = v[3] || 150;
      L.pointPos[0] = v[0]; L.pointPos[1] = v[1]; L.pointPos[2] = v[2];
    }, v);
    // freeze simulated time (fire, physics), so a painted state can be looked at without the fx modules
    else if (name === 'pause') await page.evaluate(() => { window.__cloth.world.paused = true; });
    else if (name === 'nofire') await page.evaluate(() => { window.__cloth.world.lights.fireCol.fill(0); });
    // a burn painted straight into the cloth's fields: burnt through (killed) inside r·0.55, a charred ring,
    // heat glowing around the edge. Coordinates are cloth uv.
    else if (name === 'burnfield') await page.evaluate(([cu, cv, r, h]) => {
      const C = window.__cloth, W = C.world, c = W.cloth, ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      W.paused = true; W.lights.fireCol.fill(0);
      for (let i = 0; i < c.n; i++) {
        const d = Math.hypot((c.uv[i * 2] - cu) * 1.0, c.uv[i * 2 + 1] - cv) / r;
        c.fuel[i] = Math.min(c.fuel[i], ss(0.45, 1.0, d));
        c.char[i] = Math.max(c.char[i], 1 - ss(0.75, 1.7, d));
        c.heat[i] = Math.max(c.heat[i], (1 - ss(0.6, 1.25, d)) * (h == null || Number.isNaN(h) ? 0.8 : h));
      }
      for (let i = 0; i < c.n; i++) if (c.fuel[i] <= 0.02 && c.alias[i] < 0) C.modules.sim.killVertex(W, i);
    }, v);
    // test-only stand-in for the weather agent's dye layer: ink blooms painted into a dyeTex
    else if (name === 'fakedye') await page.evaluate(() => {
      const W = window.__cloth.world, gl = W.gl, S = 128, d = new Uint8Array(S * S * 4);
      const blobs = [[0.3, 0.35, 0.12, [26, 43, 122]], [0.62, 0.5, 0.1, [227, 64, 41]], [0.45, 0.72, 0.09, [217, 158, 46]], [0.75, 0.25, 0.07, [13, 13, 18]]];
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let a = 0, r = 255, g = 255, b = 255;
        for (const [cx, cy, rad, c] of blobs) {
          const q = Math.hypot(x / S - cx, y / S - cy) / rad; if (q > 1.25) continue;
          const am = Math.max(0, Math.min(1, 1.25 - q)) * (0.75 + 0.25 * Math.sin(x * 0.7 + y * 0.4));
          if (am > a) { a = am; r = c[0]; g = c[1]; b = c[2]; }
        }
        const o = (y * S + x) * 4; d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = Math.round(a * 255);
      }
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      W.gpu.dyeTex = t;
    });
    else if (name === 'char') await page.evaluate((v) => { const c = window.__cloth.world.cloth; c.char.fill(v); }, v[0]);
  }
  await advance(page, Math.floor(frames / 2));
  if (process.argv.includes('--probe')) {
    // read back the rendered pixel at a few points of the cloth (fractions of its screen box)
    const px = await page.evaluate(() => {
      const C = window.__cloth, W = C.world, gl = W.gl, s = W.screen, out = [];
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < W.cloth.n; i++) { if (s[i * 3 + 2] <= 0) continue; x0 = Math.min(x0, s[i * 3]); x1 = Math.max(x1, s[i * 3]); y0 = Math.min(y0, s[i * 3 + 1]); y1 = Math.max(y1, s[i * 3 + 1]); }
      C.advance(1);
      const b = new Uint8Array(4);
      for (const [fx, fy] of [[0.15, 0.85], [0.5, 0.5], [0.85, 0.15]]) {
        const x = Math.round((x0 + (x1 - x0) * fx) * W.dpr), y = Math.round(W.pxHeight - (y0 + (y1 - y0) * fy) * W.dpr);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); out.push(`(${fx},${fy})=${b[0]},${b[1]},${b[2]}`);
      }
      return out.join('  ');
    });
    console.log('   probe', px);
  }
  const buf = await page.screenshot();
  shots.push({ label: c, b64: buf.toString('base64') });
  console.log(`${errors.length ? '✗' : '·'} ${c}`);
}

// assemble the sheet in a blank page
const vp = page.viewportSize();
const tw = Math.round(vp.width * scale), th = Math.round(vp.height * scale);
const sheet = await page.context().newPage();
await sheet.setViewportSize({ width: tw * Math.min(cols, shots.length), height: (th + 16) * Math.ceil(shots.length / cols) });
await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${tw}px);font:10px monospace;color:#ddd">${shots.map((s) => `<div><img src="data:image/png;base64,${s.b64}" style="width:${tw}px;height:${th}px;display:block"><div style="height:16px;overflow:hidden;white-space:nowrap">${s.label}</div></div>`).join('')}</body>`);
await sheet.screenshot({ path, fullPage: true });
writeFileSync(path.replace(/\.png$/, '.txt'), shots.map((s) => s.label).join('\n'));
console.log(`${errors.length ? '✗' : '✓'} ${path}`);
for (const e of errors) console.log('   ', e.slice(0, 1500));
await browser.close();
process.exit(errors.length ? 1 : 0);
