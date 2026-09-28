/**
 * Photo mode panel (P): the world pauses, the camera flies free, and the shot is set up like a
 * real camera: focal length, aperture and focus distance (physically based depth of field),
 * exposure, roll, time of day, season and weather, vignette and grain. Saves PNGs at up to 4x.
 */
export interface PhotoState {
  focal: number; // mm (full-frame equivalent)
  aperture: number; // f-number
  focus: number; // m
  dof: boolean;
  ev: number;
  roll: number; // deg
  hour: number;
  vignette: number;
  grain: number;
  scale: number; // PNG resolution multiplier
}

export interface PhotoHost {
  seasons: readonly string[];
  weathers: readonly string[];
  getSeason(): string;
  setSeason(s: string): void;
  getWeather(): string;
  setWeather(w: string): void;
  apply(s: PhotoState): void;
  /** Autofocus: distance to whatever is under the screen centre. */
  focusCentre(): number | null;
  capture(scale: number): Promise<Blob | null>;
}

const CSS = `
.photo { position: absolute; right: 16px; top: 16px; width: min(300px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
  background: rgba(14,17,22,0.82); color: #e8ecf2; border: 1px solid #2c3440; border-radius: 10px; padding: 12px 14px;
  font: 13px/1.4 system-ui, sans-serif; z-index: 15; backdrop-filter: blur(6px); }
.photo.hidden { display: none; }
.photo h3 { margin: 0 0 8px; font-size: 14px; letter-spacing: 0.5px; }
.photo .r { display: grid; grid-template-columns: 86px 1fr 48px; gap: 6px; align-items: center; margin: 5px 0; }
.photo input[type=range] { width: 100%; }
.photo select, .photo button { background: #253040; color: #e8ecf2; border: 1px solid #3a4658; border-radius: 6px; padding: 5px 8px; font: inherit; }
.photo button { cursor: pointer; } .photo button:hover { background: #2f3d52; }
.photo .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.photo .hint { opacity: 0.7; font-size: 12px; margin-top: 8px; }
`;

interface SliderDef {
  key: keyof PhotoState;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  log?: boolean;
}

const SLIDERS: SliderDef[] = [
  { key: 'focal', label: 'Focal length', min: 12, max: 400, step: 1, fmt: (v) => `${Math.round(v)}mm`, log: true },
  { key: 'aperture', label: 'Aperture', min: 1.2, max: 22, step: 0.1, fmt: (v) => `f/${v.toFixed(1)}`, log: true },
  { key: 'focus', label: 'Focus', min: 0.3, max: 2000, step: 0.1, fmt: (v) => (v < 10 ? `${v.toFixed(1)}m` : `${Math.round(v)}m`), log: true },
  { key: 'ev', label: 'Exposure', min: -4, max: 4, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}EV` },
  { key: 'roll', label: 'Roll', min: -45, max: 45, step: 0.5, fmt: (v) => `${v.toFixed(1)}°` },
  { key: 'hour', label: 'Time', min: 0, max: 24, step: 0.05, fmt: (v) => `${String(Math.floor(v) % 24).padStart(2, '0')}:${String(Math.floor((v % 1) * 60)).padStart(2, '0')}` },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'grain', label: 'Grain', min: 0, max: 0.05, step: 0.001, fmt: (v) => v.toFixed(3) },
];

export class PhotoMode {
  readonly el: HTMLDivElement;
  state: PhotoState;
  private readonly inputs = new Map<keyof PhotoState, [HTMLInputElement, HTMLSpanElement, SliderDef]>();

  constructor(parent: HTMLElement, private readonly host: PhotoHost, init: Partial<PhotoState>) {
    this.state = { focal: 35, aperture: 5.6, focus: 20, dof: false, ev: 0, roll: 0, hour: 14, vignette: 0.22, grain: 0.004, scale: 2, ...init };
    if (!document.getElementById('photo-style')) {
      const st = document.createElement('style');
      st.id = 'photo-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'photo hidden';
    this.el.innerHTML = '<h3>PHOTO MODE</h3>';
    for (const d of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'r';
      const lab = document.createElement('span');
      lab.textContent = d.label;
      const inp = document.createElement('input');
      inp.type = 'range';
      const val = document.createElement('span');
      if (d.log) {
        inp.min = '0';
        inp.max = '1000';
        inp.step = '1';
      } else {
        inp.min = String(d.min);
        inp.max = String(d.max);
        inp.step = String(d.step);
      }
      inp.addEventListener('input', () => {
        const v = d.log ? d.min * Math.pow(d.max / d.min, Number(inp.value) / 1000) : Number(inp.value);
        (this.state[d.key] as number) = v;
        if (d.key === 'aperture' || d.key === 'focus') this.state.dof = true;
        val.textContent = d.fmt(v);
        this.host.apply(this.state);
      });
      row.append(lab, inp, val);
      this.el.appendChild(row);
      this.inputs.set(d.key, [inp, val, d]);
    }
    const sel = (label: string, opts: readonly string[], get: () => string, set: (v: string) => void) => {
      const row = document.createElement('div');
      row.className = 'r';
      const lab = document.createElement('span');
      lab.textContent = label;
      const s = document.createElement('select');
      for (const o of opts) s.add(new Option(o[0].toUpperCase() + o.slice(1), o));
      s.value = get();
      s.addEventListener('change', () => set(s.value));
      row.append(lab, s, document.createElement('span'));
      this.el.appendChild(row);
      return s;
    };
    this.seasonSel = sel('Season', host.seasons, () => host.getSeason(), (v) => host.setSeason(v));
    this.weatherSel = sel('Weather', host.weathers, () => host.getWeather(), (v) => host.setWeather(v));
    const row = document.createElement('div');
    row.className = 'row';
    const dof = document.createElement('button');
    const af = document.createElement('button');
    af.textContent = 'Autofocus centre';
    const res = document.createElement('select');
    for (const k of [1, 2, 3, 4]) res.add(new Option(`${k}x`, String(k)));
    res.value = String(this.state.scale);
    res.addEventListener('change', () => (this.state.scale = Number(res.value)));
    const shot = document.createElement('button');
    shot.textContent = 'Save PNG';
    const syncDof = () => (dof.textContent = this.state.dof ? 'Depth of field: on' : 'Depth of field: off');
    dof.addEventListener('click', () => {
      this.state.dof = !this.state.dof;
      syncDof();
      this.host.apply(this.state);
    });
    syncDof();
    af.addEventListener('click', () => {
      const d = this.host.focusCentre();
      if (d) {
        this.state.focus = d;
        this.state.dof = true;
        syncDof();
        this.refresh();
        this.host.apply(this.state);
      }
    });
    shot.addEventListener('click', () => void this.save());
    row.append(dof, af, res, shot);
    this.el.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Right-drag or WASD + mouse to move the camera (Q/E down/up, Shift faster). H hides this panel. P exits.';
    this.el.appendChild(hint);
    parent.appendChild(this.el);
    this.refresh();
  }

  private readonly seasonSel: HTMLSelectElement;
  private readonly weatherSel: HTMLSelectElement;

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
    if (on) {
      this.seasonSel.value = this.host.getSeason();
      this.weatherSel.value = this.host.getWeather();
      this.refresh();
      this.host.apply(this.state);
    }
  }

  togglePanel(): void {
    this.el.style.visibility = this.el.style.visibility === 'hidden' ? '' : 'hidden';
  }

  refresh(): void {
    for (const [key, [inp, val, d]] of this.inputs) {
      const v = this.state[key] as number;
      inp.value = String(d.log ? (Math.log(v / d.min) / Math.log(d.max / d.min)) * 1000 : v);
      val.textContent = d.fmt(v);
    }
  }

  async save(): Promise<void> {
    const vis = this.el.style.visibility;
    this.el.style.visibility = 'hidden';
    const blob = await this.host.capture(this.state.scale);
    this.el.style.visibility = vis;
    if (!blob) return;
    const a = document.createElement('a');
    const d = new Date();
    a.download = `chetwynd-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}.png`;
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
