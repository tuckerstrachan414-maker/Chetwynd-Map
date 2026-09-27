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


def vegetation():
    """Pack LiDAR trees and shrubs per chunk: public/world/veg/i_j.bin (gzip).

    Layout: magic 'CWV1', nTrees u32, nShrubs u32, yMin f32, then records of 10 bytes:
    x u16 (cm in chunk), z u16 (cm), y u16 (cm above yMin), h u8 (0.25 m), r u8 (0.1 m), species u8, seed u8.
    """
    import struct

    d = np.load(CACHE / "trees" / "trees.npz")
    out = OUT / "veg"
    out.mkdir(parents=True, exist_ok=True)
    groups = defaultdict(lambda: {"t": [], "s": []})
    for kind in ("t", "s"):
        E, N = d[f"{kind}_E"], d[f"{kind}_N"]
        x = E - ORIGIN_E
        z = ORIGIN_N - N
        ci = np.floor((x + H) / NODE_BASE).astype(int)
        cj = np.floor((z + H) / NODE_BASE).astype(int)
        order = np.lexsort((cj, ci))
        keys = np.stack([ci[order], cj[order]], 1)
        splits = np.flatnonzero(np.any(np.diff(keys, axis=0) != 0, axis=1)) + 1
        for part in np.split(order, splits):
            if part.size:
                groups[(int(ci[part[0]]), int(cj[part[0]]))][kind].append(part)
    index = []
    total = 0
    for (i, j), g in groups.items():
        x0 = -H + i * NODE_BASE
        z0 = -H + j * NODE_BASE
        recs = []
        ymins = []
        for kind in ("t", "s"):
            if g[kind]:
                idx = np.concatenate(g[kind])
                ymins.append(np.nanmin(d[f"{kind}_base"][idx]))
        ymin = float(np.floor(min(ymins))) if ymins else 0.0
        counts = []
        for kind in ("t", "s"):
            if not g[kind]:
                counts.append(0)
                continue
            idx = np.concatenate(g[kind])
            x = d[f"{kind}_E"][idx] - ORIGIN_E - x0
            z = ORIGIN_N - d[f"{kind}_N"][idx] - z0
            base = np.nan_to_num(d[f"{kind}_base"][idx], nan=ymin)
            rec = np.zeros(idx.size, dtype=[("x", "<u2"), ("z", "<u2"), ("y", "<u2"), ("h", "u1"), ("r", "u1"), ("sp", "u1"), ("seed", "u1")])
            rec["x"] = np.clip(np.round(x * 100), 0, 65535)
            rec["z"] = np.clip(np.round(z * 100), 0, 65535)
            rec["y"] = np.clip(np.round((base - ymin) * 100), 0, 65535)
            rec["h"] = np.clip(np.round(d[f"{kind}_h"][idx] * 4), 1, 255)
            rec["r"] = np.clip(np.round(d[f"{kind}_r"][idx] * 10), 1, 255)
            rec["sp"] = d[f"{kind}_sp"][idx]
            rec["seed"] = d[f"{kind}_seed"][idx]
            recs.append(rec.tobytes())
            counts.append(idx.size)
        payload = b"CWV1" + struct.pack("<IIf", counts[0], counts[1], ymin) + b"".join(recs)
        data = gzip.compress(payload, 6)
        (out / f"{i}_{j}.bin").write_bytes(data)
        total += len(data)
        index.append([i, j, counts[0], counts[1]])
    (out / "index.json").write_text(json.dumps({"size": NODE_BASE, "half": H, "chunks": index}))
    print("veg chunks", len(index), "MB", round(total / 1e6, 1))


if __name__ == "__main__" and False:
    pass
