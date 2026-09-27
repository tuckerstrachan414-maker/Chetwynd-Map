import { describe, expect, it } from 'vitest';
import { chetwyndLocalToDate, moonPosition, sunPosition } from '../src/util/astro';

describe('astro', () => {
  it('sun is high in the south at local solar noon near the June solstice', () => {
    // Longitude -121.6 in UTC-7: solar noon is about 13:06 MST.
    const p = sunPosition(chetwyndLocalToDate(2025, 6, 21, 13.1));
    expect(p.elevation).toBeGreaterThan(56);
    expect(p.elevation).toBeLessThan(59);
    expect(Math.abs(p.azimuth - 180)).toBeLessThan(5);
  });

  it('sun is low at the December solstice noon', () => {
    const p = sunPosition(chetwyndLocalToDate(2025, 12, 21, 13.1));
    expect(p.elevation).toBeGreaterThan(9.5);
    expect(p.elevation).toBeLessThan(12);
  });

  it('sun is below the horizon at local midnight in winter', () => {
    expect(sunPosition(chetwyndLocalToDate(2025, 1, 15, 0)).elevation).toBeLessThan(-30);
  });

  it('moon is nearly full on 2025-10-07', () => {
    expect(moonPosition(chetwyndLocalToDate(2025, 10, 7, 0)).illumination).toBeGreaterThan(0.95);
  });
});
