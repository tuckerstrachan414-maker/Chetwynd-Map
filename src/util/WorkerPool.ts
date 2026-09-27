/** Minimal promise-based worker pool with request ids. */
export class WorkerPool<Req extends object, Res> {
  private readonly workers: Worker[] = [];
  private readonly busy: number[] = [];
  private readonly pending = new Map<number, { resolve: (r: Res) => void; reject: (e: Error) => void; w: number }>();
  private nextId = 1;

  constructor(factory: () => Worker, size: number) {
    for (let k = 0; k < size; k++) {
      const w = factory();
      w.onmessage = (e: MessageEvent) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        this.busy[p.w]--;
        if (e.data.ok) p.resolve(e.data as Res);
        else p.reject(new Error(e.data.error));
      };
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  get inFlight(): number {
    return this.pending.size;
  }

  run(req: Req, transfer: Transferable[] = []): Promise<Res> {
    let w = 0;
    for (let k = 1; k < this.workers.length; k++) if (this.busy[k] < this.busy[w]) w = k;
    const id = this.nextId++;
    this.busy[w]++;
    return new Promise<Res>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, w });
      this.workers[w].postMessage({ ...req, id }, transfer);
    });
  }
}
