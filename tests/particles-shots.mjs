// Close-up screenshots of every particle kind, the fire, rain, the katana trail, slow-mo and the ambient
// motes and petals (owner: particles-post). One browser, one page per shot, shot device (390×700 @1×).
//   node tests/particles-shots.mjs                   → every shot
//   node tests/particles-shots.mjs --only fire,slash → just those
//   [--quality mid] [--device shot]
// Images land in tests/out/particles-<name>.png. Fire is emulated here (flames, sparks, embers, smoke and
// ash spawned from the burning vertices every frame, the way an fx module would) so the particles can be
// judged on their own, whatever the fire module currently spawns. The shots (quality high unless noted):
//   gallery-night / gallery-day   every kind side by side (embers at night · koinobori by day)
//   fire · fire-low (low tier)    a dense fire on the hanging cloth · flames over cool cloth
//   close-fire · close-fire-moderate   flame tongues, sparks, embers, smoke, ash up close
//   rain · close-water · slowmo-rain   monsoon: streaks, drips, splashes, crown rings, steam · slow-mo beads
//   slash · slash-print · slash-two   the katana trail mid-swipe, fibres in the print's colours, two fingers
//   slowmo                        the slow-mo grade (vignette, muted edges, chromatic bloom) on a slash
//   petals · banner-dusk · motes  ambient sakura (koinobori), dusk leaves (banner), dust (noren)
//   shadow-motes · shadow-tint    particles behind the cloth take the coloured shadow (stand-in map)
//   post-unveil · post-moon · post-noren-low   bloom halo and grade; the low-tier composite
//   close-air                     ash, embers, fibres, wind streaks and leaves at dusk, close
import { launch, open, build, advance, drag, clothRect, OUT } from './lib.mjs';
import { join } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const only = (arg('--only', '') || '').split(',').filter(Boolean);
const quality = arg('--quality', 'high'), device = arg('--device', 'shot');

// In-page helpers, installed once per page: emitters that call the real spawn() every frame.
const HELPERS = () => {
  const C = window.__cloth, W = C.world, P = C.modules.particles;
  const K = { FLAME: 0, SPARK: 1, EMBER: 2, ASH: 3, SMOKE: 4, STEAM: 5, RAIN: 6, SPLASH: 7, DRIP: 8, FIBER: 9, STREAK: 10, MOTE: 11, PETAL: 12 };
  let s = 12345; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const at = (sx, sy, depthK = 1) => { // screen fraction (0..1) → world point at the camera's subject depth
    const c = W.camera, d = c.dist * depthK, nx = sx * 2 - 1, ny = 1 - sy * 2;
    const ox = nx * c.tanHalf * c.aspect * d, oy = ny * c.tanHalf * d;
    return [0, 1, 2].map((k) => c.pos[k] + c.fwd[k] * d + c.right[k] * ox + c.up[k] * oy);
  };
  const emit = {
    [K.FLAME]: (p, f) => { for (let i = 0; i < 3; i++) P.spawn(W, K.FLAME, p[0] + (r() - 0.5) * 0.08, p[1] + (r() - 0.5) * 0.03, p[2], 0, 0.4, 0, 0.06 + 0.05 * r(), 0.45 + 0.4 * r()); },
    [K.SPARK]: (p, f) => { if (f % 2 === 0) P.spawn(W, K.SPARK, p[0], p[1], p[2], (r() - 0.5) * 2.5, 1.5 + 2 * r(), (r() - 0.5) * 1.5, 0.007, 0.8 + 0.6 * r()); },
    [K.EMBER]: (p, f) => { if (f % 2 === 0) P.spawn(W, K.EMBER, p[0] + (r() - 0.5) * 0.1, p[1], p[2], (r() - 0.5) * 0.5, 0.4 + 0.4 * r(), (r() - 0.5) * 0.3, 0.012, 1.5 + r()); },
    [K.ASH]: (p, f) => { if (f % 3 === 0) P.spawn(W, K.ASH, p[0] + (r() - 0.5) * 0.15, p[1] + 0.25, p[2], (r() - 0.5) * 0.3, 0.2, 0, 0.02, 3); },
    [K.SMOKE]: (p, f) => { if (f % 4 === 0) P.spawn(W, K.SMOKE, p[0] + (r() - 0.5) * 0.05, p[1], p[2], (r() - 0.5) * 0.1, 0.25, 0, 0.1 + 0.04 * r(), 2.4 + r()); },
    [K.STEAM]: (p, f) => { if (f % 4 === 0) P.spawn(W, K.STEAM, p[0] + (r() - 0.5) * 0.05, p[1], p[2], 0, 0.5, 0, 0.08, 1.2 + 0.4 * r()); },
    [K.RAIN]: (p, f) => { for (let i = 0; i < 2; i++) P.spawn(W, K.RAIN, p[0] + (r() - 0.5) * 0.4, p[1] + 0.6 + r() * 0.3, p[2] + (r() - 0.5) * 0.2, 0, -9, 0, 0.012, 2, p[1] - 0.25); },
    [K.SPLASH]: (p, f) => { if (f % 6 === 0) for (let i = 0; i < 3; i++) P.spawn(W, K.SPLASH, p[0], p[1] - 0.2, p[2], (r() - 0.5) * 0.8, 0.8 + r(), (r() - 0.5) * 0.8, 0.012, 0.3); },
    [K.DRIP]: (p, f) => { if (f % 12 === 0) P.spawn(W, K.DRIP, p[0], p[1] + 0.25, p[2], 0, -0.2, 0, 0.012, 3, p[1] - 0.25); },
    [K.FIBER]: (p, f) => { if (f % 3 === 0) P.spawn(W, K.FIBER, p[0], p[1] + 0.1, p[2], (r() - 0.5) * 1.2, 0.6 * r(), (r() - 0.5) * 0.5, 0.03, 2.2, [0x2b3a96, 0xe2412a, 0xc8962e, 0xf4efe4][f % 4]); },
    [K.STREAK]: (p, f) => { if (f % 5 === 0) P.spawn(W, K.STREAK, p[0] - 0.3, p[1] + (r() - 0.5) * 0.3, p[2], 0, 0, 0, 0.02, 0.8); },
    [K.MOTE]: (p, f) => { if (f === 0) for (let i = 0; i < 40; i++) P.spawn(W, K.MOTE, p[0] + (r() - 0.5) * 0.5, p[1] + (r() - 0.5) * 0.4, p[2] + (r() - 0.5) * 0.5, 0, 0, 0, 0.005, 10); },
    [K.PETAL]: (p, f) => { if (f % 5 === 0) P.spawn(W, K.PETAL, p[0] + (r() - 0.5) * 0.3, p[1] + 0.25, p[2], 0.2, 0, 0, 0.018, 3, [0xf7cdd8, 0xf2b4c4, 0xfde6ec][f % 3]); },
  };
  /** Run frames while the given emitters fire at screen points. list: [[kind, sx, sy], ...] */
  window.__px = {
    K, at,
    run(list, frames) {
      const pts = list.map(([k, sx, sy, dk]) => [k, at(sx, sy, dk || 0.72)]);
      for (let f = 0; f < frames; f++) { for (const [k, p] of pts) emit[k](p, f); C.advance(1); }
    },
    /** Emulated fire: flames/sparks/embers/smoke/ash from every burning vertex, like an fx module would.
     *  density scales the flame rate (1 = a very dense fire, every burning vertex, a fifth of all frames).
     *  region [cx, cy, r] (world x, y, metres): fake the burning patch instead of reading cloth.heat, so the
     *  cloth stays cool and unlit and only the particles are judged. */
    fire(frames, density = 1, region = null) {
      const cl = W.cloth;
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < cl.n; i++) {
          if (cl.alias[i] >= 0) continue;
          if (region) { const dx = cl.pos[i * 3] - region[0], dy = cl.pos[i * 3 + 1] - region[1]; if (dx * dx + dy * dy > region[2] * region[2]) continue; }
          else if (cl.heat[i] < 0.45 || cl.fuel[i] <= 0) continue;
          const x = cl.pos[i * 3], y = cl.pos[i * 3 + 1], z = cl.pos[i * 3 + 2];
          if (r() < 0.22 * density) P.spawn(W, K.FLAME, x, y, z + 0.01, 0, 0.35, 0, 0.05 + 0.06 * r(), 0.4 + 0.35 * r());
          if (r() < 0.012) P.spawn(W, K.SPARK, x, y, z + 0.02, (r() - 0.5) * 2, 1 + 2.5 * r(), 0.3 + r(), 0.006, 0.7 + 0.8 * r());
          if (r() < 0.03) P.spawn(W, K.EMBER, x, y, z + 0.02, (r() - 0.5) * 0.4, 0.5 + 0.5 * r(), (r() - 0.5) * 0.4, 0.011, 1.4 + 1.2 * r());
          if (r() < 0.025) P.spawn(W, K.SMOKE, x, y + 0.12, z, 0, 0.3, 0, 0.09 + 0.05 * r(), 2 + r());
          if (r() < 0.012) P.spawn(W, K.ASH, x, y + 0.05, z + 0.02, (r() - 0.5) * 0.3, 0.4, 0, 0.016, 3 + 2 * r());
        }
        C.advance(1);
      }
    },
  };
};

const SHOTS = {
  // every kind, one emitter each, over a night scene
  'gallery-night': async (page) => {
    await page.evaluate(() => { const C = window.__cloth; C.api.setToggle('wind', 0); });
    await advance(page, 10);
    await page.evaluate(() => {
      const K = window.__px.K;
      window.__px.run([[K.FLAME, 0.2, 0.33], [K.SPARK, 0.5, 0.33], [K.EMBER, 0.8, 0.33], [K.SMOKE, 0.2, 0.55], [K.STEAM, 0.5, 0.55], [K.ASH, 0.8, 0.5],
        [K.RAIN, 0.2, 0.75], [K.DRIP, 0.5, 0.75], [K.FIBER, 0.8, 0.72], [K.STREAK, 0.35, 0.92], [K.PETAL, 0.75, 0.9], [K.MOTE, 0.5, 0.12, 0.7]], 70);
    });
  },
  'gallery-day': async (page) => {
    await page.evaluate(() => { const C = window.__cloth; C.api.setToggle('wind', 0); });
    await advance(page, 10);
    await page.evaluate(() => {
      const K = window.__px.K;
      window.__px.run([[K.FLAME, 0.2, 0.33], [K.SPARK, 0.5, 0.33], [K.EMBER, 0.8, 0.33], [K.SMOKE, 0.2, 0.55], [K.STEAM, 0.5, 0.55], [K.ASH, 0.8, 0.5],
        [K.RAIN, 0.2, 0.75], [K.SPLASH, 0.5, 0.78], [K.FIBER, 0.8, 0.72], [K.STREAK, 0.35, 0.92], [K.PETAL, 0.75, 0.9]], 70);
    });
  },
  // a real burn with the burn tool, plus the emulated fire spawner, close up
  fire: async (page) => {
    const r = await clothRect(page);
    await drag(page, [[r.cx, r.y0 + r.h * 0.8], [r.cx + 1, r.y0 + r.h * 0.8]], { tool: 'burn', framesPerStep: 6 });
    await page.evaluate(() => window.__px.fire(140));
  },
  rain: async (page) => {
    await page.evaluate(() => window.__cloth.api.setToggle('rain', true));
    await advance(page, 120);
    // drips from the tarp's lowest points, like the wet module would
    await page.evaluate(() => {
      const C = window.__cloth, W = C.world, P = C.modules.particles, cl = W.cloth;
      let lo = 0; for (let i = 0; i < cl.n; i++) if (cl.pos[i * 3 + 1] < cl.pos[lo * 3 + 1]) lo = i;
      for (let f = 0; f < 60; f++) { if (f % 9 === 0) P.spawn(W, 8, cl.pos[lo * 3] + (f % 3 - 1) * 0.05, cl.pos[lo * 3 + 1] - 0.01, cl.pos[lo * 3 + 2], 0, -0.1, 0, 0.012, 3, 0); C.advance(1); }
    });
  },
  // a slice across the cloth: the trail mid-swipe, fibres flying
  slash: async (page) => {
    const r = await clothRect(page);
    await page.evaluate(([r]) => {
      const C = window.__cloth; C.api.setTool('slice');
      const N = 8, x0 = r.x0 - 20, y0 = r.y0 + r.h * 0.3, x1 = r.x1 + 20, y1 = r.y0 + r.h * 0.62;
      let px = x0, py = y0;
      C.input('down', px, py, 1); C.advance(1);
      for (let i = 1; i <= N; i++) {
        const t = i / N, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t + Math.sin(t * Math.PI) * -40;
        C.input('move', x, y, 1); C.api.trail(px, py, x, y); px = x; py = y; C.advance(1);
      }
      C.input('up', px, py, 1); C.advance(2);
    }, [r]);
  },
  // the same slash with time slowed: chromatic fringing on the trail's bloom, frozen rain beads
  slowmo: async (page) => {
    await page.evaluate(() => { window.__cloth.api.setToggle('rain', true); window.__cloth.api.setToggle('slowmo', true); });
    await advance(page, 90);
    const r = await clothRect(page);
    await page.evaluate(([r]) => {
      const C = window.__cloth; C.api.setTool('slice');
      const N = 8, x0 = r.x0 - 20, y0 = r.y0 + r.h * 0.25, x1 = r.x1 + 20, y1 = r.y0 + r.h * 0.7;
      let px = x0, py = y0;
      C.input('down', px, py, 1); C.advance(1);
      for (let i = 1; i <= N; i++) { const t = i / N, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; C.input('move', x, y, 1); C.api.trail(px, py, x, y); px = x; py = y; C.advance(1); }
      C.input('up', px, py, 1); C.advance(2);
    }, [r]);
  },
  petals: async (page) => { await advance(page, 150); },
  motes: async (page) => { await advance(page, 90); },
  // close-ups: the camera rig pulled in so single particles are big enough to judge
  // flames over a patch of cool cloth (no cloth glow, no fire light on the fabric): the particles alone
  'close-fire': async (page) => {
    await page.evaluate(() => { const C = window.__cloth, R = C.world.cameraRig; C.api.setToggle('wind', 0); R.target = [0, 1.25, 0]; R.width *= 0.4; R.height *= 0.4; });
    await page.evaluate(() => window.__px.fire(60, 1, [0, 1.0, 0.16]));
  },
  'close-fire-moderate': async (page) => {
    await page.evaluate(() => { const C = window.__cloth, R = C.world.cameraRig; C.api.setToggle('wind', 0); R.target = [0, 1.25, 0]; R.width *= 0.4; R.height *= 0.4; });
    await page.evaluate(() => window.__px.fire(60, 0.3, [0, 1.0, 0.16]));
  },
  'close-water': async (page) => {
    await page.evaluate(() => { const C = window.__cloth, R = C.world.cameraRig; C.api.setToggle('rain', true); R.target = [0, 0.35, 0.3]; R.width *= 0.3; R.height *= 0.3; });
    await advance(page, 100);
    await page.evaluate(() => {
      const C = window.__cloth, W = C.world, P = C.modules.particles;
      for (let f = 0; f < 40; f++) {
        if (f % 7 === 0) P.spawn(W, 8, (f % 3 - 1) * 0.12, 0.75, 0.3, 0, -0.2, 0, 0.014, 3, 0);
        if (f % 9 === 0) P.spawn(W, 5, 0.25, 0.2, 0.3, 0, 0.4, 0, 0.06, 1.4);
        C.advance(1);
      }
    });
  },
  // the slash again, with a print published (the cloth renderer's job): fibres take the print's colours
  'slash-print': async (page) => {
    await page.evaluate(() => {
      const W = window.__cloth.world;
      if (!W.gpu.printPixels) { // navy with vermilion bands, standing in for the real print
        const w = 64, h = 64, d = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4, band = (y >> 3) % 3 === 1; d[o] = band ? 226 : 29; d[o + 1] = band ? 65 : 42; d[o + 2] = band ? 42 : 99; d[o + 3] = 255; }
        W.gpu.printPixels = { w, h, data: d };
      }
    });
    await SHOTS.slash(page);
    await advance(page, 6);
  },
  // two fingers slashing at once: interleaved segments must still make two smooth ribbons
  'slash-two': async (page) => {
    const r = await clothRect(page);
    await page.evaluate(([r]) => {
      const C = window.__cloth; C.api.setTool('slice');
      const N = 9, a = [r.x0 - 10, r.y0 + r.h * 0.2, r.x1 + 10, r.y0 + r.h * 0.45], b = [r.x1 + 10, r.y0 + r.h * 0.55, r.x0 - 10, r.y0 + r.h * 0.85];
      let pa = [a[0], a[1]], pb = [b[0], b[1]];
      C.input('down', pa[0], pa[1], 1); C.input('down', pb[0], pb[1], 2); C.advance(1);
      for (let i = 1; i <= N; i++) {
        const t = i / N, bend = Math.sin(t * Math.PI) * 35;
        const na = [a[0] + (a[2] - a[0]) * t, a[1] + (a[3] - a[1]) * t - bend], nb = [b[0] + (b[2] - b[0]) * t, b[1] + (b[3] - b[1]) * t + bend];
        C.input('move', na[0], na[1], 1); C.api.trail(pa[0], pa[1], na[0], na[1]); pa = na;
        C.input('move', nb[0], nb[1], 2); C.api.trail(pb[0], pb[1], nb[0], nb[1]); pb = nb;
        C.advance(1);
      }
      C.input('up', pa[0], pa[1], 1); C.input('up', pb[0], pb[1], 2); C.advance(1);
    }, [r]);
  },
  // slow-mo in the rain: streaks freeze into hanging beads
  'slowmo-rain': async (page) => {
    await page.evaluate(() => { const C = window.__cloth, R = C.world.cameraRig; C.api.setToggle('rain', true); R.target = [0, 0.9, 0.4]; R.width *= 0.5; R.height *= 0.5; });
    await advance(page, 90);
    await page.evaluate(() => window.__cloth.api.setToggle('slowmo', true));
    await advance(page, 40);
  },
  // a stand-in coloured shadow map (the cloth renderer's job): dust and rain behind the cloth take its colour
  'shadow-motes': async (page) => {
    await page.evaluate(() => {
      const W = window.__cloth.world, gl = W.gl, n = 64, d = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const o = (y * n + x) * 4, s = ((x >> 3) + (y >> 3)) & 1; d[o] = s ? 255 : 40; d[o + 1] = s ? 140 : 60; d[o + 2] = s ? 60 : 200; d[o + 3] = 255; }
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // world x,y in [-2, 2] → uv [0, 1]: a "light" looking along −z through the curtain
      const M = W.gpu.shadowMat; M.fill(0); M[0] = 0.25; M[5] = 0.25; M[10] = 0.1; M[12] = 0.5; M[13] = 0.5; M[15] = 1;
      W.lights.shadow.type = 'dir'; W.lights.shadow.dir.set([0, 0, 1]);
      W.gpu.shadowTex = t; W.gpu.shadowOn = 1;
      W.scene.ambient = { motes: 220, petals: 0 }; // fill the room with dust
    });
    await advance(page, 60);
  },
  // the same stand-in shadow map, with big white petals hung in front of the curtain: they must take the
  // checker's colours (orange / blue), and the ones behind the curtain (in the lamp's light) stay white
  'shadow-tint': async (page) => {
    await page.evaluate(() => {
      const W = window.__cloth.world, gl = W.gl, n = 64, d = new Uint8Array(n * n * 4);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const o = (y * n + x) * 4, s = ((x >> 3) + (y >> 3)) & 1; d[o] = s ? 255 : 40; d[o + 1] = s ? 140 : 60; d[o + 2] = s ? 60 : 200; d[o + 3] = 255; }
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const M = W.gpu.shadowMat; M.fill(0); M[0] = 0.25; M[5] = 0.25; M[10] = 0.1; M[12] = 0.5; M[13] = 0.5; M[15] = 1;
      W.lights.shadow.type = 'dir'; W.lights.shadow.dir.set([0, 0, 1]);
      W.gpu.shadowTex = t; W.gpu.shadowOn = 1;
      W.scene.ambient = { motes: 0, petals: 0 };
      W.toggles.wind = 0;
      const P = window.__cloth.modules.particles;
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
        const z = r === 2 ? -0.5 : 0.6; // the third row hangs behind the curtain
        P.spawn(W, 12, -0.8 + c * 0.4, 0.9 + r * 0.45, z, 0, 0, 0, 0.09, 30, 0xffffff);
      }
    });
    for (let f = 0; f < 12; f++) await page.evaluate(() => { const D = window.__cloth.modules.particles.debug; for (let i = 0; i < D.n; i++) { D.pool.vx[i] = D.pool.vy[i] = D.pool.vz[i] = 0; } window.__cloth.advance(1); });
  },
  'post-unveil': async (page) => { await advance(page, 60); },
  // what the fire module sends: flame warmth (aux) 0.2 · default · 0.95, and smoke sootiness 0.85 · 0.25
  'fire-aux': async (page) => {
    await page.evaluate(() => { const C = window.__cloth; C.api.setToggle('wind', 0); });
    await page.evaluate(() => {
      const C = window.__cloth, W = C.world, P = C.modules.particles, at = window.__px.at;
      let s = 7; const r = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
      const em = [[0.2, 0.2], [0.5, 0], [0.8, 0.95]].map(([sx, w]) => [at(sx, 0.62, 0.7), w]);
      const sm = [[0.3, 0.85], [0.7, 0.25]].map(([sx, k]) => [at(sx, 0.38, 0.7), k]);
      for (let f = 0; f < 80; f++) {
        for (const [p, w] of em) for (let k = 0; k < 4; k++) P.spawn(W, 0, p[0] + (r() - 0.5) * 0.12, p[1], p[2], (r() - 0.5) * 0.1, 0.35, 0, 0.05 + 0.05 * r(), 0.25 + 0.35 * r(), w);
        if (f % 4 === 0) for (const [p, k] of sm) P.spawn(W, 4, p[0], p[1], p[2], 0, 0.25, 0, 0.11, 2.4, k);
        C.advance(1);
      }
    });
  },
  'banner-dusk': async (page) => { await advance(page, 150); },
  // the moon bare (the sheet's triangles hidden): the bloom's tight core and wide halo on a big emissive
  'post-moon': async (page) => {
    await page.evaluate(() => { const cl = window.__cloth.world.cloth; cl.triAlive.fill(0); cl.vTri.fill(0); cl.topoVersion++; });
    await advance(page, 30);
  },
  'post-noren-low': async (page) => { await advance(page, 60); },
  'fire-low': async (page) => {
    await page.evaluate(() => { const C = window.__cloth, R = C.world.cameraRig; C.api.setToggle('wind', 0); R.target = [0, 1.25, 0]; R.width *= 0.4; R.height *= 0.4; });
    await page.evaluate(() => window.__px.fire(60, 0.6, [0, 1.0, 0.16]));
  },
  'close-air': async (page) => {
    await page.evaluate(() => { const R = window.__cloth.world.cameraRig; R.width *= 0.45; R.height *= 0.45; });
    await advance(page, 10);
    await page.evaluate(() => {
      const K = window.__px.K;
      window.__px.run([[K.ASH, 0.3, 0.25], [K.EMBER, 0.7, 0.45], [K.FIBER, 0.3, 0.6], [K.STREAK, 0.2, 0.8], [K.STREAK, 0.6, 0.3], [K.PETAL, 0.7, 0.75]], 60);
    });
  },
};
const SETUP = {
  'gallery-night': 'scene=embers', 'gallery-day': 'scene=koinobori', fire: 'scene=embers', rain: 'scene=monsoon',
  slash: 'scene=noren', slowmo: 'scene=banner', petals: 'scene=koinobori', motes: 'scene=noren',
  'slash-print': 'scene=noren', 'slash-two': 'scene=embers', 'slowmo-rain': 'scene=monsoon', 'shadow-motes': 'scene=noren',
  'shadow-tint': 'scene=noren',
  'post-unveil': 'scene=unveil', 'fire-aux': 'scene=embers', 'banner-dusk': 'scene=banner', 'post-moon': 'scene=unveil', 'post-noren-low': 'scene=noren&quality=low', 'fire-low': 'scene=embers&quality=low',
  'close-fire': 'scene=embers', 'close-fire-moderate': 'scene=embers', 'close-water': 'scene=monsoon', 'close-air': 'scene=banner&wind=1',
};

const url = build();
const browser = await launch();
let failed = 0;
for (const name of Object.keys(SHOTS)) {
  if (only.length && !only.includes(name)) continue;
  const t0 = Date.now();
  const q = SETUP[name].includes('quality=') ? SETUP[name] : `${SETUP[name]}&quality=${quality}`;
  const { page, errors, ctx } = await open(browser, url, { device, query: `${q}&nogov=1` });
  page.setDefaultTimeout(240000); // eight agents share four cores: SwiftShader can be very slow
  await page.evaluate(HELPERS);
  await advance(page, 30);
  await SHOTS[name](page);
  const path = join(OUT, `particles-${name}.png`);
  await page.screenshot({ path });
  const st = await page.evaluate(() => { const s = window.__cloth.world.stats; return { particles: s.particles, calls: s.drawCalls, ms: +s.ms.particles.toFixed(2), render: +s.ms.render.toFixed(2) }; });
  console.log(`${errors.length ? '✗' : '✓'} ${name.padEnd(14)} ${JSON.stringify(st)}  ${((Date.now() - t0) / 1000).toFixed(1)} s  → ${path}`);
  for (const e of errors) console.log('   ', e.slice(0, 900));
  if (errors.length) failed++;
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
