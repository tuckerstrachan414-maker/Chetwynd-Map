import * as THREE from 'three';
import type { Sticks } from './FlightModel';
import type { Input } from './Input';

/** One calibrated gamepad axis: index, observed range and centre, direction. */
export interface AxisCal {
  index: number;
  min: number;
  max: number;
  center: number;
  invert: boolean;
}

export interface StickMap {
  throttle: AxisCal;
  yaw: AxisCal;
  pitch: AxisCal;
  roll: AxisCal;
  /** Button that re-spawns after a crash, and one that toggles acro/angle (-1 = none). */
  reset: number;
  mode: number;
  /** Controller id the map was made for. */
  id: string;
  /** A radio transmitter (throttle stays where it is put) rather than a sprung gamepad stick. */
  radio: boolean;
}

/** USB joystick names of RC transmitters (EdgeTX/OpenTX radios, ELRS/CRSF dongles). */
export const RADIO_RE = /radio|edgetx|opentx|taranis|radiomaster|jumper|tx16|tx12|zorro|boxer|pocket|crsf|elrs|frsky|flysky/i;

const KEY = 'cw.fpv.sticks.v1';

/** Mode 2 layout of a standard gamepad (left stick throttle/yaw, right stick pitch/roll). */
export function defaultMap(id = ''): StickMap {
  const ax = (index: number, invert = false): AxisCal => ({ index, min: -1, max: 1, center: 0, invert });
  return { throttle: ax(1, true), yaw: ax(0), pitch: ax(3, true), roll: ax(2), reset: 3, mode: 2, id, radio: RADIO_RE.test(id) };
}

export function loadMap(): StickMap | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as StickMap) : null;
  } catch {
    return null;
  }
}

export function saveMap(m: StickMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage unavailable: the map lasts for this session */
  }
}

/** Centred axis in [-1, 1] with the calibrated range on each side of the centre. */
export function readCentered(v: number, c: AxisCal, deadband = 0.02): number {
  let x = v >= c.center ? (v - c.center) / Math.max(c.max - c.center, 1e-3) : (v - c.center) / Math.max(c.center - c.min, 1e-3);
  x = THREE.MathUtils.clamp(x, -1, 1);
  if (c.invert) x = -x;
  return Math.abs(x) < deadband ? 0 : (x - Math.sign(x) * deadband) / (1 - deadband);
}

/**
 * Throttle in [0, 1]. A radio's throttle has no spring, so its full range maps to 0..1; a
 * gamepad stick springs back to the middle, which maps to 0 (push up to climb).
 */
export function readThrottle(v: number, c: AxisCal, sprung: boolean): number {
  let x = (v - c.min) / Math.max(c.max - c.min, 1e-3);
  if (c.invert) x = 1 - x;
  x = THREE.MathUtils.clamp(x, 0, 1);
  if (sprung) x = Math.max(0, x * 2 - 1);
  return x;
}

/**
 * Stick source for the drone: a calibrated gamepad / USB radio when connected, else keyboard and
 * mouse. Keyboard: W/S pitch, A/D roll, Q/E yaw (or mouse X), Shift/Ctrl throttle up/down (sticky),
 * Space punch-out.
 */
export class StickInput {
  map: StickMap | null = loadMap();
  readonly sticks: Sticks = { throttle: 0, roll: 0, pitch: 0, yaw: 0 };
  private kbThrottle = 0.2;
  private readonly kb = { roll: 0, pitch: 0, yaw: 0 };
  /** True when a gamepad with a spring-loaded throttle (not a radio) is in use. */
  sprung = true;
  source: 'keyboard' | 'gamepad' = 'keyboard';

  update(input: Input, dt: number): Sticks {
    const gp = input.gamepad;
    const s = this.sticks;
    if (gp && gp.axes.length >= 4) {
      this.source = 'gamepad';
      const m = this.map && this.map.id === gp.id ? this.map : defaultMap(gp.id);
      this.sprung = !m.radio;
      const a = gp.axes;
      s.throttle = readThrottle(a[m.throttle.index] ?? 0, m.throttle, this.sprung);
      s.yaw = readCentered(a[m.yaw.index] ?? 0, m.yaw);
      s.pitch = readCentered(a[m.pitch.index] ?? 0, m.pitch);
      s.roll = readCentered(a[m.roll.index] ?? 0, m.roll);
      return s;
    }
    this.source = 'keyboard';
    // Keyboard sticks ease in and out so taps give small corrections and holds give flips.
    const k = 1 - Math.exp(-dt * 14);
    const tgt = (neg: boolean, pos: boolean) => (pos ? 1 : 0) - (neg ? 1 : 0);
    this.kb.pitch += (tgt(input.down('KeyS') || input.down('ArrowDown'), input.down('KeyW') || input.down('ArrowUp')) - this.kb.pitch) * k;
    this.kb.roll += (tgt(input.down('KeyA') || input.down('ArrowLeft'), input.down('KeyD') || input.down('ArrowRight')) - this.kb.roll) * k;
    this.kb.yaw += (tgt(input.down('KeyQ'), input.down('KeyE')) - this.kb.yaw) * k;
    if (input.down('ShiftLeft') || input.down('ShiftRight')) this.kbThrottle += dt * 0.6;
    if (input.down('ControlLeft') || input.down('ControlRight')) this.kbThrottle -= dt * 0.6;
    this.kbThrottle = THREE.MathUtils.clamp(this.kbThrottle, 0, 1);
    s.throttle = input.down('Space') ? 1 : this.kbThrottle;
    s.pitch = this.kb.pitch;
    s.roll = this.kb.roll;
    // Mouse X adds yaw like a rudder stick.
    s.yaw = THREE.MathUtils.clamp(this.kb.yaw + input.mouseDX * 0.03, -1, 1);
    return s;
  }

  setKeyboardThrottle(v: number): void {
    this.kbThrottle = v;
  }
}
