// Per-frame event rings. Producers push(x, y, z, w); consumers read data[0 .. n*4) during the frame;
// main.js clears every ring at the end of the frame. Fixed capacity, no allocation: when a ring is
// full, further pushes that frame are dropped (and counted in `dropped`).
export class Ring {
  constructor(cap) { this.cap = cap; this.n = 0; this.dropped = 0; this.data = new Float32Array(cap * 4); }
  push(x, y, z, w) {
    if (this.n >= this.cap) { this.dropped++; return; }
    const o = this.n++ * 4, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
  }
  clear() { this.n = 0; this.dropped = 0; }
}

/**
 * Every event type, its payload and its producer. Consumers: audio (all), particles/fx (some), ui (some).
 *   tear     (x, y, z, j)           sim: constraint j broke from overstretch (x,y,z = its midpoint)
 *   cut      (x, y, z, j)           sim: constraint j was cut by a slice (one per cut constraint; ring may drop)
 *   slice    (x, y, z, count)       sim: one slice segment cut `count` constraints (x,y,z = centroid)
 *   ignite   (x, y, z, strength)    fire: a flame started
 *   burnout  (x, y, z, 0)           fire: a vertex burnt through
 *   steam    (x, y, z, amount)      fire/wet: water met heat
 *   drip     (x, y, z, radius)      wet: a drop left the cloth (radius in metres, ~0.004–0.012)
 *   rainLand (x, y, z, 0)           particles: a RAIN particle reached its kill height (aux); rain decides what it hit
 *   rainHit  (x, y, z, intensity)   rain: a raindrop hit the cloth (after rainLand is processed)
 *   splash   (x, y, z, size)        particles: a DRIP reached the floor (size in metres)
 *   pin      (x, y, z, on)          sim: a vertex was pinned (1) or unpinned (0)
 *   grab     (x, y, z, slot)        main/api: a pointer grabbed the cloth
 *   release  (x, y, z, speed)       main/api: a pointer let go (speed in m/s)
 *   dye      (x, y, z, colour)      dye: an ink drop landed
 *   ui       (code, 0, 0, 0)        ui: a control was used (code: see ui/hud.js UI_SFX)
 */
export const EVENT_TYPES = ['tear', 'cut', 'slice', 'ignite', 'burnout', 'steam', 'drip', 'rainLand', 'rainHit', 'splash', 'pin', 'grab', 'release', 'dye', 'ui'];

export function makeEvents() {
  return {
    tear: new Ring(256), cut: new Ring(256), slice: new Ring(32), ignite: new Ring(32), burnout: new Ring(256), steam: new Ring(64),
    drip: new Ring(64), rainLand: new Ring(512), rainHit: new Ring(256), splash: new Ring(256), pin: new Ring(16),
    grab: new Ring(16), release: new Ring(16), dye: new Ring(32), ui: new Ring(16),
  };
}

export function clearEvents(ev) { for (let i = 0; i < EVENT_TYPES.length; i++) ev[EVENT_TYPES[i]].clear(); }
