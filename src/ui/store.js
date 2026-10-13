// What the UI remembers between visits: whether the first-run hint has been seen, which tools and
// toggles have already been taught, and whether the dock labels can retire. localStorage can throw
// (private windows, sandboxed iframes like claude.ai artifacts), so every access is wrapped; without it
// the page simply behaves like a first visit.
const KEY = 'cloth-sim:ui:v1';

export const prefs = {
  seen: 0,       // the first-run hint was dismissed
  compact: 0,    // the dock labels have done their job
  taught: {},    // tool / toggle ids whose long caption has been shown once
};

export function load() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return;
    prefs.seen = d.seen ? 1 : 0;
    prefs.compact = d.compact ? 1 : 0;
    if (d.taught && typeof d.taught === 'object') prefs.taught = d.taught;
  } catch (e) { /* no storage: first visit every time */ }
}

export function save() {
  try { window.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
}

/** Has `id` been taught? Marks it taught as a side effect. */
export function teach(id) {
  if (prefs.taught[id]) return false;
  prefs.taught[id] = 1;
  save();
  return true;
}

export function taughtCount(ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i++) if (prefs.taught[ids[i]]) n++;
  return n;
}
