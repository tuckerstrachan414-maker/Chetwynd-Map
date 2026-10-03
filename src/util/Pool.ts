/**
 * Objects handed out and taken back instead of created and garbage-collected. Streaming content
 * (impostor batches, colliders, building meshes) cycles through pools as the camera travels, so a
 * fast flight reuses what it already allocated rather than leaving a trail for the collector.
 */
export class Pool<T> {
  private readonly free: T[] = [];
  /** Objects ever created (in use + free). */
  created = 0;

  constructor(private readonly make: () => T, private readonly reset?: (t: T) => void) {}

  acquire(): T {
    const t = this.free.pop();
    if (t !== undefined) return t;
    this.created++;
    return this.make();
  }

  release(t: T): void {
    this.reset?.(t);
    this.free.push(t);
  }

  /** Allocate up front so the first uses cost nothing. */
  prefill(n: number): void {
    while (this.created < n) {
      this.created++;
      this.free.push(this.make());
    }
  }

  get available(): number {
    return this.free.length;
  }
}

/** Pools of objects by capacity, rounded up to a power of two (at least `min`). */
export class BucketPool<T> {
  private readonly pools = new Map<number, Pool<T>>();

  constructor(private readonly make: (capacity: number) => T, private readonly min = 256, private readonly reset?: (t: T) => void) {}

  /** Capacity of the bucket that holds `n` items. */
  bucket(n: number): number {
    let c = this.min;
    while (c < n) c *= 2;
    return c;
  }

  acquire(n: number): T {
    const c = this.bucket(n);
    let p = this.pools.get(c);
    if (!p) this.pools.set(c, (p = new Pool(() => this.make(c), this.reset)));
    return p.acquire();
  }

  release(t: T, capacity: number): void {
    this.pools.get(capacity)?.release(t);
  }

  get created(): number {
    let n = 0;
    for (const p of this.pools.values()) n += p.created;
    return n;
  }
}
