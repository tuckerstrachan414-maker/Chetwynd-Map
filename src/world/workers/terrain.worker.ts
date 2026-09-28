/// <reference lib="webworker" />
import { decodeHeight, gunzip } from '../codec';

interface Req {
  id: number;
  url: string;
  matUrl?: string;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, url, matUrl } = e.data;
  try {
    const [res, mres] = await Promise.all([fetch(url), matUrl ? fetch(matUrl) : Promise.resolve(null)]);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const tile = await decodeHeight(await res.arrayBuffer());
    let mats: Uint8Array | null = null;
    if (mres && mres.ok) mats = await gunzip(await mres.arrayBuffer());
    const transfer: Transferable[] = [tile.heights.buffer];
    if (mats) transfer.push(mats.buffer);
    (self as unknown as Worker).postMessage({ id, ok: true, tile, mats }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(err) });
  }
};
