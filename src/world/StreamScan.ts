import * as THREE from 'three';

/**
 * Bookkeeping for grid-streamed content: chunk centres parsed once from their "i_j" keys, and a gate
 * so the load/unload scan runs only when the camera has moved a few metres or a load has finished
 * (not every frame over thousands of keys).
 */
export class StreamScan {
  private readonly centres = new Map<string, [number, number]>();
  private readonly last = new THREE.Vector3(1e9, 0, 0);
  /** Set when something changed (a load finished); forces the next scan. */
  dirty = true;
  /** Result of the last scan: nothing pending or loading. */
  complete = false;

  constructor(private readonly size: number, private readonly half: number) {}

  centre(key: string): [number, number] {
    let c = this.centres.get(key);
    if (!c) {
      const [i, j] = key.split('_').map(Number);
      c = [-this.half + (i + 0.5) * this.size, -this.half + (j + 0.5) * this.size];
      this.centres.set(key, c);
    }
    return c;
  }

  distance(key: string, cam: THREE.Vector3): number {
    const [cx, cz] = this.centre(key);
    return Math.hypot(cx - cam.x, cz - cam.z);
  }

  /** True when a scan is due: the camera moved more than `step` m, or `dirty` was set. */
  due(cam: THREE.Vector3, step = 8): boolean {
    if (!this.dirty && cam.distanceToSquared(this.last) < step * step) return false;
    this.dirty = false;
    this.last.copy(cam);
    return true;
  }
}
