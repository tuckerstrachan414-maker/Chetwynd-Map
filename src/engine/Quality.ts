import type * as THREE from 'three';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  /** Render scale relative to the device pixel ratio (capped at 2). */
  scale: number;
  msaa: number;
  fxaa: boolean;
  /** Temporal anti-aliasing instead of MSAA (see Post). */
  taa: boolean;
  /** Resolution of one sun shadow cascade tile (four tiles in a 2x2 atlas). */
  shadowMap: number;
  /** How far sun shadows reach from the eye (m), and each cascade's refresh interval in frames. */
  shadowDistance: number;
  shadowInterval: readonly number[];
  ao: boolean;
  ssr: boolean;
  /** Grass density (1 = full). */
  grass: number;
  /** Full-geometry tree radius, LOD0 radius and shrub radius (m). */
  treeNear: number;
  treeLod0: number;
  shrubs: number;
  /** Building chunk streaming radius (m). */
  chunks: number;
  /**
   * Target frame time for dynamic resolution (ms); 0 disables it. With TAA the scene's render size
   * drops below the output and the TAA resolve upsamples (the output stays at full resolution).
   */
  targetMs: number;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  low: {
    scale: 0.7, msaa: 0, fxaa: true, taa: false, shadowMap: 1024, shadowDistance: 220, shadowInterval: [1, 2, 4, 8], ao: false, ssr: false,
    grass: 0.35, treeNear: 90, treeLod0: 22, shrubs: 60, chunks: 800, targetMs: 33,
  },
  medium: {
    scale: 0.85, msaa: 2, fxaa: false, taa: false, shadowMap: 1024, shadowDistance: 320, shadowInterval: [1, 1, 2, 4], ao: true, ssr: false,
    grass: 0.6, treeNear: 120, treeLod0: 30, shrubs: 85, chunks: 1100, targetMs: 16.7,
  },
  high: {
    scale: 1, msaa: 0, fxaa: false, taa: true, shadowMap: 2048, shadowDistance: 450, shadowInterval: [1, 2, 4, 8], ao: true, ssr: true,
    grass: 1, treeNear: 150, treeLod0: 40, shrubs: 110, chunks: 1600, targetMs: 16.7,
  },
  ultra: {
    scale: 1, msaa: 0, fxaa: false, taa: true, shadowMap: 2048, shadowDistance: 600, shadowInterval: [1, 2, 4, 8], ao: true, ssr: true,
    grass: 1.35, treeNear: 210, treeLod0: 60, shrubs: 150, chunks: 2200, targetMs: 33.3,
  },
};

const LS_KEY = 'cw.quality';

/**
 * Pick a quality level for this machine: a saved choice, else a GPU tier from the renderer
 * string (discrete desktop GPUs -> high/ultra, integrated -> medium, old/mobile -> low).
 */
export function detectQuality(renderer: THREE.WebGLRenderer): QualityLevel {
  try {
    const saved = localStorage.getItem(LS_KEY) as QualityLevel | null;
    if (saved && QUALITY_LEVELS.includes(saved)) return saved;
  } catch {
    /* no storage */
  }
  const gpu = gpuName(renderer).toLowerCase();
  if (!gpu || /swiftshader|llvmpipe|software|basic render/.test(gpu)) return 'low';
  if (/rtx\s*[2-9]0[6-9]0|rtx\s*[3-9]0[7-9]0|rx\s*[67][89]\d\d|rx\s*7[6-9]00|apple m[1-9] (pro|max|ultra)|radeon pro w/.test(gpu)) return 'ultra';
  if (/rtx|gtx\s*1[06-9][6-8]0|gtx\s*16|rx\s*[5-7]\d\d\d|rx\s*[45][6-9]0|vega|arc a[57]|apple m[1-9]/.test(gpu)) return 'high';
  if (/iris xe|iris\(r\) xe|radeon\(tm\) graphics|radeon graphics|780m|680m|arc|gtx\s*(9|10[35]0)|mx\s*\d/.test(gpu)) return 'medium';
  if (/intel|uhd|hd graphics|mali|adreno|powervr/.test(gpu)) return 'low';
  return 'high';
}

export function saveQuality(q: QualityLevel): void {
  try {
    localStorage.setItem(LS_KEY, q);
  } catch {
    /* no storage */
  }
}

export function gpuName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}

/**
 * Dynamic resolution: nudges the render scale (`minScale`..1) to keep the smoothed GPU-bound frame time
 * at or just under the target (it steps down once the average runs 2 % over the target, back up below 82 % of
 * it). Changes are small and at most every 1.5 s, so the image does not pump.
 */
export class DynamicResolution {
  scale = 1;
  private avg = 16.7;
  private cooldown = 2;
  constructor(public targetMs: number, public maxScale = 1, public minScale = 0.55) {
    this.scale = maxScale;
  }

  /** Feed the last frame's duration (ms); returns true when the scale changed. */
  update(frameMs: number, dt: number): boolean {
    if (this.targetMs <= 0) return false;
    this.avg += (Math.min(frameMs, 100) - this.avg) * 0.08;
    this.cooldown -= dt;
    if (this.cooldown > 0) return false;
    let next = this.scale;
    // Steps are rounded to hundredths so repeated changes land exactly on the limits.
    if (this.avg > this.targetMs * 1.02) next = Math.max(this.minScale, Math.round((this.scale - 0.05) * 100) / 100);
    else if (this.avg < this.targetMs * 0.82) next = Math.min(this.maxScale, Math.round((this.scale + 0.05) * 100) / 100);
    if (next === this.scale) return false;
    this.scale = next;
    this.cooldown = 1.5;
    return true;
  }
}
