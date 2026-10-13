// Seeded RNG so every run (and every test) is reproducible. Use rand() everywhere, never Math.random().
let s = 0x9e3779b9 >>> 0;

/** Reset the generator. main.js seeds it from ?seed= (default 1) at boot. */
export function seed(n) { s = (n >>> 0) || 1; }

/** mulberry32: a float in [0, 1). */
export function rand() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A float in [a, b). */
export const randRange = (a, b) => a + (b - a) * rand();
/** An integer in [0, n). */
export const randInt = (n) => (rand() * n) | 0;
/** A float in [-1, 1). */
export const randSigned = () => rand() * 2 - 1;
