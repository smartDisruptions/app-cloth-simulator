// Shared helpers for the headless checks (Node 22 + Playwright/Chromium, WebGL on SwiftShader).
//
// SwiftShader rasterises on the CPU in the GPU process: frame RATES here mean nothing, but per-frame
// JS cost (physics, fx, draw submission) does, and CDP CPU throttling slows that main thread the way an
// old phone would. Up to eight agents share 4 cores: keep viewports small and runs short.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'tests', 'out');
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  for (const p of ['/opt/node22/lib/node_modules/playwright/index.mjs', '/usr/local/lib/node_modules/playwright/index.mjs']) {
    if (existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error('Playwright not found');
}
const { chromium } = await loadPlaywright();

/** Build an unminified page into tests/out, one file per process so parallel runs never collide. */
export function build({ minify = false } = {}) {
  const file = join(OUT, `page-${process.pid}.html`);
  execFileSync(process.execPath, [join(ROOT, 'build.mjs'), ...(minify ? [] : ['--dev']), '--out', file], { stdio: ['ignore', 'ignore', 'inherit'] });
  return pathToFileURL(file).href;
}

// The page loads Dela Gothic One from Google Fonts; serve a cached copy so screenshots show real type.
const FONT_URL = 'https://fonts.gstatic.com/s/delagothicone/v19/hESp6XxvMDRA-2eD0lXpDa6QkBA2QkEI.woff2';
const CACHE = join(ROOT, 'tests', '.cache'), FONT = join(CACHE, 'dela-gothic-one.woff2');
function font() {
  if (existsSync(FONT)) return readFileSync(FONT);
  mkdirSync(CACHE, { recursive: true });
  try { execFileSync('curl', ['-sS', '-m', '20', '-o', FONT, FONT_URL], { stdio: 'ignore' }); return readFileSync(FONT); } catch { return null; }
}

export const DEVICES = {
  // an older phone: small screen, 2× pixels, touch
  phone: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, touch: true },
  // the same phone, drawn tiny: separates JS cost from SwiftShader's rasterising back-pressure
  'phone-tiny': { viewport: { width: 180, height: 370 }, deviceScaleFactor: 1, touch: true },
  'phone-landscape': { viewport: { width: 740, height: 360 }, deviceScaleFactor: 2, touch: true },
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, touch: true },
  // cheap to rasterise on SwiftShader, for looking at things
  shot: { viewport: { width: 390, height: 700 }, deviceScaleFactor: 1, touch: true },
  'shot-wide': { viewport: { width: 800, height: 450 }, deviceScaleFactor: 1, touch: false },
  laptop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, touch: false },
};

export async function launch() {
  return chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
}

/**
 * Open the page on a device preset. query: '' or 'scene=embers&quality=low'. manual=1 is always added
 * (the loop is stopped; drive frames with advance()). Resolves when booted.
 */
/** An init script that marks the first-run hint as seen (screenshots of the scene itself). */
export const SEEN = () => { try { localStorage.setItem('cloth-sim:ui:v1', JSON.stringify({ seen: 1, compact: 0, taught: {} })); } catch (e) {} };

export async function open(browser, url, { device = 'shot', query = '', init = null } = {}) {
  const d = DEVICES[device] || DEVICES.shot;
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.touch, isMobile: d.touch });
  const f = font();
  await ctx.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: f ? `@font-face{font-family:'Dela Gothic One';font-style:normal;font-weight:400;font-display:swap;src:url(${FONT_URL}) format('woff2');}` : '' }));
  await ctx.route(/fonts\.gstatic\.com/, (r) => (f ? r.fulfill({ status: 200, contentType: 'font/woff2', body: f }) : r.abort()));
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (/GPU stall due to ReadPixels|GL Driver Message|Automatic fallback to software WebGL|WebGL-/.test(m.text())) return;
    if (m.type() === 'error' || (m.type() === 'warning' && /WebGL|shader|NaN/i.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  const q = ['manual=1', query].filter(Boolean).join('&');
  await page.goto(`${url}?${q}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.bootError, null, { timeout: 60000 });
  const bootError = await page.evaluate(() => document.body.dataset.bootError || '');
  if (bootError) errors.push('[boot] ' + bootError);
  return { ctx, page, errors };
}

/** Slow the page's main thread by `rate`× (4 ≈ a 2017 mid-range phone vs this container's cores). */
export async function throttle(page, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/** Run n frames of dt; returns per-frame JS ms. */
export const advance = (page, n, dt = 1 / 60) => page.evaluate(([n, dt]) => window.__cloth.advance(n, dt), [n, dt]);

/** Pointer gesture helpers (css px). Each step advances `framesPerStep` frames. */
export async function drag(page, pts, { tool, framesPerStep = 2, id = 1 } = {}) {
  await page.evaluate(([pts, tool, k, id]) => {
    const C = window.__cloth;
    if (tool) C.api.setTool(tool);
    C.input('down', pts[0][0], pts[0][1], id); C.advance(k);
    for (let i = 1; i < pts.length; i++) { C.input('move', pts[i][0], pts[i][1], id); C.advance(k); }
    C.input('up', pts[pts.length - 1][0], pts[pts.length - 1][1], id); C.advance(k);
  }, [pts, tool, framesPerStep, id]);
}

/** Screen position of the cloth's bounds centre and size (css px), for aiming gestures. */
export const clothRect = (page) => page.evaluate(() => {
  const W = window.__cloth.world, s = W.screen, n = W.cloth.n;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) { if (s[i * 3 + 2] <= 0 || !W.cloth.vTri[i]) continue; x0 = Math.min(x0, s[i * 3]); x1 = Math.max(x1, s[i * 3]); y0 = Math.min(y0, s[i * 3 + 1]); y1 = Math.max(y1, s[i * 3 + 1]); }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
});

export function summarize(ms) {
  const a = [...ms].sort((x, y) => x - y), n = a.length || 1;
  const mean = a.reduce((s, x) => s + x, 0) / n;
  return { mean: +mean.toFixed(2), p50: +a[Math.floor(n * 0.5)].toFixed(2), p95: +a[Math.floor(n * 0.95)].toFixed(2), max: +a[n - 1].toFixed(2) };
}
