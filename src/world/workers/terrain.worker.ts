/// <reference lib="webworker" />
import { decodeHeight } from '../codec';

interface Req {
  id: number;
  url: string;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, url } = e.data;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const tile = await decodeHeight(await res.arrayBuffer());
    (self as unknown as Worker).postMessage({ id, ok: true, tile }, [tile.heights.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
