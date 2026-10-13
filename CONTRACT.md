# Cloth Simulator — the build contract

Everything an agent needs to build its part without breaking anyone else's. Read it all once. When this
file and the code disagree, the code's comments in `src/core/world.js` and `src/core/events.js` win, and
say so in your report.

## The brief

Josh, 2026-10-13: *"Rebuild this from scratch. Make it a creative and visually stunning cloth simulator.
Do things not thought possible. It needs to run smooth and fast even on an old mobile phone. I want 60
fps."* "This" is the Cloth Simulator in the Smart Disruptions Arcade (2026-03, Canvas 2D: drag, tear,
burn, pin, wind; flag/curtain/hammock/web/cape presets; cotton/silk/denim/chain).

The rebuild is a real-time 3D cloth you can touch: lit like a film set, made of real materials, with fire,
rain, ink and wind that all affect each other. It runs at 60 fps on a 2017-era phone because it measures
itself and scales itself.

### What it does

- **Six scenes**, each a mood and a showcase. **Noren** 暖簾: a split shop curtain with the lamps lit
  behind it. **Koinobori** 鯉のぼり: a carp streamer that swims in the wind. **Banner** 幟: a banner
  in a gale at dusk. **Unveiling** 除幕: a silk sheet over a glowing moon, so you pull it off. **Embers**
  火の粉: a night courtyard and a cloth that wants a match. **Monsoon** 梅雨: a tarp in the rain that fills
  with water.
- **Five tools.** Grab (multi-touch, fling on release), Slice (a katana swipe, slow-mo on big cuts),
  Burn (tap to light, hold to torch), Pin (tap to pin or unpin), Dye (ink drops that wick into the weave).
- **Six materials.** Cotton, Silk, Denim, Velvet, Chainmail (never tears, glows red-hot instead of
  burning), Aurora (iridescent film).
- **Toggles.** Wind (still / breeze / gale), Rain, Slow-mo, Tilt (gravity follows the phone), Sound, and
  Stats (the on-screen receipt: fps, frame ms, JS ms per system, tier).

### The moments that should make Josh say "that's not possible in a browser"

1. **Light through fabric.** The key light passes *through* the cloth and lands on the wall and floor as
   coloured light: the print's colours, softened. Burnt holes and cuts throw bright patches. Backlit cloth
   glows (the Noren's lamps).
2. **Fire that eats cloth.** Burn holes with organic, pixel-sharp glowing edges (a coarse physics grid but
   per-pixel noise edges), charring that spreads ahead of the flame, flames and sparks and smoke and ash,
   the burn front lighting the whole scene, burnt-through scraps falling away. Chainmail glows red-hot.
3. **Rain that soaks.** Drops land on the cloth. Wet cloth darkens, turns glossy, gets heavier and sags.
   Water wicks outward, pools in the low spots, and drips from the lowest point. Wet cloth won't burn: fire
   hisses into steam.
4. **Ink that wicks.** A drop of indigo (aizome), vermilion, gold or sumi blooms along the threads.
   Wet cloth spreads it faster.
5. **The carp swims.** The koinobori tube inflates and undulates in gusts.
6. **The katana.** A swipe cuts cleanly through every layer, time slows for a beat, threads fly.
7. **Tilt the phone** and gravity follows.
8. **Every sound is synthesised live**: rip, flutter, wind, crackle, hiss, rain, drips.
9. **The receipt.** Stats mode shows 60 fps and where every millisecond goes. Proof, not a claim.

## Hard rules

1. **WebGL1 + GLSL ES 1.00 only.** It runs on every phone that has WebGL. Optional extensions must have
   fallbacks: `OES_standard_derivatives` (shaders get `#define HAS_DERIV`) and anisotropic filtering. No
   float textures, MRT, instancing or VAOs. The cloth is < 65,535 vertices, so 16-bit indices.
2. **No allocation in per-frame code**: no `new`, array or object literals, closures, `map`, `filter`,
   spread, or string building in `update`/`step`/`draw` paths. Size typed arrays once (`init` or
   `onScene`). GC pauses are the #1 cause of dropped frames on phones.
3. **Deterministic.** Anything that affects the simulation or the picture uses `rand()` from
   `src/core/rng.js`, never `Math.random()`. Audio may use its own noise.
4. **One self-contained file.** No runtime fetches except the Dela Gothic One webfont, and no libraries.
   Textures are painted procedurally (Canvas 2D or code) at load.
5. **Never draw text glyphs into textures.** Phones without CJK fonts would show boxes. Draw motifs as
   vector shapes. DOM text in the HUD is fine.
6. **IP.** No national or hero emblems on the banner, the cape or anything else. Copy no other game's or
   brand's art. Traditional Japanese patterns (seigaiha, asanoha, kikkō, shippō, uroko) are public domain
   and welcome.
7. **mediump-safe shaders.** Don't hash noise with big ALU constants. Sample the shared `uNoise` texture.
   Old Mali/Adreno GPUs run fragment shaders at mediump.
8. **Respect `world.q`.** Every module scales with the quality tier (table below).
9. **Stay in your files.** See the owners table. Need something in a file you don't own? Work around it in
   your own files and put the request in your report under **CONTRACT REQUESTS**. The lead merges
   everything.

## Performance budget (the 60 fps receipt)

A frame is 16.7 ms, and the browser and the GPU need their share. **The JS budget is 8 ms p95 per frame at
quality `low` under `node tests/perf.mjs --throttle 4 --stress`** (4× CPU throttle ≈ a 2017 mid-range
phone). Per-module shares, roughly:

| Module | ms (low, 4×) | Notes |
|---|---|---|
| sim (physics + normals + projection) | ≤ 3.5 | the big one: tight typed-array loops |
| weather (wind + rain + wet + dye) | ≤ 0.8 | dye texture upload only when it changed |
| fire | ≤ 0.6 | near zero when nothing burns |
| particles update + rain.late | ≤ 0.6 | |
| render submission (all draw calls) | ≤ 1.5 | ≤ ~20 draw calls a frame |
| audio + ui + scene | ≤ 0.5 | DOM writes ≤ 4×/s (pin-marker transforms per frame, and ring/ripple transforms on pointer events, are fine) |

The GPU can't be measured here (SwiftShader is a CPU rasteriser), so design for it:
- Fill rate is the old-phone killer. Keep it to **≤ 2 full-resolution full-screen passes** (sky + bloom
  composite). Everything else full-screen runs at ¼ resolution or lower.
- The cloth fragment shader at tier `low` should be ≲ 60 ALU ops and ≤ 5 texture taps. Use
  `#define QUALITY 0|1|2` branches compiled per tier, not runtime ifs on uniforms.
- Big soft particles (smoke, steam) cost overdraw: cap their size and count per tier.
- Render resolution is the governor's GPU dial (`world.q.dprScale`). Don't fight it.

## Files and owners

| Owner (agent) | Files | Job |
|---|---|---|
| **lead** | `src/main.js`, `src/core/*`, `src/render/gl.js`, `src/render/glsl.js`, `src/shell.html`, `build.mjs`, `tests/lib.mjs`, `tests/smoke.mjs`, `tests/perf.mjs`, `tests/shot.mjs`, `CONTRACT.md`, `README.md` | boot, loop, shared state, integration |
| **physics** | `src/sim/*` | XPBD solver, tearing, collisions, aerodynamics, grabs, picking, slicing, the builder |
| **cloth-render** | `src/render/cloth.js`, `src/render/materials.js`, `src/render/prints.js`, `src/render/shadow.js` | fabric shading, the six materials, the six prints, burn and wet looks, coloured shadows |
| **scenes** | `src/scenes/*`, `src/render/env.js` (+ any `src/render/env-*.js`) | the six scenes: topology, pins, colliders, anchors, cameras, lights, environments and props |
| **fire** | `src/fx/fire.js` (+ `src/fx/fire-*.js`) | combustion, charring, burn-through, flame, spark, smoke and ash emission, fire light, chainmail red-heat |
| **weather** | `src/fx/wind.js`, `src/fx/rain.js`, `src/fx/wet.js`, `src/fx/dye.js` (+ `src/fx/weather-*.js`) | wind field, rain on cloth, wetness and drips and pooling, ink wicking |
| **particles-post** | `src/render/particles.js`, `src/render/post.js` (+ `src/render/fx-*.js`) | how every particle kind looks and moves, slash trails, fibres, ambient motes and petals, bloom, vignette, grade |
| **ui** | `src/ui/*`, `src/style.css` | the HUD design, gestures and tools feel, tilt, haptics, onboarding, stats receipt |
| **audio** | `src/audio/*` | the procedural sound engine |

Everyone may add tests named `tests/<owner>-*.mjs`. Nobody commits `index.html`, `tests/out/` or
`node_modules/`: the lead builds the page at integration.

## Frame order (main.js `tick`)

```
input.update (frameDt) → scenes.update → wind → rain → wet → dye → fire → sim.step
  → camera update + projectAll (world.screen) → particles.update → rain.late → audio.update
  → render: cloth.upload → shadow.render → [screen] env.draw → cloth.draw → particles.draw('main')
            → post.begin → env.drawEmissive → cloth.drawEmissive → particles.draw('emissive') → post.end
  → hud.update → clear events
```

- `dt` passed to sim/fx/particles is **simulated** time (`frameDt × timeScale`, 0 when paused). UI, audio
  and hud get real `frameDt`.
- Pointer events arrive between frames and call `world.api` immediately. Picking uses `world.screen` from
  the previous frame, which is what the user saw.
- Events are produced and consumed in the same frame, then cleared. That's why `rain.late` exists:
  `rainLand` is produced by `particles.update`.

## Module interface

main.js calls only these. All hooks are optional except where a module's API is listed.

| Hook | When |
|---|---|
| `init(world)` | once, after the GL context exists: compile programs, allocate fixed pools |
| `onScene(world)` | after a scene's cloth is built (`world.cloth` is new): size per-cloth arrays, reset state |
| `onMaterial(world)` | `world.materialId` changed |
| `onResize(world)` | canvas size or render scale changed (`world.pxWidth/pxHeight`) |

Module APIs that must keep their signatures:

- **sim/cloth.js**: `step(world, dt)` · `pick(world, x, y, radiusPx)` → master vertex or −1 ·
  `slice(world, x0, y0, x1, y1)` → count (pushes `cut` + `slice` events) · `togglePin(world, v)` → 0|1 ·
  `breakConstraint(world, j, emitTear)` · `killVertex(world, v)` · `computeNormals(cloth)` ·
  `syncAliases(cloth)` · `benchmark()` → ns per constraint solve · `material()` → current sim params.
- **sim/builder.js**: `createBuilder()` → `particle · constraint · bend · triangle · grid · tube · finalize`
  (scenes use these. Extend, don't break).
- **render/cloth.js**: `upload(world)` · `draw(world)` · `drawEmissive(world)`. Publishes `gpu.printTex`,
  `gpu.printPixels`, `gpu.cloth`.
- **render/shadow.js**: `render(world)`. Publishes `gpu.shadowTex`, `gpu.shadowMat`, `gpu.shadowOn`.
- **render/env.js**: `draw(world)` · `drawEmissive(world)`.
- **render/particles.js**: `spawn(world, kind, x, y, z, vx, vy, vz, size, life, aux)` → 1|0 ·
  `capacity(world)` · `count()` · `update(world, dt)` · `draw(world, 'main'|'emissive')` ·
  `trail(world, x0, y0, x1, y1)` (a glowing slash streak in css px. The particles agent adds it and
  main.js exposes it as `world.api.trail`).
- **render/post.js**: `begin(world)` → bool (bloom on) · `end(world)`.
- **fx/wind.js**: `update(world, dt)`. Installs `world.wind.sample(x, y, z, out)` in `init`.
- **fx/rain.js**: `update(world, dt)` · `late(world, dt)`.
- **fx/wet.js**: `update(world, dt)`.
- **fx/dye.js**: `update(world, dt)` · `drop(world, v, colourIndex)` → bool.
- **fx/fire.js**: `update(world, dt)` · `ignite(world, v, strength)` → bool · `torch(world, v, dt)`.
- **scenes/index.js**: `SCENES` · `sceneById(id)` · `load(world, id)` · `update(world, dt)`. A scene module:
  `{ id, name, kanji, blurb, print, defaults: { material, tool, wind, rain }, build(world, b, res),
  update(world, dt)?, env, windDir?, ambient? }`.
- **ui/hud.js**: `sync(world)` · `update(world, dt)` · `fatal(msg)`.
- **ui/input.js**: `update(world, dt)` · `handle(type, x, y, id)` (tests drive input through it).
- **audio/audio.js**: `unlock(world)` · `update(world, dt)` · `sfx(world, name)`.

`world.api` (main.js) is the only door from the UI into the simulation: `setScene · reset · setMaterial ·
setTool · setDye · setToggle · setQuality · pick · grabStart · grabMove · grabEnd · slice · ignite · torch
· togglePin · dye · airPoint · audioUnlock · sfx` (+ `trail` once particles has it).

## The world (`src/core/world.js`)

Every field names its single writer in a comment. The ones that cross agent lines:

| Field | Writer | Readers |
|---|---|---|
| `cloth.pos/prev/vel/normal/invMass/mass0/grabbed/force`, `constraintsAlive`, `trisAlive`, `topoVersion`, `bounds` | physics | everyone |
| `cloth.anchor` (pin targets), `colliders`, `cameraRig`, `lights` (except fire), `gravity` default, `scene.env`, `scene.ambient`, `scene.windDir` | scenes | physics, render, fx |
| `cloth.heat/fuel/char`, `lights.firePos/fireCol` | fire | render, physics (via killVertex), audio, wet |
| `cloth.wet`, `cloth.massScale` | weather (wet) | render, physics (mass), fire (quench), audio |
| `wind.*` + `wind.sample` | weather (wind) | physics (aero), particles, audio, scenes |
| `rain.intensity` | weather (rain) | audio, render (wet sheen on env), scenes |
| `gpu.dyeTex` | weather (dye) | cloth-render |
| `gpu.printTex/printPixels/cloth` | cloth-render | env (none), particles (fibre colour), dye (base colour) |
| `gpu.shadowTex/shadowMat/shadowOn` | cloth-render (shadow) | scenes (env receivers) |
| `pointers[]`, `tilt`, `gravity` (when tilt is on), `slowmoPulse`, `tool`, `dyeColor`, `toggles` | ui (via api for most) | physics (grabs), everyone |
| `cameraRig.uiOffset`, `cameraRig.zoom` | ui (main.js zeroes them per scene) | camera |
| `gravityDefault` | main (each scene's own gravity, restored when Tilt turns off) | ui |
| `stats.*` | as commented | ui (receipt), governor, audio, tests |

Stats whose meaning physics fixed: `stats.flutter` is the RMS angular speed of the surface normals in
rad/s (≈0 still, 5–15 a flag in a breeze, 15–30 snapping in a gale); `stats.tension` is the worst thread
strain (1 at rest, ≈2.2 at a rip). `events.cut` and slice counts cover stretch and shear threads only.
`events.ui` codes: 1 tool · 2 scene · 3 material · 4 toggle · 5 ink pick · 6 reset · 7 sheet open ·
8 sheet close. `world.wind.gustAt(x, y, z, dx, dy, dz, strength)` pushes a local puff of air;
`world.api.gust(x0, y0, x1, y1, dt)` is the swipe-through-air gesture that uses it.

### The cloth (`world.cloth`, built by `sim/builder.js`)

- `n` vertices: `pos`, `prev`, `vel`, `force` (3n floats, metres, y up), `normal` (3n), `uv` (2n),
  `anchor` (3n), `pinned`, `grabbed` (u8), `alias` (i32: −1, or the master this seam vertex copies),
  `piece` (u8), `area`, `mass0`, `massScale`, `invMass`, `heat`, `fuel`, `char`, `wet` (n floats).
- `m` constraints: `cA`, `cB` (u32, always masters), `rest`, `kind` (0 stretch · 1 shear · 2 bend),
  `strength`, `alive` (u8), `bendDep`, `cBend`, `cTri`, and CSR adjacency `vcStart`/`vcList`
  (vertex → its constraints).
- `t` triangles: `tri` (u16), `triAlive`, `triQuad`. `vTri` (per vertex: alive triangles touching it,
  0 = invisible).
- `pieces`: `{ name, type: 'grid'|'tube', start, count, cols, rows, uv, id(c, r) }`.
- **Masters and aliases.** A tube's seam column duplicates its first column so the texture can wrap. Only
  masters are simulated. FX simulate per-vertex fields on masters only. `sim.syncAliases` copies
  everything to aliases after the step.
- **Added at integration (2026-10-13):** `cMid` (per bend: its middle particle), `restPos` (the rest
  shape), `pool` (wet: metres of standing water on up-facing cloth), `solver` (physics-private), and
  `restLen` on tube pieces. `cloth.vel` may be nudged between frames (rain knocks): physics copies it in
  at the start of each step. `sim.material()` returns physical units (`stretchK`, `shearK`, `bendLen`,
  `tear`, `tearTime`, `thickness`, …); the baseline's 0–1 stiffnesses are gone.
- **Topology changes only through `breakConstraint`/`killVertex`.** They keep visuals and physics honest
  (a dead edge kills its triangles, a dead triangle drops its quad's diagonals, a dead edge drops the bends
  across it) and bump `topoVersion` so the renderer re-packs indices.
- Vertex FX fields are 0..1: `heat` (≥ ~0.45 burns, depending on material), `fuel` (1 intact … 0 burnt
  through), `char` (monotonic darkening), `wet`.

## Particles

`spawn(world, PK.X, x, y, z, vx, vy, vz, size_m, life_s, aux)`. The fx modules choose **where and when**.
`render/particles.js` owns **how it moves after spawn and how it looks**. The kinds are in
`src/core/world.js` `PK`:

| Kind | Spawned by | aux |
|---|---|---|
| FLAME, SPARK, EMBER, SMOKE, ASH | fire | FLAME: warmth 0..1 (0 deep red … 1 white-gold) · SMOKE: sootiness 0..1 |
| STEAM | fire (water met heat) and wet | — |
| RAIN | rain (aux = kill height, the cloth or floor under it). On kill → `events.rainLand` | kill y |
| SPLASH | rain (on landing) and particles (DRIP hits the floor) | — |
| DRIP | wet (aux = floor y). On kill → `events.splash` | floor y |
| STREAK | wind (visible gusts) | — |
| FIBER | particles itself, from `tear`/`cut` events (colour from `gpu.printPixels` at the edge's uv) | 0xRRGGBB |
| MOTE, PETAL | particles itself, from `scene.ambient = { motes, petals, petalColors }` | 0xRRGGBB (petal) |

Spawning returns 0 at capacity. Don't retry. RAIN, SPLASH and DRIP may fill the whole pool; every other kind
stops at 85% (rain keeps falling through a big fire), and SMOKE + STEAM together are capped at
44 / 96 / 170 / 240 by tier × `particleScale`. RAIN moves at constant velocity (rain.js predicts its landing
from a straight path); STREAK re-reads `wind.sample` every frame. SPLASH aux = 1 throws a crown ring (standing
water; floor splashes ring by themselves). An aux of 0 means "the default" for FLAME (warmth 0.6) and SMOKE
(sootiness 0.45). Fire keeps ~100 flames alive at tier low (~200 at mid), overlapping
3–5 deep, so each flame's additive intensity stays ~0.25–0.4. `fire.updraft(x, y, z, out)` adds the fire's
plume (a rising, widening column) to `world.wind.sample`, so anything that rides the wind rises over a fire. The cap is `world.q.particles × world.q.particleScale`.

## GL conventions

- Texture units: `UNIT` in `render/gl.js` (0 print · 1 dye · 2 shadow · 3–6 yours · 7 noise).
- main.js calls `resetState(gl)` between modules (blend off, depth test on LEQUAL, depth write on, cull
  off). Set what you need at the start of your draw. If you bind a framebuffer, restore with
  `bindTarget(world, null)`.
- Compile programs in `init`, never per frame. Recompile per tier only in `onScene`/`onResize` when the
  tier's `QUALITY` define changed.
- Lit shaders include `COMMON` (+ `SHADOW` if they receive the coloured shadow), call `setCommon(world, p)`
  (and `setShadow`), work in linear (`toLinear(texture)`), and end with `finish(col, worldPos)` (fog →
  tonemap → gamma). Use `fbm(uv)` / `noiseTex(uv)` for noise.
- `world.stats.drawCalls++` per draw call.

## Quality tiers (`src/core/quality.js`)

| Knob | low | mid | high | ultra | Who reads it |
|---|---|---|---|---|---|
| `clothRes` (× each scene's nominal grid) | 0.55 | 0.75 | 1.0 | 1.3 | scenes |
| `substeps` (max per frame) | 6 | 8 | 10 | 12 | physics |
| `particles` (cap) | 700 | 1400 | 2600 | 4000 | particles, all spawners |
| `bloom`, `bloomDiv` | on, ¼ | on, ¼ | on, ¼ | on, ½ | post |
| `shadowRes` | 128 | 256 | 512 | 512 | shadow |
| `dyeRes` | 64 | 128 | 128 | 256 | dye |
| `dprCap` | 1.25 | 1.6 | 2.0 | 2.0 | main (render scale) |
| `rain` (drops/s at full rain) | 140 | 260 | 420 | 650 | rain |

The governor turns `dprScale`, `particleScale`, `substeps`, `bloom` and `shadowRes` down at runtime, and
`clothRes` at the next scene build. Boot picks the tier from a physics micro-benchmark
(`sim.benchmark()`), so keep that function honest. Shader quality: derive `QUALITY` 0/1/2 from the tier
name (`low` → 0, `mid` → 1, `high`/`ultra` → 2).

## Testing

```sh
cd Tools/cloth-sim && npm install          # once per worktree (esbuild)
node build.mjs --dev                        # → index.html (don't commit it)
node tests/smoke.mjs                        # every scene × every tool, fails on console errors
node tests/perf.mjs --throttle 4 --quality low --stress    # the CPU budget receipt
node tests/shot.mjs --q "scene=embers&quality=mid" --frames 120 --do "burn:0.5,0.8" --out embers.png
```

- Tests open the page with `?manual=1`, so the loop is stopped and frames run only through
  `__cloth.advance(n)`. That's deterministic. `window.__cloth` also exposes `world`, `api`, `modules`
  and `input(type, x, y, id)`.
- Query params: `scene`, `material`, `tool`, `wind` (0–2), `rain` (0/1), `quality`
  (low/mid/high/ultra), `stats`, `seed`, `nogov`, `manual`.
- Look at your screenshots: open the PNG with the Read tool. A screenshot you didn't look at isn't a test.
- Up to eight agents share four CPU cores. Use the `shot` device (390×700 @1×) for looking, run one
  browser at a time, and keep runs short.

## Working in your worktree, and your report

- Your agent runs in its own git worktree on its own branch, created from the skeleton commit. Commit your
  work there (the repo is already configured to author commits as Josh). Use clear messages, small commits
  are fine, and end every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QbnAbVcccgYxb3APRzczQ3
  ```
- Before your last commit: `node build.mjs` succeeds, `node tests/smoke.mjs` passes, and your area is
  inside its perf budget.
- **Your final message is your report**, and the lead reads it to integrate. Include: branch name and final
  commit SHA · what you built · how to see each feature (shot commands) · perf numbers · known issues ·
  **CONTRACT REQUESTS** (exact changes you need in files you don't own, as small diffs or precise
  descriptions).
