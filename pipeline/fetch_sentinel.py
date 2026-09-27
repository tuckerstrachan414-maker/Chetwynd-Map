"""Mosaic a cloud-free Sentinel-2 L2A acquisition (2025-08-25) into world-CRS grids.

Outputs uint16 surface reflectance (x10000) for bands R, G, B, NIR:
  cache/s2/root.tif  - 32 m over the horizon root node
  cache/s2/near.tif  - 5 m over the NEAR zone
"""
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject

from .config import CACHE, HORIZON_HALF, NEAR, ORIGIN_E, ORIGIN_N, WORLD_CRS

SCENES = ["S2C_10UEG_20250825_0_L2A", "S2C_10UFG_20250825_0_L2A", "S2C_10VEH_20250825_0_L2A", "S2C_10VFH_20250825_0_L2A"]
BANDS = ["B04", "B03", "B02", "B08"]


def href(scene, band):
    _, tile, date, *_ = scene.split("_")
    zone, lat, sq = tile[:2], tile[2], tile[3:]
    return (f"/vsicurl/https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/"
            f"{int(zone)}/{lat}/{sq}/{date[:4]}/{int(date[4:6])}/{scene}/{band}.tif")


def build(name, transform, w, h):
    out = np.zeros((len(BANDS), h, w), dtype=np.float32)
    have = np.zeros((h, w), dtype=bool)
    for scene in SCENES:
        for bi, band in enumerate(BANDS):
            dst = np.zeros((h, w), dtype=np.float32)
            with rasterio.open(href(scene, band)) as src:
                reproject(rasterio.band(src, 1), dst, dst_transform=transform, dst_crs=WORLD_CRS,
                          src_nodata=0, dst_nodata=0, resampling=Resampling.bilinear, num_threads=4)
            m = (dst > 0) & ~have
            out[bi][m] = dst[m]
            if bi == len(BANDS) - 1:
                have |= dst > 0
        print(name, scene, "coverage", round(have.mean(), 4), flush=True)
    prof = dict(driver="GTiff", width=w, height=h, count=len(BANDS), dtype="uint16", crs=WORLD_CRS,
                transform=transform, nodata=0, compress="deflate", tiled=True, predictor=2)
    with rasterio.open(CACHE / "s2" / f"{name}.tif", "w", **prof) as f:
        f.write(np.clip(out, 0, 65535).astype(np.uint16))


def main():
    (CACHE / "s2").mkdir(parents=True, exist_ok=True)
    n = int(2 * HORIZON_HALF / 32)
    build("root", from_origin(ORIGIN_E - HORIZON_HALF, ORIGIN_N + HORIZON_HALF, 32, 32), n, n)
    w = int((NEAR[2] - NEAR[0]) / 5)
    h = int((NEAR[3] - NEAR[1]) / 5)
    build("near", from_origin(NEAR[0], NEAR[3], 5, 5), w, h)


if __name__ == "__main__":
    main()


def winter():
    """Late-March scene with snow on the ground: leafless deciduous stands read bright, conifers dark."""
    global SCENES
    SCENES = ["S2A_10UEG_20250330_1_L2A"]
    w = int((NEAR[2] - NEAR[0]) / 5)
    h = int((NEAR[3] - NEAR[1]) / 5)
    build("near_winter", from_origin(NEAR[0], NEAR[3], 5, 5), w, h)
