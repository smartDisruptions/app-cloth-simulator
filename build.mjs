#!/usr/bin/env node
// Builds the Cloth Simulator into one self-contained page.
//
//   node build.mjs                       → index.html (minified)
//   node build.mjs --dev                 → unminified, for readable stack traces
//   node build.mjs --out <file>          → write the page somewhere else (tests build into tests/out/)
//   node build.mjs --artifact <file>     → also write a copy without the document skeleton, for claude.ai
//
// src/main.js and its ES-module graph are bundled by esbuild into one IIFE and inlined with
// src/style.css into src/shell.html. Nothing loads at runtime except the Dela Gothic One webfont.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const argv = process.argv.slice(2);
const dev = argv.includes('--dev');
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const out = resolve(arg('--out') || join(ROOT, 'index.html'));

let js;
try {
  const r = await esbuild.build({
    entryPoints: [join(SRC, 'main.js')], bundle: true, write: false, format: 'iife',
    target: ['es2019', 'safari14.1'] /* iOS 14.5+: every iPhone from the 6s (2015) on */, minify: !dev, legalComments: 'none', logLevel: 'silent', charset: 'utf8',
  });
  for (const w of r.warnings) console.warn('⚠', w.text, w.location ? `(${w.location.file}:${w.location.line})` : '');
  js = r.outputFiles[0].text;
} catch (e) {
  for (const er of e.errors || []) console.error(`✗ ${er.text}${er.location ? `  (${er.location.file}:${er.location.line}:${er.location.column})` : ''}`);
  if (!e.errors) console.error('✗', e.message);
  process.exit(1);
}

const css = readFileSync(join(SRC, 'style.css'), 'utf8').trimEnd();
const shell = readFileSync(join(SRC, 'shell.html'), 'utf8');
if (!shell.includes('/*@@CSS@@*/') || !shell.includes('/*@@JS@@*/')) { console.error('✗ shell.html is missing a /*@@CSS@@*/ or /*@@JS@@*/ placeholder'); process.exit(1); }
const page = shell.replace('/*@@CSS@@*/', () => css).replace('/*@@JS@@*/', () => js.replace(/<\/script/gi, '<\\/script'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
console.log(`✓ ${out.replace(ROOT + '/', '')}  ${(page.length / 1024).toFixed(0)} KB  (js ${(js.length / 1024).toFixed(0)} KB)${dev ? '  [unminified]' : ''}`);

const art = arg('--artifact');
if (art) {
  let a = page;
  for (const t of ['<!doctype html>\n', '<html lang="en">\n', '<head>\n', '</head>\n', '<body>\n', '</body>\n', '</html>\n']) a = a.replace(t, '');
  a = a.replace(/<meta (charset|name="viewport"|name="description"|name="theme-color"|name="color-scheme"|name="apple-[^"]*"|name="mobile-web-app-capable")[^>]*>\n/g, '');
  if (!a.trimStart().startsWith('<title>')) { console.error('✗ artifact copy must start with <title>'); process.exit(1); }
  writeFileSync(resolve(art), a);
  console.log(`✓ artifact copy → ${art}`);
}
