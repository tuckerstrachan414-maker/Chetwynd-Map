"""Rebuild the whole world from the open sources, in dependency order.

    python -m pipeline.run_all            # everything (downloads ~60 GB of LiDAR point clouds)
    python -m pipeline.run_all roads props  # just these stages (inputs must already be cached)

Stages write to pipeline/cache/ (inputs, intermediates) and public/world/ (runtime data).
Texture atlases and KTX2 encoding are separate: see assets-src/ and README.md.
"""
import importlib
import sys
import time
import urllib.request

from .config import CACHE

CARVING_MAP = "https://www.gochetwynd.com/wp-content/uploads/2019/02/Chainsaw-Carving-Tour-Map.pdf"


def fetch_carving_map():
    dst = CACHE / "carvings" / "tour.pdf"
    if dst.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(CARVING_MAP, headers={"User-Agent": "Mozilla/5.0 chetwynd-map"})
    dst.write_bytes(urllib.request.urlopen(req, timeout=120).read())


def call(module, fn="main", *args):
    def run():
        getattr(importlib.import_module(f"pipeline.{module}"), fn)(*args)
    return run


STAGES = [
    ("osm", call("fetch_osm")),
    ("overture", call("fetch_overture")),
    ("sentinel", call("fetch_sentinel")),
    ("horizon", call("fetch_horizon")),
    ("lidar_index", call("lidar_index")),
    ("lidar", call("fetch_lidar")),
    ("mosaic", call("lidar_mosaic")),
    ("pointcloud", call("pointcloud_rasters")),
    ("aux", call("lidar_aux")),
    ("ground", lambda: _ground()),
    ("buildings", call("buildings")),
    ("chunks", call("chunks")),
    ("trees", call("trees")),
    ("veg", call("chunks", "vegetation")),
    ("water", call("water")),  # carves channels: writes dem*_final.tif and horizon dtm_final.tif
    ("terrain", call("terrain_pyramid", "build")),
    ("imagery", call("imagery")),
    ("roads", call("roads")),
    ("props", call("props")),
    ("fences", call("fences")),
    ("carvings", lambda: (fetch_carving_map(), call("carvings")())),
    ("textures", call("fetch_textures")),
]


def _ground():
    g = importlib.import_module("pipeline.ground")
    grid, m = g.classify()
    g.debug_png(m)
    g.export_tiles(grid, m)


def main(names):
    todo = [s for s in STAGES if not names or s[0] in names]
    unknown = set(names) - {s[0] for s in STAGES}
    if unknown:
        sys.exit(f"unknown stage(s): {', '.join(sorted(unknown))}; stages: {', '.join(s[0] for s in STAGES)}")
    for name, fn in todo:
        t0 = time.time()
        print(f"== {name}", flush=True)
        fn()
        print(f"== {name} done in {time.time() - t0:.0f} s", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
