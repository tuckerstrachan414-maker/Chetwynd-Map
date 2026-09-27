"""Rasterize LidarBC point clouds over the 1 m zone into per-cell statistics.

For each 1 m cell (grid of dem1.tif) accumulates:
  g_cnt, g_int   ground-class point count and intensity sum (surface material cue)
  f_cnt, f_int   first-return count and intensity sum
  m_cnt          first returns that belong to multi-return pulses (vegetation cue)
  lo_cnt         points 0.3-2.5 m above ground (shrubs, fences, vehicles)
  hi_cnt         points >2.5 m above ground (trees, roofs, wires)
Tiles are streamed one at a time and deleted after processing.
Writes cache/lidar/pc_stats.npz plus per-tile intensity medians for normalization.
"""
import json
import multiprocessing as mp
import os
import sys
import urllib.request

import laspy
import numpy as np
import rasterio
from rasterio.windows import from_bounds

from .config import CACHE, LIDAR_BASE

PC = CACHE / "lidar" / "pc"
FIELDS = ["g_cnt", "g_int", "f_cnt", "f_int", "m_cnt", "lo_cnt", "hi_cnt"]


def tile_list():
    res = json.load(open(CACHE / "lidar" / "pc_index.json"))
    idx = json.load(open(CACHE / "lidar" / "index.json"))
    keys = {o["key"].rsplit("/", 1)[1]: o["key"] for o in idx if o["prod"] == "pointcloud"}
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as d:
        b = d.bounds
    return [(keys[r[0]], r[3]) for r in res
            if r[3][0] < b.right and r[3][2] > b.left and r[3][1] < b.top and r[3][3] > b.bottom]


def process(job):
    key, bounds = job
    name = key.rsplit("/", 1)[1]
    fn = PC / name
    if not fn.exists():
        tmp = fn.with_suffix(".part")
        urllib.request.urlretrieve(LIDAR_BASE + key, tmp)
        tmp.rename(fn)
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as d:
        win = from_bounds(*bounds, transform=d.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, d.width, d.height))
        dem = d.read(1, window=win)
        tr = d.window_transform(win)
    h, w = dem.shape
    acc = {k: np.zeros(h * w, dtype=np.float64 if k.endswith("int") else np.uint32) for k in FIELDS}
    gi_samples = []
    with laspy.open(fn) as f:
        for ch in f.chunk_iterator(8_000_000):
            x = np.asarray(ch.x); y = np.asarray(ch.y); z = np.asarray(ch.z)
            col = ((x - tr.c) / tr.a).astype(np.int64)
            row = ((y - tr.f) / tr.e).astype(np.int64)
            ok = (col >= 0) & (col < w) & (row >= 0) & (row < h)
            cls = np.asarray(ch.classification)
            ok &= (cls != 7) & (cls != 18)
            col, row, z, cls = col[ok], row[ok], z[ok], cls[ok]
            inten = np.asarray(ch.intensity)[ok].astype(np.float64)
            rn = np.asarray(ch.return_number)[ok]
            nr = np.asarray(ch.number_of_returns)[ok]
            cell = row * w + col
            hag = z - dem.ravel()[cell]
            g = cls == 2
            acc["g_cnt"] += np.bincount(cell[g], minlength=h * w).astype(np.uint32)
            acc["g_int"] += np.bincount(cell[g], weights=inten[g], minlength=h * w)
            fr = rn == 1
            acc["f_cnt"] += np.bincount(cell[fr], minlength=h * w).astype(np.uint32)
            acc["f_int"] += np.bincount(cell[fr], weights=inten[fr], minlength=h * w)
            m = fr & (nr > 1)
            acc["m_cnt"] += np.bincount(cell[m], minlength=h * w).astype(np.uint32)
            lo = (hag > 0.3) & (hag <= 2.5)
            acc["lo_cnt"] += np.bincount(cell[lo], minlength=h * w).astype(np.uint32)
            hi = (hag > 2.5) & (hag < 60)
            acc["hi_cnt"] += np.bincount(cell[hi], minlength=h * w).astype(np.uint32)
            if g.any():
                gi_samples.append(inten[g][:: max(1, g.sum() // 20000)])
    os.remove(fn)
    gi = np.concatenate(gi_samples) if gi_samples else np.array([1.0])
    stats = {"name": name, "p10": float(np.percentile(gi, 10)), "p50": float(np.percentile(gi, 50)),
             "p90": float(np.percentile(gi, 90))}
    out = {k: v.reshape(h, w) for k, v in acc.items()}
    return (int(win.row_off), int(win.col_off), h, w), out, stats


def main():
    jobs = tile_list()
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as d:
        H, W = d.height, d.width
    grids = {k: np.zeros((H, W), dtype=np.float32) for k in FIELDS}
    cover = np.zeros((H, W), dtype=np.int16)  # tile index + 1 for intensity normalization
    tstats = []
    nproc = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    with mp.Pool(nproc) as pool:
        for i, (win, out, stats) in enumerate(pool.imap_unordered(process, jobs)):
            r0, c0, h, w = win
            for k in FIELDS:
                grids[k][r0:r0 + h, c0:c0 + w] += out[k]
            cover[r0:r0 + h, c0:c0 + w][out["f_cnt"] > 0] = len(tstats) + 1
            tstats.append(stats)
            print(f"[{i + 1}/{len(jobs)}]", stats, flush=True)
    np.savez_compressed(CACHE / "lidar" / "pc_stats.npz", cover=cover, **grids)
    json.dump(tstats, open(CACHE / "lidar" / "pc_tile_stats.json", "w"), indent=1)
    print("done")


if __name__ == "__main__":
    main()
