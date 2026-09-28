"""The 1 m analysis grid (same as cache/lidar/dem1.tif) and helpers to rasterize vectors onto it."""
import json

import numpy as np
import rasterio
from rasterio import features
from rasterio.enums import Resampling
from rasterio.warp import reproject

from .config import CACHE


class Grid:
    def __init__(self, path=CACHE / "lidar" / "dem1.tif"):
        with rasterio.open(path) as f:
            self.transform = f.transform
            self.crs = f.crs
            self.shape = (f.height, f.width)
            self.bounds = f.bounds

    def rasterize(self, shapes, fill=0, dtype="uint8", all_touched=False):
        shapes = [(g, v) for g, v in shapes if g is not None and not g.is_empty]
        if not shapes:
            return np.full(self.shape, fill, dtype=dtype)
        return features.rasterize(shapes, out_shape=self.shape, transform=self.transform, fill=fill,
                                  dtype=dtype, all_touched=all_touched)

    def warp(self, path, band=1, resampling=Resampling.bilinear):
        out = np.full(self.shape, np.nan, dtype=np.float32)
        with rasterio.open(path) as src:
            reproject(rasterio.band(src, band), out, dst_transform=self.transform, dst_crs=self.crs,
                      dst_nodata=np.nan, resampling=resampling)
        return out

    def rc(self, e, n):
        c = (np.asarray(e) - self.transform.c) / self.transform.a
        r = (np.asarray(n) - self.transform.f) / self.transform.e
        return r, c


def load_pc_stats(grid: Grid):
    d = np.load(CACHE / "lidar" / "pc_stats.npz")
    st = json.load(open(CACHE / "lidar" / "pc_tile_stats.json"))
    cover = d["cover"]
    p50 = np.array([1.0] + [s["p50"] for s in st], dtype=np.float32)
    g_cnt, f_cnt = d["g_cnt"], d["f_cnt"]
    with np.errstate(invalid="ignore", divide="ignore"):
        gin = np.where(g_cnt > 0, d["g_int"] / np.maximum(g_cnt, 1), np.nan) / p50[cover]
        fin = np.where(f_cnt > 0, d["f_int"] / np.maximum(f_cnt, 1), np.nan) / p50[cover]
        vegfrac = np.where(f_cnt > 0, d["m_cnt"] / np.maximum(f_cnt, 1), 0)
        lofrac = np.where(f_cnt > 0, d["lo_cnt"] / np.maximum(f_cnt, 1), 0)
    return {"gin": gin.astype(np.float32), "fin": fin.astype(np.float32), "vegfrac": vegfrac.astype(np.float32),
            "lofrac": lofrac.astype(np.float32), "f_cnt": f_cnt, "g_cnt": g_cnt, "hi_cnt": d["hi_cnt"], "cover": cover}
