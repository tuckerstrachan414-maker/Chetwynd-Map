"""Pack per-256 m chunk feature files (public/world/chunks/i_j.bin, gzipped JSON) for runtime streaming.

Chunk (i, j) is the level-0 terrain node footprint: x in [-H + 256 i, ...), z likewise.
All coordinates are engine space (x = E - ORIGIN_E, z = ORIGIN_N - N, y = elevation).
"""
import gzip
import json
import math
from collections import defaultdict

import numpy as np
import rasterio

from .config import CACHE, HORIZON_HALF, NODE_BASE, ORIGIN_E, ORIGIN_N, OUT

H = HORIZON_HALF
DEFAULT_EAVE = {"house": 3.0, "mobile": 2.9, "garage": 2.6, "shed": 2.3, "carport": 2.4, "commercial": 5.0,
                "industrial": 7.0, "civic": 6.0, "church": 6.0, "apartments": 9.0}


def to_engine(e, n):
    return round(e - ORIGIN_E, 2), round(ORIGIN_N - n, 2)


def chunk_of(x, z):
    return int(math.floor((x + H) / NODE_BASE)), int(math.floor((z + H) / NODE_BASE))


class DemSampler:
    def __init__(self):
        self.srcs = []
        for name in ("dem1", "dem2"):
            f = rasterio.open(CACHE / "lidar" / f"{name}.tif")
            self.srcs.append((f, f.read(1)))

    def __call__(self, e, n):
        for f, a in self.srcs:
            r, c = f.index(e, n)
            if 0 <= r < a.shape[0] and 0 <= c < a.shape[1] and not np.isnan(a[r, c]):
                return float(a[r, c])
        return None


def buildings(chunks):
    data = json.load(open(CACHE / "buildings" / "buildings.json"))
    dem = DemSampler()
    for b in data:
        poly = [to_engine(*p) for p in b["poly"]]
        holes = [[to_engine(*p) for p in h] for h in b["holes"]]
        fit = b["fit"]
        cls = b["cls"]
        if fit is None:
            vals = [dem(*p) for p in b["poly"]]
            vals = [v for v in vals if v is not None]
            if not vals:
                continue
            base = float(np.percentile(vals, 20))
            fit = {"base": base, "baseMin": min(vals), "eave": DEFAULT_EAVE.get(cls, 3.0),
                   "height": DEFAULT_EAVE.get(cls, 3.0) + (2.0 if cls in ("house", "mobile", "garage") else 0.5),
                   "roof": {"type": "gabled", "pitch": 22, "ridgeAz": None} if cls in ("house", "garage", "shed") else {"type": "flat"},
                   "roofInt": 1.0}
        cx = sum(p[0] for p in poly) / len(poly)
        cz = sum(p[1] for p in poly) / len(poly)
        rec = {
            "id": b["id"], "cls": cls, "seed": b["seed"], "poly": poly, "base": round(fit["base"], 2),
            "baseMin": round(fit["baseMin"], 2), "eave": round(fit["eave"], 2), "top": round(fit["height"], 2),
            "roof": fit["roof"], "ri": fit.get("roofInt", 1.0), "src": b["src"],
        }
        if holes:
            rec["holes"] = holes
        if b.get("name"):
            rec["name"] = b["name"]
        if b.get("levels"):
            rec["levels"] = b["levels"]
        chunks[chunk_of(cx, cz)]["buildings"].append(rec)


def main():
    chunks = defaultdict(lambda: defaultdict(list))
    buildings(chunks)
    out = OUT / "chunks"
    out.mkdir(parents=True, exist_ok=True)
    index = []
    total = 0
    for (i, j), content in chunks.items():
        payload = json.dumps(content, separators=(",", ":")).encode()
        data = gzip.compress(payload, 9)
        (out / f"{i}_{j}.bin").write_bytes(data)
        total += len(data)
        index.append([i, j, {k: len(v) for k, v in content.items()}])
    (out / "index.json").write_text(json.dumps({"size": NODE_BASE, "half": H, "chunks": index}))
    print("chunks", len(index), "bytes", total)


if __name__ == "__main__":
    main()
