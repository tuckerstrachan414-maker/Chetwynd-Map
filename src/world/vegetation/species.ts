/** Species table shared with the pipeline (pipeline/trees.py). */
export const SP = {
  ASPEN: 0, POPLAR: 1, BIRCH: 2, WSPRUCE: 3, BSPRUCE: 4, PINE: 5, WILLOW: 6, ALDER: 7, BLUESPRUCE: 8, MAYDAY: 9, MTNASH: 10,
  SH_ROSE: 20, SH_DOGWOOD: 21, SH_HEDGE: 22, SH_WILLOW: 23,
} as const;

export type Archetype = 'spruce' | 'bspruce' | 'pine' | 'aspen' | 'poplar' | 'round' | 'shrub' | 'willow';

export interface SpeciesDef {
  arch: Archetype;
  foliage: 'spruce' | 'pine' | 'aspen' | 'poplar' | 'birch' | 'willow' | 'shrub';
  bark: 'spruce' | 'pine' | 'birch';
  deciduous: boolean;
  /** Linear RGB leaf colours by season: summer, autumn, spring. */
  summer: [number, number, number];
  autumn: [number, number, number];
  spring: [number, number, number];
  barkTint: [number, number, number];
}

const g = (r: number, gg: number, b: number): [number, number, number] => [r, gg, b];

export const SPECIES: Record<number, SpeciesDef> = {
  [SP.ASPEN]: { arch: 'aspen', foliage: 'aspen', bark: 'birch', deciduous: true, summer: g(0.16, 0.3, 0.06), autumn: g(0.75, 0.52, 0.06), spring: g(0.3, 0.45, 0.08), barkTint: g(0.85, 0.9, 0.8) },
  [SP.POPLAR]: { arch: 'poplar', foliage: 'poplar', bark: 'spruce', deciduous: true, summer: g(0.13, 0.24, 0.06), autumn: g(0.62, 0.5, 0.08), spring: g(0.25, 0.38, 0.08), barkTint: g(0.7, 0.7, 0.68) },
  [SP.BIRCH]: { arch: 'aspen', foliage: 'birch', bark: 'birch', deciduous: true, summer: g(0.18, 0.32, 0.07), autumn: g(0.8, 0.6, 0.1), spring: g(0.32, 0.47, 0.1), barkTint: g(1.0, 1.0, 1.0) },
  [SP.WSPRUCE]: { arch: 'spruce', foliage: 'spruce', bark: 'spruce', deciduous: false, summer: g(0.09, 0.15, 0.08), autumn: g(0.09, 0.15, 0.08), spring: g(0.12, 0.2, 0.09), barkTint: g(0.8, 0.75, 0.7) },
  [SP.BSPRUCE]: { arch: 'bspruce', foliage: 'spruce', bark: 'spruce', deciduous: false, summer: g(0.07, 0.11, 0.07), autumn: g(0.07, 0.11, 0.07), spring: g(0.09, 0.14, 0.08), barkTint: g(0.6, 0.55, 0.5) },
  [SP.PINE]: { arch: 'pine', foliage: 'pine', bark: 'pine', deciduous: false, summer: g(0.13, 0.2, 0.07), autumn: g(0.13, 0.2, 0.07), spring: g(0.15, 0.23, 0.08), barkTint: g(0.9, 0.8, 0.75) },
  [SP.WILLOW]: { arch: 'willow', foliage: 'willow', bark: 'spruce', deciduous: true, summer: g(0.15, 0.27, 0.1), autumn: g(0.55, 0.5, 0.12), spring: g(0.25, 0.38, 0.1), barkTint: g(0.6, 0.55, 0.45) },
  [SP.ALDER]: { arch: 'round', foliage: 'birch', bark: 'birch', deciduous: true, summer: g(0.11, 0.22, 0.06), autumn: g(0.3, 0.32, 0.08), spring: g(0.2, 0.33, 0.08), barkTint: g(0.55, 0.55, 0.52) },
  [SP.BLUESPRUCE]: { arch: 'spruce', foliage: 'spruce', bark: 'spruce', deciduous: false, summer: g(0.1, 0.16, 0.16), autumn: g(0.1, 0.16, 0.16), spring: g(0.12, 0.19, 0.18), barkTint: g(0.7, 0.65, 0.6) },
  [SP.MAYDAY]: { arch: 'round', foliage: 'birch', bark: 'spruce', deciduous: true, summer: g(0.14, 0.26, 0.07), autumn: g(0.6, 0.18, 0.06), spring: g(0.5, 0.52, 0.45), barkTint: g(0.45, 0.35, 0.3) },
  [SP.MTNASH]: { arch: 'round', foliage: 'birch', bark: 'birch', deciduous: true, summer: g(0.12, 0.24, 0.06), autumn: g(0.7, 0.2, 0.05), spring: g(0.22, 0.36, 0.08), barkTint: g(0.5, 0.48, 0.45) },
  // Shrubs (LiDAR 0.5-2.5 m vegetation): wild rose, red-osier dogwood, hedges (caragana/lilac), willow.
  [SP.SH_ROSE]: { arch: 'shrub', foliage: 'shrub', bark: 'spruce', deciduous: true, summer: g(0.13, 0.24, 0.06), autumn: g(0.62, 0.2, 0.05), spring: g(0.22, 0.36, 0.08), barkTint: g(0.55, 0.3, 0.22) },
  [SP.SH_DOGWOOD]: { arch: 'shrub', foliage: 'shrub', bark: 'spruce', deciduous: true, summer: g(0.12, 0.23, 0.07), autumn: g(0.45, 0.07, 0.06), spring: g(0.2, 0.34, 0.09), barkTint: g(0.75, 0.2, 0.12) },
  [SP.SH_HEDGE]: { arch: 'shrub', foliage: 'shrub', bark: 'spruce', deciduous: true, summer: g(0.14, 0.26, 0.07), autumn: g(0.6, 0.52, 0.1), spring: g(0.26, 0.4, 0.09), barkTint: g(0.55, 0.5, 0.42) },
  [SP.SH_WILLOW]: { arch: 'willow', foliage: 'willow', bark: 'spruce', deciduous: true, summer: g(0.16, 0.27, 0.1), autumn: g(0.6, 0.55, 0.12), spring: g(0.27, 0.4, 0.1), barkTint: g(0.7, 0.55, 0.3) },
};

/** Model archetypes that get generated meshes; species map onto them with tints. */
export const ARCHETYPES: Archetype[] = ['spruce', 'bspruce', 'pine', 'aspen', 'poplar', 'round', 'shrub', 'willow'];

export function archetypeOf(sp: number): Archetype {
  return SPECIES[sp]?.arch ?? 'round';
}
