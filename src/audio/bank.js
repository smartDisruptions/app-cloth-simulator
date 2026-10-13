// The sound bank. Every buffer the engine plays is synthesised here, in plain JS, after the first touch:
// noise beds, the grain of a rip, fire crackle, rain, the katana's ring, drips, chimes, crickets. No audio
// files exist anywhere.
//
// makeBank() is ONE self-contained function: nothing inside refers to anything outside it. That lets
// engine.js ship its source text to a Web Worker (a blob URL) and synthesise the whole bank off the main
// thread, so it can never cost a frame. Where workers are blocked, the same generators run in idle time on
// the main thread; the tests call them directly. Every generator is gen(v, sr) → { sr, ch: [Float32Array…] }
// (v: the variant; sr: the context's rate, used only by the reverb).
//
// Buffers use modest sample rates (32 kHz for bright sounds, 22.05 kHz for soft ones: never below Safari's
// 22.05 kHz floor) to keep the one-time cost low; playback resamples. Everything that loops wraps seamlessly.

export function makeBank() {
  const SR_HI = 32000, SR_MID = 22050, TAU = Math.PI * 2;

  // ---------------------------------------------------------------- tiny PRNG (audio keeps its own noise)
  let rs = 1;
  const seedR = (n) => { rs = Math.imul(n | 0, 2654435761) | 0 || 1; };
  const rnd = () => { let x = rs; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; rs = x; return (x >>> 0) / 4294967296; };
  const nz = () => rnd() * 2 - 1;
  const expRand = (rate) => -Math.log(1 - rnd()) / rate;

  // ---------------------------------------------------------------- helpers
  const mk = (chans, seconds, sr) => {
    const n = Math.max(2, Math.round(seconds * sr)), ch = [];
    for (let c = 0; c < chans; c++) ch.push(new Float32Array(n));
    return { sr, ch };
  };
  const normalize = (d, peak) => {
    let m = 0;
    for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > m) m = a; }
    if (m > 1e-9) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
  };
  const normalize2 = (a, b, peak) => {
    let m = 0;
    for (let i = 0; i < a.length; i++) { const x = Math.max(Math.abs(a[i]), Math.abs(b[i])); if (x > m) m = x; }
    if (m > 1e-9) { const k = peak / m; for (let i = 0; i < a.length; i++) { a[i] *= k; b[i] *= k; } }
  };
  /** Scale to an RMS, then soft-saturate the peaks (tanh): a dense texture with a sane crest factor. */
  const normRms = (d, rms, drive) => {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    const r = Math.sqrt(s / d.length); if (r < 1e-9) return;
    const k = (rms / r) * drive;
    for (let i = 0; i < d.length; i++) d[i] = Math.tanh(d[i] * k) / drive;
  };
  /** Fold a generated tail (the samples that would follow d) into d's head: the buffer loops seamlessly. */
  const loopFold = (d, tail) => {
    const F = tail.length;
    for (let i = 0; i < F; i++) { const a = (i / F) * 1.5707963; d[i] = d[i] * Math.sin(a) + tail[i] * Math.cos(a); }
  };
  /**
   * Add a damped sinusoid A·e^(−t/τ)·sin(2πft) from sample i0 (a struck mode): a recursive oscillator, two
   * multiplies a sample, run to −60 dB. wrap: continue from the start (loops). att: soft attack (s, 0 = struck).
   */
  const addMode = (d, sr, i0, f, A, tau, wrap, att) => {
    const n = d.length;
    if (f <= 0 || f >= sr * 0.45 || A === 0) return;
    const w = (TAU * f) / sr, r = Math.exp(-1 / (tau * sr)), c = 2 * r * Math.cos(w), r2 = r * r;
    let y0 = 0, ym1 = (-A * Math.sin(w)) / r;
    const len = Math.min(wrap ? n : n - i0, Math.ceil(tau * sr * 6.9));
    let a = 1;
    const ka = att > 0 ? Math.exp(-1 / (att * sr)) : 0;
    let ix = i0 % n;
    for (let k = 0; k < len; k++) {
      d[ix] += ka ? y0 * (1 - a) : y0;
      a *= ka;
      const yn = c * y0 - r2 * ym1; ym1 = y0; y0 = yn;
      if (++ix >= n) { if (!wrap) break; ix = 0; }
    }
  };
  /** A whole-buffer sine with a recursive oscillator (no Math.sin per sample). */
  const addSine = (d, sr, f, A) => {
    const w = (TAU * f) / sr, c = 2 * Math.cos(w);
    let y1 = 0, y2 = -A * Math.sin(w);
    for (let i = 0; i < d.length; i++) { d[i] += y1; const y = c * y1 - y2; y2 = y1; y1 = y; }
  };
  /** A short noise burst with an exponential decay: a click, a grain, a fibre snapping. */
  const burst = (d, p, a, len, wrap) => {
    const n = d.length, k = Math.exp(-3 / Math.max(1, len));
    let e = a, ix = (p | 0) % n;
    for (let j = 0; j < 2 * len; j++) {
      d[ix] += e * nz(); e *= k;
      if (++ix >= n) { if (!wrap) return; ix = 0; }
    }
  };
  /** Topology-preserving state-variable filter (Zavalishin): stable under fast sweeps. bp is unity-peak. */
  const svf = (sr) => {
    const f = { i1: 0, i2: 0, a1: 0, a2: 0, a3: 0, k: 1, lp: 0, bp: 0, hp: 0 };
    f.set = (fc, q) => {
      const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr);
      f.k = 1 / q; f.a1 = 1 / (1 + g * (g + f.k)); f.a2 = g * f.a1; f.a3 = g * f.a2;
    };
    f.run = (x) => {
      const v3 = x - f.i2, v1 = f.a1 * f.i1 + f.a2 * v3, v2 = f.i2 + f.a2 * f.i1 + f.a3 * v3;
      f.i1 = 2 * v1 - f.i1; f.i2 = 2 * v2 - f.i2;
      f.bp = v1 * f.k; f.lp = v2; f.hp = x - f.k * v1 - v2;
      return f.bp;
    };
    return f;
  };
  const onePole = (fc, sr) => 1 - Math.exp((-TAU * fc) / sr);

  // ---------------------------------------------------------------- noise beds
  function white() {
    seedR(11);
    const b = mk(1, 2.5, SR_HI), d = b.ch[0];
    for (let i = 0; i < d.length; i++) d[i] = nz();
    return b;
  }

  /** Pink noise (Kellet's filter bank), two independent channels, loop-folded: wind, rain and roar that surround you. */
  function pink() {
    const b = mk(2, 3, SR_MID), n = b.ch[0].length;
    for (let c = 0; c < 2; c++) {
      seedR(12 + c * 101);
      const d = b.ch[c], tail = new Float32Array(2048);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = -3000; i < n + tail.length; i++) {
        const w = nz();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        const y = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
        if (i >= n) tail[i - n] = y; else if (i >= 0) d[i] = y;
      }
      loopFold(d, tail);
    }
    normalize2(b.ch[0], b.ch[1], 0.9);
    return b;
  }

  // ---------------------------------------------------------------- textures (all loop)
  /**
   * The grain of a rip: fibres snapping as a Poisson stream of tiny noise bursts with a heavy-tailed size,
   * sometimes in bundles that go in one zip. v = 1 is silk: denser, smaller, smoother grains (a hiss).
   */
  function grain(v) {
    const fine = !!v;
    seedR(fine ? 21 : 22);
    const b = mk(1, fine ? 1.1 : 1.3, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const floor = fine ? 0.1 : 0.04, rate = fine ? 4000 : 2000;
    for (let i = 0; i < n; i++) d[i] = nz() * floor;
    let t = rnd() * 20;
    while (t < n) {
      t += 1 + expRand(rate) * sr;
      const u = rnd(), a = fine ? 0.3 + 0.7 * u * u : 0.15 + 0.85 * u * Math.sqrt(u);
      let reps = 1, gap = 0;
      if (!fine && rnd() < 0.12) { reps = 3 + ((rnd() * 6) | 0); gap = sr * (0.0004 + rnd() * 0.0018); }
      let p = t;
      for (let r = 0; r < reps; r++) {
        burst(d, p, r ? a * (0.5 + 0.5 * rnd()) : a, fine ? 3 + ((rnd() * 9) | 0) : 5 + ((rnd() * 30) | 0), true);
        p += gap;
      }
    }
    normRms(d, fine ? 0.2 : 0.22, fine ? 1.3 : 1.4);
    return b;
  }

  /** Aurora's film: cellophane crinkle, clusters of very short, very bright clicks. */
  function crinkle() {
    seedR(23);
    const b = mk(1, 1.5, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    for (let i = 0; i < n; i++) d[i] = nz() * 0.015;
    let t = 0;
    while (t < n) {
      t += 1 + expRand(110) * sr;
      const cnt = 2 + ((rnd() * 8) | 0), base = 0.25 + 0.75 * rnd();
      let p = t;
      for (let c = 0; c < cnt; c++) {
        p += sr * (0.0004 + rnd() * 0.0035);
        const L = 2 + ((rnd() * 5) | 0), k = Math.exp(-2.5 / L), s = rnd() < 0.5 ? -1 : 1;
        let e = base * (0.35 + 0.65 * rnd()), ix = (p | 0) % n;
        for (let j = 0; j < 3 * L; j++) { d[ix] += s * e * ((j & 1) ? -0.6 : 1) * (0.5 + 0.5 * rnd()); e *= k; if (++ix >= n) ix = 0; }
      }
    }
    t = 0;
    while (t < n) { t += 1 + expRand(110) * sr; burst(d, t, 0.04 + 0.1 * rnd(), 2 + ((rnd() * 3) | 0), true); }
    normRms(d, 0.14, 1.6);
    return b;
  }

  /** Fire crackle: sparse pops (a click, sometimes a "thup" body, sometimes a double crack) over tiny ticks. v = 1: dense. */
  function crackle(v) {
    const dense = !!v;
    seedR(dense ? 25 : 24);
    const b = mk(1, dense ? 2.3 : 3.1, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const popRate = dense ? 30 : 8, microRate = dense ? 240 : 50;
    let t = 0;
    while (t < n) { t += 1 + expRand(microRate) * sr; burst(d, t, 0.03 + 0.12 * rnd(), 3 + ((rnd() * 10) | 0), true); }
    t = rnd() * 400;
    while (t < n) {
      t += 1 + expRand(popRate) * sr;
      const u = rnd(), a = dense ? 0.2 + 0.8 * u * u : 0.25 + 0.75 * u * u * u;
      burst(d, t, a, ((sr * (0.00025 + rnd() * 0.0016)) | 0) + 2, true);
      if (rnd() < 0.45) addMode(d, sr, t | 0, 140 + rnd() * 240, a * 0.5, 0.003 + rnd() * 0.006, true, 0);
      if (rnd() < 0.25) burst(d, t + sr * (0.002 + rnd() * 0.01), a * 0.6, ((sr * 0.0006) | 0) + 2, true);
    }
    normRms(d, dense ? 0.12 : 0.07, dense ? 1.3 : 1.2);
    return b;
  }

  /** Rain: a stereo field of ~1100 drops a second, each a tiny burst at its own place, a few with a bright plip. */
  function rain() {
    seedR(26);
    const b = mk(2, 2.6, SR_MID), cl = b.ch[0], cr = b.ch[1], n = cl.length, sr = b.sr;
    let t = 0;
    while (t < n) {
      t += 1 + expRand(1100) * sr;
      const len = 6 + ((rnd() * 30) | 0), k = Math.exp(-3 / len), u = rnd();
      const a = 0.03 + 0.5 * u * u * u, p = rnd(), gl = Math.cos(p * 1.5708), gr = Math.sin(p * 1.5708);
      let e = a, ix = (t | 0) % n;
      for (let j = 0; j < 2 * len; j++) { const x = e * nz(); cl[ix] += x * gl; cr[ix] += x * gr; e *= k; if (++ix >= n) ix = 0; }
      if (rnd() < 0.03) {
        const f = 1800 + rnd() * 2700, tau = 0.006 + rnd() * 0.009, A = 0.12 + 0.15 * rnd();
        addMode(cl, sr, t | 0, f, A * gl, tau, true, 0); addMode(cr, sr, t | 0, f, A * gr, tau, true, 0);
      }
    }
    normalize2(cl, cr, 0.85);
    return b;
  }

  /** Rain patter on cloth: soft low thumps, as if on canvas. */
  function patter() {
    seedR(27);
    const b = mk(1, 2.1, SR_MID), d = b.ch[0], n = d.length, sr = b.sr, a1 = onePole(1500, sr);
    let t = 0;
    while (t < n) {
      t += 1 + expRand(95) * sr;
      const u = rnd(), a = 0.15 + 0.85 * u * u, len = ((sr * (0.002 + rnd() * 0.005)) | 0) + 2, k = Math.exp(-3 / len);
      let e = a, y = 0, ix = (t | 0) % n;
      for (let j = 0; j < 3 * len; j++) { y += a1 * (nz() * e - y); d[ix] += y * 2.2; e *= k; if (++ix >= n) ix = 0; }
      addMode(d, sr, t | 0, 240 + rnd() * 180, a * 0.35, 0.006 + rnd() * 0.006, true, 0);
    }
    normRms(d, 0.15, 1.3);
    return b;
  }

  /** Reverb impulse (v = seconds, at the context's rate): pre-delay, early reflections, a tail that darkens as it fades. */
  function ir(seconds, sr) {
    seedR(28);
    const b = mk(2, seconds, sr), n = b.ch[0].length;
    const decay = Math.exp(-6.91 / (seconds * 0.8 * sr)), pre = (0.007 * sr) | 0, fade = (0.004 * sr) | 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = b.ch[ch];
      let y = 0, env = 1, a = 0;
      for (let i = pre; i < n; i++) {
        const j = i - pre;
        if ((j & 63) === 0) a = onePole(800 + 7500 * Math.exp((-j / sr) * 3.2), sr);
        y += a * (nz() - y);
        d[i] = y * env * (j < fade ? j / fade : 1); env *= decay;
      }
      for (let k = 0; k < 7; k++) d[pre + (((0.004 + rnd() * 0.04) * sr) | 0)] += ((k & 1) ? -1 : 1) * (0.25 + 0.35 * rnd());
    }
    return b;
  }

  // ---------------------------------------------------------------- one-shots
  const SHING_R = [1, 1.0067, 1.503, 2.163, 2.749, 3.318, 4.263, 5.12];
  const SHING_A = [1, 0.6, 0.55, 0.5, 0.38, 0.3, 0.18, 0.1];
  const SHING_T = [0.75, 0.7, 0.5, 0.36, 0.27, 0.2, 0.13, 0.08];
  /** The katana: a bright scrape as the edge bites, then the blade's inharmonic ring (two near modes beat: it shimmers). */
  function shing(v) {
    seedR(31 + v);
    const b = mk(1, 1.4, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const sv = svf(sr), ns = (0.07 * sr) | 0;
    for (let i = 0; i < ns; i++) {
      if ((i & 15) === 0) sv.set(2600 * Math.pow(6800 / 2600, i / ns), 2.2);
      const w = Math.sin((Math.PI * i) / ns);
      d[i] += sv.run(nz()) * 0.45 * w * w;
    }
    const f0 = [1720, 1850, 1990][v % 3] * (1 + (rnd() - 0.5) * 0.01), i0 = (0.028 * sr) | 0;
    for (let m = 0; m < 8; m++) addMode(d, sr, i0, f0 * SHING_R[m] * (1 + (rnd() - 0.5) * 0.004), SHING_A[m] * 0.3, SHING_T[m], false, 0.0015);
    const sa = svf(sr); sa.set(1500, 0.8);
    let e = 0.08; const k = Math.exp(-1 / (0.12 * sr));
    for (let i = i0; i < n && e > 1e-4; i++) { d[i] += sa.run(nz()) * e; e *= k; }
    normalize(d, 0.9);
    return b;
  }

  /** Air moved fast: band-passed noise whose centre rises then falls (a swing, a fling). */
  function whoosh(v) {
    seedR(41 + v);
    const b = mk(1, v ? 0.8 : 0.65, SR_MID), d = b.ch[0], n = d.length, sr = b.sr;
    const tp = (v ? 0.4 : 0.33) * n, f0 = 300, fp = v ? 1500 : 1250, f1 = 520, sv = svf(sr);
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) sv.set(i < tp ? f0 * Math.pow(fp / f0, i / tp) : fp * Math.pow(f1 / fp, (i - tp) / (n - tp)), 1.3);
      const a = i < tp ? Math.pow(i / tp, 1.6) : Math.pow((n - i) / (n - tp), 2.2);
      sv.run(nz());
      d[i] = (sv.bp + sv.lp * 0.25) * a;
    }
    normalize(d, 0.9);
    return b;
  }

  /** A water plink: a sine that drops in pitch as it dies, over a tiny contact tick. */
  function plink(v) {
    seedR(51 + v);
    const b = mk(1, 0.25, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const f0 = [1550, 1820, 2150][v % 3];
    let ph = 0, ph2 = 0, eg = 0, a = 1, e1 = 1, e2 = 1, e3 = 0.25, g = 1;
    const ka = Math.exp(-1 / (0.0012 * sr)), k1 = Math.exp(-1 / (0.04 * sr)), k2 = Math.exp(-1 / (0.012 * sr)), k3 = Math.exp(-1 / (0.0006 * sr)), kg = Math.exp(-1 / (0.02 * sr));
    for (let i = 0; i < n; i++) {
      const f = f0 * (0.6 + 0.4 * g); g *= kg;
      ph += (TAU * f) / sr; ph2 += (TAU * f * 2.3) / sr;
      eg = 1 - a; a *= ka;
      d[i] = Math.sin(ph) * eg * e1 + Math.sin(ph2) * 0.22 * e2 * eg + nz() * e3;
      e1 *= k1; e2 *= k2; e3 *= k3;
    }
    normalize(d, 0.85);
    return b;
  }

  /** A drop landing: a soft wash of spray, a low plop and a few droplets flicking off. */
  function splash(v) {
    seedR(61 + v);
    const b = mk(1, 0.45, SR_HI), d = b.ch[0], n = d.length, sr = b.sr, sv = svf(sr);
    sv.set(2300 * (0.85 + 0.3 * rnd()), 0.7);
    let a = 1, e = 1, ph = 0, ep = 0.35, g = 1;
    const ka = Math.exp(-1 / (0.002 * sr)), ke = Math.exp(-1 / (0.055 * sr)), kp = Math.exp(-1 / (0.025 * sr)), kg = Math.exp(-1 / (0.02 * sr));
    for (let i = 0; i < n; i++) {
      const att = 1 - a; a *= ka;
      ph += (TAU * (170 + 150 * g)) / sr; g *= kg;
      d[i] = sv.run(nz()) * att * e + Math.sin(ph) * ep * att;
      e *= ke; ep *= kp;
    }
    const drops = 3 + ((rnd() * 4) | 0);
    for (let k = 0; k < drops; k++) addMode(d, sr, (sr * (0.015 + rnd() * 0.15)) | 0, 2400 + rnd() * 2800, 0.12 + 0.18 * rnd(), 0.008 + rnd() * 0.008, false, 0.0003);
    normalize(d, 0.85);
    return b;
  }

  /** Ink meeting cloth: a rising liquid "bloop" over a soft thump. */
  function bloop(v) {
    seedR(71 + v);
    const b = mk(1, 0.32, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const f0 = v ? 420 : 360;
    let ph = 0, ph3 = 0, a = 1, e = 1, et = 0.35, g = 1;
    const ka = Math.exp(-1 / (0.004 * sr)), ke = Math.exp(-1 / (0.06 * sr)), kt = Math.exp(-1 / (0.018 * sr)), kg = Math.exp(-1 / (0.028 * sr));
    for (let i = 0; i < n; i++) {
      const f = f0 * (1 + 1.3 * (1 - g)); g *= kg;
      ph += (TAU * f) / sr; ph3 += (TAU * 150) / sr;
      const att = 1 - a; a *= ka;
      d[i] = (Math.sin(ph) + 0.12 * Math.sin(2 * ph)) * att * e + Math.sin(ph3) * et * att;
      e *= ke; et *= kt;
    }
    normalize(d, 0.85);
    return b;
  }

  /** Pin: a small bright tick (0 = pin on, higher; 1 = pin off, lower). */
  function tick(v) {
    seedR(81 + v);
    const b = mk(1, 0.08, SR_HI), d = b.ch[0], sr = b.sr;
    const hi = v ? 1500 : 2350, body = v ? 560 : 880;
    addMode(d, sr, 0, hi, 0.6, 0.007, false, 0.0002);
    addMode(d, sr, 0, hi * 1.66, 0.22, 0.004, false, 0.0002);
    addMode(d, sr, 0, body, 0.4, 0.012, false, 0.0004);
    burst(d, 0, 0.5, 6, false);
    normalize(d, 0.8);
    return b;
  }

  /** A match strike: a grainy scratch whose pitch climbs, then the head flaring into a hiss. */
  function strike(v) {
    seedR(91 + v);
    const b = mk(1, 0.32, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const sv = svf(sr), ns = (0.075 * sr) | 0;
    let am = 0, cnt = 0, ka = 0;
    for (let i = 0; i < ns; i++) {
      if ((i & 15) === 0) sv.set(2400 * Math.pow(5200 / 2400, i / ns), 1.6);
      if (--cnt <= 0) { am = 0.3 + 0.7 * rnd(); cnt = (sr * (0.002 + rnd() * 0.003)) | 0; ka = Math.exp(-1 / (0.0015 * sr)); }
      am *= ka;
      const w = Math.sin((Math.PI * i) / ns);
      d[i] += sv.run(nz()) * (0.25 + am) * w * w;
    }
    const fl = svf(sr); fl.set(5600, 0.9);
    const i0 = (0.045 * sr) | 0;
    let a = 1, e = 0.45;
    const k1 = Math.exp(-1 / (0.004 * sr)), k2 = Math.exp(-1 / (0.085 * sr));
    for (let i = i0; i < n; i++) { d[i] += fl.run(nz()) * (1 - a) * e; a *= k1; e *= k2; }
    normalize(d, 0.85);
    return b;
  }

  /** The flame catching: warm noise through a lowpass that opens then settles, with a soft low thump. */
  function whoomph(v) {
    seedR(101 + v);
    const b = mk(1, 1.1, SR_MID), d = b.ch[0], n = d.length, sr = b.sr, sv = svf(sr);
    const pk = (v ? 0.11 : 0.085) * sr, att = 0.075 * sr, k = Math.exp(-1 / ((v ? 0.3 : 0.24) * sr)), a1 = onePole(500, sr);
    let y = 0, e = 1, ph = 0, es = 0.25;
    const ks = Math.exp(-1 / (0.12 * sr));
    for (let i = 0; i < n; i++) {
      if ((i & 15) === 0) sv.set(i < pk ? 200 * Math.pow(1800 / 200, i / pk) : 1800 * Math.pow(450 / 1800, Math.min(1, (i - pk) / (n - pk))), 1.1);
      y += a1 * (nz() - y);
      const env = i < att ? Math.pow(Math.sin((Math.PI * 0.5 * i) / att), 2) : (e *= k);
      ph += (TAU * (90 + 20 * es)) / sr;
      sv.run(y * 4);
      d[i] = sv.lp * env + Math.sin(ph) * es * (i < att ? i / att : 1);
      es *= ks;
    }
    normalize(d, 0.9);
    return b;
  }

  /** A soft pop: cloth burning through. A click, a warm burst and a little body. */
  function pop(v) {
    seedR(111 + v);
    const b = mk(1, 0.14, SR_HI), d = b.ch[0], n = d.length, sr = b.sr, a1 = onePole(2200, sr);
    burst(d, 0, 0.8, 8, false);
    let y = 0, e = 0.7;
    const k = Math.exp(-1 / (0.004 * sr));
    for (let i = 0; i < n; i++) { y += a1 * (nz() * e - y); d[i] += y * 2.5; e *= k; }
    const f = 320 + rnd() * 300;
    addMode(d, sr, 0, f, 0.6, 0.016, false, 0.0006);
    addMode(d, sr, 0, f * 0.86, 0.3, 0.02, false, 0.0006);
    normalize(d, 0.8);
    return b;
  }

  /** The first thread to go: a sharp crack with a tiny ring. */
  function snap(v) {
    seedR(121 + v);
    const b = mk(1, 0.06, SR_HI), d = b.ch[0], sr = b.sr;
    burst(d, 0, 1, (sr * 0.0012) | 0, false);
    addMode(d, sr, 0, 2800 + rnd() * 1200, 0.4, 0.003, false, 0);
    addMode(d, sr, 0, 5200 + rnd() * 800, 0.2, 0.002, false, 0);
    normalize(d, 0.85);
    return b;
  }

  /** Cloth rustle: a few overlapping swells of rubbing fibres. Neutral; the voice's filters give it the material. */
  function rustle(v) {
    seedR(131 + v);
    const b = mk(1, 0.5, SR_HI), d = b.ch[0], n = d.length, sr = b.sr;
    const nb = 4 + ((rnd() * 4) | 0);
    let start = 0;
    for (let k = 0; k < nb && start < n; k++) {
      const len = (sr * (0.025 + rnd() * 0.05)) | 0, amp = (0.45 + 0.55 * rnd()) * Math.pow(0.85, k);
      for (let j = 0; j < len && start + j < n; j++) { const w = Math.sin((Math.PI * j) / len); d[start + j] += amp * w * w; }
      start += (sr * (0.025 + rnd() * 0.06)) | 0;
    }
    let hold = 0, cnt = 0, sm = 0;
    for (let i = 0; i < n; i++) {
      if (--cnt <= 0) { hold = 0.35 + 0.65 * rnd(); cnt = (sr * (0.0015 + rnd() * 0.0025)) | 0; }
      sm += 0.2 * (hold - sm);
      d[i] *= sm * nz();
    }
    normalize(d, 0.85);
    return b;
  }

  /** One raindrop on cloth: a soft, low pat. */
  function tap(v) {
    seedR(141 + v);
    const b = mk(1, 0.06, SR_MID), d = b.ch[0], n = d.length, sr = b.sr, a1 = onePole(1600, sr);
    let y = 0, e = 1;
    const k = Math.exp(-1 / (0.003 * sr));
    for (let i = 0; i < n; i++) { y += a1 * (nz() * e - y); d[i] = y * 2; e *= k; }
    addMode(d, sr, 0, 260 + rnd() * 220, 0.5, 0.009, false, 0.0005);
    normalize(d, 0.85);
    return b;
  }

  /** Chainmail: a cluster of rings knocking together, mostly early. */
  function jingle(v) {
    seedR(151 + v);
    const b = mk(1, 0.5, SR_HI), d = b.ch[0], sr = b.sr;
    const nt = 5 + ((rnd() * 5) | 0);
    for (let k = 0; k < nt; k++) {
      const i0 = (sr * 0.22 * Math.pow(rnd(), 1.7)) | 0, a = 0.3 + 0.7 * rnd(), f = 2700 + rnd() * 4800, tau = 0.03 + rnd() * 0.06;
      addMode(d, sr, i0, f, a, tau, false, 0.0003);
      addMode(d, sr, i0, f * (1.47 + rnd() * 0.2), a * 0.5, tau * 0.6, false, 0.0003);
      addMode(d, sr, i0, f * (2.31 + rnd() * 0.3), a * 0.3, tau * 0.4, false, 0.0003);
      burst(d, i0, a * 0.3, 4, false);
    }
    normalize(d, 0.85);
    return b;
  }

  /** One small metallic tink (rain on chainmail, rings ticking as they heat). */
  function tink(v) {
    seedR(161 + v);
    const b = mk(1, 0.18, SR_HI), d = b.ch[0], sr = b.sr, f = 3300 + rnd() * 1900;
    addMode(d, sr, 0, f, 0.8, 0.045, false, 0.0002);
    addMode(d, sr, 0, f * 1.53, 0.35, 0.028, false, 0.0002);
    addMode(d, sr, 0, 900 + rnd() * 300, 0.2, 0.02, false, 0.0005);
    burst(d, 0, 0.25, 4, false);
    normalize(d, 0.85);
    return b;
  }

  /** The HUD's voice: short, warm, wooden. tap · tool · scene (wide: a swell and two bells) · toggle · reset (a falling swoosh) · open/close (a sheet). */
  function ui() {
    seedR(171);
    const out = {};
    let b = mk(1, 0.08, SR_HI), d = b.ch[0], sr = b.sr;
    {
      let ph = 0, a = 1, e = 1, g = 1;
      const ka = Math.exp(-1 / (0.0008 * sr)), ke = Math.exp(-1 / (0.016 * sr)), kg = Math.exp(-1 / (0.012 * sr));
      for (let i = 0; i < d.length; i++) { ph += (TAU * (1000 + 250 * g)) / sr; g *= kg; d[i] = (Math.sin(ph) + 0.1 * Math.sin(2.6 * ph)) * (1 - a) * e; a *= ka; e *= ke; }
      normalize(d, 0.7); out.tap = b;
    }
    b = mk(1, 0.12, SR_HI); d = b.ch[0]; sr = b.sr;
    addMode(d, sr, 0, 820, 1, 0.035, false, 0.0004); addMode(d, sr, 0, 2030, 0.35, 0.014, false, 0.0003);
    addMode(d, sr, 0, 3360, 0.15, 0.007, false, 0.0002); burst(d, 0, 0.2, 5, false);
    normalize(d, 0.75); out.tool = b;
    // scene: soft and wide. An airy swell (the cut through black) under two bells (C5, then G5), each a hair
    // detuned between the ears so it beats across the stereo field.
    b = mk(2, 1.5, SR_MID); sr = b.sr;
    {
      const dl = b.ch[0], dr = b.ch[1], n = dl.length, pk = 0.35 * sr, svL = svf(sr), svR = svf(sr);
      for (let i = 0; i < n; i++) {
        if ((i & 15) === 0) {
          const fc = i < pk ? 300 * Math.pow(1800 / 300, i / pk) : 1800 * Math.pow(500 / 1800, Math.min(1, (i - pk) / (n - pk)));
          svL.set(fc, 0.9); svR.set(fc * 1.07, 0.9);
        }
        const env = i < pk ? Math.pow(i / pk, 1.5) : Math.exp(-(i - pk) / (0.28 * sr));
        dl[i] = svL.run(nz()) * env * 0.3; dr[i] = svR.run(nz()) * env * 0.3;
      }
      for (let s = 0; s < 2; s++) {
        const f = s ? 783.99 : 523.25, i0 = ((s ? 0.18 : 0.06) * sr) | 0, k = s ? 0.75 : 0.9;
        for (let c = 0; c < 2; c++) {
          const d2 = c ? dr : dl, det = c ? 1.0035 : 0.9965;
          addMode(d2, sr, i0, f * det, k, 0.6, false, 0.006); addMode(d2, sr, i0, f * 2 * det, 0.3 * k, 0.35, false, 0.005);
          addMode(d2, sr, i0, f * 3.01 * det, 0.12 * k, 0.2, false, 0.004);
        }
      }
      normalize2(dl, dr, 0.75);
    }
    out.scene = b;
    b = mk(1, 0.08, SR_HI); d = b.ch[0]; sr = b.sr;
    burst(d, 0, 0.6, 16, false);
    addMode(d, sr, 0, 1900, 0.6, 0.009, false, 0.0002); addMode(d, sr, 0, 950, 0.4, 0.012, false, 0.0003);
    normalize(d, 0.7); out.toggle = b;
    b = mk(1, 0.5, SR_MID); d = b.ch[0]; sr = b.sr;
    {
      const sv = svf(sr), n = d.length, ns = 0.32 * sr;
      for (let i = 0; i < n; i++) {
        if ((i & 15) === 0) sv.set(2400 * Math.pow(380 / 2400, Math.min(1, i / ns)), 1.3);
        const env = i < 0.03 * sr ? i / (0.03 * sr) : Math.exp(-(i - 0.03 * sr) / (0.11 * sr));
        d[i] = sv.run(nz()) * env;
      }
      addMode(d, sr, (0.2 * sr) | 0, 230, 0.5, 0.06, false, 0.003);
      normalize(d, 0.75); out.reset = b;
    }
    // a sheet (the scene and material pickers) sliding open or shut: a soft cloth fwip, rising or falling
    for (let up = 1; up >= 0; up--) {
      b = mk(1, 0.24, SR_HI); d = b.ch[0]; sr = b.sr;
      const n = d.length, pk = 0.4 * n, sv = svf(sr);
      for (let i = 0; i < n; i++) {
        if ((i & 15) === 0) { const u = i / n; sv.set(up ? 900 * Math.pow(3600 / 900, u) : 3200 * Math.pow(800 / 3200, u), 1.1); }
        const env = i < pk ? Math.sin((Math.PI * 0.5 * i) / pk) : Math.pow((n - i) / (n - pk), 2);
        d[i] = sv.run(nz()) * env;
      }
      normalize(d, 0.7);
      if (up) out.open = b; else out.close = b;
    }
    return out;
  }

  // ---------------------------------------------------------------- ambience (built when a scene asks)
  const CHIME = [587.33, 659.26, 739.99, 880.0, 987.77]; // D5 major pentatonic: warm, never a wrong note
  /** A wind-chime tube: free-bar modes (1, 2.76, 5.40), a detuned twin that beats, a soft strike. */
  function chime(v) {
    seedR(181 + v);
    const b = mk(1, 2, SR_MID), d = b.ch[0], sr = b.sr, f = CHIME[v % 5];
    addMode(d, sr, 0, f, 1, 1.6, false, 0.001); addMode(d, sr, 0, f * 2.76, 0.35, 0.65, false, 0.001);
    addMode(d, sr, 0, f * 5.4, 0.12, 0.22, false, 0.0008); addMode(d, sr, 0, f * 1.003, 0.25, 1.4, false, 0.001);
    burst(d, 0, 0.06, 20, false);
    normalize(d, 0.8);
    return b;
  }

  /** Two crickets in the dark, each with its own rhythm and side. Computed only inside their pulses. */
  function crickets() {
    seedR(191);
    const b = mk(2, 6.5, SR_MID), cl = b.ch[0], cr = b.ch[1], n = cl.length, sr = b.sr;
    for (let c = 0; c < 2; c++) {
      const f = c ? 4790 : 4380, gl = c ? 0.42 : 0.9, gr = c ? 0.9 : 0.42;
      let t = rnd() * 0.3 * sr;
      while (t < n) {
        const pulses = c ? 4 + ((rnd() * 2) | 0) : 3 + (rnd() < 0.3 ? 1 : 0), pl = (c ? 0.013 : 0.016) * sr, pp = (c ? 0.021 : 0.024) * sr;
        const amp = (c ? 0.4 : 0.5) * (0.85 + 0.3 * rnd());
        for (let p = 0; p < pulses; p++) {
          const s0 = (t + p * pp) | 0;
          let ph = rnd() * TAU;
          for (let j = 0; j < pl; j++) {
            const w = Math.sin((Math.PI * j) / pl);
            ph += (TAU * f * (1 + 0.006 * w)) / sr; // the wing's pitch lifts a hair mid-pulse
            const x = Math.sin(ph) * w * w * amp, ix = (s0 + j) % n;
            cl[ix] += x * gl; cr[ix] += x * gr;
          }
        }
        t += (c ? 0.9 : 0.62) * sr * (0.85 + 0.3 * rnd());
      }
    }
    normalize2(cl, cr, 0.7);
    return b;
  }

  /** The lamps behind the noren: a warm hum, mostly its 240/360 Hz harmonics so phones carry it (loops exactly in 2 s), in a little room air. */
  function hum() {
    seedR(201);
    const b = mk(1, 2, SR_MID), d = b.ch[0], n = d.length, sr = b.sr, a1 = onePole(380, sr);
    const F = [120, 120.5, 240, 360, 480.5], A = [0.3, 0.14, 0.34, 0.2, 0.1];
    for (let k = 0; k < 5; k++) addSine(d, sr, F[k], A[k]);
    const tail = new Float32Array(2048), air = new Float32Array(n);
    let y = 0;
    for (let i = -2000; i < n + tail.length; i++) { y += a1 * (nz() - y); if (i >= n) tail[i - n] = y; else if (i >= 0) air[i] = y; }
    loopFold(air, tail);
    for (let i = 0; i < n; i++) d[i] += air[i] * 1.6;
    normalize(d, 0.6);
    return b;
  }

  /** The moon under the sheet: a soft open fifth with slow beating tremolo (loops exactly in 2 s). */
  function moon() {
    const b = mk(1, 2, SR_MID), d = b.ch[0], n = d.length, sr = b.sr;
    const F = [261.5, 392, 523.5, 784.5], A = [0.5, 0.35, 0.25, 0.08], M = [0.5, 0.5, 1, 0.5];
    for (let k = 0; k < 4; k++) {
      const w = (TAU * F[k]) / sr, c = 2 * Math.cos(w), wm = (TAU * M[k]) / sr, cm = 2 * Math.cos(wm);
      let y1 = 0, y2 = -A[k] * Math.sin(w), m1 = Math.sin(k), m2 = Math.sin(k - wm);
      for (let i = 0; i < n; i++) {
        d[i] += y1 * (0.6 + 0.4 * m1);
        const y = c * y1 - y2; y2 = y1; y1 = y;
        const m = cm * m1 - m2; m2 = m1; m1 = m;
      }
    }
    normalize(d, 0.6);
    return b;
  }

  /** Distant thunder: brown noise, deeply lowpassed (with a little of its upper edge so phones hear it), rolling in waves. */
  function thunder() {
    seedR(211);
    const b = mk(1, 4, SR_MID), d = b.ch[0], n = d.length, sr = b.sr;
    const a1 = onePole(160, sr), a2 = onePole(700, sr), a3 = onePole(450, sr);
    const on = [0, 0.35 + rnd() * 0.45, 1.1 + rnd() * 0.8, 2.2 + rnd() * 0.8], amp = [1, 0.7, 0.5, 0.35];
    const at = [0.12 + rnd() * 0.1, 0.25, 0.3, 0.4], dc = [0.8, 1.1, 1.2, 1.3];
    const env = new Float64Array(4), up = new Float64Array(4), kd = new Float64Array(4), i0 = new Int32Array(4), i1 = new Int32Array(4);
    for (let k = 0; k < 4; k++) { i0[k] = (on[k] * sr) | 0; i1[k] = i0[k] + ((at[k] * sr) | 0); up[k] = 1 / (at[k] * sr); kd[k] = Math.exp(-1 / (dc[k] * sr)); }
    let y = 0, br = 0, z = 0, m = 0, ec = 0.15;
    const kc = Math.exp(-1 / (0.08 * sr));
    for (let i = 0; i < n; i++) {
      br = (br + 0.02 * nz()) / 1.02; y += a1 * (br * 8 - y); m += a3 * (br * 8 - m); z += a2 * (nz() - z);
      let e = 0;
      for (let k = 0; k < 4; k++) {
        if (i < i0[k]) continue;
        if (i < i1[k]) { const u = (i - i0[k]) * up[k]; env[k] = amp[k] * u * u * (3 - 2 * u); } else env[k] *= kd[k];
        e += env[k];
      }
      d[i] = (y + (m - y) * 0.35) * e + z * ec; ec *= kc;
    }
    normalize(d, 0.9);
    return b;
  }

  return {
    white, pink, grain, crinkle, crackle, rain, patter, ir, shing, whoosh, plink, splash, bloop, tick, strike, whoomph,
    pop, snap, rustle, tap, jingle, tink, ui, chime, crickets, hum, moon, thunder,
  };
}
