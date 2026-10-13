// Topology changes: the only door through which the cloth loses constraints and triangles. They keep the
// visuals and the physics honest: a dead edge kills the triangles it borders, a dead triangle drops its
// quad's diagonals, and a dead edge drops the bends that spanned it. Every death bumps the counters the
// solver watches (constraintsAlive / trisAlive / topoVersion), so its compacted lists rebuild before the
// next substep. Nothing here allocates.

/** Break constraint j (and what depends on it). emit: push a tear event. Safe to call on a dead one. */
export function breakConstraint(world, j, emit) {
  const cl = world.cloth;
  if (!cl.alive[j]) return;
  cl.alive[j] = 0; cl.constraintsAlive--;
  if (emit) {
    const a = cl.cA[j] * 3, b = cl.cB[j] * 3, p = cl.pos;
    world.events.tear.push((p[a] + p[b]) * 0.5, (p[a + 1] + p[b + 1]) * 0.5, (p[a + 2] + p[b + 2]) * 0.5, j);
  }
  const cBend = cl.cBend, alive = cl.alive;
  for (let s = 0; s < 2; s++) { const bj = cBend[j * 2 + s]; if (bj >= 0 && alive[bj]) { alive[bj] = 0; cl.constraintsAlive--; } }
  for (let s = 0; s < 2; s++) { const t = cl.cTri[j * 2 + s]; if (t >= 0) killTriangle(world, t); }
}

function killTriangle(world, t) {
  const cl = world.cloth;
  if (!cl.triAlive[t]) return;
  cl.triAlive[t] = 0; cl.trisAlive--; cl.topoVersion++;
  cl.vTri[cl.tri[t * 3]]--; cl.vTri[cl.tri[t * 3 + 1]]--; cl.vTri[cl.tri[t * 3 + 2]]--;
  const q0 = cl.triQuad[t * 2], q1 = cl.triQuad[t * 2 + 1];
  if (q0 >= 0) breakConstraint(world, q0, false);
  if (q1 >= 0) breakConstraint(world, q1, false);
}

/** Break every constraint at vertex v (fire burnt it through). v should be a master. */
export function killVertex(world, v) {
  const cl = world.cloth;
  if (!cl || v < 0 || v >= cl.n) return;
  for (let k = cl.vcStart[v]; k < cl.vcStart[v + 1]; k++) breakConstraint(world, cl.vcList[k], false);
}
