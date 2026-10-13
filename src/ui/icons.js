// Hand-built inline SVG icons (24×24, stroked with currentColor; `.f` parts are filled) and the scene
// cards' line-art motifs (96×64). Strings, turned into DOM once at init. No emoji, no fonts, no emblems.
const svg = (body, cls = '') => `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  // an open hand, ready to take hold
  grab: svg('<path d="M8.4 12.2V5.6a1.45 1.45 0 0 1 2.9 0v5.6M11.3 10.9V4.2a1.45 1.45 0 0 1 2.9 0v6.7M14.2 11.1V5.5a1.45 1.45 0 0 1 2.9 0v6.3"/>' +
    '<path d="M17.1 11.3V8.3a1.45 1.45 0 0 1 2.9 0v6.1c0 4-2.9 6.8-6.8 6.8h-.8c-2.3 0-3.7-.9-5-2.5l-3-3.9a1.55 1.55 0 0 1 2.3-2.1l1.7 1.7"/>'),
  // a katana: a long, slightly curved blade, the guard, the grip
  slice: svg('<path d="M8.4 15.6C13 12.6 17.4 8.4 21 3c-1.2 4.4-4.6 8.9-11 13.9"/><path d="M5.8 14.4l3.8 3.8"/><path class="grip" d="M7.1 16.9l-3.6 3.6"/>'),
  // a flame with its inner tongue
  burn: svg('<path d="M12 2.8c.6 2.9 2.3 4.5 3.8 6.2 1.4 1.6 2.3 3.2 2.3 5.2a6.1 6.1 0 0 1-12.2 0c0-2.2 1-3.9 2.4-5.2.1 1.6.8 2.7 1.9 3.3-.3-3.7.6-6.9 1.8-9.5z"/>' +
    '<path d="M12 20.3c-1.6 0-2.8-1.2-2.8-2.8 0-1.5 1-2.5 1.9-3.5.3 1 .8 1.6 1.5 1.9.1-1 .4-1.8 1-2.6.9 1.1 1.3 2.3 1.3 3.8 0 1.8-1.2 3.2-2.9 3.2z"/>'),
  // a dressmaker's pin through a fold of cloth: the needle dips behind the fabric and out again
  pin: svg('<path d="M2.8 14.4c2.4-1.7 4.7-1.7 7.1 0s4.7 1.7 7.1 0 3.4-1.4 4.6-1"/><path d="M14.2 9.8l-3.3 3.3M8.5 15.5l-4.2 4.2"/><circle class="f" cx="16.6" cy="7.4" r="3.1"/>'),
  // an ink drop with a highlight
  dye: svg('<path d="M12 3.1c3 3.6 5.7 7 5.7 10.4a5.7 5.7 0 0 1-11.4 0C6.3 10.1 9 6.7 12 3.1z"/><path d="M9.2 14.2a2.9 2.9 0 0 0 2.4 2.7"/>'),

  // wind: still air, a breeze, a gale
  wind0: svg('<path d="M3.5 9.8h14"/><path d="M3.5 14.4h9.5" opacity=".6"/>', 'w0'),
  wind1: svg('<path d="M3.2 9.6h9.6a2.6 2.6 0 1 0-2.6-2.6M3.2 14.4h13.4a2.6 2.6 0 1 1-2.6 2.6"/>', 'w1'),
  wind2: svg('<path d="M2.6 7.2h9.1a2.3 2.3 0 1 0-2.3-2.3M2.6 12h15.6a2.6 2.6 0 1 0-2.6-2.6M2.6 16.8h11.2a2.6 2.6 0 1 1-2.6 2.6"/>', 'w2'),
  // a wagasa: paper umbrella with ribs, and rain
  rain: svg('<path d="M12 2.6v1.6M3.3 11C5.4 6.5 8.4 4.2 12 4.2s6.6 2.3 8.7 6.8"/><path d="M3.3 11q1.09-1 2.17 0t2.17 0 2.18 0 2.18 0 2.17 0 2.18 0 2.17 0 2.18 0"/>' +
    '<path d="M12 4.2V11M12 4.2L7.7 11M12 4.2l4.3 6.8M12 11v9.2"/><path d="M5.2 14.6l-.9 2.2M19.6 14.6l-.9 2.2M7.4 18.2l-.7 1.7" opacity=".8"/>'),
  // an hourglass, sand running
  slowmo: svg('<path d="M6.4 3.4h11.2M6.4 20.6h11.2M8 3.4C8 8 11.3 9 11.3 12S8 16 8 20.6M16 3.4C16 8 12.7 9 12.7 12S16 16 16 20.6"/><path class="f" d="M9.5 19.4c.8-1.3 1.6-1.9 2.5-1.9s1.7.6 2.5 1.9z"/><path d="M12 13.2v3" opacity=".7"/>'),
  // a phone, turning
  tilt: svg('<rect x="8.3" y="4.6" width="7.4" height="14.8" rx="1.8" transform="rotate(-18 12 12)"/><path d="M3.6 9.2a8.8 8.8 0 0 1 3.9-5.1M20.4 14.8a8.8 8.8 0 0 1-3.9 5.1"/><path d="M5.2 3.6l2.3.5-.5 2.3M18.8 20.4l-2.3-.5.5-2.3"/>'),
  soundOn: svg('<path d="M4.4 9.4h3.4l4.7-3.9v13l-4.7-3.9H4.4z"/><path d="M15.6 9.1a4.1 4.1 0 0 1 0 5.8M18.3 6.5a7.8 7.8 0 0 1 0 11"/>', 'son'),
  soundOff: svg('<path d="M4.4 9.4h3.4l4.7-3.9v13l-4.7-3.9H4.4z"/><path d="M16.1 9.6l4.8 4.8M20.9 9.6l-4.8 4.8"/>', 'soff'),
  // the receipt
  stats: svg('<path d="M6.4 3.4h11.2v17.2l-1.87-1.3-1.86 1.3-1.87-1.3-1.87 1.3-1.86-1.3-1.87 1.3z"/><path d="M9.2 8h5.6M9.2 11.4h5.6M9.2 14.8h3.2"/>'),
  // fullscreen: corners opening out, and folding back in
  fsIn: svg('<path d="M4 9V5.6C4 4.7 4.7 4 5.6 4H9M15 4h3.4c.9 0 1.6.7 1.6 1.6V9M20 15v3.4c0 .9-.7 1.6-1.6 1.6H15M9 20H5.6C4.7 20 4 19.3 4 18.4V15"/>', 'fin'),
  fsOut: svg('<path d="M9 4v3.4C9 8.3 8.3 9 7.4 9H4M20 9h-3.4C15.7 9 15 8.3 15 7.4V4M15 20v-3.4c0-.9.7-1.6 1.6-1.6H20M4 15h3.4c.9 0 1.6.7 1.6 1.6V20"/>', 'fout'),
  copy: svg('<rect x="8.4" y="8.4" width="11" height="11" rx="2"/><path d="M15.6 8.4V6.2c0-1-.8-1.8-1.8-1.8H6.2c-1 0-1.8.8-1.8 1.8v7.6c0 1 .8 1.8 1.8 1.8h2.2"/>'),
  reset: svg('<path d="M4.9 12.6a7.3 7.3 0 1 0 2-5.4"/><path d="M5.6 3.6v4h4"/>'),
  chev: svg('<path d="M7.5 10l4.5 4.5 4.5-4.5"/>', 'chev'),
  close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
};

const motif = (body) => `<svg class="motif" viewBox="0 0 96 64" aria-hidden="true" focusable="false">${body}</svg>`;

/** Scene card art, keyed by scene id (unknown ids get none). */
export const MOTIF = {
  noren: motif('<path class="thick" d="M8 11h80"/>' +
    '<path d="M11 12v30c2.7 1.4 5.7 1.6 8.8.5s6.2-.9 8.8.6V12M30.4 12v30c2.7 1.4 5.7 1.6 8.8.5s6.2-.9 8.8.6V12M49.8 12v30c2.7 1.4 5.7 1.6 8.8.5s6.2-.9 8.8.6V12M69.2 12v30c2.7 1.4 5.7 1.6 8.8.5s6.2-.9 8.8.6V12"/>' +
    '<circle class="glow" cx="48" cy="56" r="7"/>'),
  koinobori: motif('<path class="thick" d="M15 7v54"/><circle class="fill" cx="15" cy="5" r="2.4"/>' +
    '<path d="M20 13c18-4.4 36-3.4 50 2.6L84 9l-6 11 6 11-14-6.6C56 30.4 38 31.4 20 27"/><ellipse cx="20" cy="20" rx="2.6" ry="7"/>' +
    '<circle class="fill" cx="29" cy="17.6" r="2"/><path d="M39 15.4c2.2 3 2.2 6.2 0 9.2M49 15c2.2 3.2 2.2 6.8 0 10M59 15.6c2.2 3 2.2 6.2 0 9.2" opacity=".7"/>'),
  banner: motif('<path class="thick" d="M13 7v54"/><circle class="fill" cx="13" cy="5" r="2.2"/>' +
    '<path d="M15 10c18-5 36 6 70-1l-3 27c-28 6-48-4-67 1z"/><path d="M30 11.6c-1 9-1 17 .2 25M50 13.6c-.8 8.6-.6 16.6.6 23.6M68 12.8c-.6 8.2-.2 15.6 1 22" opacity=".45"/>'),
  unveil: motif('<circle class="glowfill" cx="48" cy="30" r="13"/>' +
    '<path d="M18 52c4-17 14-35 30-35s26 18 30 35"/><path d="M40 22c-3.6 9-5.4 19-6 30M56 22c3.6 9 5.4 19 6 30M48 17v35" opacity=".55"/><path class="thick" d="M30 56h36"/>'),
  embers: motif('<path d="M48 14c1.4 6.6 5.4 10.2 8.6 14 3.2 3.6 5.2 7.2 5.2 11.8a13.8 13.8 0 0 1-27.6 0c0-5 2.2-8.8 5.4-11.8.2 3.6 1.8 6.2 4.4 7.6-.6-8.4 1.4-15.6 4-21.6z"/>' +
    '<circle class="fill" cx="31" cy="18" r="1.4"/><circle class="fill" cx="66" cy="12" r="1.1"/><circle class="fill" cx="71" cy="27" r="1.6"/><circle class="fill" cx="26" cy="31" r="1"/><circle class="fill" cx="58" cy="6" r=".9"/>'),
  monsoon: motif('<path d="M12 31c10-2.4 20-6 32-10 14 2.4 28 4.6 42 5.4-10 4.4-21 9-32 14C40 38 26 35 12 31z"/><path d="M28 30c8 3 18 5 26 6" opacity=".55"/>' +
    '<path class="thick" d="M12 31v26M54 40v20M86 26.4V50M44 21v12"/><path d="M22 3l-3.2 8M35 1l-3.2 8M50 3l-3.2 8M65 1l-3.2 8M80 4l-3.2 8M28 13l-2 5M58 13l-2 5" opacity=".7"/>'),
};

/** Scene card backgrounds (CSS), keyed by id. A scene may override with `ui: { gradient }`. */
export const SCENE_BG = {
  noren: 'radial-gradient(30px 22px at calc(100% - 48px) 57px, rgba(255,214,150,.75), rgba(255,180,90,0) 100%), radial-gradient(120% 85% at 50% 108%, rgba(240,150,64,.95) 0%, rgba(162,70,42,.6) 34%, rgba(42,29,52,0) 70%), linear-gradient(180deg, #121633 0%, #2a1d34 100%)',
  koinobori: 'radial-gradient(42% 46% at 82% 18%, rgba(255,255,255,.6), rgba(255,255,255,0) 70%), linear-gradient(180deg, #3f78cc 0%, #86b1e6 58%, #d9e6f2 100%)',
  banner: 'linear-gradient(180deg, #27204c 0%, #73375a 46%, #e4834f 86%, #f2a35c 100%)',
  unveil: 'radial-gradient(70px 56px at calc(100% - 48px) 34px, rgba(241,227,192,.95) 0%, rgba(184,158,112,.45) 34%, rgba(20,18,26,0) 66%), linear-gradient(180deg, #0c0b12, #1d1a22)',
  embers: 'radial-gradient(75% 62% at 56% 104%, rgba(232,80,40,.95) 0%, rgba(122,31,18,.6) 34%, rgba(20,13,22,0) 70%), linear-gradient(180deg, #05050b, #150d16)',
  monsoon: 'linear-gradient(180deg, #3d4955 0%, #63707c 55%, #8a959c 100%)',
};
export const SCENE_BG_FALLBACK = 'linear-gradient(180deg, #1a1f44, #10132a)';
