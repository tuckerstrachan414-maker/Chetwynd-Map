"""Index the LidarBC holdings for NTS map sheets 093P.062/063/072/073 (Chetwynd).

Lists the public object store (2024 and 2025 acquisitions) for DEM, DSM, CHM rasters and LAZ point
clouds, reads each raster's bounds and grid over HTTP range requests, and each LAZ header for its
extent and point count.

Outputs: cache/lidar/index.json (rasters and point clouds), cache/lidar/pc_index.json (LAZ headers).
"""
import concurrent.futures as cf
import io
import json
import re
import urllib.request

from .config import CACHE, LIDAR_BASE

SHEETS = r"bc_093p0(62|63|72|73)"
YEARS = ("2024", "2025")
PRODUCTS = ("dem", "dsm", "chm", "pointcloud")


def list_keys(prefix):
    keys, marker = [], ""
    while True:
        u = f"{LIDAR_BASE}?prefix={prefix}&max-keys=1000&marker={marker}"
        x = urllib.request.urlopen(u, timeout=120).read().decode()
        ks = re.findall(r"<Key>([^<]*)</Key>", x)
        sz = re.findall(r"<Size>([^<]*)</Size>", x)
        keys += list(zip(ks, map(int, sz)))
        if "<IsTruncated>true" in x:
            marker = ks[-1]
        else:
            return keys


def raster_info(job):
    import rasterio

    yr, prod, key, size = job
    if prod == "pointcloud":
        return dict(year=yr, prod=prod, key=key, size=size)
    try:
        with rasterio.open("/vsicurl/" + LIDAR_BASE + key) as ds:
            b = ds.bounds
            return dict(year=yr, prod=prod, key=key, size=size, bounds=[b.left, b.bottom, b.right, b.top],
                        crs=str(ds.crs.to_epsg()), shape=[ds.width, ds.height], block=ds.block_shapes[0], nodata=ds.nodata)
    except Exception as e:  # noqa: BLE001 - keep going; the entry records the failure
        return dict(year=yr, prod=prod, key=key, size=size, err=str(e))


def laz_header(o):
    import laspy

    req = urllib.request.Request(LIDAR_BASE + o["key"], headers={"Range": "bytes=0-65535"})
    b = urllib.request.urlopen(req, timeout=60).read()
    h = laspy.LasHeader.read_from(io.BytesIO(b))
    return o["key"].rsplit("/", 1)[1], o["year"], o["size"], (h.mins[0], h.mins[1], h.maxs[0], h.maxs[1]), h.point_count, h.point_format.id


def main():
    jobs = []
    for yr in YEARS:
        for prod in PRODUCTS:
            for k, s in list_keys(f"093/093p/{yr}/{prod}/"):
                if re.search(SHEETS, k):
                    jobs.append((yr, prod, k, s))
    print(len(jobs), "files", flush=True)
    with cf.ThreadPoolExecutor(16) as ex:
        out = list(ex.map(raster_info, jobs))
    (CACHE / "lidar").mkdir(parents=True, exist_ok=True)
    json.dump(out, open(CACHE / "lidar" / "index.json", "w"), indent=1)
    pcs = [o for o in out if o["prod"] == "pointcloud"]
    with cf.ThreadPoolExecutor(16) as ex:
        res = list(ex.map(laz_header, pcs))
    json.dump(res, open(CACHE / "lidar" / "pc_index.json", "w"))
    print("rasters", len(out) - len(pcs), "point clouds", len(res))


if __name__ == "__main__":
    main()
