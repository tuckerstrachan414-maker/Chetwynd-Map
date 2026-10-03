import * as THREE from 'three';
import { chetwyndLocalToDate, horizontalToEngine, moonPosition, sunPosition } from '../util/astro';
import { transmittance } from '../engine/sky/transmittance';

/** Sun illuminance in engine radiometric units (consistent across sky, lights and IBL). */
export const SUN_E = 10;
const MOON_FULL_E = SUN_E * 2.6e-6 * 400; // boosted x400: a filmic "day-for-night" moonlight

/** Time of day and the derived sun/moon lighting state. */
export class SkyState {
  year = 2025;
  month = 7;
  day = 15;
  hour = 14;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  readonly sunColor = new THREE.Color();
  readonly moonColor = new THREE.Color();
  /** Direction of the light that currently casts shadows (sun by day, moon by night). */
  readonly lightDir = new THREE.Vector3(0, 1, 0);
  readonly lightColor = new THREE.Color();
  sunE = SUN_E;
  moonE = 0;
  moonIllum = 0;
  /** 0 at day, 1 in full night. */
  night = 0;
  private readonly tmp: [number, number, number] = [0, 0, 0];
  /** The date and hour the sun and moon positions were last computed for (they change only with it). */
  private ephemNum = NaN;
  private sunElevation = 0;
  private moonElevation = 0;

  get date(): Date {
    return chetwyndLocalToDate(this.year, this.month, this.day, this.hour);
  }

  update(altKm: number, haze: number): void {
    // Sun and moon positions depend only on the date and hour: recompute them when those change.
    if (this.year * 1e7 + this.month * 1e5 + this.day * 1e3 + this.hour !== this.ephemNum) {
      this.ephemNum = this.year * 1e7 + this.month * 1e5 + this.day * 1e3 + this.hour;
      const d = this.date;
      const sp = sunPosition(d);
      horizontalToEngine(sp, this.sunDir);
      const mp = moonPosition(d);
      horizontalToEngine(mp, this.moonDir);
      this.moonIllum = mp.illumination;
      this.sunElevation = sp.elevation;
      this.moonElevation = mp.elevation;
    }
    const sunEl = this.sunElevation, moonEl = this.moonElevation;
    const ts = transmittance(altKm, this.sunDir.y, haze, this.tmp);
    this.sunColor.setRGB(ts[0] * SUN_E, ts[1] * SUN_E, ts[2] * SUN_E);
    const tm = transmittance(altKm, this.moonDir.y, haze, this.tmp);
    this.moonE = MOON_FULL_E * this.moonIllum;
    this.moonColor.setRGB(tm[0] * this.moonE * 0.9, tm[1] * this.moonE * 0.95, tm[2] * this.moonE * 1.1);
    // Blend the shadow-casting light from sun to moon through twilight.
    this.night = THREE.MathUtils.smoothstep(-sunEl, -2, 8);
    if (sunEl > -4 || moonEl < 0) {
      this.lightDir.copy(this.sunDir);
      this.lightColor.copy(this.sunColor);
    } else {
      this.lightDir.copy(this.moonDir);
      this.lightColor.copy(this.moonColor);
    }
    if (this.lightDir.y < 0.02) {
      // Light below the horizon: keep a valid shadow direction, zero intensity.
      this.lightColor.multiplyScalar(THREE.MathUtils.smoothstep(this.lightDir.y, -0.02, 0.02));
    }
  }
}
