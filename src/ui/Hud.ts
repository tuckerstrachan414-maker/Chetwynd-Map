/** Minimal heads-up display: crosshair, mode badge, controls help and a status line. */
export class Hud {
  private readonly el: HTMLDivElement;
  private readonly mode: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly start: HTMLDivElement;
  private readonly error: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private hintText: string | null = null;
  private readonly tip: HTMLDivElement;
  private tipText = '';

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'hud';
    this.el.innerHTML = `
      <div class="hud-cross"></div>
      <div class="hud-mode"></div>
      <div class="hud-status"></div>
      <div class="hud-tip hidden"></div>
      <div class="hud-help">
        <b>Walk</b> WASD / arrows · Shift run · Space jump · Mouse look<br/>
        <b>F</b> fly · <b>V</b> drive (C camera, Space handbrake, R reset) · <b>G</b> FPV drone (K radio setup, M acro/angle, R reset)<br/>
        <b>P</b> photo · <b>E</b> editor · <b>N</b> go to a landmark · <b>T</b> time (Shift+T back) · <b>Y</b> season · <b>U</b> weather · <b>O</b> settings · <b>H</b> hide help
      </div>
      <div class="hud-start loading"><div><h1>Chetwynd, BC</h1><p class="start-msg">Loading…</p><div class="start-bar"><i></i></div><small>Built from 2024–25 LidarBC LiDAR, OpenStreetMap, Overture Maps and Sentinel-2.</small></div></div>
      <div class="hud-hint hidden"></div>
      <div class="hud-error hidden"></div>
    `;
    root.appendChild(this.el);
    this.mode = this.el.querySelector('.hud-mode')!;
    this.status = this.el.querySelector('.hud-status')!;
    this.help = this.el.querySelector('.hud-help')!;
    this.start = this.el.querySelector('.hud-start')!;
    this.error = this.el.querySelector('.hud-error')!;
    this.error.addEventListener('click', () => this.error.classList.add('hidden'));
    this.hint = this.el.querySelector('.hud-hint')!;
    this.tip = this.el.querySelector('.hud-tip')!;
  }

  setMode(m: string): void {
    this.mode.textContent = m.toUpperCase();
  }

  /** Info card near the crosshair (e.g. the carving being looked at); null hides it. */
  setTooltip(title: string | null, lines: string[] = []): void {
    const key = title === null ? '' : `${title}|${lines.join('|')}`;
    if (key === this.tipText) return;
    this.tipText = key;
    this.tip.classList.toggle('hidden', title === null);
    if (title === null) return;
    this.tip.replaceChildren();
    const h = document.createElement('b');
    h.textContent = title;
    this.tip.append(h);
    for (const l of lines) {
      const d = document.createElement('div');
      d.textContent = l;
      this.tip.append(d);
    }
  }

  setStatus(s: string): void {
    this.status.textContent = s;
  }

  toggleHelp(): void {
    this.help.classList.toggle('hidden');
  }

  /** Loading progress on the start card (fraction 0..1). */
  setLoading(label: string, frac: number): void {
    (this.start.querySelector('.start-msg') as HTMLElement).textContent = `${label}…`;
    (this.start.querySelector('.start-bar i') as HTMLElement).style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  }

  /** Loading finished: the card now starts the game. */
  setStartReady(): void {
    this.start.classList.remove('loading');
    (this.start.querySelector('.start-msg') as HTMLElement).textContent = 'Click to explore';
  }

  /** The card again, smaller, after the mouse was freed (Esc, a panel, another window). */
  showResume(msg: string): void {
    this.start.classList.remove('loading');
    this.start.classList.add('resume');
    (this.start.querySelector('.start-msg') as HTMLElement).textContent = msg;
    this.setStartVisible(true);
  }

  get startVisible(): boolean {
    return !this.start.classList.contains('hidden');
  }

  /** A short line under the crosshair; null hides it. */
  setHint(text: string | null): void {
    if (text === this.hintText) return;
    this.hintText = text;
    this.hint.classList.toggle('hidden', text === null);
    this.hint.textContent = text ?? '';
  }

  /** Brief feedback when the card is clicked while still loading. */
  nudgeLoading(): void {
    this.start.classList.remove('nudge');
    void this.start.offsetWidth;
    this.start.classList.add('nudge');
  }

  /** Something went wrong: show it on screen so it can be reported. */
  showError(msg: string): void {
    this.error.classList.remove('hidden');
    this.error.innerHTML = '<b>Something went wrong</b><div class="msg"></div><small>Please send this message (or a screenshot) so it can be fixed. Reloading the page may help. Click to close.</small>';
    (this.error.querySelector('.msg') as HTMLElement).textContent = msg.slice(0, 600);
  }

  setStartVisible(v: boolean): void {
    this.start.classList.toggle('hidden', !v);
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('hidden', !v);
  }

  onStartClick(fn: () => void): void {
    this.start.addEventListener('click', fn);
  }
}
