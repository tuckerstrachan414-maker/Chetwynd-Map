/** Betaflight-style FPV on-screen display: timer, battery, altitude, speed, horizon, warnings. */
export interface OsdData {
  time: number; // s since arming
  volt: number;
  amps: number;
  mah: number;
  cells: number;
  alt: number;
  speed: number; // km/h
  throttle: number; // 0..1
  mode: string;
  roll: number; // rad
  pitch: number; // rad
  /** Camera uptilt (rad) and screen pixels per radian, to line the horizon bars up with the view. */
  uptilt: number;
  pxPerRad: number;
  warning: string;
  source: string;
}

const CSS = `
.osd { position: absolute; inset: 0; pointer-events: none; font: 700 18px/1.15 "DejaVu Sans Mono", "Consolas", monospace;
  color: #f4f4f4; text-shadow: 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000; letter-spacing: 1px; }
.osd.hidden { display: none; }
.osd div { position: absolute; white-space: pre; }
.osd .tl { left: 7%; top: 8%; } .osd .tr { right: 7%; top: 8%; text-align: right; }
.osd .bl { left: 7%; bottom: 9%; } .osd .br { right: 7%; bottom: 9%; text-align: right; }
.osd .bc { left: 50%; bottom: 9%; transform: translateX(-50%); text-align: center; }
.osd .warn { left: 50%; top: 34%; transform: translateX(-50%); text-align: center; font-size: 22px; }
.osd .warn.blink { animation: osdblink 0.8s steps(2) infinite; }
@keyframes osdblink { 50% { opacity: 0; } }
.osd .cross { left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 20px; }
.osd .ahi { left: 50%; top: 50%; width: 0; height: 0; }
.osd .ahi span { position: absolute; left: -160px; top: -1px; width: 320px; text-align: center; letter-spacing: 6px; opacity: 0.85; }
.osd .help { left: 50%; top: 14%; transform: translateX(-50%); text-align: center; font-size: 13px; font-weight: 400; opacity: 0.85; }
`;

export class DroneOsd {
  readonly el: HTMLDivElement;
  private readonly f: Record<string, HTMLDivElement> = {};
  private helpTimer = 0;

  constructor(parent: HTMLElement) {
    if (!document.getElementById('osd-style')) {
      const st = document.createElement('style');
      st.id = 'osd-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'osd hidden';
    for (const k of ['tl', 'tr', 'bl', 'br', 'bc', 'warn', 'cross', 'ahi', 'help']) {
      const d = document.createElement('div');
      d.className = k;
      this.el.appendChild(d);
      this.f[k] = d;
    }
    this.f.cross.textContent = '-+-';
    this.f.ahi.innerHTML = '<span>- - - -        - - - -</span>';
    parent.appendChild(this.el);
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (on) this.helpTimer = 9;
  }

  update(d: OsdData, dt: number): void {
    const mm = Math.floor(d.time / 60);
    const ss = Math.floor(d.time % 60);
    this.f.tl.textContent = `⏱ ${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}\n${d.mode}`;
    this.f.tr.textContent = `${Math.round(d.mah)}MAH\nTHR ${String(Math.round(d.throttle * 100)).padStart(3, ' ')}`;
    this.f.bl.textContent = `${d.volt.toFixed(1)}V  ${(d.volt / d.cells).toFixed(2)}\n${d.amps.toFixed(1)}A`;
    this.f.br.textContent = `ALT ${Math.round(d.alt)}M\n${Math.round(d.speed)}KM/H`;
    this.f.bc.textContent = d.source === 'keyboard' ? 'KEYS' : 'RC';
    const low = d.volt / d.cells < 3.5 && !d.warning;
    this.f.warn.textContent = d.warning || (low ? 'LOW BATTERY' : '');
    this.f.warn.classList.toggle('blink', !!d.warning || low);
    // Artificial horizon: rolls with the quad and sits on the real horizon (camera uptilt included).
    const py = Math.max(-320, Math.min(320, (d.pitch + d.uptilt) * d.pxPerRad));
    (this.f.ahi.firstChild as HTMLElement).style.transform = `translateY(${py}px) rotate(${(-d.roll * 180) / Math.PI}deg)`;
    this.helpTimer -= dt;
    this.f.help.textContent = this.helpTimer > 0
      ? d.source === 'keyboard'
        ? 'SHIFT/CTRL THROTTLE  SPACE PUNCH  W/S PITCH  A/D ROLL  Q/E YAW\nM ACRO/ANGLE  B LENS  R RESET  K CALIBRATE RADIO  G EXIT'
        : 'M ACRO/ANGLE  B LENS  R RESET  K CALIBRATE RADIO  G EXIT'
      : '';
  }
}
