/**
 * Low-cost solar and lunar ephemerides (NOAA / Meeus low precision, ~0.1-1 deg),
 * plus conversion to engine directions.
 */

export const CHETWYND = {
  lat: 55.690488840924544,
  lon: -121.61605788503977,
  /** Chetwynd (Peace River region) observes MST (UTC-7) all year. */
  utcOffsetHours: -7,
  /** Bearing of true north in the UTM grid (degrees clockwise from grid north). */
  trueNorthGridBearing: -1.1432825319770625,
};

const RAD = Math.PI / 180;

export interface HorizontalPos {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon (no refraction). */
  elevation: number;
}

export function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Local mean sidereal time in degrees. */
function lmst(jd: number, lonDeg: number): number {
  const d = jd - 2451545.0;
  const gmst = 280.46061837 + 360.98564736629 * d;
  return (((gmst + lonDeg) % 360) + 360) % 360;
}

function equatorialToHorizontal(raDeg: number, decDeg: number, jd: number, lat: number, lon: number): HorizontalPos {
  const ha = (lmst(jd, lon) - raDeg) * RAD;
  const dec = decDeg * RAD;
  const phi = lat * RAD;
  const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(-Math.sin(ha) * Math.cos(dec), Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(ha));
  return { azimuth: ((az / RAD) % 360 + 360) % 360, elevation: el / RAD };
}

function obliquity(T: number): number {
  return 23.439291 - 0.0130042 * T;
}

/** Sun ecliptic longitude (deg) and distance (AU). */
function sunEcliptic(jd: number): { lon: number; T: number } {
  const T = (jd - 2451545.0) / 36525;
  const L0 = 280.46646 + 36000.76983 * T;
  const M = (357.52911 + 35999.05029 * T) * RAD;
  const C = (1.914602 - 0.004817 * T) * Math.sin(M) + 0.019993 * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  return { lon: L0 + C, T };
}

export function sunPosition(date: Date, lat = CHETWYND.lat, lon = CHETWYND.lon): HorizontalPos {
  const jd = julianDay(date);
  const { lon: lam, T } = sunEcliptic(jd);
  const eps = obliquity(T) * RAD;
  const l = lam * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(l), Math.cos(l)) / RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(l)) / RAD;
  return equatorialToHorizontal(ra, dec, jd, lat, lon);
}

/** Moon position and illuminated fraction (0..1). */
export function moonPosition(date: Date, lat = CHETWYND.lat, lon = CHETWYND.lon): HorizontalPos & { illumination: number } {
  const jd = julianDay(date);
  const d = jd - 2451545.0;
  const T = d / 36525;
  const Lp = 218.316 + 13.176396 * d;
  const Mm = (134.963 + 13.064993 * d) * RAD;
  const F = (93.272 + 13.22935 * d) * RAD;
  const D = (297.85 + 12.190749 * d) * RAD;
  const Ms = (357.529 + 0.98560028 * d) * RAD;
  const lamb = Lp + 6.289 * Math.sin(Mm) + 1.274 * Math.sin(2 * D - Mm) + 0.658 * Math.sin(2 * D) - 0.186 * Math.sin(Ms) - 0.059 * Math.sin(2 * Mm - 2 * D);
  const beta = 5.128 * Math.sin(F);
  const eps = obliquity(T) * RAD;
  const l = lamb * RAD;
  const b = beta * RAD;
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)) / RAD;
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)) / RAD;
  const pos = equatorialToHorizontal(ra, dec, jd, lat, lon);
  const sunLon = sunEcliptic(jd).lon;
  const elong = Math.acos(Math.cos((lamb - sunLon) * RAD) * Math.cos(b));
  const illumination = (1 - Math.cos(elong)) / 2;
  return { ...pos, illumination };
}

/** Unit direction in engine space (x east, y up, z south) for a true-north azimuth/elevation. */
export function horizontalToEngine(p: HorizontalPos, out: { x: number; y: number; z: number }): typeof out {
  const bearing = (p.azimuth + CHETWYND.trueNorthGridBearing) * RAD;
  const el = p.elevation * RAD;
  out.x = Math.sin(bearing) * Math.cos(el);
  out.y = Math.sin(el);
  out.z = -Math.cos(bearing) * Math.cos(el);
  return out;
}

/** Build a UTC Date from Chetwynd local (MST) date and fractional hour. */
export function chetwyndLocalToDate(year: number, month: number, day: number, hour: number): Date {
  const ms = Date.UTC(year, month - 1, day, 0, 0, 0) + (hour - CHETWYND.utcOffsetHours) * 3600000;
  return new Date(ms);
}
