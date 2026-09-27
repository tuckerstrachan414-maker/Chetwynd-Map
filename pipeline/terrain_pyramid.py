"""Build the terrain quadtree pyramid (public/world/terrain/L/i_j.bin).

Node (L, i, j) covers engine x in [x0, x0+S], z in [z0, z0+S] with S = NODE_BASE*2^L,
x0 = -H + i*S, z0 = -H + j*S (H = root half size), sampled on a (NODE_RES+1)^2 vertex grid.
Engine x = E - ORIGIN_E, z = ORIGIN_N - N.
Heights come from the finest source available with feathered blending between sources:
LiDAR 1 m -> LiDAR 2 m -> MRDEM 32 m.
"""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from scipy import ndimage

from .codec import encode_height
from .config import CACHE, DETAIL, HORIZON_HALF, NEAR, NODE_BASE, NODE_RES, ORIGIN_E, ORIGIN_N, OUT, ROOT_LEVEL

H = HORIZON_HALF
N1 = NODE_RES + 1


def expand(z, m):
    return (z[0] - m, z[1] - m, z[2] + m, z[3] + m)


LEVEL_COVER = {
    0: DETAIL,
    1: (580000.0, 6166500.0, 594000.0, 6179500.0),
    2: NEAR,
    3: expand(NEAR, 16000),
    4: expand(NEAR, 32000),
}


class Source:
    """A north-up raster with NaN no-data, pre-filtered into power-of-two mips."""

    def __init__(self, path: Path, feather: float, fill_holes=True):
        with rasterio.open(path) as f:
            a = f.read(1).astype(np.float32)
            self.left, self.top, self.res = f.transform.c, f.transform.f, f.transform.a
        valid = ~np.isnan(a)
        if fill_holes and not valid.all():
            # Interior holes (water, no returns): nearest fill then smooth only inside holes.
            idx = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
            filled = a[tuple(idx)]
            sm = ndimage.uniform_filter(filled, 9)
            a = np.where(valid, a, sm)
            # Keep the outer boundary invalid: holes touching the raster edge are "outside".
            lab, _ = ndimage.label(~valid)
            edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
            outside = np.isin(lab, edge[edge > 0])
            a[outside] = np.nan
            valid = ~outside
        self.mips = []
        w = np.clip(ndimage.distance_transform_edt(valid) * self.res / feather, 0, 1).astype(np.float32)
        res = self.res
        while True:
            self.mips.append((res, np.where(valid, a, 0).astype(np.float32), w, valid))
            if min(a.shape) < 64:
                break
            a, w, valid = self._down(a, valid, w)
            res *= 2

    @staticmethod
    def _down(a, valid, w):
        h2, w2 = a.shape[0] // 2, a.shape[1] // 2
        a = a[: h2 * 2, : w2 * 2]
        v = valid[: h2 * 2, : w2 * 2].astype(np.float32)
        s = np.where(valid[: h2 * 2, : w2 * 2], a, 0).reshape(h2, 2, w2, 2).sum((1, 3))
        c = v.reshape(h2, 2, w2, 2).sum((1, 3))
        out = np.where(c > 0, s / np.maximum(c, 1), np.nan)
        wm = w[: h2 * 2, : w2 * 2].reshape(h2, 2, w2, 2).min((1, 3))
        return out, wm, c == 4

    def sample(self, E, N, spacing):
        """Bilinear sample at world coords; returns (height, weight) with weight 0 outside."""
        mip = self.mips[0]
        for m in self.mips:
            if m[0] <= spacing + 1e-6:
                mip = m
        res, a, w, valid = mip
        col = (E - self.left) / res - 0.5
        row = (self.top - N) / res - 0.5
        coords = np.array([row.ravel(), col.ravel()])
        hv = ndimage.map_coordinates(a, coords, order=1, mode="nearest").reshape(E.shape)
        wv = ndimage.map_coordinates(w, coords, order=1, mode="constant", cval=0).reshape(E.shape)
        inside = (col >= -0.5) & (col <= a.shape[1] - 0.5) & (row >= -0.5) & (row <= a.shape[0] - 0.5)
        wv = np.where(inside, wv, 0)
        return hv, wv


def node_box(L, i, j):
    S = NODE_BASE * 2 ** L
    x0, z0 = -H + i * S, -H + j * S
    return x0, z0, S


def node_in(L, i, j, zone):
    x0, z0, S = node_box(L, i, j)
    minE, minN, maxE, maxN = ORIGIN_E + x0, ORIGIN_N - (z0 + S), ORIGIN_E + x0 + S, ORIGIN_N - z0
    return minE < zone[2] and maxE > zone[0] and minN < zone[3] and maxN > zone[1]


def build(dem1="dem1", dem2="dem2", only_levels=None):
    lid = CACHE / "lidar"
    srcs = [
        Source(lid / (f"{dem1}_final.tif" if (lid / f"{dem1}_final.tif").exists() else f"{dem1}.tif"), feather=40),
        Source(lid / (f"{dem2}_final.tif" if (lid / f"{dem2}_final.tif").exists() else f"{dem2}.tif"), feather=300),
        Source(CACHE / "horizon" / "dtm.tif", feather=1, fill_holes=False),
    ]
    print("sources ready", flush=True)
    out = OUT / "terrain"
    manifest = {}
    total = 0
    for L in range(ROOT_LEVEL, -1, -1):
        if only_levels is not None and L not in only_levels:
            continue
        n = 2 ** (ROOT_LEVEL - L)
        zone = LEVEL_COVER.get(L)
        spacing = NODE_BASE * 2 ** L / NODE_RES
        entries = []
        (out / str(L)).mkdir(parents=True, exist_ok=True)
        for j in range(n):
            for i in range(n):
                if zone is not None and not node_in(L, i, j, zone):
                    continue
                x0, z0, S = node_box(L, i, j)
                k = np.arange(N1) * spacing
                X, Z = np.meshgrid(x0 + k, z0 + k)
                E, Nn = ORIGIN_E + X, ORIGIN_N - Z
                # Blend from coarsest to finest.
                h = None
                for s in reversed(srcs):
                    hv, wv = s.sample(E, Nn, spacing)
                    h = hv if h is None else h * (1 - wv) + hv * wv
                data, hmin, hmax = encode_height(h.astype(np.float64), L, i, j, step=0.02 * max(1.0, spacing / 2))
                (out / str(L) / f"{i}_{j}.bin").write_bytes(data)
                total += len(data)
                entries.append([i, j, round(hmin, 2), round(hmax, 2)])
        manifest[str(L)] = entries
        print(f"L{L}: {len(entries)} nodes, spacing {spacing} m, total {total / 1e6:.1f} MB", flush=True)
    (out / "index.json").write_text(json.dumps({
        "nodeRes": NODE_RES, "nodeBase": NODE_BASE, "rootLevel": ROOT_LEVEL, "half": H, "levels": manifest,
    }))


if __name__ == "__main__":
    build()
