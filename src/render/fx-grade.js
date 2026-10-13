// Per-scene colour grade for the composite pass (owner: particles-post).
//
// A scene may set `env.grade` (render/env.js reads scene.env; post.js reads only this field):
//   { bloom      bloom strength (1 = neutral)
//     vig        vignette strength 0..1, vigCol: [r,g,b] display-space colour the corners sink toward
//     lift       [r,g,b] matte-black lift colour, liftK: how much (0..0.1): tinted shadows, film stock feel
//     grain      film grain amplitude (0..0.1) }
// Missing fields fall back to the defaults below (tuned per scene), then to NEUTRAL.
// Colours lean on the brand palette: night ink #10132a for the corners, warm lamp, cool rain.
export const NEUTRAL = { bloom: 1.1, vig: 0.4, vigCol: [0.04, 0.045, 0.1], lift: [0.04, 0.04, 0.06], liftK: 0.03, grain: 0.045 };

export const GRADES = {
  noren: { bloom: 1.25, vig: 0.42, vigCol: [0.06, 0.04, 0.05], lift: [0.09, 0.05, 0.03], liftK: 0.035, grain: 0.05 },
  koinobori: { bloom: 0.9, vig: 0.26, vigCol: [0.1, 0.12, 0.2], lift: [0.04, 0.06, 0.1], liftK: 0.025, grain: 0.035 },
  banner: { bloom: 1.15, vig: 0.4, vigCol: [0.09, 0.04, 0.07], lift: [0.1, 0.04, 0.07], liftK: 0.03, grain: 0.045 },
  unveil: { bloom: 1.35, vig: 0.5, vigCol: [0.025, 0.025, 0.045], lift: [0.04, 0.04, 0.06], liftK: 0.025, grain: 0.05 },
  embers: { bloom: 1.45, vig: 0.55, vigCol: [0.02, 0.02, 0.05], lift: [0.06, 0.035, 0.08], liftK: 0.03, grain: 0.055 },
  monsoon: { bloom: 1.0, vig: 0.36, vigCol: [0.06, 0.07, 0.08], lift: [0.04, 0.07, 0.075], liftK: 0.04, grain: 0.05 },
};

/** The grade for the current scene: its env.grade fields over the scene default over NEUTRAL. */
export function gradeFor(world, out) {
  const env = world.scene && world.scene.env, g = (env && env.grade) || {}, d = GRADES[world.sceneId] || NEUTRAL;
  for (const k in NEUTRAL) out[k] = g[k] != null ? g[k] : d[k] != null ? d[k] : NEUTRAL[k];
  return out;
}
