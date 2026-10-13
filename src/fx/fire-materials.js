// How each material burns (ids from core/materials.js). The fire agent owns and tunes this table.
//
// Temperatures are cloth.heat units: 0 cold · ~0.25 scorching starts · `ign` flaming starts ·
// 0.5–0.6 a flaming band (black char under the flames, barely glowing) · ~0.95 the ember edge the hole
// recedes behind · 1 white-hot.
//
//   ign          flaming ignition temperature (per-vertex jitter ±0.03 is added)
//   smoulderT    smouldering starts here (0 = this material never smoulders)
//   smoulderHeat temperature a smouldering vertex holds (≥ 0.5 so the char front glows)
//   vSmoulder    smoulder front speed, m/s (nearly isotropic, slight upward bias)
//   smoulderTime seconds of smouldering to consume all fuel
//   flareUp      chance per second that deep char (> 0.8) bursts into flame
//   flameLo/Hi   temperature held while flaming: Lo with fresh fuel, Hi at the ember edge (fuel → 0)
//   vUp/vSide/vDown  per-thread flame speed, m/s, up the plume / across / down. Measured fronts
//                (tests/fire-metrics.mjs, still air): cotton 0.36/0.038/0.015 → ~0.25 up, 0.06 across, 0.02
//                down; silk ~0.5 up, 0.12 across; alike at tiers low and mid (the point of speeds in m/s)
//   burnTime     seconds a vertex flames at full intensity before its fuel is gone (a cell coarser than
//                6 cm burns proportionally longer, so slow fronts sustain on every tier)
//   charRate     scorch speed of pre-heated cloth; charCap the darkest scorch before it burns
//   cool         Newtonian cooling, 1/s (a scorch that never caught cools back)
//   cond         thread conduction, m²/s (diffusion along intact threads; below 0.001 it is skipped for
//                fabric, where it is negligible; metal always conducts)
//   torch        how fast the burn tool heats it (× the base rate)
//   flame…drip   emission multipliers (flame tongues, sparks, embers, smoke, ash, burning drips)
//   flameSize    flame tongue size multiplier · smokeDark 0 pale … 1 sooty (passed as SMOKE aux)
//   light        fire-light strength · warmth 0 deep red … 1 white-gold (light and FLAME aux)
//   glowOnly     never burns: takes heat, glows red → orange → yellow, cools by radiation (coolLin, coolRad)
export const FIRE = {
  cotton: {
    ign: 0.45, smoulderT: 0, flameLo: 0.5, flameHi: 0.95,
    vUp: 0.36, vSide: 0.038, vDown: 0.015, burnTime: 1.6,
    charRate: 1.4, charCap: 0.62, cool: 0.4, cond: 0.0004, torch: 1.0,
    flame: 1.0, flameSize: 1.0, spark: 1.0, ember: 1.0, smoke: 0.6, smokeDark: 0.45, ash: 1.0, drip: 0,
    light: 1.0, warmth: 0.45,
  },
  silk: {
    ign: 0.4, smoulderT: 0, flameLo: 0.54, flameHi: 1.0,
    vUp: 1.05, vSide: 0.1, vDown: 0.035, burnTime: 0.7,
    charRate: 2.4, charCap: 0.55, cool: 0.45, cond: 0.0003, torch: 1.5,
    flame: 1.35, flameSize: 1.25, spark: 1.5, ember: 0.8, smoke: 0.22, smokeDark: 0.25, ash: 0.6, drip: 0,
    light: 1.45, warmth: 0.78,
  },
  denim: {
    ign: 0.55, smoulderT: 0, flameLo: 0.5, flameHi: 0.86,
    vUp: 0.12, vSide: 0.008, vDown: 0.005, burnTime: 5.0,
    charRate: 0.9, charCap: 0.7, cool: 0.3, cond: 0.0005, torch: 0.6,
    flame: 0.75, flameSize: 0.9, spark: 0.6, ember: 1.3, smoke: 2.2, smokeDark: 0.85, ash: 1.4, drip: 0,
    light: 0.8, warmth: 0.25,
  },
  velvet: {
    ign: 0.66, smoulderT: 0.34, smoulderHeat: 0.53, vSmoulder: 0.03, smoulderTime: 3.5, flareUp: 0.018,
    flameLo: 0.5, flameHi: 0.9,
    vUp: 0.14, vSide: 0.012, vDown: 0.006, burnTime: 3.0,
    charRate: 3.2, charCap: 0.9, cool: 0.26, cond: 0.0004, torch: 0.85,
    flame: 0.8, flameSize: 0.95, spark: 0.5, ember: 1.6, smoke: 1.7, smokeDark: 0.7, ash: 1.0, drip: 0,
    light: 0.8, warmth: 0.2,
  },
  aurora: {
    ign: 0.36, smoulderT: 0, flameLo: 0.62, flameHi: 1.0,
    vUp: 0.45, vSide: 0.2, vDown: 0.15, burnTime: 0.32,
    charRate: 4.0, charCap: 0.5, cool: 0.55, cond: 0.0003, torch: 1.6,
    flame: 0.35, flameSize: 0.7, spark: 0.5, ember: 0.3, smoke: 0.3, smokeDark: 0.3, ash: 0.15, drip: 1.0,
    light: 1.15, warmth: 0.95,
  },
  chainmail: {
    glowOnly: true, ign: 9, smoulderT: 0,
    cond: 0.0002, coolLin: 0.022, coolRad: 0.16, cool: 0, torch: 2.0,
    flame: 0, flameSize: 0.6, spark: 1.6, ember: 0.2, smoke: 0.1, smokeDark: 0.2, ash: 0, drip: 0,
    light: 0.95, warmth: 0.3,
  },
};
