import { type AxisCal, RADIO_RE, saveMap, type StickMap } from '../sim/StickInput';

/**
 * Radio / gamepad calibration wizard (K in drone mode). Works with any USB joystick: EdgeTX or
 * OpenTX radios in joystick mode, ELRS/CRSF dongles, Xbox/PlayStation pads. Each step waits for
 * the stick to be held at an extreme, so no axis numbering has to be known in advance.
 */
type Step =
  | { kind: 'rest' }
  | { kind: 'axis'; name: 'throttle' | 'yaw' | 'pitch' | 'roll'; text: string; phase: 'a' | 'b' }
  | { kind: 'button'; name: 'reset' | 'mode'; text: string }
  | { kind: 'done' };

const CSS = `
.fpvsetup { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(8,10,12,0.72);
  color: #eef; font: 15px/1.5 system-ui, sans-serif; z-index: 20; }
.fpvsetup.hidden { display: none; }
.fpvsetup .card { background: #151a20; border: 1px solid #334; border-radius: 10px; padding: 22px 26px; width: min(560px, calc(100vw - 32px)); }
.fpvsetup h2 { margin: 0 0 6px; font-size: 18px; }
.fpvsetup .msg { font-size: 17px; margin: 12px 0; min-height: 52px; }
.fpvsetup .bars { display: grid; grid-template-columns: 70px 1fr; gap: 4px 10px; font: 12px monospace; }
.fpvsetup .bar { height: 10px; background: #223; position: relative; border-radius: 3px; }
.fpvsetup .bar i { position: absolute; top: 0; bottom: 0; width: 3px; background: #7cf; }
.fpvsetup .row { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; align-items: center; }
.fpvsetup button { background: #2a3a4c; color: #eef; border: 1px solid #456; border-radius: 6px; padding: 7px 14px; cursor: pointer; font: inherit; }
.fpvsetup button:hover { background: #34506a; }
.fpvsetup label { display: flex; gap: 6px; align-items: center; }
`;

export class FpvSetup {
  private readonly el: HTMLDivElement;
  private readonly msg: HTMLDivElement;
  private readonly bars: HTMLDivElement;
  private readonly radioBox: HTMLInputElement;
  private steps: Step[] = [];
  private si = 0;
  private rest: number[] = [];
  private hold = 0;
  private cand = { axis: -1, value: 0 };
  private map: Partial<StickMap> & { throttle?: AxisCal } = {};
  private throttleUp = 0;
  private raf = 0;
  private prevButtons: boolean[] = [];
  onClose: (map: StickMap | null) => void = () => {};

  constructor(parent: HTMLElement) {
    if (!document.getElementById('fpvsetup-style')) {
      const st = document.createElement('style');
      st.id = 'fpvsetup-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'fpvsetup hidden';
    this.el.innerHTML = `<div class="card"><h2>Radio / controller setup</h2>
      <div class="sub">Plug in your radio (USB joystick mode) or gamepad and move a stick so the browser sees it.</div>
      <div class="msg"></div><div class="bars"></div>
      <div class="row"><label><input type="checkbox" class="radio"> Radio transmitter (throttle stays where you leave it)</label></div>
      <div class="row"><button class="next">Next</button><button class="skip">Skip step</button><button class="restart">Restart</button><button class="close">Close</button></div></div>`;
    parent.appendChild(this.el);
    this.msg = this.el.querySelector('.msg')!;
    this.bars = this.el.querySelector('.bars')!;
    this.radioBox = this.el.querySelector('.radio')!;
    this.el.querySelector('.next')!.addEventListener('click', () => this.next());
    this.el.querySelector('.skip')!.addEventListener('click', () => this.advance());
    this.el.querySelector('.restart')!.addEventListener('click', () => this.open());
    this.el.querySelector('.close')!.addEventListener('click', () => this.close(null));
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  open(): void {
    document.exitPointerLock?.();
    this.el.classList.remove('hidden');
    this.steps = [
      { kind: 'rest' },
      { kind: 'axis', name: 'throttle', text: 'Push THROTTLE fully UP and hold it', phase: 'a' },
      { kind: 'axis', name: 'throttle', text: 'Now pull THROTTLE fully DOWN and hold it', phase: 'b' },
      { kind: 'axis', name: 'yaw', text: 'Hold YAW (rudder) fully RIGHT', phase: 'a' },
      { kind: 'axis', name: 'pitch', text: 'Hold PITCH (elevator) fully UP / forward', phase: 'a' },
      { kind: 'axis', name: 'roll', text: 'Hold ROLL (aileron) fully RIGHT', phase: 'a' },
      { kind: 'button', name: 'reset', text: 'Press the button or flip the switch you want for RESET (or Skip)' },
      { kind: 'button', name: 'mode', text: 'Press the button or flip the switch for ACRO / ANGLE (or Skip)' },
      { kind: 'done' },
    ];
    this.si = 0;
    this.map = { reset: -1, mode: -1 };
    this.hold = 0;
    this.prevButtons = [];
    cancelAnimationFrame(this.raf);
    const tick = () => {
      this.poll();
      if (this.visible) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private pad(): Gamepad | null {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected) return p;
    return null;
  }

  private close(map: StickMap | null): void {
    this.el.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.onClose(map);
  }

  private advance(): void {
    this.si++;
    this.hold = 0;
    this.cand = { axis: -1, value: 0 };
  }

  private next(): void {
    const st = this.steps[this.si];
    const gp = this.pad();
    if (st.kind === 'rest' && gp) {
      this.rest = [...gp.axes];
      this.radioBox.checked = RADIO_RE.test(gp.id);
      this.advance();
    } else if (st.kind === 'done' && gp) {
      const m = this.map;
      if (!m.throttle || !m.yaw || !m.pitch || !m.roll) {
        this.msg.textContent = 'Some sticks were not calibrated; press Restart.';
        return;
      }
      const map: StickMap = {
        throttle: m.throttle, yaw: m.yaw, pitch: m.pitch, roll: m.roll,
        reset: m.reset ?? -1, mode: m.mode ?? -1, id: gp.id, radio: this.radioBox.checked,
      };
      saveMap(map);
      this.close(map);
    }
  }

  private poll(): void {
    const gp = this.pad();
    const st = this.steps[this.si];
    // Live bars for every axis.
    if (gp) {
      if (this.bars.childElementCount !== gp.axes.length * 2) {
        this.bars.innerHTML = gp.axes.map((_, i) => `<span>axis ${i}</span><div class="bar"><i></i></div>`).join('');
      }
      gp.axes.forEach((v, i) => {
        const bar = this.bars.children[i * 2 + 1]?.firstElementChild as HTMLElement | null;
        if (bar) bar.style.left = `calc(${((v + 1) / 2) * 100}% - 1px)`;
      });
    }
    if (!gp) {
      this.msg.textContent = 'No controller detected yet: connect it and move any stick.';
      return;
    }
    if (st.kind === 'rest') {
      this.msg.textContent = `Found "${gp.id}". Centre all sticks, put THROTTLE fully DOWN, then press Next.`;
      return;
    }
    if (st.kind === 'done') {
      this.msg.textContent = 'All set. Press Next to save (stored in this browser).';
      return;
    }
    if (st.kind === 'button') {
      this.msg.textContent = st.text;
      const pressed = gp.buttons.map((b) => b.pressed);
      const hit = pressed.findIndex((p, i) => p && !this.prevButtons[i]);
      // Switches on radios often appear as axes too; buttons are what we bind here.
      if (hit >= 0 && this.prevButtons.length) {
        (this.map as Record<string, unknown>)[st.name] = hit;
        this.advance();
      }
      this.prevButtons = pressed;
      return;
    }
    this.msg.textContent = st.text;
    // Find the axis furthest from rest (ignoring axes already assigned).
    const used = new Set(['throttle', 'yaw', 'pitch', 'roll'].map((k) => (this.map as Record<string, AxisCal | undefined>)[k]?.index).filter((x) => x !== undefined));
    let best = -1, bestD = 0;
    gp.axes.forEach((v, i) => {
      if (!(st.name === 'throttle' && st.phase === 'b') && used.has(i)) return;
      const d = Math.abs(v - (this.rest[i] ?? 0));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    if (st.name === 'throttle' && st.phase === 'b') best = this.map.throttle?.index ?? best;
    const v = gp.axes[best] ?? 0;
    const moved = st.name === 'throttle' && st.phase === 'b' ? Math.abs(v - this.throttleUp) > 0.6 : bestD > 0.45;
    if (!moved || best < 0 || (best !== this.cand.axis && this.hold > 0)) {
      this.hold = 0;
      this.cand = { axis: best, value: v };
      return;
    }
    this.cand = { axis: best, value: Math.abs(v) > Math.abs(this.cand.value) ? v : this.cand.value };
    this.hold += 1 / 60;
    if (this.hold < 0.5) return;
    if (st.name === 'throttle') {
      if (st.phase === 'a') {
        this.throttleUp = this.cand.value;
        this.map.throttle = { index: best, min: 0, max: 0, center: 0, invert: false };
      } else {
        const up = this.throttleUp, down = this.cand.value;
        this.map.throttle = { index: best, min: Math.min(up, down), max: Math.max(up, down), center: (up + down) / 2, invert: up < down };
      }
    } else {
      const c = this.rest[best] ?? 0;
      const ext = Math.abs(this.cand.value - c);
      const positive = this.cand.value > c;
      (this.map as Record<string, AxisCal>)[st.name] = { index: best, min: c - ext, max: c + ext, center: c, invert: !positive };
    }
    this.advance();
  }
}
