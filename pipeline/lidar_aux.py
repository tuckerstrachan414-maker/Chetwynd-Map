"""Auxiliary 1 m rasters on the LiDAR grid: canopy height (DSM - DTM) and Sentinel-2 NDVI.

Output: cache/lidar/aux.npz with chm and ndvi (float32, dem1.tif grid).
"""
import numpy as np
import rasterio

from .config import CACHE
from .grid import Grid


def main():
    g = Grid()
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
        dem = f.read(1)
    with rasterio.open(CACHE / "lidar" / "dsm1.tif") as f:
        dsm = f.read(1)
    chm = np.nan_to_num(dsm - dem)
    red = g.warp(CACHE / "s2" / "near.tif", 1)
    nir = g.warp(CACHE / "s2" / "near.tif", 4)
    ndvi = (nir - red) / (nir + red + 1e-6)
    np.savez_compressed(CACHE / "lidar" / "aux.npz", ndvi=ndvi.astype(np.float32), chm=chm.astype(np.float32))
    print("aux.npz", chm.shape)


if __name__ == "__main__":
    main()
