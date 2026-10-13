# Cloth Simulator

Real-time 3D cloth you can touch, in the browser. Six scenes, five tools and six materials, with fire, rain, ink
and wind that act on each other. I built it to hold 60 fps on an old phone.

**Play it:** https://app-cloth-simulator.vercel.app

## What you can do

- **Six scenes:**
  - Noren 暖簾, a shop curtain at dusk with the lamps lit behind it
  - Koinobori 鯉のぼり, carp streamers that swim when the wind fills them
  - Banner 幟, a row of banners in a gale at the end of the day
  - Unveiling 除幕, a silk sheet over a glowing moon
  - Embers 火の粉, a night courtyard and a cloth that wants a match
  - Monsoon 梅雨, a tarp in the rain that slowly fills with water
- **Five tools.** Grab with up to five fingers and fling on release. Slice with a katana swipe; big cuts
  slow time for a beat. Burn by tapping to light or holding to torch. Pin by tapping, and tap again to free it. Dye
  with indigo, vermilion, gold or sumi ink that wicks into the weave.
- **Six materials.** Cotton, Silk, Denim, Velvet, Chainmail (it never tears and glows red-hot instead of burning)
  and Aurora (an iridescent film).
- **Weather and the rest.** Wind (still, breeze, gale), rain, slow-mo, tilt (gravity follows your phone), sound,
  and Stats, which shows fps and where every millisecond of the frame goes.

Light passes through the cloth and lands on the floor in the print's colours. Fire chars ahead of the flame and
eats holes with glowing edges. Wet cloth darkens, sags, pools and drips, and won't burn: the fire hisses into
steam. Every sound is synthesised live.

## How it's built

- **WebGL1 and GLSL ES 1.00 only**, so it runs on every phone that has WebGL. There are no libraries: `node build.mjs`
  joins the 64 modules in `src/` into one self-contained `index.html`. The only thing it fetches is a webfont.
- **Physics:**
  - XPBD with small steps (Macklin et al. 2019), with stiffness in physical units
  - tethers that stop the cloth from stretching like rubber
  - strain-based tearing, so rips run
  - aerodynamic drag and lift, which inflate the carp
  - approximate self-collision
- **It measures itself.** A governor watches frame times and steps quality down until the frame fits. When the CPU
  is the bottleneck it drops physics substeps, then particles, then cloth resolution. When the GPU is, it drops
  render resolution, then bloom, then shadow detail. It raises the resolution again when there's headroom.
- **Built with Claude Code.** Eight agents worked in parallel git worktrees on one written contract
  ([CONTRACT.md](CONTRACT.md)), and each owned its own modules: physics, cloth rendering, fire, weather, particles
  and post, scenes, audio, and UI.

## The receipts

`node tests/perf.mjs --throttle 4 --quality low --stress` slows the CPU 4×, which is roughly a 2017 mid-range
phone. It runs each scene for 240 frames, and halfway through it lights two fires, cuts the cloth with the katana
and turns on the rain. It prints the JavaScript milliseconds of every frame, per system. A frame at 60 fps has
16.7 ms.

The run on 2026-10-13 kept the quality fixed at the low tier with the governor off, and it includes the stress half:

| Scene | Mean | Median | Slowest 1 in 20 | Worst frame |
|---|---|---|---|---|
| Noren 暖簾 | 5.9 ms | 5.2 ms | 13.5 ms | 39.4 ms |
| Koinobori 鯉のぼり | 5.9 ms | 5.0 ms | 14.6 ms | 23.0 ms |
| Banner 幟 | 6.3 ms | 5.8 ms | 14.3 ms | 27.2 ms |
| Unveiling 除幕 | 6.8 ms | 6.1 ms | 16.7 ms | 35.2 ms |
| Embers 火の粉 | 4.6 ms | 3.8 ms | 11.8 ms | 39.4 ms |
| Monsoon 梅雨 | 5.7 ms | 5.0 ms | 15.0 ms | 27.8 ms |

The average frame uses about a third of its 16.7 ms. Physics takes 2.3–3.4 ms of that and drawing 1.5–2.2 ms.
Weather, fire, particles, sound and the UI share the last millisecond. The slowest frames come when a cut or a
burn changes the cloth's shape, and when the browser collects garbage. My own budget for those frames was 8 ms,
and they run over it, so on a phone this slow the governor steps quality down.

GPU time can't be measured headless, because Chromium rasterises on the CPU there. On a real device the governor
measures it: it watches real frame times and steps quality down until the frame fits.

## Run it

```sh
npm install
node build.mjs                                            # → index.html
node tests/smoke.mjs                                      # every scene × every tool; fails on any console error
node tests/perf.mjs --throttle 4 --quality low --stress   # JS cost per frame on a 4× slowed CPU
```

The tests drive headless Chromium through Playwright. On the live page, `?stats=1` opens the Stats panel on load,
and `?scene=monsoon` (or `noren`, `koinobori`, `banner`, `unveil`, `embers`) opens a scene directly.

The first version (March 2026, Canvas 2D) is in this repo's history.
