/** Keyboard, mouse (pointer lock) and gamepad state shared by all control modes. */
export class Input {
  readonly keys = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  gamepad: Gamepad | null = null;
  /** A lock request is in flight. */
  pending = false;
  /** When the mouse was last released (Esc, focus loss); browsers refuse a new lock for a moment after Esc. */
  unlockedAt = -1e9;
  /** A mouse button went down on the view: dragging looks around even without pointer lock. */
  private dragging = false;

  constructor(private readonly dom: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'Tab'].includes(e.code) && this.locked) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('mousedown', () => (this.dragging = true));
    window.addEventListener('mouseup', () => (this.dragging = false));
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom && !(this.dragging && e.buttons & 1)) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.locked && document.pointerLockElement !== dom) this.unlockedAt = performance.now();
      this.locked = document.pointerLockElement === dom;
    });
    dom.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
  }

  /** Capture the mouse. Resolves false when the browser refuses (for a moment after Esc, or never in some embeds). */
  requestLock(): Promise<boolean> {
    const dom = this.dom;
    if (document.pointerLockElement === dom) return Promise.resolve(true);
    if (!dom.requestPointerLock) return Promise.resolve(false);
    this.pending = true;
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.pending = false;
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        resolve(ok);
      };
      const onChange = () => document.pointerLockElement === dom && done(true);
      const onError = () => done(false);
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
      try {
        // Newer browsers return a promise; older ones report through the events above.
        const r = dom.requestPointerLock() as unknown as Promise<void> | undefined;
        r?.then?.(() => done(true), () => done(false));
      } catch {
        done(false);
      }
      setTimeout(() => done(document.pointerLockElement === dom), 2000);
    });
  }

  down(code: string): boolean {
    return this.keys.has(code);
  }

  /** True once per key press. */
  hit(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Call at the end of each frame. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    this.gamepad = null;
    for (const p of pads) if (p && p.connected) {
      this.gamepad = p;
      break;
    }
  }
}
