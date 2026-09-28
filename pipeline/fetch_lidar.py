"""Download LidarBC DEM/DSM rasters covering the NEAR zone."""
import concurrent.futures as cf
import json
import urllib.request

from .config import CACHE, LIDAR_BASE, NEAR

RAW = CACHE / "lidar" / "raw"


def wanted(o, zone=NEAR):
    if o["prod"] not in ("dem", "dsm", "chm") or "bounds" not in o:
        return False
    b = o["bounds"]
    return b[0] < zone[2] and b[2] > zone[0] and b[1] < zone[3] and b[3] > zone[1]


def download(o):
    dst = RAW / o["year"] / o["prod"] / o["key"].rsplit("/", 1)[1]
    if dst.exists() and dst.stat().st_size == o["size"]:
        return dst, "cached"
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".part")
    with urllib.request.urlopen(LIDAR_BASE + o["key"], timeout=600) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.rename(dst)
    return dst, "ok"


def main():
    idx = json.load(open(CACHE / "lidar" / "index.json"))
    todo = [o for o in idx if wanted(o) and o["prod"] != "chm"]
    print(len(todo), "files", round(sum(o["size"] for o in todo) / 1e9, 2), "GB", flush=True)
    with cf.ThreadPoolExecutor(8) as ex:
        for dst, st in ex.map(download, todo):
            print(st, dst.name, flush=True)


if __name__ == "__main__":
    main()
