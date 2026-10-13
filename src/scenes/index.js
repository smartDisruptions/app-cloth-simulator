// Scene registry and loading. The scenes+environment agent owns src/scenes/ and src/render/env.js.
//
// A scene module default-exports:
//   { id, name, kanji, blurb, print,                         // print = a render/prints.js id
//     defaults: { material, tool, wind: 0|1|2, rain: bool },  // applied by main.js setScene()
//     build(world, b, res),   // b = sim/builder.js builder, res = world.q.clothRes (scale your grid dims by it)
//                             // set world.cameraRig, world.lights (start from resetLights), world.colliders,
//                             // world.gravity, and the scene's `env` description (see render/env.js)
//     afterBuild(world)?,     // optional: runs right after finalize, before any module's onScene. Sets the
//                             // initial pose (cloth.pos/prev) and pin targets (cloth.anchor), e.g. a tarp
//                             // pre-sagged into its catenary so the first frame doesn't jolt
//     update(world, dt) }     // optional: animate anchors (cloth.anchor), colliders, lights, camera
import { createBuilder } from '../sim/builder.js';
import { resetLights, clock } from './util.js';
import noren from './noren.js';
import koinobori from './koinobori.js';
import banner from './banner.js';
import unveil from './unveil.js';
import embers from './embers.js';
import monsoon from './monsoon.js';

export const SCENES = [noren, koinobori, banner, unveil, embers, monsoon];
export const sceneById = (id) => SCENES.find((s) => s.id === id) || SCENES[0];

/** Build scene `id` into world (cloth, colliders, lights, camera, env). */
export function load(world, id) {
  const s = sceneById(id);
  world.sceneId = s.id; world.scene = s;
  world.colliders.spheres.length = 0; world.colliders.capsules.length = 0; world.colliders.planes.length = 0;
  world.gravity.set([0, -9.81, 0]);
  const r = world.cameraRig; r.offset[0] = r.offset[1] = r.offset[2] = 0; r.up[0] = 0; r.up[1] = 1; r.up[2] = 0; r.margin = 1.08;
  resetLights(world);
  clock.t = 0;
  const b = createBuilder();
  s.build(world, b, world.q.clothRes);
  b.finalize(world);
  if (s.afterBuild) s.afterBuild(world);
  return s;
}

export function update(world, dt) {
  clock.t += dt;
  if (world.scene && world.scene.update) world.scene.update(world, dt);
}

export { resetLights, dim, clock } from './util.js';
