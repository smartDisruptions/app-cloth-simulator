// Physics parameters per material (ids from core/materials.js). The physics agent owns and tunes these.
//
// Everything is in physical units, so a material behaves the same at every cloth resolution and every
// substep count (XPBD compliance = 1 / stiffness; the solver derives per-constraint compliance from these):
//
//   density     kg/m² of cloth (wet cloth multiplies it by cloth.massScale)
//   stretchK    N/m   resistance to stretching along the threads (huge = near-inextensible)
//   compressK   N/m   resistance to in-plane compression. Low = the weave buckles into folds instead of
//                     acting like a rubber sheet. 0 = free to bunch up (chainmail rings slide together)
//                     until they jam at `jam` × rest length.
//   shearK      N/m   resistance to the weave skewing diagonally (fabric drapes because this is low)
//   bendLen     m     bending length (Peirce's cantilever test): how far the dry cloth sticks out
//                     straight before it droops. Bending stiffness B = bendLen³ · density · g, so wet,
//                     heavier cloth drapes more liquidly, as it does.
//   damping     1/s   internal friction (air drag is separate and comes from the aerodynamics)
//   tear        thread strain at which the cloth starts to fail (1.4 = 40 % over rest, judged along the
//               thread, not one segment; where it is pinned the cloth is reinforced). Infinity = never.
//   tearTime    s     how long a thread must stay over `tear` before it snaps (gusts and jitter never
//                     tear, a held pull does; 60 % over, it snaps at once)
//   rip         0..1  how much a fresh break weakens its neighbours for a moment (and makes them fail
//                     4× faster), so a pull opens a running rip instead of popping single holes
//   drag, lift        aerodynamic coefficients: drag pushes along the relative wind, lift (thin-plate,
//                     linear in the angle of attack) is what makes flags flutter and snap
//   friction    0..1  Coulomb friction against colliders
//   thickness   m     collision margin
//   crease      0..1  plasticity: how readily sustained folds set into creases (cotton, denim, foil)
//   creaseYield m     fold depth (per bend, relative to the cell) a crease needs before it starts to set
export const SIM_MATERIALS = {
  cotton:    { density: 0.15, stretchK: 4000,  compressK: 30, shearK: 60,  bendLen: 0.075, damping: 0.12, tear: 1.40, tearTime: 0.10, rip: 0.2, drag: 1.0,  lift: 0.7,  friction: 0.45, thickness: 0.008, crease: 0.25, creaseYield: 0.35 },
  silk:      { density: 0.06, stretchK: 3000,  compressK: 6,  shearK: 20,  bendLen: 0.022, damping: 0.06, tear: 1.38, tearTime: 0.08, rip: 0.24, drag: 1.1,  lift: 1.0,  friction: 0.12, thickness: 0.005, crease: 0.0,  creaseYield: 1.0 },
  denim:     { density: 0.38, stretchK: 9000,  compressK: 90, shearK: 160, bendLen: 0.17,  damping: 0.2,  tear: 1.55, tearTime: 0.16, rip: 0.12, drag: 0.9,  lift: 0.45, friction: 0.6,  thickness: 0.012, crease: 0.45, creaseYield: 0.3 },
  velvet:    { density: 0.30, stretchK: 3500,  compressK: 25, shearK: 45,  bendLen: 0.065, damping: 0.55, tear: 1.42, tearTime: 0.12, rip: 0.16, drag: 1.25, lift: 0.35, friction: 0.75, thickness: 0.012, crease: 0.1,  creaseYield: 0.45 },
  chainmail: { density: 2.4,  stretchK: 30000, compressK: 0,  jam: 0.58, shearK: 8,   bendLen: 0.0,   damping: 0.7,  tear: Infinity, tearTime: 1, rip: 0, drag: 0.28, lift: 0.04, friction: 0.28, thickness: 0.014, crease: 0.0,  creaseYield: 1.0 },
  aurora:    { density: 0.045, stretchK: 2500, compressK: 40, shearK: 400, bendLen: 0.04,  damping: 0.08, tear: 1.34, tearTime: 0.06, rip: 0.32,  drag: 1.0,  lift: 1.25, friction: 0.15, thickness: 0.004, crease: 0.8,  creaseYield: 0.18 },
};
