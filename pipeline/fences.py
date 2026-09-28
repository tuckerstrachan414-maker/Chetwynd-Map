"""Fences from the LiDAR surface model plus the few mapped in OpenStreetMap.

A fence shows in the 1 m canopy height model (DSM - DTM) as a line of cells 0.7-2.6 m high, one or
two cells wide, with ground on both sides and nothing tall above it. Detection:
  1. raised = CHM in 0.7..2.6 m; thin = raised minus its 3x3 opening (drops blobs: cars, sheds,
     shrubs); ground (CHM < 0.4) on two opposite sides; not buildings, not under trees;
  2. skeletonise, keep components >= 10 m whose extent is at least 55 % of their length (straight
     or gently bent runs, not tangles);
  3. trace each component into polylines, simplify (0.6 m), and join runs that continue each other
     across small gaps (gates, missing returns);
  4. height = median CHM along the run; type by height and return density: privacy (wood boards,
     >= 1.45 m), chain-link, or rail (< 1.1 m).
OSM barrier=fence ways are added (height from tags or 1.5 m).

Output: public/world/props/fences.json {"fences": [{"p": [[x, y, z], ...], "h": m, "t": type, "src": "lidar"|"osm"}]}
"""
import json
import math

import numpy as np
import rasterio
from scipy import ndimage
from shapely.geometry import LineString
from skimage.morphology import skeletonize

from . import osm
from .config import CACHE, ORIGIN_E, ORIGIN_N, OUT
from .grid import Grid, load_pc_stats

TILE = 1000
PAD = 24


def detect_tile(chm, hi, bld):
    raised = (chm > 0.7) & (chm < 2.6)
    thin = raised & ~ndimage.binary_opening(raised, structure=np.ones((3, 3)))
    low = chm < 0.4

    def sh(a, dy, dx):
        return np.roll(np.roll(a, dy, 0), dx, 1)

    across = ((sh(low, 0, 1) & sh(low, 0, -1)) | (sh(low, 1, 0) & sh(low, -1, 0))
              | (sh(low, 1, 1) & sh(low, -1, -1)) | (sh(low, 1, -1) & sh(low, -1, 1)))
    cand = thin & across & ~bld & (hi <= 2)
    sk = skeletonize(ndimage.binary_closing(cand, structure=np.ones((3, 3))))
    lab, n = ndimage.label(sk, structure=np.ones((3, 3)))
    keep = np.zeros_like(sk)
    for i, s in enumerate(ndimage.find_objects(lab)):
        if s is None:
            continue
        comp = lab[s] == i + 1
        npx = int(comp.sum())
        if npx < 10:
            continue
        ys, xs = np.nonzero(comp)
        if math.hypot(ys.max() - ys.min(), xs.max() - xs.min()) < 0.55 * npx:
            continue
        keep[s] |= comp
    return keep


NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def trace(mask):
    """Skeleton pixels -> list of pixel paths (split at junctions)."""
    pts = set(zip(*np.nonzero(mask)))
    deg = {p: sum((p[0] + dy, p[1] + dx) in pts for dy, dx in NB) for p in pts}
    seen = set()
    paths = []
    starts = [p for p in pts if deg[p] != 2] + list(pts)
    for s in starts:
        if s in seen:
            continue
        path = [s]
        seen.add(s)
        cur = s
        while True:
            nxt = [(cur[0] + dy, cur[1] + dx) for dy, dx in NB if (cur[0] + dy, cur[1] + dx) in pts and (cur[0] + dy, cur[1] + dx) not in seen]
            if not nxt:
                break
            # Prefer 4-neighbours so diagonal shortcuts do not split runs.
            nxt.sort(key=lambda q: abs(q[0] - cur[0]) + abs(q[1] - cur[1]))
            cur = nxt[0]
            seen.add(cur)
            path.append(cur)
            if deg[cur] > 2:
                break
        if len(path) >= 6:
            paths.append(path)
    return paths


def join(lines, gap=3.5, angle=0.45):
    """Merge runs whose ends meet (within `gap` m) heading the same way (greedy, KD-tree on ends)."""
    from scipy.spatial import cKDTree

    runs = [list(ln.coords) for ln in lines]
    alive = [True] * len(runs)
    changed = True
    while changed:
        changed = False
        ends, owner = [], []
        for i, r in enumerate(runs):
            if alive[i]:
                ends += [r[0], r[-1]]
                owner += [(i, 0), (i, 1)]
        if len(ends) < 2:
            break
        tree = cKDTree(np.array(ends))
        used = set()
        for a, b in sorted(tree.query_pairs(gap), key=lambda ab: np.linalg.norm(np.subtract(ends[ab[0]], ends[ab[1]]))):
            (i, ei), (j, ej) = owner[a], owner[b]
            if i == j or i in used or j in used or not alive[i] or not alive[j]:
                continue
            ra = runs[i] if ei == 1 else runs[i][::-1]  # ra ends at the joint
            rb = runs[j] if ej == 0 else runs[j][::-1]  # rb starts at the joint
            da = np.subtract(ra[-1], ra[-2])
            db = np.subtract(rb[1], rb[0])
            c = np.dot(da, db) / (np.linalg.norm(da) * np.linalg.norm(db) + 1e-9)
            if c < math.cos(angle):
                continue
            runs[i] = ra + rb
            alive[j] = False
            used.update((i, j))
            changed = True
    return [LineString(r) for r, ok in zip(runs, alive) if ok and len(r) >= 2]


def main():
    g = Grid()
    pc = load_pc_stats(g)
    aux = np.load(CACHE / "lidar" / "aux.npz")
    chm = np.clip(np.nan_to_num(aux["chm"]), -1, 60).astype(np.float32)
    masks = np.load(CACHE / "ground" / "masks.npz")
    bld = ndimage.binary_dilation(masks["bld_vec"], iterations=2)
    hi = pc["hi_cnt"]
    lo = np.load(CACHE / "lidar" / "pc_stats.npz")["lo_cnt"]
    H, W = chm.shape
    keep = np.zeros((H, W), dtype=bool)
    for r0 in range(0, H, TILE):
        for c0 in range(0, W, TILE):
            rs = slice(max(0, r0 - PAD), min(H, r0 + TILE + PAD))
            cs = slice(max(0, c0 - PAD), min(W, c0 + TILE + PAD))
            k = detect_tile(chm[rs, cs], hi[rs, cs], bld[rs, cs])
            ir = slice(r0 - rs.start, r0 - rs.start + min(TILE, H - r0))
            ic = slice(c0 - cs.start, c0 - cs.start + min(TILE, W - c0))
            keep[r0:r0 + TILE, c0:c0 + TILE] = k[ir, ic]
    print("fence pixels", int(keep.sum()), flush=True)
    t = g.transform
    lines = []
    lab, n = ndimage.label(keep, structure=np.ones((3, 3)))
    for i, s in enumerate(ndimage.find_objects(lab)):
        comp = lab[s] == i + 1
        for path in trace(comp):
            ys = np.array([p[0] for p in path]) + s[0].start + 0.5
            xs = np.array([p[1] for p in path]) + s[1].start + 0.5
            E = t.c + xs * t.a
            N = t.f + ys * t.e
            ln = LineString(np.c_[E, N]).simplify(0.6)
            if ln.length >= 6:
                lines.append(ln)
    lines = join(lines)
    # Keep confident runs: yards, compounds and lots near buildings (isolated short lines in the
    # bush are logs, debris or slope artefacts).
    near_bld = ndimage.distance_transform_edt(~masks["bld_vec"]) <= 60
    lines = [ln for ln in lines if ln.length >= 12 and near_bld[
        int(np.clip((ln.centroid.y - t.f) / t.e, 0, H - 1)), int(np.clip((ln.centroid.x - t.c) / t.a, 0, W - 1))]]
    print("lidar fence runs", len(lines), "km", round(sum(ln.length for ln in lines) / 1000, 2), flush=True)

    dem_path = CACHE / "lidar" / ("dem1_final.tif" if (CACHE / "lidar" / "dem1_final.tif").exists() else "dem1.tif")
    with rasterio.open(dem_path) as f:
        dem = f.read(1)

    def sample(arr, E, N):
        r = np.clip(((np.asarray(N) - t.f) / t.e).astype(int), 0, H - 1)
        c = np.clip(((np.asarray(E) - t.c) / t.a).astype(int), 0, W - 1)
        return arr[r, c]

    out = []
    for ln in lines:
        d = np.linspace(0, ln.length, max(3, int(ln.length / 1.0)))
        pts = np.array([ln.interpolate(v).coords[0] for v in d])
        h = float(np.nanmedian(sample(chm, pts[:, 0], pts[:, 1])))
        dens = float(np.mean(sample(lo, pts[:, 0], pts[:, 1])))
        kind = "privacy" if h >= 1.45 and dens >= 2 else "rail" if h < 1.1 else "chainlink"
        if kind == "rail" and ln.length < 20:
            continue
        out.append(fence_rec(ln, dem, sample, min(max(h, 0.9), 2.2), kind, "lidar"))
    # Mapped fences.
    for f in osm.load():
        if f.tags.get("barrier") != "fence" or f.geom.geom_type != "LineString":
            continue
        try:
            h = float(str(f.tags.get("height", "1.5")).split()[0])
        except ValueError:
            h = 1.5
        ft = f.tags.get("fence_type", "")
        kind = "chainlink" if ft in ("chain_link", "metal", "mesh") else "rail" if ft in ("split_rail", "rail", "wood_rail") else "privacy" if ft in ("wood", "board", "panel") else "chainlink"
        out.append(fence_rec(f.geom, dem, sample, h, kind, "osm"))
    (OUT / "props").mkdir(parents=True, exist_ok=True)
    (OUT / "props" / "fences.json").write_text(json.dumps({"fences": out}, separators=(",", ":")))
    print("fences", len(out), {k: sum(1 for o in out if o["t"] == k) for k in ("privacy", "chainlink", "rail")})


def fence_rec(ln, dem, sample, h, kind, src):
    c = np.array(ln.coords)
    y = sample(dem, c[:, 0], c[:, 1])
    pts = [[round(float(e - ORIGIN_E), 2), round(float(yy), 2), round(float(ORIGIN_N - n), 2)] for (e, n), yy in zip(c, y)]
    return {"p": pts, "h": round(h, 2), "t": kind, "src": src}


if __name__ == "__main__":
    main()
