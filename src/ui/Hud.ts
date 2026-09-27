/** Minimal heads-up display: crosshair, mode badge, controls help and a status line. */
export class Hud {
  private readonly el: HTMLDivElement;
  private readonly mode: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly start: HTMLDivElement;
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
        <b>P</b> photo · <b>E</b> editor · <b>N</b> go to a landmark · <b>T</b> time (Shift+T back) · <b>Y</b> season · <b>U</b> weather · <b>H</b> hide help
      </div>
      <div class="hud-start"><div><h1>Chetwynd, BC</h1><p>Click to explore</p><small>Built from 2024–25 LidarBC LiDAR, OpenStreetMap, Overture Maps and Sentinel-2.</small></div></div>
    `;
    root.appendChild(this.el);
    this.mode = this.el.querySelector('.hud-mode')!;
    this.status = this.el.querySelector('.hud-status')!;
    this.help = this.el.querySelector('.hud-help')!;
    this.start = this.el.querySelector('.hud-start')!;
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
