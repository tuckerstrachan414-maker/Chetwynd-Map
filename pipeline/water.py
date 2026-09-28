"""Water: the Pine and Sukunka rivers, creeks, ditches, ponds and lagoons.

1. Rivers. The OSM river line gives an along-channel coordinate s. The water surface h(s) is a
   monotone (never rising downstream) fit to hydro-flattened LiDAR ground where Sentinel-2 NDWI or
   LiDAR no-return holes say there is water. The wetted area is wherever the LiDAR ground lies at
   or below that surface inside the river corridor, so shorelines follow the real banks.
2. Ponds. OSM water polygons, LiDAR no-return flats and Sentinel-2 water, kept only with LiDAR or
   spectral evidence. The level is the hydro-flattened surface, or the bank ring when the DEM has a hole.
3. Creeks and ditches. OSM waterway lines are snapped to the LiDAR thalweg (least-cost path inside a
   corridor around the mapped line). The surface is the running minimum of the bed downstream, and
   stretches where the ground rises above it (culverts, road fills) stay dry.
4. Terrain. Beds are carved below the surface, deepening away from the shore, and written to
   cache/lidar/dem{1,2}_final.tif and cache/horizon/dtm_final.tif for terrain_pyramid.
5. Meshes. Per 256 m chunk, constrained-Delaunay water polygons dilated under the banks plus creek
   ribbons, with per-vertex flow velocity, turbulence and water kind, go to public/world/water/i_j.bin.
   A coarse whole-valley mesh goes to far.bin for distant views.

Chunk layout (gzip): magic 'CWW1', nGroups u32, then per group:
  flags u8 (bit0 seasonal: spring only), pad[3], nVerts u32, nIdx u32,
  pos f32[3n] (engine x, y, z), flow f32[2n] (engine m/s along x, z), attr f32[2n] (turbulence 0..1, kind),
  idx u32[m]
"""
import gzip
import json
import math
import struct
from collections import defaultdict

import numpy as np
import rasterio
from rasterio import features
from rasterio.warp import Resampling, reproject
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box, shape
from shapely.ops import linemerge, unary_union

from . import osm
from .config import CACHE, HORIZON_HALF, NODE_BASE, ORIGIN_E, ORIGIN_N, OUT
from .roads import width_of

WCACHE = CACHE / "water"
H = HORIZON_HALF
RIVER, POND, LAGOON, CREEK, DITCH = 0, 1, 2, 3, 4
MAIN_RIVERS = ("Pine River", "Sukunka River")
FAR_RADIUS = 45000.0


# ----------------------------------------------------------------------------------------------
# Rasters
# ----------------------------------------------------------------------------------------------
class Raster:
    """A north-up float raster (NaN no-data) with pixel-centre coordinate helpers."""

    def __init__(self, path):
        with rasterio.open(path) as f:
            self.a = f.read(1).astype(np.float32)
            self.profile = f.profile
            self.t = f.transform
            self.crs = f.crs
        self.res = float(self.t.a)
        self.left, self.top = float(self.t.c), float(self.t.f)
        self.shape = self.a.shape
        self.right = self.left + self.shape[1] * self.res
        self.bottom = self.top - self.shape[0] * self.res
        self.nan = np.isnan(self.a)
        if self.nan.any():
            idx = ndimage.distance_transform_edt(self.nan, return_distances=False, return_indices=True)
            self.filled = self.a[idx[0], idx[1]]
            del idx
        else:
            self.filled = self.a.copy()

    def en(self, r, c):
        return self.left + (np.asarray(c) + 0.5) * self.res, self.top - (np.asarray(r) + 0.5) * self.res

    def rc(self, E, N):
        return (self.top - np.asarray(N)) / self.res - 0.5, (np.asarray(E) - self.left) / self.res - 0.5

    def sample(self, arr, E, N, order=1):
        r, c = self.rc(E, N)
        return ndimage.map_coordinates(arr, [np.atleast_1d(r), np.atleast_1d(c)], order=order, mode="nearest")

    def rasterize(self, shapes, all_touched=False, dtype="uint8", fill=0):
        shapes = [(g, v) for g, v in shapes if g is not None and not g.is_empty]
        if not shapes:
            return np.full(self.shape, fill, dtype=dtype)
        return features.rasterize(shapes, out_shape=self.shape, transform=self.t, fill=fill, dtype=dtype,
                                  all_touched=all_touched)

    def inside(self, geom_bounds, margin=0.0):
        minE, minN, maxE, maxN = geom_bounds
        return (minE - margin >= self.left and maxE + margin <= self.right and minN - margin >= self.bottom
                and maxN + margin <= self.top)

    def flat(self, win=5, std_max=0.04, slope_max=0.6):
        """Hydro-flattened surfaces: near-zero local relief and slope."""
        a = self.filled.astype(np.float64)
        m = ndimage.uniform_filter(a, win)
        m2 = ndimage.uniform_filter(a * a, win)
        std = np.sqrt(np.maximum(m2 - m * m, 0))
        gy, gx = np.gradient(a, self.res)
        slope = np.degrees(np.arctan(np.hypot(gx, gy)))
        return (std < std_max) & (slope < slope_max) & ~self.nan

    def write(self, path, arr):
        prof = dict(self.profile)
        prof.update(dtype="float32", nodata=np.nan, compress="deflate", tiled=True, predictor=3)
        with rasterio.open(path, "w", **prof) as f:
            f.write(arr.astype(np.float32), 1)


def warp_to(src_arr, src_t, crs, dst: Raster, resampling=Resampling.bilinear):
    out = np.full(dst.shape, np.nan, np.float32)
    reproject(src_arr, out, src_transform=src_t, src_crs=crs, dst_transform=dst.t, dst_crs=crs,
              dst_nodata=np.nan, resampling=resampling)
    return out


def ndwi_on(g: Raster):
    with rasterio.open(CACHE / "s2" / "near.tif") as f:
        s2 = f.read().astype(np.float32)
        t, crs = f.transform, f.crs
    green, nir = s2[1], s2[3]
    nd = (green - nir) / np.maximum(green + nir, 1)
    return warp_to(nd, t, crs, g)


def sparse_returns(g1: Raster):
    """1 m cells with almost no first returns: open water absorbs the laser."""
    return np.load(CACHE / "lidar" / "pc_stats.npz")["f_cnt"] < 3


def to_grid(mask1, g1: Raster, g: Raster):
    if g.res == g1.res and g.left == g1.left and g.top == g1.top:
        return mask1
    f = warp_to(mask1.astype(np.float32), g1.t, g1.crs, g, Resampling.average)
    return np.nan_to_num(f) > 0.5


def outside_holes(nan):
    """NaN regions touching the raster edge are outside the survey, not water."""
    lab, _ = ndimage.label(nan)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    return np.isin(lab, edge[edge > 0])


def pava_decreasing(y, w):
    """Weighted isotonic regression constrained to be non-increasing."""
    yy = -np.asarray(y, np.float64)
    ww = np.asarray(w, np.float64)
    vals, wts, cnt = [], [], []
    for v, wt in zip(yy, ww):
        vals.append(v)
        wts.append(wt)
        cnt.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            v2, w2, c2 = vals.pop(), wts.pop(), cnt.pop()
            wsum = wts[-1] + w2
            vals[-1] = (vals[-1] * wts[-1] + v2 * w2) / wsum if wsum > 0 else (vals[-1] + v2) / 2
            wts[-1] = wsum
            cnt[-1] += c2
    return -np.repeat(vals, cnt)


# ----------------------------------------------------------------------------------------------
# Rivers
# ----------------------------------------------------------------------------------------------
class RiverLine:
    def __init__(self, name, line: LineString, horizon: Raster):
        self.name = name
        # OSM waterways are drawn downstream; verify against the terrain anyway.
        n = len(line.coords)
        a = horizon.sample(horizon.filled, *np.array(line.coords[: max(2, n // 20)]).T).mean()
        b = horizon.sample(horizon.filled, *np.array(line.coords[-max(2, n // 20):]).T).mean()
        if a < b:
            line = LineString(line.coords[::-1])
        self.line = line
        step = 2.0
        self.s = np.arange(0.0, line.length, step)
        pts = np.array([line.interpolate(v).coords[0] for v in self.s])
        self.pts = pts
        d = np.gradient(pts, axis=0)
        d /= np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
        self.tan = ndimage.gaussian_filter1d(d, 10, axis=0)
        self.tan /= np.maximum(np.linalg.norm(self.tan, axis=1, keepdims=True), 1e-9)
        self.tree = cKDTree(pts)
        self.prof_s = None
        self.prof_h = None

    def locate(self, E, N):
        d, k = self.tree.query(np.column_stack([E, N]), workers=4)
        return self.s[k], d, k

    def level(self, s):
        return np.interp(s, self.prof_s, self.prof_h)

    def slope(self, s):
        g = -np.gradient(self.prof_h, self.prof_s)
        return np.interp(s, self.prof_s, ndimage.gaussian_filter1d(g, 3))


def river_lines(feats, horizon):
    lines = []
    for f in feats:
        if f.tags.get("waterway") != "river" or f.tags.get("name") not in MAIN_RIVERS:
            continue
        g = f.geom
        if isinstance(g, MultiLineString):
            g = linemerge(g)
        if isinstance(g, MultiLineString):
            g = max(g.geoms, key=lambda x: x.length)
        lines.append(RiverLine(f.tags["name"], g, horizon))
    return lines


def river_polys(feats):
    out = []
    for f in feats:
        t = f.tags
        if not isinstance(f.geom, (Polygon, MultiPolygon)):
            continue
        if t.get("water") == "river" or t.get("waterway") == "riverbank" or t.get("name") in MAIN_RIVERS:
            out.append(f.geom)
    return out


def river_profiles(rivers, g2: Raster, horizon: Raster, ndwi2, lw2, flat2, rpolys):
    """Fit h(s) per river from LiDAR water (NEAR) and MRDEM valley floors (beyond)."""
    corridor = g2.rasterize([(unary_union([r.line.buffer(120) for r in rivers] + [p.buffer(20) for p in rpolys]), 1)]).astype(bool)
    rr, cc = np.nonzero(corridor)
    E, N = g2.en(rr, cc)
    best = np.full(len(rr), np.inf)
    owner = np.full(len(rr), -1)
    svals = np.zeros(len(rr))
    for i, r in enumerate(rivers):
        s, d, _ = r.locate(E, N)
        m = d < best
        best[m], owner[m], svals[m] = d[m], i, s[m]
    obs = ((ndwi2[rr, cc] > 0.02) | g2.nan[rr, cc] | lw2[rr, cc]) & (best < 100)
    hmin = ndimage.minimum_filter(np.where(horizon.nan, 1e4, horizon.a), size=3)
    for i, r in enumerate(rivers):
        bins = np.arange(0.0, r.line.length + 20.0, 20.0)
        sel = (owner == i) & obs & flat2[rr, cc]
        z = g2.a[rr[sel], cc[sel]]
        k = np.clip(np.searchsorted(bins, svals[sel]) - 1, 0, len(bins) - 2)
        med = np.full(len(bins) - 1, np.nan)
        cnt = np.bincount(k, minlength=len(bins) - 1).astype(float)
        order = np.argsort(k, kind="stable")
        ks, zs = k[order], z[order]
        starts = np.searchsorted(ks, np.arange(len(bins) - 1))
        ends = np.searchsorted(ks, np.arange(len(bins) - 1), side="right")
        for b in np.nonzero(cnt >= 6)[0]:
            med[b] = np.median(zs[starts[b]:ends[b]])
        # NaN-hole stretches: the low end of the observed water that still has ground returns.
        sel2 = (owner == i) & obs & ~g2.nan[rr, cc]
        k2 = np.clip(np.searchsorted(bins, svals[sel2]) - 1, 0, len(bins) - 2)
        z2 = g2.a[rr[sel2], cc[sel2]]
        lo = np.full(len(bins) - 1, np.nan)
        o2 = np.argsort(k2, kind="stable")
        k2s, z2s = k2[o2], z2[o2]
        st2 = np.searchsorted(k2s, np.arange(len(bins) - 1))
        en2 = np.searchsorted(k2s, np.arange(len(bins) - 1), side="right")
        for b in np.nonzero((cnt < 6) & (en2 - st2 >= 6))[0]:
            lo[b] = np.percentile(z2s[st2[b]:en2[b]], 5)
        mid = 0.5 * (bins[:-1] + bins[1:])
        # Beyond the LiDAR: MRDEM valley floor along the line (lowest cell within ~50 m).
        pts = np.array([r.line.interpolate(v).coords[0] for v in mid])
        far = horizon.sample(hmin, pts[:, 0], pts[:, 1], order=1)
        inside = (pts[:, 0] > g2.left + 100) & (pts[:, 0] < g2.right - 100) & (pts[:, 1] > g2.bottom + 100) & (pts[:, 1] < g2.top - 100)
        y = np.where(~np.isnan(med), med, np.where(~np.isnan(lo), lo, np.nan))
        w = np.where(~np.isnan(med), np.minimum(cnt, 40), np.where(~np.isnan(lo), 3, 0)).astype(float)
        # Far bins: use MRDEM, weakly, where no LiDAR evidence exists.
        farm = np.isnan(y) & ~inside & (far < 5000)
        y[farm] = far[farm]
        w[farm] = 0.5
        good = ~np.isnan(y)
        yi = np.interp(mid, mid[good], y[good])
        wi = np.where(good, w, 0.05)
        h = pava_decreasing(yi, wi)
        h = ndimage.gaussian_filter1d(h, 2)
        h = pava_decreasing(h, np.ones_like(h))
        r.prof_s, r.prof_h = mid, h
        print(f"{r.name}: profile {h[0]:.1f} -> {h[-1]:.1f} m over {r.line.length / 1000:.1f} km, "
              f"lidar bins {int((~np.isnan(med)).sum())}, hole bins {int((~np.isnan(lo)).sum())}", flush=True)


def river_surface(rivers, g: Raster, obs_mask, flat, rpolys):
    """Surface, wetted mask and flow on grid g for the rivers (profiles already fitted)."""
    corridor = g.rasterize([(unary_union([r.line.buffer(120) for r in rivers] + [p.buffer(20) for p in rpolys]), 1)]).astype(bool)
    rr, cc = np.nonzero(corridor)
    E, N = g.en(rr, cc)
    best = np.full(len(rr), np.inf)
    owner = np.full(len(rr), -1)
    svals = np.zeros(len(rr))
    kidx = np.zeros(len(rr), dtype=np.int64)
    for i, r in enumerate(rivers):
        s, d, k = r.locate(E, N)
        m = d < best
        best[m], owner[m], svals[m], kidx[m] = d[m], i, s[m], k[m]
    S = np.full(len(rr), np.nan)
    for i, r in enumerate(rivers):
        m = owner == i
        S[m] = r.level(svals[m])
    dem = g.a[rr, cc]
    obs = obs_mask[rr, cc] & (best < 100)
    cand = (best < 90) & (g.nan[rr, cc] | (dem <= S + 0.12) | (obs & flat[rr, cc] & (dem <= S + 0.6)))
    wet = np.zeros(g.shape, bool)
    wet[rr[cand], cc[cand]] = True
    lab, n = ndimage.label(wet)
    ob = np.zeros(g.shape, bool)
    ob[rr[obs], cc[obs]] = True
    hits = ndimage.sum(ob, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = hits >= max(8, 100 / g.res ** 2)
    wet = keep[lab]
    wet = fill_small_holes(wet, 150 / g.res ** 2)
    Sr = np.full(g.shape, np.nan, np.float32)
    Sr[rr, cc] = S
    own = np.full(g.shape, -1, np.int8)
    own[rr, cc] = owner
    tx = np.zeros(g.shape, np.float32)
    ty = np.zeros(g.shape, np.float32)
    slope = np.zeros(g.shape, np.float32)
    for i, r in enumerate(rivers):
        m = owner == i
        tx[rr[m], cc[m]] = r.tan[kidx[m], 0]
        ty[rr[m], cc[m]] = r.tan[kidx[m], 1]
        slope[rr[m], cc[m]] = r.slope(svals[m])
    return wet, Sr, own, tx, ty, slope


def fill_small_holes(mask, max_px):
    holes = ndimage.binary_fill_holes(mask) & ~mask
    lab, n = ndimage.label(holes)
    if n == 0:
        return mask
    sz = ndimage.sum(holes, lab, index=np.arange(1, n + 1))
    small = np.zeros(n + 1, bool)
    small[1:] = sz <= max_px
    return mask | small[lab]


# ----------------------------------------------------------------------------------------------
# Ponds and lagoons
# ----------------------------------------------------------------------------------------------
def osm_ponds(feats):
    """Mapped still water (not the rivers): (geometry, is_lagoon)."""
    out = []
    for f in feats:
        t = f.tags
        if not isinstance(f.geom, (Polygon, MultiPolygon)):
            continue
        is_water = t.get("natural") == "water" or t.get("landuse") in ("reservoir", "basin") or "water" in t
        if not is_water or t.get("water") == "river" or t.get("name") in MAIN_RIVERS:
            continue
        lag = t.get("landuse") in ("reservoir", "basin") or t.get("water") in ("reservoir", "wastewater", "basin", "lagoon")
        out.append((f.geom.buffer(0), lag))
    return out


def s2_rgb_on(g: Raster):
    with rasterio.open(CACHE / "s2" / "near.tif") as f:
        s2 = f.read([1, 2, 3]).astype(np.float32) / 10000.0
        t, crs = f.transform, f.crs
    return np.stack([warp_to(s2[i], t, crs, g) for i in range(3)])


def detect_ponds(g: Raster, seeds, excl, flat, ndwi, sparse, lagoon_mask, fine):
    """Grow still-water bodies from seeds to their level contour and keep those with evidence.

    Returns (id raster int32, list of bodies {id, level, lagoon, area, evidence}).
    """
    lab, n = ndimage.label(seeds & ~excl)
    objs = ndimage.find_objects(lab)
    ids = np.zeros(g.shape, np.int32)
    levels = {}
    pad = int(math.ceil(40 / g.res))
    nxt = 1
    for i, sl in enumerate(objs):
        if sl is None:
            continue
        r0, r1 = max(sl[0].start - pad, 0), min(sl[0].stop + pad, g.shape[0])
        c0, c1 = max(sl[1].start - pad, 0), min(sl[1].stop + pad, g.shape[1])
        seed = lab[r0:r1, c0:c1] == i + 1
        npx = int(seed.sum())
        if npx * g.res ** 2 < 20:
            continue
        sub = g.a[r0:r1, c0:c1]
        subnan = g.nan[r0:r1, c0:c1]
        flt = flat[r0:r1, c0:c1] & seed
        if flt.sum() >= max(6, 0.15 * npx):
            level = float(np.median(sub[flt]))
        else:
            ring = ndimage.binary_dilation(seed, iterations=max(1, int(3 / g.res))) & ~seed & ~subnan
            if not ring.any():
                continue
            level = float(np.percentile(sub[ring], 10)) - 0.12
        near = ndimage.distance_transform_edt(~seed) * g.res <= 40
        cand = near & (subnan | (sub <= level + 0.08)) & ~excl[r0:r1, c0:c1]
        cl, cn = ndimage.label(cand)
        hit = np.unique(cl[seed & cand])
        grow = np.isin(cl, hit[hit > 0]) | (seed & subnan)
        grow = fill_small_holes(grow, 60 / g.res ** 2)
        if grow.sum() * g.res ** 2 < 20:
            continue
        win = ids[r0:r1, c0:c1]
        over = np.unique(win[grow & (win > 0)])
        same = [o for o in over if abs(levels[o] - level) < 0.2]
        if same:
            tgt = same[0]
            for o in same[1:]:
                ids[ids == o] = tgt
                levels.pop(o, None)
            win[grow & ((win == 0) | np.isin(win, same))] = tgt
        else:
            win[grow & (win == 0)] = nxt
            levels[nxt] = level
            nxt += 1
    # Evidence per body.
    bodies = []
    objs = ndimage.find_objects(ids)
    for bid, sl in enumerate(objs, start=1):
        if sl is None or bid not in levels:
            continue
        m = ids[sl] == bid
        area = float(m.sum() * g.res ** 2)
        nanf = float(g.nan[sl][m].mean())
        fltf = float(flat[sl][m].mean())
        nd = ndwi[sl][m]
        ndm = float(np.nanmean(nd)) if np.isfinite(nd).any() else -1.0
        spf = float(sparse[sl][m].mean()) if sparse is not None else 0.0
        lag = bool(lagoon_mask[sl][m].mean() > 0.3)
        if fine:
            ok = area >= 60 and (
                (spf >= 0.5 and fltf + nanf >= 0.4 and ndm > -0.55)
                or (ndm > 0.0 and area >= 300)
                or (nanf >= 0.6 and ndm > -0.45)
                or (lag and (spf >= 0.3 or nanf >= 0.3 or fltf >= 0.5)))
        else:
            ok = area >= 300 and (ndm > 0.0 or (nanf >= 0.6 and ndm > -0.35) or (fltf >= 0.6 and ndm > -0.2))
        if not ok:
            ids[sl][m] = 0
            continue
        bodies.append({"id": bid, "level": levels[bid], "lagoon": lag, "area": area,
                       "evidence": dict(nan=round(nanf, 2), flat=round(fltf, 2), ndwi=round(ndm, 2), sparse=round(spf, 2))})
    return ids, bodies


def body_polygons(g: Raster, ids, bodies, rgb):
    """Vectorize accepted bodies; attach level and a Sentinel-2 colour sample of the open water."""
    by = {b["id"]: b for b in bodies}
    out = []
    for geom, v in features.shapes(ids, mask=ids > 0, transform=g.t, connectivity=8):
        b = by.get(int(v))
        if b is None:
            continue
        p = shape(geom).buffer(0)
        if p.area < 20:
            continue
        out.append({"geom": p, "level": b["level"], "kind": LAGOON if b["lagoon"] else POND, "id": int(v)})
    objs = ndimage.find_objects(ids)
    for b in bodies:
        sl = objs[b["id"] - 1]
        m = ids[sl] == b["id"]
        core = ndimage.binary_erosion(m, iterations=max(1, int(4 / g.res)))
        use = core if core.sum() >= 4 else m
        b["rgb"] = [float(np.nanmean(rgb[k][sl][use])) for k in range(3)]
    # Open water is dark in summer imagery; bright "holes" are roofs, tanks or bare ground.
    dark = {b["id"] for b in bodies if sum(b["rgb"]) / 3 < 0.15}
    out = [p for p in out if p["id"] in dark]
    for p in out:
        p["rgb"] = by[p["id"]]["rgb"]
    return out


def pond_surface(polys, g: Raster, excl):
    """Rasterize accepted bodies onto grid g, re-growing to the level contour within a few metres."""
    wet = np.zeros(g.shape, bool)
    S = np.full(g.shape, np.nan, np.float32)
    kind = np.full(g.shape, 255, np.uint8)
    from rasterio.transform import Affine
    for b in polys:
        p = b["geom"]
        minE, minN, maxE, maxN = p.bounds
        if maxE < g.left or minE > g.right or maxN < g.bottom or minN > g.top:
            continue
        m = 6.0
        r0, c0 = [int(v) for v in g.rc(minE - m, maxN + m)]
        r1, c1 = [int(math.ceil(v)) + 1 for v in g.rc(maxE + m, minN - m)]
        r0, c0 = max(r0, 0), max(c0, 0)
        r1, c1 = min(r1, g.shape[0]), min(c1, g.shape[1])
        if r1 - r0 < 2 or c1 - c0 < 2:
            continue
        t = Affine(g.res, 0, g.left + c0 * g.res, 0, -g.res, g.top - r0 * g.res)
        shp = (r1 - r0, c1 - c0)
        core = features.rasterize([(p, 1)], out_shape=shp, transform=t, fill=0).astype(bool)
        zone = features.rasterize([(p.buffer(3), 1)], out_shape=shp, transform=t, fill=0).astype(bool)
        sub = g.a[r0:r1, c0:c1]
        lvl = b["level"]
        cand = core | (zone & (g.nan[r0:r1, c0:c1] | (sub <= lvl + 0.08)))
        cand &= ~excl[r0:r1, c0:c1]
        lab, n = ndimage.label(cand)
        hit = np.unique(lab[core & cand])
        cm = np.isin(lab, hit[hit > 0])
        if not cm.any():
            continue
        wet[r0:r1, c0:c1] |= cm
        S[r0:r1, c0:c1][cm] = lvl
        kind[r0:r1, c0:c1][cm] = b["kind"]
    return wet, S, kind

# ----------------------------------------------------------------------------------------------
# Creeks, streams and ditches
# ----------------------------------------------------------------------------------------------
def key(p):
    return (round(p[0], 2), round(p[1], 2))


def creek_edges(feats):
    """Split waterway lines at shared vertices into directed edges with upstream network length."""
    ways = []
    for f in feats:
        t = f.tags
        ww = t.get("waterway")
        if ww not in ("stream", "ditch", "drain", "canal", "river") or not isinstance(f.geom, LineString):
            continue
        if ww == "river" and t.get("name") in MAIN_RIVERS:
            continue
        ways.append((f.geom, t))
    use = defaultdict(int)
    for g, _ in ways:
        for p in g.coords:
            use[key(p)] += 1
        use[key(g.coords[0])] += 1
        use[key(g.coords[-1])] += 1
    edges = []
    for g, t in ways:
        cs = list(g.coords)
        cur = [cs[0]]
        for p in cs[1:]:
            cur.append(p)
            if use[key(p)] > 1 and len(cur) >= 2 and p is not cs[-1]:
                edges.append({"coords": cur, "tags": t})
                cur = [p]
        if len(cur) >= 2:
            edges.append({"coords": cur, "tags": t})
    ends_at = defaultdict(list)
    for i, e in enumerate(edges):
        e["len"] = LineString(e["coords"]).length
        ends_at[key(e["coords"][-1])].append(i)
    up = [None] * len(edges)

    def upstream(i0):
        stack = [(i0, False)]
        onstack = set()
        while stack:
            i, done = stack.pop()
            if up[i] is not None:
                continue
            if done:
                s = edges[i]["len"]
                for j in ends_at[key(edges[i]["coords"][0])]:
                    if j != i and up[j] is not None:
                        s += up[j]
                up[i] = s
                onstack.discard(i)
                continue
            onstack.add(i)
            stack.append((i, True))
            for j in ends_at[key(edges[i]["coords"][0])]:
                if j != i and up[j] is None and j not in onstack:
                    stack.append((j, False))
        return up[i0]

    for i in range(len(edges)):
        upstream(i)
    for i, e in enumerate(edges):
        e["up"] = up[i]
    return edges


def creek_width(e):
    t = e["tags"]
    ww = t.get("waterway")
    try:
        w = float(str(t.get("width", "0")).replace(",", ".").split()[0])
        if 0.3 < w < 40:
            return w
    except (ValueError, IndexError):
        pass
    up = e["up"]
    f = float(np.clip(math.sqrt(up / 3000.0), 0.6, 1.5))
    if ww == "river":
        return 7.0 * f
    if ww == "canal":
        return 2.6
    if ww in ("ditch", "drain"):
        return 1.0
    return (2.6 if t.get("name") else 1.4) * f


def creek_seasonal(e):
    t = e["tags"]
    if t.get("intermittent") == "yes" or t.get("seasonal") == "yes":
        return True
    if t.get("name") or t.get("waterway") in ("river", "canal"):
        return False
    if t.get("waterway") in ("ditch", "drain"):
        return e["up"] < 800
    return e["up"] < 1500


class Snapper:
    """Least-cost thalweg paths through a corridor around a mapped line."""

    def __init__(self, g: Raster, road=None):
        self.g = g
        self.road = road

    def window(self, pts, margin):
        g = self.g
        minE, minN = pts.min(0) - margin
        maxE, maxN = pts.max(0) + margin
        r0, c0 = [int(math.floor(v)) for v in g.rc(minE, maxN)]
        r1, c1 = [int(math.ceil(v)) + 1 for v in g.rc(maxE, minN)]
        r0, c0 = max(r0, 0), max(c0, 0)
        r1, c1 = min(r1, g.shape[0]), min(c1, g.shape[1])
        return r0, r1, c0, c1

    def snap_point(self, p, radius=8.0):
        g = self.g
        r0, r1, c0, c1 = self.window(np.array([p]), radius + 10)
        sub = g.filled[r0:r1, c0:c1]
        low = sub - ndimage.minimum_filter(sub, size=int(2 * 8 / g.res) + 1)
        rr, cc = np.mgrid[r0:r1, c0:c1]
        E, N = g.en(rr, cc)
        d = np.hypot(E - p[0], N - p[1])
        score = np.where(d <= radius, low + 0.03 * d, np.inf)
        k = np.unravel_index(np.argmin(score), score.shape)
        return float(E[k]), float(N[k])

    def path(self, a, b, osm_pts):
        from skimage.graph import MCP_Geometric
        g = self.g
        pts = np.vstack([osm_pts, [a], [b]])
        r0, r1, c0, c1 = self.window(pts, 30)
        sub = g.filled[r0:r1, c0:c1]
        low = sub - ndimage.minimum_filter(sub, size=int(2 * 8 / g.res) + 1)
        t = rasterio.transform.Affine(g.res, 0, g.left + c0 * g.res, 0, -g.res, g.top - r0 * g.res)
        corr = features.rasterize([(LineString(osm_pts).buffer(22), 1), (Point(a).buffer(6), 1), (Point(b).buffer(6), 1)],
                                  out_shape=sub.shape, transform=t, fill=0).astype(bool)
        dist = ndimage.distance_transform_edt(~features.rasterize([(LineString(osm_pts), 1)], out_shape=sub.shape,
                                                                   transform=t, fill=0, all_touched=True).astype(bool)) * g.res
        cost = 1.0 + 10.0 * np.minimum(low, 3.0) + 0.004 * dist ** 2
        cost = np.where(corr, cost, 1e5)
        ra, ca = [int(round(v)) for v in g.rc(*a)]
        rb, cb = [int(round(v)) for v in g.rc(*b)]
        ra, ca, rb, cb = ra - r0, ca - c0, rb - r0, cb - c0
        H_, W_ = sub.shape
        if not (0 <= ra < H_ and 0 <= ca < W_ and 0 <= rb < H_ and 0 <= cb < W_):
            return np.array([a, b])
        m = MCP_Geometric(cost, fully_connected=True)
        m.find_costs([(ra, ca)], [(rb, cb)])
        tb = np.array(m.traceback((rb, cb)))
        E, N = g.en(tb[:, 0] + r0, tb[:, 1] + c0)
        return np.column_stack([E, N])


def resample(pts, step):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] < step:
        return pts[[0, -1]] if len(pts) > 1 else pts, s[[0, -1]] if len(pts) > 1 else s
    q = np.linspace(0, s[-1], max(2, int(round(s[-1] / step)) + 1))
    return np.column_stack([np.interp(q, s, pts[:, 0]), np.interp(q, s, pts[:, 1])]), q


def smooth_path(pts, win_m=5.0, step=1.0):
    p, _ = resample(pts, step)
    k = max(1, int(win_m / step))
    if len(p) > 2 * k + 2:
        sm = ndimage.uniform_filter1d(p, 2 * k + 1, axis=0, mode="nearest")
        sm[0], sm[-1] = p[0], p[-1]
        p = sm
    return resample(p, step)


def snap_creeks(edges, g1: Raster, g2: Raster):
    s1, s2 = Snapper(g1), Snapper(g2)
    junction = {}

    def grid_for(pts, margin=40):
        minE, minN = pts.min(0)
        maxE, maxN = pts.max(0)
        return s1 if g1.inside((minE, minN, maxE, maxN), margin) else s2

    def snap_j(p):
        k = key(p)
        if k not in junction:
            if not (g2.left < p[0] < g2.right and g2.bottom < p[1] < g2.top):
                junction[k] = tuple(p)
            else:
                junction[k] = grid_for(np.array([p]), 25).snap_point(p)
        return junction[k]

    out = []
    near = box(g2.left + 40, g2.bottom + 40, g2.right - 40, g2.top - 40)
    for e in edges:
        line = LineString(e["coords"])
        if not line.intersects(near):
            continue
        clip = line.intersection(near)
        parts = [clip] if isinstance(clip, LineString) else [x for x in getattr(clip, "geoms", []) if isinstance(x, LineString)]
        for part in parts:
            if part.length < 5:
                continue
            cs = np.array(part.coords)
            dense, _ = resample(cs, 5.0)
            n_pieces = max(1, int(math.ceil(part.length / 220.0)))
            idx = np.linspace(0, len(dense) - 1, n_pieces + 1).round().astype(int)
            a = snap_j(tuple(cs[0]))
            path = [np.array([a])]
            for pi in range(n_pieces):
                seg = dense[idx[pi]: idx[pi + 1] + 1]
                if pi == n_pieces - 1:
                    b = snap_j(tuple(cs[-1]))
                else:
                    b = grid_for(seg).snap_point(tuple(seg[-1]))
                pth = grid_for(np.vstack([seg, [a], [b]])).path(a, b, seg)
                path.append(pth[1:])
                a = b
            P = np.vstack(path)
            P, s = smooth_path(P, 4.0, 1.0)
            out.append({"edge": e, "pts": P, "s": s})
    return out


def creek_profiles(creeks, g1: Raster, g2: Raster, dry_masks):
    """Bed and surface along each snapped creek; flow orientation; culverts and river mouths are dry."""
    by_start = defaultdict(list)

    # The bed is the lowest ground within ~2 m of the path, so the surface never sits above
    # neighbouring channel ground even where the path runs slightly up a bank.
    lo1 = ndimage.minimum_filter(g1.filled, size=5)
    lo2 = ndimage.minimum_filter(g2.filled, size=3)

    def bed_at(P):
        z = np.empty(len(P))
        in1 = (P[:, 0] > g1.left + 2) & (P[:, 0] < g1.right - 2) & (P[:, 1] > g1.bottom + 2) & (P[:, 1] < g1.top - 2)
        if in1.any():
            z[in1] = g1.sample(lo1, P[in1, 0], P[in1, 1])
        if (~in1).any():
            z[~in1] = g2.sample(lo2, P[~in1, 0], P[~in1, 1])
        return z

    reversed_n = 0
    for c in creeks:
        z = bed_at(c["pts"])
        if z[0] < z[-1] - 3.0 and c["pts"].shape[0] > 30:
            c["pts"] = c["pts"][::-1].copy()
            z = z[::-1].copy()
            reversed_n += 1
        c["bed"] = z
        by_start[key(c["pts"][0])].append(c)
    # Surface: running minimum downstream, seeded by upstream edges, so it never rises.
    ends = {}
    for c in sorted(creeks, key=lambda c: -c["bed"][0]):
        z = c["bed"].copy()
        seed = ends.get(key(c["pts"][0]))
        if seed is not None:
            z[0] = min(z[0], seed)
        s1 = np.minimum.accumulate(z)
        s2 = np.minimum.accumulate(ndimage.gaussian_filter1d(s1, 2.0, mode="nearest"))
        surf = np.minimum(s2, s1 + 0.02) + 0.04
        c["surf"] = surf
        k = key(c["pts"][-1])
        ends[k] = min(ends.get(k, np.inf), surf[-1])
        P = c["pts"]
        dry = c["bed"] > surf + 0.35
        for dm, g in dry_masks:
            r, cc_ = g.rc(P[:, 0], P[:, 1])
            r = np.clip(np.round(r).astype(int), 0, g.shape[0] - 1)
            cc_ = np.clip(np.round(cc_).astype(int), 0, g.shape[1] - 1)
            ins = (P[:, 0] > g.left) & (P[:, 0] < g.right) & (P[:, 1] > g.bottom) & (P[:, 1] < g.top)
            dry |= ins & dm[r, cc_]
        if c["edge"]["tags"].get("tunnel") in ("culvert", "yes", "flooded"):
            dry[:] = True
        # Short wet gaps between dry stretches are culvert ends; short dry blips are noise.
        dry = ndimage.binary_closing(dry, structure=np.ones(3)) | dry
        dry = ~ndimage.binary_opening(~dry, structure=np.ones(4))
        c["dry"] = dry
        c["w"] = creek_width(c["edge"])
        c["seasonal"] = creek_seasonal(c["edge"])
        sl = -np.gradient(ndimage.gaussian_filter1d(surf, 3.0, mode="nearest"))
        c["slope"] = np.clip(sl, 0, 1)
    print(f"creeks: {len(creeks)} paths, {reversed_n} reversed to run downhill", flush=True)


def carve_creeks(creeks, g: Raster, dem, protect):
    """Carve creek channels into dem (in place) on grid g; raise low banks just outside the channel."""
    P, S, HW, D = [], [], [], []
    for c in creeks:
        wet = ~c["dry"]
        if wet.sum() < 3:
            continue
        hw = c["w"] / 2
        P.append(c["pts"][wet])
        S.append(c["surf"][wet])
        HW.append(np.full(wet.sum(), hw))
        D.append(np.full(wet.sum(), float(np.clip(0.2 * c["w"], 0.12, 0.8))))
    if not P:
        return np.zeros(g.shape, bool)
    P, S, HW, D = np.vstack(P), np.concatenate(S), np.concatenate(HW), np.concatenate(D)
    ins = (P[:, 0] > g.left - 10) & (P[:, 0] < g.right + 10) & (P[:, 1] > g.bottom - 10) & (P[:, 1] < g.top + 10)
    P, S, HW, D = P[ins], S[ins], HW[ins], D[ins]
    if len(P) == 0:
        return np.zeros(g.shape, bool)
    tree = cKDTree(P)
    reach = HW.max() + 1.6
    seed = np.zeros(g.shape, bool)
    r, c = g.rc(P[:, 0], P[:, 1])
    r = np.clip(np.round(r).astype(int), 0, g.shape[0] - 1)
    c = np.clip(np.round(c).astype(int), 0, g.shape[1] - 1)
    seed[r, c] = True
    zone = ndimage.binary_dilation(seed, iterations=int(math.ceil(reach / g.res)) + 1)
    rr, cc = np.nonzero(zone)
    E, N = g.en(rr, cc)
    d, k = tree.query(np.column_stack([E, N]), workers=4)
    hw, s, dep = HW[k], S[k], D[k]
    z = dem[rr, cc]
    nanz = np.isnan(z)
    zf = np.where(nanz, s, z)
    inner = d < hw
    band = (d >= hw) & (d < hw + 1.5)
    prot = protect[rr, cc]
    bed = s - dep * np.clip(1 - (d / np.maximum(hw, 1e-3)) ** 2, 0, 1) ** 0.7 - 0.03
    newz = zf.copy()
    # Never dig more than a channel's depth into ground the path merely skirts.
    cut = np.maximum(np.minimum(zf, bed), zf - dep - 0.5)
    newz[inner & ~prot] = cut[inner & ~prot]
    lift = s + 0.03 + 0.15 * (d - hw)
    raise_ = band & ~prot & (zf < lift) & (zf > lift - 0.4)
    newz[raise_] = lift[raise_]
    dem[rr, cc] = np.where(nanz & ~inner, np.nan, newz)
    wetm = np.zeros(g.shape, bool)
    wetm[rr[inner], cc[inner]] = True
    return wetm


# ----------------------------------------------------------------------------------------------
# Carving river/pond beds
# ----------------------------------------------------------------------------------------------
def bed_noise(E, N):
    """Grid-independent low-frequency variation of bed depth (-1..1), identical on 1 m and 2 m grids."""
    n = (np.sin(E * 0.071 + N * 0.043) + np.sin(-E * 0.037 + N * 0.089 + 1.3)
         + 0.5 * np.sin(E * 0.13 - N * 0.11 + 2.1) + 0.5 * np.sin(E * 0.021 + N * 0.017 + 0.4))
    return n / 3.0


def carve_bodies(g: Raster, dem, wet, S, kind):
    """Lower the ground under open water: depth grows from the shore towards the middle.

    Returns (carved dem, shore distance m, local half-width m, surface extended 6 m past the shore).
    """
    out = dem.copy()
    dist = np.zeros(g.shape, np.float32)
    half = np.zeros(g.shape, np.float32)
    Sx = np.full(g.shape, np.nan, np.float32)
    lab, n = ndimage.label(wet)
    pad = int(math.ceil(40 / g.res))
    for k, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        r0, r1 = max(sl[0].start - pad, 0), min(sl[0].stop + pad, g.shape[0])
        c0, c1 = max(sl[1].start - pad, 0), min(sl[1].stop + pad, g.shape[1])
        w = wet[r0:r1, c0:c1]
        mine = lab[r0:r1, c0:c1] == k
        d = (ndimage.distance_transform_edt(w) * g.res).astype(np.float32)
        hw = np.maximum(ndimage.maximum_filter(d, size=int(2 * 30 / g.res) + 1), g.res)
        rr, cc = np.nonzero(mine)
        E, N = g.en(rr + r0, cc + c0)
        dd, hh = d[rr, cc], hw[rr, cc]
        kd = kind[r0:r1, c0:c1][rr, cc]
        maxd = np.where(kd == RIVER, np.clip(0.09 * hh, 0.4, 2.6), np.clip(0.14 * hh, 0.4, 3.0))
        depth = maxd * (1 - np.exp(-dd / (0.45 * hh))) * (1 + 0.15 * bed_noise(E, N))
        depth = np.maximum(depth, 0.1)
        s = S[r0:r1, c0:c1][rr, cc]
        bed = s - depth
        z = dem[r0:r1, c0:c1][rr, cc]
        out[r0 + rr, c0 + cc] = np.where(np.isnan(z), bed, np.minimum(z, bed))
        dist[r0 + rr, c0 + cc] = dd
        half[r0 + rr, c0 + cc] = hh
        # Dry ground right next to the water that is lower than it becomes a low bank.
        dout, idx = ndimage.distance_transform_edt(~w, return_indices=True)
        dout = dout * g.res
        Ssub = S[r0:r1, c0:c1]
        sx = Ssub[idx[0], idx[1]]
        band = ~w & (dout <= 6.0) & (lab[r0:r1, c0:c1][idx[0], idx[1]] == k)
        o = out[r0:r1, c0:c1]
        lift = sx + 0.05 + 0.04 * dout
        low = band & (dout <= 3.0) & ~np.isnan(o) & (o < lift)
        o[low] = lift[low]
        sxo = Sx[r0:r1, c0:c1]
        put = (mine | band) & np.isnan(sxo)
        sxo[put] = np.where(mine, Ssub, sx)[put]
    return out, dist, half, Sx


# ----------------------------------------------------------------------------------------------
# Meshes
# ----------------------------------------------------------------------------------------------
class MeshBuf:
    def __init__(self):
        self.pos, self.flow, self.tint, self.meta, self.idx = [], [], [], [], []
        self.n = 0

    def add(self, pos, flow, tint, meta, tris):
        self.pos.append(np.asarray(pos, np.float32))
        self.flow.append(np.asarray(flow, np.float32))
        self.tint.append(np.asarray(tint, np.uint8))
        self.meta.append(np.asarray(meta, np.uint8))
        self.idx.append(np.asarray(tris, np.uint32) + self.n)
        self.n += len(pos)

    def pack(self, flags):
        if not self.n:
            return b""
        pos = np.concatenate(self.pos)
        flow = np.clip(np.round(np.concatenate(self.flow) * 1000), -32767, 32767).astype(np.int16)
        tint = np.concatenate(self.tint)
        meta = np.concatenate(self.meta)
        idx = np.concatenate(self.idx).ravel()
        head = struct.pack("<B3xII", flags, len(pos), len(idx))
        return head + pos.tobytes() + flow.tobytes() + tint.tobytes() + meta.tobytes() + idx.astype(np.uint32).tobytes()


def engine(E, N, y):
    return np.column_stack([np.asarray(E) - ORIGIN_E, np.asarray(y), ORIGIN_N - np.asarray(N)])


def tri_poly(poly, max_area, step):
    """Constrained Delaunay triangulation of a polygon with holes, boundary resampled every `step` m."""
    import triangle
    verts, segs, holes = [], [], []
    for ri, ring in enumerate([poly.exterior] + list(poly.interiors)):
        cs = np.array(ring.coords)[:-1]
        if len(cs) < 3:
            continue
        closed = np.vstack([cs, cs[:1]])
        pts, _ = resample(closed, step)
        pts = pts[:-1]
        if len(pts) < 3:
            continue
        base = len(verts)
        verts.extend(map(tuple, pts))
        segs += [(base + k, base + (k + 1) % len(pts)) for k in range(len(pts))]
        if ri > 0:
            holes.append(Polygon(ring).representative_point().coords[0])
    if len(verts) < 3:
        return None, None
    data = {"vertices": np.array(verts), "segments": np.array(segs)}
    if holes:
        data["holes"] = np.array(holes)
    try:
        t = triangle.triangulate(data, f"pq28a{max_area}")
    except Exception:  # noqa: BLE001
        return None, None
    if "triangles" not in t or len(t["triangles"]) == 0:
        return None, None
    # Counter-clockwise in (E, N) is counter-clockwise seen from above in engine space (x = E, z = -N).
    return t["vertices"], t["triangles"]


def polys_of(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def chunk_boxes(bounds, margin=0.0):
    n = int(2 * H / NODE_BASE)
    minE, minN, maxE, maxN = bounds
    i0 = max(int((minE - margin - ORIGIN_E + H) // NODE_BASE), 0)
    i1 = min(int((maxE + margin - ORIGIN_E + H) // NODE_BASE), n - 1)
    j0 = max(int((ORIGIN_N - (maxN + margin) + H) // NODE_BASE), 0)
    j1 = min(int((ORIGIN_N - (minN - margin) + H) // NODE_BASE), n - 1)
    for j in range(j0, j1 + 1):
        for i in range(i0, i1 + 1):
            x0, z0 = -H + i * NODE_BASE, -H + j * NODE_BASE
            yield i, j, box(ORIGIN_E + x0, ORIGIN_N - (z0 + NODE_BASE), ORIGIN_E + x0 + NODE_BASE, ORIGIN_N - z0)


def tint_u8(rgb, turb):
    r = np.clip(np.asarray(rgb, np.float64) * 1000.0, 0, 255)
    return np.column_stack([np.broadcast_to(r[..., 0], turb.shape), np.broadcast_to(r[..., 1], turb.shape),
                            np.broadcast_to(r[..., 2], turb.shape), np.clip(turb * 255, 0, 255)]).round()


class Fields:
    """Per-vertex attributes for open water, sampled from the 2 m rasters and the river lines."""

    def __init__(self, g2, S2x, kind2, dist2, half2, rivers, polys, river_rgb):
        self.g, self.S, self.kind = g2, S2x, kind2
        self.dist, self.half = dist2, half2
        self.rivers = rivers
        self.river_rgb = river_rgb
        self.ptree = None
        cents = [p["geom"].representative_point().coords[0] for p in polys]
        if cents:
            self.pgeoms = [p["geom"] for p in polys]
            self.prgb = [p["rgb"] for p in polys]
            self.ptree = cKDTree(np.array(cents))

    def __call__(self, E, N):
        g = self.g
        r, c = g.rc(E, N)
        ri = np.clip(np.round(r).astype(int), 0, g.shape[0] - 1)
        ci = np.clip(np.round(c).astype(int), 0, g.shape[1] - 1)
        y = g.sample(np.nan_to_num(self.S, nan=0.0), E, N, order=0).astype(np.float64)
        # Bilinear where all four neighbours are defined keeps the river surface smooth.
        yb = g.sample(np.nan_to_num(self.S, nan=-1e4), E, N, order=1)
        y = np.where(yb > -1000, yb, y)
        kind = self.kind[ri, ci].astype(np.int32)
        kind = np.where(kind == 255, RIVER, kind)
        d = g.sample(self.dist, E, N, order=1)
        hw = np.maximum(g.sample(self.half, E, N, order=1), 2.0)
        flow = np.zeros((len(E), 2))
        turb = np.zeros(len(E))
        rgb = np.tile(np.array(self.river_rgb, np.float64), (len(E), 1))
        riv = kind == RIVER
        if riv.any():
            best = np.full(riv.sum(), np.inf)
            tan = np.zeros((riv.sum(), 2))
            slope = np.zeros(riv.sum())
            for rl in self.rivers:
                s_, dd, k = rl.locate(E[riv], N[riv])
                m = dd < best
                best[m] = dd[m]
                tan[m] = rl.tan[k[m]]
                slope[m] = rl.slope(s_[m])
            v = 0.9 * np.clip(np.sqrt(22.0 / np.maximum(hw[riv], 3.0)), 0.75, 1.6)
            v *= 0.25 + 0.75 * (1 - np.exp(-d[riv] / 4.0))
            v *= np.clip(1 + (slope - 0.001) * 300, 0.8, 2.2)
            flow[riv] = tan * v[:, None]
            turb[riv] = np.clip((slope - 0.0012) * 500, 0, 1)
        if self.ptree is not None and (~riv).any():
            _, k = self.ptree.query(np.column_stack([E[~riv], N[~riv]]))
            rgb[~riv] = np.array(self.prgb)[k]
        # Engine flow: x = east, z = south.
        flow = np.column_stack([flow[:, 0], -flow[:, 1]])
        return y, flow, rgb, turb, kind


def open_water_meshes(polys_geom, fields: Fields, out_chunks):
    """Triangulate open water (rivers, ponds) per 256 m chunk."""
    for i, j, cb in chunk_boxes(polys_geom.bounds):
        clip = polys_geom.intersection(cb)
        for poly in polys_of(clip):
            if poly.area < 2:
                continue
            v, tri = tri_poly(poly, 40, 3.0)
            if v is None:
                continue
            y, flow, rgb, turb, kind = fields(v[:, 0], v[:, 1])
            ok = np.isfinite(y) & (y > 100)
            if not ok.all():
                good_tri = ok[tri].all(1)
                tri = tri[good_tri]
                if not len(tri):
                    continue
            meta = np.column_stack([kind, np.zeros((len(v), 3))])
            out_chunks[(i, j)][0].add(engine(v[:, 0], v[:, 1], y), flow, tint_u8(rgb, turb), meta, tri)


def creek_meshes(creeks, out_chunks):
    """Ribbons along the wet reaches of each snapped creek, extending under the banks."""
    rgb = np.array([0.022, 0.032, 0.024])
    for c in creeks:
        wet = ~c["dry"]
        if wet.sum() < 3:
            continue
        P = c["pts"]
        tan = np.gradient(ndimage.gaussian_filter1d(P, 2.0, axis=0, mode="nearest"), axis=0)
        tan /= np.maximum(np.linalg.norm(tan, axis=1, keepdims=True), 1e-9)
        nrm = np.column_stack([-tan[:, 1], tan[:, 0]])
        hw = c["w"] / 2 + 1.3
        kind = DITCH if c["edge"]["tags"].get("waterway") in ("ditch", "drain") else CREEK
        speed = np.clip(0.35 + 12 * c["slope"], 0.3, 2.2)
        turb = np.clip((c["slope"] - 0.015) * 12, 0, 0.7)
        flags = 1 if c["seasonal"] else 0
        # Runs of wet stations, thinned where the channel is straight.
        lab, n = ndimage.label(wet)
        for k in range(1, n + 1):
            idx = np.nonzero(lab == k)[0]
            if len(idx) < 3:
                continue
            keep = thin_stations(P[idx], 0.12, 4.0)
            idx = idx[keep]
            L = P[idx] + nrm[idx] * hw
            R = P[idx] - nrm[idx] * hw
            Cc = P[idx]
            m = len(idx)
            E = np.concatenate([L[:, 0], Cc[:, 0], R[:, 0]])
            N = np.concatenate([L[:, 1], Cc[:, 1], R[:, 1]])
            y = np.tile(c["surf"][idx], 3)
            fl = np.tile(np.column_stack([tan[idx, 0], -tan[idx, 1]]) * speed[idx, None], (3, 1))
            tb = np.tile(turb[idx], 3)
            # Chunk by segment midpoint.
            mid = 0.5 * (Cc[:-1] + Cc[1:])
            ci = ((mid[:, 0] - ORIGIN_E + H) // NODE_BASE).astype(int)
            cj = ((ORIGIN_N - mid[:, 1] + H) // NODE_BASE).astype(int)
            for key_ in set(zip(ci.tolist(), cj.tolist())):
                segs = np.nonzero((ci == key_[0]) & (cj == key_[1]))[0]
                used = np.unique(np.concatenate([segs, segs + 1]))
                remap = -np.ones(m, int)
                remap[used] = np.arange(len(used))
                vid = np.concatenate([used, used + m, used + 2 * m])
                u = len(used)
                tris = []
                for sgi in segs:
                    a, b = remap[sgi], remap[sgi + 1]
                    l0, l1, c0, c1, r0, r1 = a, b, a + u, b + u, a + 2 * u, b + 2 * u
                    tris += [(l0, c0, l1), (l1, c0, c1), (c0, r0, c1), (c1, r0, r1)]
                tris = np.array(tris)
                meta = np.column_stack([np.full(len(vid), kind), np.zeros((len(vid), 3))])
                out_chunks[key_][flags].add(engine(E[vid], N[vid], y[vid]), fl[vid],
                                            tint_u8(np.tile(rgb, (len(vid), 1)), tb[vid]), meta, orient(tris, E[vid], N[vid]))


def orient(tris, E, N):
    """Make every triangle counter-clockwise as seen from above in engine space."""
    x, z = E - ORIGIN_E, ORIGIN_N - N
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    cross = (x[b] - x[a]) * (z[c] - z[a]) - (z[b] - z[a]) * (x[c] - x[a])
    flip = cross > 0
    tris = tris.copy()
    tris[flip] = tris[flip][:, ::-1]
    return tris


def thin_stations(P, tol, max_step):
    """Douglas-Peucker style thinning of a polyline, never leaving gaps longer than max_step."""
    ls = LineString(P)
    simp = np.array(ls.simplify(tol, preserve_topology=False).coords)
    tree = cKDTree(P)
    _, keep = tree.query(simp)
    keep = set(keep.tolist()) | {0, len(P) - 1}
    s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    ks = sorted(keep)
    out = []
    for a, b in zip(ks[:-1], ks[1:]):
        out.append(a)
        if s[b] - s[a] > max_step:
            nadd = int(math.ceil((s[b] - s[a]) / max_step)) - 1
            tgt = s[a] + (s[b] - s[a]) * np.arange(1, nadd + 1) / (nadd + 1)
            out.extend(np.searchsorted(s, tgt).tolist())
    out.append(ks[-1])
    return np.unique(np.array(out))


def far_geometry(feats, rivers, g2: Raster, near_geom):
    """River water beyond the LiDAR, from OSM polygons or buffered lines, within FAR_RADIUS."""
    disk_ = Point(ORIGIN_E, ORIGIN_N).buffer(FAR_RADIUS)
    near_box = box(g2.left + 30, g2.bottom + 30, g2.right - 30, g2.top - 30)
    polys = [p.buffer(0) for p in river_polys(feats)]
    cover = unary_union(polys).buffer(5) if polys else Polygon()
    parts = list(polys)
    for r in rivers:
        missing = r.line.difference(cover)
        parts.append(missing.buffer(18 if r.name == "Pine River" else 12, cap_style=2))
    far = unary_union(parts).intersection(disk_).difference(near_box)
    far = far.simplify(4.0)
    return unary_union([far, near_geom.simplify(3.0)])


def export(creeks, fields: Fields, open_geom, far_geom, river_rgb):
    out = OUT / "water"
    out.mkdir(parents=True, exist_ok=True)
    for f in out.glob("*.bin"):
        f.unlink()
    chunks = defaultdict(lambda: (MeshBuf(), MeshBuf()))
    open_water_meshes(open_geom, fields, chunks)
    creek_meshes(creeks, chunks)
    keys, total, nv = [], 0, 0
    for (i, j), (perm, seas) in sorted(chunks.items()):
        groups = [b for b in (perm.pack(0), seas.pack(1)) if b]
        if not groups:
            continue
        data = b"CWW1" + struct.pack("<I", len(groups)) + b"".join(groups)
        z = gzip.compress(data, 9, mtime=0)
        (out / f"{i}_{j}.bin").write_bytes(z)
        keys.append(f"{i}_{j}")
        total += len(z)
        nv += perm.n + seas.n
    # Far mesh: one coarse layer for the whole valley.
    far = MeshBuf()
    for poly in polys_of(far_geom):
        if poly.area < 50:
            continue
        v, tri = tri_poly(poly, 3000, 20.0)
        if v is None:
            continue
        y, flow, rgb, turb, kind = fields(v[:, 0], v[:, 1])
        inside = (v[:, 0] > fields.g.left) & (v[:, 0] < fields.g.right) & (v[:, 1] > fields.g.bottom) & (v[:, 1] < fields.g.top)
        yf = np.full(len(v), np.nan)
        best = np.full(len(v), np.inf)
        for rl in fields.rivers:
            s_, d, _ = rl.locate(v[:, 0], v[:, 1])
            m = d < best
            best[m] = d[m]
            yf[m] = rl.level(s_[m]) + 0.3
        y = np.where(inside & np.isfinite(y) & (y > 100), y, yf)
        far.add(engine(v[:, 0], v[:, 1], y), np.zeros((len(v), 2)),
                tint_u8(np.tile(river_rgb, (len(v), 1)), np.zeros(len(v))),
                np.column_stack([kind, np.zeros((len(v), 3))]), tri)
    fz = gzip.compress(b"CWW1" + struct.pack("<I", 1) + far.pack(0), 9, mtime=0)
    (out / "far.bin").write_bytes(fz)
    (out / "index.json").write_text(json.dumps({"size": NODE_BASE, "half": H, "chunks": keys, "far": "far.bin"}))
    print(f"water: {len(keys)} chunks, {nv} verts, {total / 1e6:.1f} MB; far {far.n} verts {len(fz) / 1e6:.2f} MB", flush=True)


def carve_horizon(horizon: Raster, far_geom, rivers, g2: Raster):
    """Lower MRDEM cells under far rivers so the coarse terrain never pokes through the water."""
    a = horizon.a.copy()
    core = far_geom.buffer(-8)
    m = horizon.rasterize([(core, 1)]).astype(bool) if not core.is_empty else np.zeros(horizon.shape, bool)
    rr, cc = np.nonzero(m)
    E, N = horizon.en(rr, cc)
    best = np.full(len(rr), np.inf)
    lvl = np.full(len(rr), np.nan)
    for rl in rivers:
        s_, d, _ = rl.locate(E, N)
        k = d < best
        best[k] = d[k]
        lvl[k] = rl.level(s_[k])
    ok = np.isfinite(lvl) & (best < 400)
    a[rr[ok], cc[ok]] = np.minimum(a[rr[ok], cc[ok]], lvl[ok] - 2.0)
    horizon.write(CACHE / "horizon" / "dtm_final.tif", a)


def road_mask(feats, g: Raster):
    shapes = []
    for f in feats:
        t = f.tags
        if not isinstance(f.geom, LineString):
            continue
        if t.get("bridge") in ("yes", "viaduct") or t.get("tunnel") in ("yes", "building_passage"):
            continue
        if "highway" in t:
            if t.get("highway") in ("proposed", "construction", "abandoned", "platform", "corridor", "elevator"):
                continue
            w = width_of(t)
            if w > 0:
                shapes.append((f.geom.buffer(w / 2 + 0.5, cap_style=2), 1))
        elif t.get("railway") in ("rail", "siding", "spur", "yard"):
            shapes.append((f.geom.buffer(3.0, cap_style=2), 1))
    return g.rasterize(shapes).astype(bool)


# ----------------------------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------------------------
def build_masks():
    WCACHE.mkdir(parents=True, exist_ok=True)
    feats = osm.load()
    horizon = Raster(CACHE / "horizon" / "dtm.tif")
    g2 = Raster(CACHE / "lidar" / "dem2.tif")
    g1 = Raster(CACHE / "lidar" / "dem1.tif")
    print("rasters loaded", flush=True)
    ndwi2, ndwi1 = ndwi_on(g2), ndwi_on(g1)
    sp1 = sparse_returns(g1)
    sp2 = to_grid(sp1, g1, g2)
    flat2 = g2.flat(win=3, std_max=0.03)
    flat1 = g1.flat(win=5, std_max=0.03)
    out1, out2 = outside_holes(g1.nan), outside_holes(g2.nan)
    rivers = river_lines(feats, horizon)
    rpolys = river_polys(feats)
    river_profiles(rivers, g2, horizon, ndwi2, sp2, flat2, rpolys)
    obs2 = ((ndwi2 > 0.02) | g2.nan | sp2) & ~out2
    obs1 = ((ndwi1 > 0.02) | g1.nan | sp1) & ~out1
    rw2, rS2, rown2, tx2, ty2, sl2 = river_surface(rivers, g2, obs2, flat2, rpolys)
    rw1, rS1, rown1, tx1, ty1, sl1 = river_surface(rivers, g1, obs1, flat1, rpolys)
    print("river wet px", int(rw2.sum()), int(rw1.sum()), flush=True)

    op = osm_ponds(feats)
    bld1 = np.load(CACHE / "ground" / "masks.npz")["bld_vec"]
    osm1 = g1.rasterize([(g, 1) for g, _ in op]).astype(bool)
    lag1 = g1.rasterize([(g, 1) for g, lag in op if lag]).astype(bool)
    excl1 = ndimage.binary_dilation(rw1, iterations=6) | bld1 | out1
    seeds1 = (sp1 & (flat1 | g1.nan)) | (g1.nan & ~out1) | (ndwi1 > 0.1) | osm1
    ids1, bodies1 = detect_ponds(g1, seeds1, excl1, flat1, ndwi1, sp1, lag1, fine=True)
    polys1 = body_polygons(g1, ids1, bodies1, s2_rgb_on(g1))
    in1 = g2.rasterize([(box(g1.left + 40, g1.bottom + 40, g1.right - 40, g1.top - 40), 1)]).astype(bool)
    osm2 = g2.rasterize([(g, 1) for g, _ in op]).astype(bool)
    lag2 = g2.rasterize([(g, 1) for g, lag in op if lag]).astype(bool)
    excl2 = ndimage.binary_dilation(rw2, iterations=4) | in1 | out2
    seeds2 = (g2.nan & ~out2) | (ndwi2 > 0.1) | osm2
    ids2, bodies2 = detect_ponds(g2, seeds2, excl2, flat2, ndwi2, None, lag2, fine=False)
    polys2 = body_polygons(g2, ids2, bodies2, s2_rgb_on(g2))
    print(f"ponds: {len(bodies1)} fine, {len(bodies2)} coarse", flush=True)
    polys = polys1 + polys2
    pw2, pS2, pk2 = pond_surface(polys, g2, rw2)
    pw1, pS1, pk1 = pond_surface(polys1, g1, rw1)
    return dict(feats=feats, horizon=horizon, g1=g1, g2=g2, rivers=rivers, bodies=bodies1 + bodies2, polys=polys,
                r2=(rw2, rS2, tx2, ty2, sl2), r1=(rw1, rS1, tx1, ty1, sl1), p2=(pw2, pS2, pk2), p1=(pw1, pS1, pk1))


def main():
    st = build_masks()
    feats, g1, g2, rivers = st["feats"], st["g1"], st["g2"], st["rivers"]
    rw2, rS2, _, _, _ = st["r2"]
    rw1, rS1, _, _, _ = st["r1"]
    pw2, pS2, pk2 = st["p2"]
    pw1, pS1, pk1 = st["p1"]
    wet2, wet1 = rw2 | pw2, rw1 | pw1
    S2 = np.where(pw2, pS2, rS2).astype(np.float32)
    S1 = np.where(pw1, pS1, rS1).astype(np.float32)
    k2 = np.where(pw2, pk2, RIVER).astype(np.uint8)
    k1 = np.where(pw1, pk1, RIVER).astype(np.uint8)
    road1, road2 = road_mask(feats, g1), road_mask(feats, g2)
    edges = creek_edges(feats)
    creeks = snap_creeks(edges, g1, g2)
    creek_profiles(creeks, g1, g2, [(wet1 | road1, g1), (wet2 | road2, g2)])
    wet_km = sum(int((~c["dry"]).sum()) for c in creeks) / 1000
    print(f"creeks wet {wet_km:.1f} km", flush=True)

    dem2f, dist2, half2, S2x = carve_bodies(g2, g2.a, wet2, S2, k2)
    dem1f, _, _, _ = carve_bodies(g1, g1.a, wet1, S1, k1)
    carve_creeks(creeks, g2, dem2f, road2 | wet2)
    carve_creeks(creeks, g1, dem1f, road1 | wet1)
    g2.write(CACHE / "lidar" / "dem2_final.tif", dem2f)
    g1.write(CACHE / "lidar" / "dem1_final.tif", dem1f)
    print("carved DEMs written", flush=True)

    # River colour: Sentinel-2 reflectance of open river water away from the banks.
    rgb2 = s2_rgb_on(g2)
    core = ndimage.binary_erosion(rw2, iterations=5)
    river_rgb = [float(np.nanmedian(rgb2[k][core])) for k in range(3)]
    print("river colour", [round(v, 4) for v in river_rgb], flush=True)
    del rgb2

    # Open water outlines: the 2 m wetted mask, dilated so the mesh edge hides under the banks.
    shapes_ = [shape(gm).buffer(0) for gm, v in features.shapes(wet2.astype(np.uint8), mask=wet2, transform=g2.t,
                                                                 connectivity=8)]
    fine = [p["geom"] for p in st["polys"]]
    open_geom = unary_union([p.simplify(1.0).buffer(2.5, quad_segs=3) for p in shapes_ + fine]).buffer(0)
    open_geom = open_geom.intersection(box(g2.left, g2.bottom, g2.right, g2.top))
    fields = Fields(g2, S2x, np.where(wet2, k2, 255).astype(np.uint8), dist2, half2, rivers, st["polys"], river_rgb)
    far_geom = far_geometry(feats, rivers, g2, unary_union([p.simplify(2.0).buffer(1.0) for p in shapes_]))
    carve_horizon(st["horizon"], far_geom, rivers, g2)
    export(creeks, fields, open_geom, far_geom, river_rgb)
    import pickle
    pickle.dump({"creeks": creeks, "polys": st["polys"]}, open(WCACHE / "water.pkl", "wb"))


if __name__ == "__main__":
    main()
