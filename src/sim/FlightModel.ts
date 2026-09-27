import * as THREE from 'three';

/**
 * FPV quadcopter flight model: Betaflight rate curves, a rate (acro) or self-levelling (angle)
 * controller, motor thrust with a battery that sags under load, and body drag. Pure maths (no
 * physics engine), so it can be unit tested; Drone.ts applies it to a Rapier rigid body.
 *
 * Body frame (three.js): forward -Z, up +Y, right +X. Sticks are in [-1, 1] (throttle [0, 1]).
 */

export interface Sticks {
  throttle: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface Rates {
  /** Betaflight "RC Rate" (1.0 = 200 deg/s at full stick before super rate). */
  rcRate: number;
  /** "Super Rate" (0..0.99): steepens the end of the stick. */
  superRate: number;
  /** "RC Expo" (0..1): softens the centre. */
  expo: number;
}

export const DEFAULT_RATES: { roll: Rates; pitch: Rates; yaw: Rates } = {
  roll: { rcRate: 1.0, superRate: 0.7, expo: 0.0 },
  pitch: { rcRate: 1.0, superRate: 0.7, expo: 0.0 },
  yaw: { rcRate: 1.0, superRate: 0.6, expo: 0.0 },
};

/** Betaflight rate curve: stick deflection -> commanded body rate in deg/s. */
export function betaflightRate(stick: number, r: Rates): number {
  let s = THREE.MathUtils.clamp(stick, -1, 1);
  const a = Math.abs(s);
  if (r.expo > 0) s = s * a * a * a * r.expo + s * (1 - r.expo);
  let rc = r.rcRate;
  if (rc > 2) rc += 14.54 * (rc - 2);
  let rate = 200 * rc * s;
  if (r.superRate > 0) rate *= 1 / THREE.MathUtils.clamp(1 - a * r.superRate, 0.01, 1);
  return THREE.MathUtils.clamp(rate, -1998, 1998);
}

export interface QuadSpec {
  mass: number; // kg, all-up weight
  twr: number; // thrust-to-weight at full charge
  idle: number; // motor idle fraction of max thrust (air mode keeps authority)
  cells: number; // LiPo series cells
  capacity: number; // mAh
  rInt: number; // pack internal resistance (ohm)
  dragQ: THREE.Vector3; // quadratic drag coefficients along body axes (N / (m/s)^2)
  dragL: number; // linear rotor drag (N / (m/s))
  tau: number; // rate controller response time constant (s)
}

/** A 5-inch freestyle quad on a 4S 1300 mAh pack. */
export const FREESTYLE_5IN: QuadSpec = {
  mass: 0.65,
  twr: 7,
  idle: 0.035,
  cells: 4,
  capacity: 1300,
  rInt: 0.028,
  dragQ: new THREE.Vector3(0.018, 0.034, 0.018),
  dragL: 0.06,
  tau: 0.022,
};

/** Resting cell voltage for a state of charge (typical LiPo discharge curve). */
export function cellVoltage(soc: number): number {
  const T: [number, number][] = [[0, 3.27], [0.05, 3.5], [0.1, 3.6], [0.2, 3.7], [0.4, 3.78], [0.6, 3.86], [0.8, 3.98], [0.9, 4.07], [1, 4.2]];
  const s = THREE.MathUtils.clamp(soc, 0, 1);
  for (let i = 1; i < T.length; i++) {
    if (s <= T[i][0]) {
      const k = (s - T[i - 1][0]) / (T[i][0] - T[i - 1][0]);
      return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * k;
    }
  }
  return 4.2;
}

export class Battery {
  used = 0; // mAh
  current = 0; // A
  voltage: number;
  constructor(readonly spec: QuadSpec) {
    this.voltage = cellVoltage(1) * spec.cells;
  }
  get soc(): number {
    return Math.max(0, 1 - this.used / this.spec.capacity);
  }
  get resting(): number {
    return cellVoltage(this.soc) * this.spec.cells;
  }
  /** Draw current for a throttle output; returns the loaded pack voltage. */
  draw(output: number, dt: number): number {
    // Hover (~25 %) draws ~12 A; full punch ~110 A on a 5" quad.
    this.current = 1.2 + 108 * output * output;
    this.used += (this.current * dt) / 3.6;
    this.voltage = Math.max(this.resting - this.current * this.spec.rInt, 2.8 * this.spec.cells);
    return this.voltage;
  }
  reset(): void {
    this.used = 0;
    this.voltage = this.resting;
  }
}

/** Thrust fraction from throttle: motors respond roughly with rpm squared; mid-stick hovers near 25 %. */
export function thrustCurve(throttle: number, idle: number): number {
  const t = THREE.MathUtils.clamp(throttle, 0, 1);
  return idle + (1 - idle) * Math.pow(t, 1.6);
}

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _e = new THREE.Euler();

export interface FlightOutput {
  /** Commanded body angular velocity (rad/s), world frame. */
  angvel: THREE.Vector3;
  /** Total force on the body (N), world frame, excluding gravity. */
  force: THREE.Vector3;
  /** Throttle output after mixing (0..1), for audio and battery. */
  output: number;
}

/**
 * Per-step controller: turns sticks into the body rate the flight controller holds and the
 * thrust/drag forces. `rate` is the current body rate state (rad/s, body frame), updated in place.
 */
export class FlightController {
  mode: 'acro' | 'angle' = 'acro';
  rates = DEFAULT_RATES;
  readonly rate = new THREE.Vector3();
  readonly battery: Battery;
  maxAngle = THREE.MathUtils.degToRad(55);
  private readonly out: FlightOutput = { angvel: new THREE.Vector3(), force: new THREE.Vector3(), output: 0 };
  private wobble = new THREE.Vector3();

  constructor(readonly spec: QuadSpec = FREESTYLE_5IN) {
    this.battery = new Battery(spec);
  }

  /** Desired body rates (rad/s, body frame) from the sticks. */
  setpoint(s: Sticks, rot: THREE.Quaternion, target: THREE.Vector3): THREE.Vector3 {
    const d2r = Math.PI / 180;
    const yawRate = -betaflightRate(s.yaw, this.rates.yaw) * d2r;
    if (this.mode === 'acro') {
      return target.set(
        -betaflightRate(s.pitch, this.rates.pitch) * d2r,
        yawRate,
        -betaflightRate(s.roll, this.rates.roll) * d2r,
      );
    }
    // Angle mode: sticks set the tilt; a P controller on the attitude error gives the rates.
    _e.setFromQuaternion(rot, 'YXZ');
    const want = _q.setFromEuler(_e.set(-s.pitch * this.maxAngle, _e.y, -s.roll * this.maxAngle, 'YXZ'));
    // Error rotation in the body frame: rot^-1 * want.
    const err = _qi.copy(rot).invert().multiply(want);
    if (err.w < 0) err.set(-err.x, -err.y, -err.z, -err.w);
    const k = 9;
    target.set(err.x * 2 * k, err.y * 2 * k, err.z * 2 * k);
    target.y += yawRate * 0.6;
    return target;
  }

  /**
   * One control step.
   * @param rot body orientation (world)
   * @param vel body linear velocity (world, m/s)
   * @param wind air velocity (world, m/s)
   */
  step(dt: number, s: Sticks, rot: THREE.Quaternion, vel: THREE.Vector3, wind: THREE.Vector3, armed: boolean): FlightOutput {
    const o = this.out;
    const sp = this.setpoint(s, rot, _v);
    // The PID loop tracks the setpoint with a short lag; props washing through their own
    // downwash (descending under power) shake the quad.
    const a = 1 - Math.exp(-dt / this.spec.tau);
    this.rate.lerp(sp, a);
    const vBody = _q.copy(rot).invert();
    const vb = _vb.copy(vel).sub(wind).applyQuaternion(vBody);
    const wash = armed ? THREE.MathUtils.clamp(-vb.y / 6 - 0.3, 0, 1) * THREE.MathUtils.clamp(s.throttle * 3, 0, 1) : 0;
    if (wash > 0) {
      this.wobble.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.3, Math.random() - 0.5).multiplyScalar(wash * 5);
      this.rate.add(this.wobble.multiplyScalar(dt * 60));
    }
    o.angvel.copy(this.rate).applyQuaternion(rot);

    // Thrust along body up, scaled by the loaded battery voltage.
    const outThr = armed ? thrustCurve(s.throttle, this.spec.idle) : 0;
    const v = this.battery.draw(armed ? outThr : 0, dt);
    const vNom = 3.8 * this.spec.cells;
    const maxT = this.spec.twr * this.spec.mass * 9.81 * Math.pow(v / vNom, 1.3) * 0.93;
    const T = maxT * outThr;
    const f = o.force.set(0, T, 0);
    // Drag in the body frame: quadratic per axis plus linear rotor drag (props spinning edgewise).
    const q2 = this.spec.dragQ;
    f.x -= q2.x * vb.x * Math.abs(vb.x) + this.spec.dragL * vb.x;
    f.y -= q2.y * vb.y * Math.abs(vb.y) + this.spec.dragL * 0.3 * vb.y;
    f.z -= q2.z * vb.z * Math.abs(vb.z) + this.spec.dragL * vb.z;
    f.applyQuaternion(rot);
    o.output = outThr;
    return o;
  }
}
