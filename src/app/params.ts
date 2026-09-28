/** URL query parameters controlling the initial view (also used by the screenshot harness). */
export interface Params {
  headless: boolean;
  /** Engine x, z of the camera. */
  at?: [number, number];
  /** Latitude/longitude of the camera (alternative to `at`). */
  ll?: [number, number];
  /** Height above ground (m). */
  h: number;
  yaw: number;
  pitch: number;
  fov: number;
  /** Local (MST) date and hour. */
  date: [number, number, number];
  hour: number;
  season?: string;
  weather?: string;
  mode?: string;
  quality?: string;
  debug: boolean;
  spawn?: string;
}

function nums(s: string | null): number[] | undefined {
  if (!s) return undefined;
  const v = s.split(',').map(Number);
  return v.every((x) => Number.isFinite(x)) ? v : undefined;
}

export function readParams(search = location.search): Params {
  const q = new URLSearchParams(search);
  const at = nums(q.get('at'));
  const ll = nums(q.get('ll'));
  const date = nums(q.get('date')?.replace(/-/g, ',') ?? null);
  return {
    headless: q.has('headless'),
    at: at && at.length >= 2 ? [at[0], at[1]] : undefined,
    ll: ll && ll.length >= 2 ? [ll[0], ll[1]] : undefined,
    h: Number(q.get('h') ?? 1.7),
    yaw: Number(q.get('yaw') ?? 0),
    pitch: Number(q.get('pitch') ?? 0),
    fov: Number(q.get('fov') ?? 70),
    date: date && date.length === 3 ? [date[0], date[1], date[2]] : [2025, 7, 15],
    hour: Number(q.get('t') ?? 14),
    season: q.get('season') ?? undefined,
    weather: q.get('weather') ?? undefined,
    mode: q.get('mode') ?? undefined,
    quality: q.get('q') ?? undefined,
    debug: q.has('debug'),
    spawn: q.get('spawn') ?? undefined,
  };
}
