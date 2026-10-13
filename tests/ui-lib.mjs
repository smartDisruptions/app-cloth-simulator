// UI test helpers (owner: ui). Like lib.mjs open(), plus a Dela Gothic One kanji subset so screenshots
// show the HUD's real display face (the shared cache only has the Latin subset), extra device presets,
// and real-touch helpers over CDP.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, DEVICES } from './lib.mjs';

export const CJK = '暖簾鯉のぼり幟除幕火粉梅雨藍朱金墨掴斬燃留染証布';
const CACHE = join(ROOT, 'tests', '.cache');
const LATIN = join(CACHE, 'dela-gothic-one.woff2');
const KANJI = join(CACHE, 'dela-kanji.woff2');
const LATIN_URL = 'https://fonts.gstatic.com/s/delagothicone/v19/hESp6XxvMDRA-2eD0lXpDa6QkBA2QkEI.woff2';
const KANJI_URL = 'https://fonts.gstatic.com/s/delagothicone/ui-test/kanji.woff2';

Object.assign(DEVICES, {
  'ui-p': { viewport: { width: 360, height: 740 }, deviceScaleFactor: 1, touch: true },
  'ui-l': { viewport: { width: 740, height: 360 }, deviceScaleFactor: 1, touch: true },
  'ui-se': { viewport: { width: 320, height: 568 }, deviceScaleFactor: 1, touch: true },
  'ui-d': { viewport: { width: 1100, height: 680 }, deviceScaleFactor: 1, touch: false },
  'ui-tab': { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1, touch: true },
});

function kanjiFont() {
  if (existsSync(KANJI)) return readFileSync(KANJI);
  mkdirSync(CACHE, { recursive: true });
  try {
    const css = execFileSync('curl', ['-sS', '-m', '20', '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      `https://fonts.googleapis.com/css2?family=Dela+Gothic+One&text=${encodeURIComponent(CJK)}`]).toString();
    const m = css.match(/url\((https:[^)]+)\)/);
    if (!m) return null;
    execFileSync('curl', ['-sS', '-m', '20', '-o', KANJI, m[1]]);
    return readFileSync(KANJI);
  } catch { return null; }
}

/** Open the page like lib.open(), with both font subsets. init: a function run before page scripts. */
export async function openUI(browser, url, { device = 'ui-p', query = '', init = null, reducedMotion = 'no-preference' } = {}) {
  const d = DEVICES[device] || DEVICES['ui-p'];
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.touch, isMobile: d.touch, reducedMotion });
  const latin = existsSync(LATIN) ? readFileSync(LATIN) : null, kanji = kanjiFont();
  const css = (latin ? `@font-face{font-family:'Dela Gothic One';font-display:swap;src:url(${LATIN_URL}) format('woff2');unicode-range:U+0000-00FF,U+2000-206F;}` : '') +
    (kanji ? `@font-face{font-family:'Dela Gothic One';font-display:swap;src:url(${KANJI_URL}) format('woff2');unicode-range:U+3000-9FFF;}` : '');
  await ctx.route(/fonts\.googleapis\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: css }));
  await ctx.route(/fonts\.gstatic\.com/, (r) => {
    const u = r.request().url();
    const body = u.includes('ui-test') ? kanji : latin;
    return body ? r.fulfill({ status: 200, contentType: 'font/woff2', body }) : r.abort();
  });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (/GPU stall due to ReadPixels|GL Driver Message|Automatic fallback to software WebGL|WebGL-/.test(m.text())) return;
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  const q = ['manual=1', query].filter(Boolean).join('&');
  page.setDefaultTimeout(240000);   // eight agents share four cores: be patient
  await page.goto(`${url}?${q}`, { timeout: 240000 });
  await page.waitForFunction(() => document.body.dataset.ready === '1' || document.body.dataset.bootError, null, { timeout: 240000 });
  const bootError = await page.evaluate(() => document.body.dataset.bootError || '');
  if (bootError) errors.push('[boot] ' + bootError);
  await page.evaluate(() => document.fonts && document.fonts.ready);
  return { ctx, page, errors };
}

/** Centre of an element (css px), for real taps. */
export async function centre(page, sel) {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no element ' + sel);
  return [b.x + b.width / 2, b.y + b.height / 2];
}

/** A real touch tap on an element, then n frames. */
export async function tapEl(page, sel, frames = 2) {
  const [x, y] = await centre(page, sel);
  await page.touchscreen.tap(x, y);
  if (frames) await page.evaluate((n) => window.__cloth.advance(n), frames);
}

/** Multi-touch over CDP. points: [[x, y, id], ...]; type: touchStart | touchMove | touchEnd. */
export async function touch(cdp, type, points) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Freeze an element's CSS animations at `ms` in, so a screenshot shows that moment however slow the machine. */
export async function freeze(page, sel, ms) {
  await page.evaluate(([sel, ms]) => { for (const el of document.querySelectorAll(sel)) for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms; } }, [sel, ms]);
}
/** With ?manual=1 nothing pumps rendering frames, so CSS transitions only start when something forces
 *  a frame. Force two, then wait: what a live page would show after `ms`. */
export async function settle(page, ms = 0) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  if (ms) await sleep(ms);
}
