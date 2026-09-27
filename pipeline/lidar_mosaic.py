"""Merge LidarBC tiles into seamless DEM/DSM mosaics.

Outputs (float32, NaN = no data):
  cache/lidar/dem1.tif, dsm1.tif  - 1 m over DETAIL + 1 km margin
  cache/lidar/dem2.tif, dsm2.tif  - 2 m over NEAR
The 2025 flight is preferred west of the mapsheet line and the June 2024 flight east of it
(leaf-on, same season as the CHM). Remaining holes are filled from the Sept 2024 subtiles.
Any vertical offset between flights is measured in their overlap and removed.
"""
import json

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from .config import CACHE, DETAIL, NEAR

RAW = CACHE / "lidar" / "raw"


def sources(prod):
    idx = json.load(open(CACHE / "lidar" / "index.json"))
    files = {"a": [], "b": [], "c": []}
    for o in idx:
        if o["prod"] != prod or "bounds" not in o:
            continue
        fn = RAW / o["year"] / prod / o["key"].rsplit("/", 1)[1]
        if not fn.exists():
            continue
        if o["year"] == "2025":
            files["a"].append(fn)
        elif o["shape"][0] > 5000:  # June 2024 full-sheet mosaics (063, 073)
            files["b"].append(fn)
        else:
            files["c"].append(fn)
    return files


def warp_into(fns, transform, w, h, resampling):
    dst = np.full((h, w), np.nan, dtype=np.float32)
    for fn in fns:
        with rasterio.open(fn) as src:
            b = src.bounds
            L, T = transform.c, transform.f
            R, B = L + w * transform.a, T + h * transform.e
            if b.left >= R or b.right <= L or b.bottom >= T or b.top <= B:
                continue
            tmp = np.full((h, w), np.nan, dtype=np.float32)
            reproject(rasterio.band(src, 1), tmp, src_transform=src.transform, src_crs="EPSG:3157",
                      src_nodata=src.nodata, dst_transform=transform, dst_crs="EPSG:3157",
                      dst_nodata=np.nan, resampling=resampling, num_threads=4)
            tmp[(tmp < -100) | (tmp > 5000)] = np.nan
            m = np.isnan(dst) & ~np.isnan(tmp)
            dst[m] = tmp[m]
    return dst


def build(prod, zone, res, name):
    minE, minN, maxE, maxN = zone
    w, h = int((maxE - minE) / res), int((maxN - minN) / res)
    tr = from_origin(minE, maxN, res, res)
    rs = Resampling.bilinear if res == 1 else Resampling.average
    s = sources(prod)
    a = warp_into(s["a"], tr, w, h, rs)
    b = warp_into(s["b"], tr, w, h, rs)
    c = warp_into(s["c"], tr, w, h, rs)
    # Remove vertical offsets relative to the 2025 flight using overlap medians (ground only).
    for other, label in ((b, "jun2024"), (c, "sep2024")):
        ov = ~np.isnan(a) & ~np.isnan(other)
        if ov.sum() > 1000:
            d = np.median((a - other)[ov])
            print(prod, name, label, "overlap px", int(ov.sum()), "median dz", round(float(d), 3), flush=True)
            if prod == "dem" and abs(d) < 2:
                other += d
    out = a.copy()
    for other in (b, c):
        m = np.isnan(out) & ~np.isnan(other)
        out[m] = other[m]
    print(prod, name, "shape", out.shape, "nan frac", round(float(np.isnan(out).mean()), 5), flush=True)
    prof = dict(driver="GTiff", width=w, height=h, count=1, dtype="float32", crs="EPSG:3157", transform=tr,
                nodata=np.nan, compress="deflate", tiled=True, predictor=3, BIGTIFF="IF_SAFER")
    with rasterio.open(CACHE / "lidar" / f"{name}.tif", "w", **prof) as f:
        f.write(out, 1)


def main():
    m = 1000.0
    zone1 = (DETAIL[0] - m, DETAIL[1] - m, DETAIL[2] + m, DETAIL[3] + m)
    for prod in ("dem", "dsm"):
        build(prod, zone1, 1.0, f"{prod}1")
        build(prod, NEAR, 2.0, f"{prod}2")


if __name__ == "__main__":
    main()
