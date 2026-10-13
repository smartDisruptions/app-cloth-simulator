// What the headless GPU offers the cloth renderer (MSAA for alpha-to-coverage, blend-minmax for the
// depth-in-alpha shadow, derivatives).     node tests/cloth-render-caps.mjs
import { launch, open, build } from './lib.mjs';

const url = build();
const browser = await launch();
const { page, errors } = await open(browser, url, { device: 'shot', query: 'scene=noren&quality=low' });
const caps = await page.evaluate(() => {
  const W = window.__cloth.world, gl = W.gl;
  return {
    samples: gl.getParameter(gl.SAMPLES), sampleBuffers: gl.getParameter(gl.SAMPLE_BUFFERS),
    ext: gl.getSupportedExtensions(), caps: W.glx.caps,
    maxVary: gl.getParameter(gl.MAX_VARYING_VECTORS), maxTexUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
    tier: W.q.name, dpr: W.dpr, px: [W.pxWidth, W.pxHeight],
    shadow: window.__cloth.modules.shadow.debug(),
    a2c: window.__cloth.modules.clothR.debug().a2c,
  };
});
console.log(JSON.stringify(caps, null, 1));
for (const e of errors) console.log('   ', e.slice(0, 600));
await browser.close();
