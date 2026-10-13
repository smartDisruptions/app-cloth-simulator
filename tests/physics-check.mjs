// Physics regression checks, in Node (no browser): the behaviours the cloth must keep.
//   node tests/physics-check.mjs            (~1–2 min on a quiet machine)
// Each check prints ✓/✗ with its numbers; exit code 1 if any fails.
import v8 from 'node:v8';
import { world } from '../src/core/world.js';
import { unproject } from '../src/core/camera.js';
import { clearEvents } from '../src/core/events.js';
import * as sim from '../src/sim/cloth.js';
import { setup, frame } from './physics-lab.mjs';

let failed = 0;
const ok = (name, pass, info) => { console.log(`${pass ? '✓' : '✗'} ${name.padEnd(46)} ${info}`); if (!pass) failed++; };
const finite = () => { const p = world.cloth.pos; for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false; return true; };
function run(frames, each) { let tears = 0, cuts = 0; for (let f = 0; f < frames; f++) { if (each) each(f); frame(1 / 60); tears += world.events.tear.n; cuts += world.events.cut.n; clearEvents(world.events); } return { tears, cuts }; }
function rect() {
  const s = world.screen, cl = world.cloth; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < cl.n; i++) { if (s[i * 3 + 2] <= 0 || !cl.vTri[i]) continue; x0 = Math.min(x0, s[i * 3]); x1 = Math.max(x1, s[i * 3]); y0 = Math.min(y0, s[i * 3 + 1]); y1 = Math.max(y1, s[i * 3 + 1]); }
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}
/** A finger: grab at a fraction of the cloth's screen box, drag by (dx, dy) css px over `frames`, hold, release. */
function pull(fx, fy, dx, dy, frames, hold = 20) {
  const r = rect(), x = r.x0 + r.w * fx, y = r.y0 + r.h * fy;
  const v = sim.pick(world, x, y, 44); if (v < 0) return { tears: -1 };
  const P = world.pointers[0]; P.active = true; P.particle = v; P.depth = world.screen[v * 3 + 2];
  unproject(world, x, y, P.depth, P.target);
  const res = run(frames + hold, (f) => { const t = Math.min(1, f / frames); unproject(world, x + dx * t, y + dy * t, P.depth, P.target); });
  P.active = false; P.particle = -1;
  return res;
}

// 1. self-load never tears, never explodes: every scene, every material, still/gale, dry/soaked
{
  let worst = '', tears = 0, nan = false;
  for (const scene of ['noren', 'koinobori', 'banner', 'unveil', 'embers', 'monsoon']) for (const material of ['cotton', 'silk', 'denim', 'velvet', 'chainmail', 'aurora']) for (const wind of [0, 2]) {
    setup(scene, { quality: 'low', wind, material });
    const r = run(150, (f) => { if (f === 30) world.cloth.massScale.fill(3); });
    if (r.tears) { tears += r.tears; worst = `${scene}/${material}/wind${wind}`; }
    if (!finite()) nan = true;
  }
  ok('self-load: no tears (6 scenes × 6 materials × wind)', tears === 0, tears ? `${tears} tears, e.g. ${worst}` : 'gravity, gale and 3× wet weight hold');
  ok('self-load: positions stay finite', !nan, '');
}

// 2. a finger within reach drapes the cloth, beyond reach rips it, and the rip runs
{
  setup('noren', { quality: 'mid', wind: 0 }); run(40);
  const within = pull(0.37, 0.8, 90, -60, 80);
  ok('grab within reach does not tear', within.tears === 0, `tears ${within.tears}`);
  setup('noren', { quality: 'mid', wind: 0 }); run(40);
  const beyond = pull(0.37, 0.75, 0, 260, 60);
  ok('hard pull beyond reach rips (and the rip runs)', beyond.tears >= 8, `tears ${beyond.tears}`);
  setup('noren', { quality: 'mid', wind: 0, material: 'chainmail' }); run(40);
  const top = world.cloth.bounds.max[1];
  let peak = 0; const mail = pull(0.37, 0.7, 120, 0, 30); run(60, () => { peak = Math.max(peak, world.cloth.bounds.max[1]); });
  ok('chainmail never tears, slips instead of flinging', mail.tears === 0 && peak < top + 0.1, `tears ${mail.tears}, highest ${peak.toFixed(2)} (rod ${top.toFixed(2)})`);
}

// 3. the katana cuts every thread it crosses and says so
{
  setup('noren', { quality: 'mid', wind: 0 }); run(30);
  const r = rect();
  const n = sim.slice(world, r.x0 - 5, r.y0 + r.h * 0.5, r.x0 + r.w + 5, r.y0 + r.h * 0.55);
  const cuts = world.events.cut.n, slices = world.events.slice.n; clearEvents(world.events);
  ok('slice cuts across all four panels', n >= 4 * 5 && cuts > 0 && slices === 1, `cut ${n} threads, ${cuts} cut events, ${slices} slice event`);
  const before = world.cloth.bounds.min[1]; run(90);
  ok('cut-off halves fall', world.cloth.bounds.min[1] < before - 0.3, `lowest y ${before.toFixed(2)} → ${world.cloth.bounds.min[1].toFixed(2)}`);
}

// 4. the carp: limp in still air, inflated and swimming in a gale
{
  const girth = () => { // mean distance of the mid-body ring from its centroid
    const cl = world.cloth, T = cl.pieces[0], r = (T.rows / 2) | 0, p = cl.pos; let cx = 0, cy = 0, cz = 0;
    for (let s = 0; s < T.cols - 1; s++) { const i = T.start + r * T.cols + s; cx += p[i * 3]; cy += p[i * 3 + 1]; cz += p[i * 3 + 2]; }
    cx /= T.cols - 1; cy /= T.cols - 1; cz /= T.cols - 1; let d = 0;
    for (let s = 0; s < T.cols - 1; s++) { const i = T.start + r * T.cols + s; d += Math.hypot(p[i * 3] - cx, p[i * 3 + 1] - cy, p[i * 3 + 2] - cz); }
    return d / (T.cols - 1);
  };
  setup('koinobori', { quality: 'mid', wind: 0 }); run(240); const limp = girth(), limpX = world.cloth.bounds.max[0];
  setup('koinobori', { quality: 'mid', wind: 2 }); let swim = 0; run(300, (f) => { if (f > 120) swim += world.stats.kinetic; }); const full = girth(), fullX = world.cloth.bounds.max[0];
  ok('koinobori inflates in the gale', full > limp * 1.3, `mid-body radius ${limp.toFixed(3)} still → ${full.toFixed(3)} gale`);
  ok('koinobori streams out and keeps swimming', fullX > limpX + 0.8 && swim / 180 > 0.3, `tail x ${limpX.toFixed(2)} → ${fullX.toFixed(2)}, mean speed ${(swim / 180).toFixed(2)} m/s`);
}

// 5. the unveiling: the sheet drapes the moon and stays there (no tunnelling, no slide-off)
{
  setup('unveil', { quality: 'low', wind: 0 }); run(400);
  const cl = world.cloth, S = world.colliders.spheres[0]; let inside = 0;
  for (let i = 0; i < cl.n; i++) { const o = i * 3; if (Math.hypot(cl.pos[o] - S.x, cl.pos[o + 1] - S.y, cl.pos[o + 2] - S.z) < S.r - 0.005) inside++; }
  ok('unveil: nothing inside the moon', inside === 0, `${inside} particles inside`);
  ok('unveil: the sheet stays on the moon', cl.bounds.max[1] > S.y + S.r - 0.05 && cl.bounds.min[1] > 0.1, `top ${cl.bounds.max[1].toFixed(2)}, bottom ${cl.bounds.min[1].toFixed(2)}`);
}

// 6. stability: dt spikes, slow-mo, 120 Hz, wet weight swings, random fingers and cuts
{
  let nan = false;
  for (const scene of ['noren', 'banner', 'monsoon']) {
    setup(scene, { quality: 'low', wind: 2 });
    for (let f = 0; f < 400; f++) {
      const dt = f % 97 === 0 ? 1 / 20 : f % 3 === 0 ? 1 / 120 : f > 200 ? 0.22 / 60 : 1 / 60;
      if (f % 50 === 0) world.cloth.massScale.fill(1 + (f % 150) / 50);
      if (f === 120) pull(0.5, 0.5, 120, 80, 30, 0);
      frame(dt); clearEvents(world.events);
    }
    if (!finite()) nan = true;
  }
  ok('stable through dt spikes, slow-mo, 120 Hz, soaking', !nan, `nan fixes ${world.cloth.solver.nanFixes}`);
}

// 7. pins: toggling re-anchors
{
  setup('noren', { quality: 'low', wind: 0 }); run(30);
  const cl = world.cloth, v = cl.pieces[0].id(3, 10), y0 = cl.pos[v * 3 + 1];
  sim.togglePin(world, v); run(60);
  ok('a new pin holds its particle', Math.abs(cl.pos[v * 3 + 1] - y0) < 1e-3, `moved ${(Math.abs(cl.pos[v * 3 + 1] - y0) * 1000).toFixed(2)} mm`);
}

// 8. the hot path doesn't make garbage (after the JIT has settled): sim.step alone
{
  setup('unveil', { quality: 'low', wind: 1 });
  const DT = new Float64Array([1 / 60]);
  const steps = (n) => { for (let i = 0; i < n; i++) { sim.step(world, DT[0]); clearEvents(world.events); } };
  steps(1500);
  const used = () => v8.getHeapStatistics().used_heap_size;
  const a = used(); steps(300); const per = (used() - a) / 300;
  // the solver itself makes no garbage; what's left is V8 boxing the arguments of the ~32 world.wind.sample
  // calls a frame (the lattice, every other frame) since weather's sampler is too big to inline: ~0.7 KB
  ok('steady-state allocation per step', per < 1000, `${per.toFixed(0)} B/frame (wind-sample argument boxing)`);
}

// 9. the benchmark is the real solver and gives a sane number
{
  const ns = sim.benchmark();
  ok('benchmark() ns per constraint-substep', ns > 0.5 && ns < 2000, `${ns.toFixed(1)} ns`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall physics checks passed');
process.exit(failed ? 1 : 0);
