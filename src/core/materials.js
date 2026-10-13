// The material list: ids, names and UI swatches. Each domain keeps its own parameter table keyed by
// these ids (sim/materials.js for physics, render/materials.js for shading, fx/fire.js for burning,
// fx/wet.js for absorbency), so agents never edit the same table.
export const MATERIALS = [
  { id: 'cotton', name: 'Cotton', swatch: '#e8e0cf', blurb: 'Soft, matte, tears clean, burns steady' },
  { id: 'silk', name: 'Silk', swatch: '#e6c9e0', blurb: 'Light, liquid, a sheen that slides across the folds' },
  { id: 'denim', name: 'Denim', swatch: '#3f5f93', blurb: 'Heavy twill, stiff, hard to tear, slow to burn' },
  { id: 'velvet', name: 'Velvet', swatch: '#7c1832', blurb: 'Deep pile that glows at the edges' },
  { id: 'chainmail', name: 'Chainmail', swatch: '#a7aeb6', blurb: 'Steel rings: heavy, never tears, glows red-hot instead of burning' },
  { id: 'aurora', name: 'Aurora', swatch: '#8fd6e8', blurb: 'Iridescent film: colour shifts with every angle' },
];
export const MATERIAL_IDS = MATERIALS.map((m) => m.id);
export const materialById = (id) => MATERIALS.find((m) => m.id === id) || MATERIALS[0];
