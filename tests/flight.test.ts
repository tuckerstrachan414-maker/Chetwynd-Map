import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Battery, betaflightRate, cellVoltage, DEFAULT_RATES, FlightController, FREESTYLE_5IN, thrustCurve } from '../src/sim/FlightModel';

describe('Betaflight rates', () => {
  it('matches the classic formula at full stick', () => {
    // RC rate 1.0, super 0.7, expo 0: 200 / (1 - 0.7) = 666.7 deg/s
    expect(betaflightRate(1, DEFAULT_RATES.roll)).toBeCloseTo(666.67, 1);
    expect(betaflightRate(-1, DEFAULT_RATES.roll)).toBeCloseTo(-666.67, 1);
    expect(betaflightRate(0, DEFAULT_RATES.roll)).toBe(0);
  });
  it('is monotonic and softened by expo', () => {
    const r = { rcRate: 1, superRate: 0.7, expo: 0.5 };
    let prev = -Infinity;
    for (let s = 0; s <= 1; s += 0.05) {
      const v = betaflightRate(s, r);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(betaflightRate(0.3, r)).toBeLessThan(betaflightRate(0.3, DEFAULT_RATES.roll));
  });
});

describe('battery', () => {
  it('rests at 4.2 V/cell full and sags under load', () => {
    expect(cellVoltage(1)).toBeCloseTo(4.2);
    expect(cellVoltage(0)).toBeCloseTo(3.27);
    const b = new Battery(FREESTYLE_5IN);
    const hover = b.draw(0.25, 0.01);
    const punch = b.draw(1, 0.01);
    expect(punch).toBeLessThan(hover);
    expect(b.current).toBeGreaterThan(100);
  });
});

describe('flight controller', () => {
  it('hovers near a quarter throttle', () => {
    const fc = new FlightController();
    const q = new THREE.Quaternion();
    const zero = new THREE.Vector3();
    // Find the throttle whose thrust equals the weight.
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      fc.battery.reset();
      const f = fc.step(0.001, { throttle: mid, roll: 0, pitch: 0, yaw: 0 }, q, zero, zero, true).force.y;
      if (f > FREESTYLE_5IN.mass * 9.81) hi = mid;
      else lo = mid;
    }
    expect(lo).toBeGreaterThan(0.18);
    expect(lo).toBeLessThan(0.4);
  });
  it('commands a roll to the right for right stick (body -Z rotation)', () => {
    const fc = new FlightController();
    const q = new THREE.Quaternion();
    const zero = new THREE.Vector3();
    let o = fc.step(0.01, { throttle: 0.5, roll: 1, pitch: 0, yaw: 0 }, q, zero, zero, true);
    for (let i = 0; i < 20; i++) o = fc.step(0.01, { throttle: 0.5, roll: 1, pitch: 0, yaw: 0 }, q, zero, zero, true);
    expect(o.angvel.z).toBeLessThan(-8); // rad/s towards the right wing going down
    expect(Math.abs(o.angvel.x)).toBeLessThan(1e-6);
  });
  it('angle mode levels out from a bank', () => {
    const fc = new FlightController();
    fc.mode = 'angle';
    const banked = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5); // left wing down
    const zero = new THREE.Vector3();
    let o = fc.step(0.01, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0 }, banked, zero, zero, true);
    for (let i = 0; i < 20; i++) o = fc.step(0.01, { throttle: 0.3, roll: 0, pitch: 0, yaw: 0 }, banked, zero, zero, true);
    expect(o.angvel.z).toBeLessThan(0); // rolls back to the right
  });
  it('drags against the airflow', () => {
    const fc = new FlightController();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3(20, 0, 0);
    const o = fc.step(0.01, { throttle: 0, roll: 0, pitch: 0, yaw: 0 }, q, v, new THREE.Vector3(), true);
    expect(o.force.x).toBeLessThan(-5);
    expect(thrustCurve(0, 0.035)).toBeCloseTo(0.035);
  });
});
