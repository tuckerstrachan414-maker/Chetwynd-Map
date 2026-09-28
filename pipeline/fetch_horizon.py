"""Sample NRCan MRDEM-30 (DTM + DSM) over the whole horizon root node.

Output: cache/horizon/{dtm,dsm}.tif at 32 m in the world CRS, covering the root node.
"""
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from .config import CACHE, HORIZON_HALF, ORIGIN_E, ORIGIN_N, WORLD_CRS

SRC = "/vsicurl/https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-{}.tif"
RES = 32.0


def main():
    out = CACHE / "horizon"
    out.mkdir(parents=True, exist_ok=True)
    n = int(2 * HORIZON_HALF / RES)
    transform = from_origin(ORIGIN_E - HORIZON_HALF, ORIGIN_N + HORIZON_HALF, RES, RES)
    for kind in ("dtm", "dsm"):
        dst = np.full((n, n), np.nan, dtype=np.float32)
        with rasterio.open(SRC.format(kind)) as src:
            print(kind, src.crs, src.res, src.nodata, flush=True)
            reproject(
                rasterio.band(src, 1), dst,
                dst_transform=transform, dst_crs=WORLD_CRS, dst_nodata=np.nan,
                resampling=Resampling.bilinear, num_threads=4,
            )
        prof = dict(driver="GTiff", width=n, height=n, count=1, dtype="float32", crs=WORLD_CRS,
                    transform=transform, nodata=np.nan, compress="deflate", tiled=True, predictor=3)
        with rasterio.open(out / f"{kind}.tif", "w", **prof) as f:
            f.write(dst, 1)
        print(kind, "min/max", np.nanmin(dst), np.nanmax(dst), "nan", int(np.isnan(dst).sum()), flush=True)


if __name__ == "__main__":
    main()
