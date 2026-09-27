/// <reference lib="webworker" />
import { SkeletonBuilder } from 'straight-skeleton';
import { gunzip } from '../codec';
import { buildBuilding, Stream, type BuildingRec, type BuildingStreams, type SkeletonFn } from '../buildings/BuildingGen';

let ready: Promise<SkeletonFn | null> | null = null;
function skeletonFn(): Promise<SkeletonFn | null> {
  if (!ready) {
    ready = SkeletonBuilder.init()
      .then(() => (rings: number[][][]) => {
        try {
          return SkeletonBuilder.buildFromPolygon(rings) as ReturnType<SkeletonFn>;
        } catch {
          return null;
        }
      })
      .catch(() => null);
  }
  return ready;
}

export interface PackedStream {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  a0: Float32Array;
  a1: Float32Array;
  a2: Float32Array;
  a3: Float32Array;
}

function pack(s: Stream): PackedStream {
  return {
    pos: new Float32Array(s.pos),
    nrm: new Float32Array(s.nrm),
    uv: new Float32Array(s.uv),
    a0: new Float32Array(s.a0),
    a1: new Float32Array(s.a1),
    a2: new Float32Array(s.a2),
    a3: new Float32Array(s.a3),
  };
}

self.onmessage = async (e: MessageEvent<{ id: number; url: string }>) => {
  const { id, url } = e.data;
  try {
    const [sk, res] = await Promise.all([skeletonFn(), fetch(url)]);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const json = JSON.parse(new TextDecoder().decode(await gunzip(await res.arrayBuffer())));
    const streams: BuildingStreams = { walls: new Stream(), roofs: new Stream(), trims: new Stream() };
    const buildings: BuildingRec[] = json.buildings ?? [];
    for (const b of buildings) {
      try {
        buildBuilding(b, streams, sk);
      } catch (err) {
        console.warn('building failed', b.id, err);
      }
    }
    const out = { walls: pack(streams.walls), roofs: pack(streams.roofs), trims: pack(streams.trims) };
    const transfer: Transferable[] = [];
    for (const s of Object.values(out)) for (const a of Object.values(s)) transfer.push((a as Float32Array).buffer);
    const colliders = buildings.map((b) => ({ poly: b.poly, base: b.base, baseMin: b.baseMin, eave: b.eave }));
    (self as unknown as Worker).postMessage({ id, ok: true, data: out, raw: { ...json, buildings: colliders } }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
