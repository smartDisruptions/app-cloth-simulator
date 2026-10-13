// Haptics. Android: navigator.vibrate. iPhone (no Vibration API): iOS 18+ ticks the Taptic Engine when a
// native switch toggles, so a hidden <input type="checkbox" switch> is clicked from inside the gesture
// handler. Both are progressive: anywhere else nothing happens. No allocation per call.
let vib = false, iosLabel = null, last = -1e9;
const THUD = [26, 46, 14];   // the katana beat: hit, gap, aftershock

export const TICK = 0, TAP = 1, THUD_K = 2;

export function init() {
  try {
    vib = typeof navigator.vibrate === 'function';
    const ua = navigator.userAgent || '';
    const ios = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!vib && ios) {
      const label = document.createElement('label');
      label.setAttribute('aria-hidden', 'true');
      label.style.display = 'none';
      const sw = document.createElement('input');
      sw.type = 'checkbox'; sw.tabIndex = -1; sw.setAttribute('switch', '');
      label.appendChild(sw);
      document.body.appendChild(label);
      iosLabel = label;
    }
  } catch (e) { vib = false; iosLabel = null; }
}

/** Chrome blocks vibrate (with a console intervention) until the page has had a real user gesture. */
function activated() {
  const ua = navigator.userActivation;
  return !ua || ua.hasBeenActive;
}

/**
 * kind: TICK (a light tick), TAP (a firm tap), THUD_K (the slow-mo beat). gesture: true when called
 * synchronously from a pointer or click handler (iOS only honours it there).
 */
export function buzz(kind, gesture) {
  const t = performance.now();
  if (kind !== THUD_K && t - last < (kind === TICK ? 70 : 45)) return;
  last = t;
  if (vib) {
    if (!activated()) return;
    try { navigator.vibrate(kind === THUD_K ? THUD : kind === TAP ? 14 : 7); } catch (e) { /* ignore */ }
  } else if (iosLabel && gesture) {
    try { iosLabel.click(); } catch (e) { /* ignore */ }
  }
}
