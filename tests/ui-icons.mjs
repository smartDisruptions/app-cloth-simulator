// A contact sheet of every HUD icon (4×) and scene motif (2×), for judging the drawing (owner: ui).
//   node tests/ui-icons.mjs  →  tests/out/ui-icons.png
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { launch, OUT, ROOT } from './lib.mjs';

const { ICON, MOTIF, SCENE_BG } = await import(pathToFileURL(join(ROOT, 'src/ui/icons.js')).href);
const cell = (name, svg) => `<figure><div class="i">${svg}</div><figcaption>${name}</figcaption></figure>`;
const html = `<!doctype html><meta charset="utf-8"><style>
body { margin: 0; padding: 18px; background: #10132a; color: #f4efe4; font: 12px system-ui; width: 900px; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 14px; margin-bottom: 22px; }
figure { margin: 0; text-align: center; } figcaption { margin-top: 6px; color: rgba(244,239,228,.6); }
.i { height: 96px; display: grid; place-items: center; background: rgba(255,255,255,.04); border-radius: 12px; }
.i svg.ic { width: 96px; height: 96px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.i svg .f { fill: currentColor; stroke: none; } .i svg .grip { stroke-width: 2.7; }
.m { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.m .i { height: 150px; } .m svg.motif { width: 192px; height: 128px; fill: none; stroke: rgba(241,227,192,.85); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.m .thick { stroke-width: 2.6; } .m .fill { fill: rgba(241,227,192,.9); stroke: none; } .m .glow { fill: rgba(255,196,120,.5); stroke: none; } .m .glowfill { fill: rgba(241,227,192,.3); }
</style><div class="grid">${Object.entries(ICON).map(([k, v]) => cell(k, v)).join('')}</div>
<div class="m">${Object.entries(MOTIF).map(([k, v]) => `<figure><div class="i" style="background:${SCENE_BG[k]}">${v}</div><figcaption>${k}</figcaption></figure>`).join('')}</div>`;
const file = join(OUT, 'ui-icons.html');
writeFileSync(file, html);
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 936, height: 900 } });
await page.goto(pathToFileURL(file).href);
await page.screenshot({ path: join(OUT, 'ui-icons.png'), fullPage: true });
await browser.close();
console.log('✓ tests/out/ui-icons.png');
