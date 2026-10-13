// Helpers for the audio tests: a bare page with the audio engine bundled in (no WebGL, so it is cheap on a
// shared CPU), and a WAV writer. The engine renders through an OfflineAudioContext inside that page.
import * as esbuild from 'esbuild';
import { writeFileSync } from 'node:fs';
import { ROOT, launch } from './lib.mjs';

export { launch };

/** Open a blank page with window.AUDIO = src/audio/offline.js (+ engine, director, bank). */
export async function audioPage(browser) {
  const r = await esbuild.build({
    stdin: { contents: "import * as A from './src/audio/offline.js'; window.AUDIO = A;", resolveDir: ROOT, loader: 'js' },
    bundle: true, write: false, format: 'iife', target: ['es2019'], logLevel: 'silent',
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: r.outputFiles[0].text });
  return { page, errors };
}

/** Write interleaved stereo 16-bit PCM (base64 from offline.js) as a WAV file. */
export function writeWav(path, pcm) {
  const data = Buffer.from(pcm.b64, 'base64'), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(pcm.sr, 24);
  h.writeUInt32LE(pcm.sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}
