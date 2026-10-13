// The one seam between ui/input.js and ui/hud.js, so neither imports the other. hud.js fills these in
// at init; input.js calls them. Every slot starts as a no-op so input works without a HUD (tests).
const noop = () => {};

export const bus = {
  /** A finger (or mouse) went down on the cloth canvas. */
  touchStart: noop,
  /** The last finger left the canvas. */
  touchEnd: noop,
  /** The katana beat started (slow-mo pulse). */
  beat: noop,
  /** A short status note, e.g. a tilt sensor problem: note(text). */
  note: noop,
  /** Tilt availability changed: 1 live, 0 off, -1 no sensor, -2 permission denied. */
  tiltState: noop,
};
