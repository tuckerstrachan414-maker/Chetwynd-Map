"""Individual tree and shrub extraction from the LiDAR canopy height model.

Trees: local maxima with height-adaptive windows, watershed crowns, species from crown shape
+ summer/winter Sentinel-2 + ecological context. Shrubs: Poisson samples in the 0.5-2.5 m layer.
Output: cache/trees/trees.npz
"""
import numpy as np
import rasterio
from scipy import ndimage
from skimage.segmentation import watershed

from .config import CACHE
from .grid import Grid, load_pc_stats

# Species codes shared with the runtime (src/world/vegetation/species.ts).
ASPEN, POPLAR, BIRCH, WSPRUCE, BSPRUCE, PINE, WILLOW, ALDER, BLUESPRUCE, MAYDAY, MTNASH = range(11)
SH_ROSE, SH_DOGWOOD, SH_HEDGE, SH_WILLOW = 20, 21, 22, 23


def disk(r):
    y, x = np.ogrid[-int(np.ceil(r)):int(np.ceil(r)) + 1, -int(np.ceil(r)):int(np.ceil(r)) + 1]
    return (x * x + y * y) <= r * r + 0.25


def detect(chm_s, veg_ok):
    radii = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.5]
    rpx = np.clip(0.8 + 0.08 * chm_s, 1.0, 4.5)
    tops = np.zeros(chm_s.shape, dtype=bool)
    for k, r in enumerate(radii):
        lo = radii[k - 1] if k else 0
        sel = (rpx > lo) & (rpx <= r)
        if not sel.any():
            continue
        mx = ndimage.maximum_filter(chm_s, footprint=disk(r))
        tops |= sel & (chm_s >= mx - 1e-3)
    tops &= (chm_s >= 2.5) & veg_ok
    lab, n = ndimage.label(tops, structure=np.ones((3, 3)))
    cents = ndimage.center_of_mass(tops, lab, range(1, n + 1))
    return np.array(cents, dtype=np.float32), lab


def main():
    g = Grid()
    pc = load_pc_stats(g)
    aux = np.load(CACHE / "lidar" / "aux.npz")
    chm = np.clip(np.nan_to_num(aux["chm"]), 0, 60).astype(np.float32)
    masks = np.load(CACHE / "ground" / "masks.npz")
    bld = ndimage.binary_dilation(masks["bld_vec"], iterations=1)
    water = masks["water"]
    urban = masks["urban"]
    veg = ndimage.uniform_filter(pc["vegfrac"], 5)
    roofish = (chm > 2.0) & (ndimage.uniform_filter(pc["vegfrac"], 3) < 0.12)
    veg_ok = (veg > 0.1) & ~bld & ~roofish
    chm_s = ndimage.gaussian_filter(chm, 0.8)
    print("detecting treetops", flush=True)
    cents, _ = detect(chm_s, veg_ok)
    rows = np.clip(np.round(cents[:, 0]).astype(int), 0, chm.shape[0] - 1)
    cols = np.clip(np.round(cents[:, 1]).astype(int), 0, chm.shape[1] - 1)
    print("treetops", len(cents), flush=True)
    markers = np.zeros(chm.shape, dtype=np.int32)
    markers[rows, cols] = np.arange(1, len(cents) + 1)
    crown_mask = (chm_s > 1.5) & veg_ok
    print("watershed", flush=True)
    labels = watershed(-chm_s, markers, mask=crown_mask)
    idx = np.arange(1, len(cents) + 1)
    area = ndimage.sum(np.ones_like(chm, dtype=np.float32), labels, idx)
    hmax = chm[rows, cols]
    hmean = ndimage.mean(chm, labels, idx)
    radius = np.sqrt(np.maximum(area, 1) / np.pi)
    radius = np.minimum(radius, 0.6 + 0.28 * hmax)
    sharp = (hmax - hmean) / np.maximum(hmax, 1)
    # Sentinel-2 context sampled at tree positions (5 m grids -> nearest).
    t = g.transform
    E = t.c + (cents[:, 1] + 0.5) * t.a
    N = t.f + (cents[:, 0] + 0.5) * t.e

    def s2(name, band):
        with rasterio.open(CACHE / "s2" / f"{name}.tif") as f:
            a = f.read(band).astype(np.float32) / 10000
            r, c = rasterio.transform.rowcol(f.transform, E, N)
            r = np.clip(np.asarray(r), 0, a.shape[0] - 1)
            c = np.clip(np.asarray(c), 0, a.shape[1] - 1)
            return a[r, c]

    nir = s2("near", 4)
    red = s2("near", 1)
    wint = (s2("near_winter", 1) + s2("near_winter", 2) + s2("near_winter", 3)) / 3
    ndvi = (nir - red) / (nir + red + 1e-6)
    ground = aux["chm"]  # placeholder to keep arrays aligned
    del ground
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
        dem = f.read(1)
    base = dem[rows, cols]
    # Distance to water for riparian species.
    dwater = ndimage.distance_transform_edt(~water)[rows, cols]
    is_urban = urban[rows, cols]
    np.savez_compressed(CACHE / "trees" / "raw.npz",
                        E=E, N=N, base=base, h=hmax, r=radius, sharp=sharp, nir=nir, wint=wint, ndvi=ndvi,
                        dwater=dwater, urban=is_urban)
    print("features saved", flush=True)
    print("winter brightness pct", np.percentile(wint, [5, 25, 50, 75, 95]).round(3))
    print("sharp pct", np.percentile(sharp, [5, 25, 50, 75, 95]).round(3))
    print("nir pct", np.percentile(nir, [5, 25, 50, 75, 95]).round(3))
    print("height pct", np.percentile(hmax, [5, 25, 50, 75, 95]).round(1), "radius pct", np.percentile(radius, [5, 50, 95]).round(1))




def smooth(x, a, b):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def hash01(*vals):
    h = np.zeros_like(vals[0], dtype=np.uint64)
    for v in vals:
        h = h * np.uint64(6364136223846793005) + (np.asarray(v).astype(np.int64).astype(np.uint64) + np.uint64(1442695040888963407))
        h ^= h >> np.uint64(29)
    return ((h >> np.uint64(11)) & np.uint64((1 << 53) - 1)).astype(np.float64) / float(1 << 53)


def species():
    d = np.load(CACHE / "trees" / "raw.npz")
    E, N, h, r = d["E"], d["N"], d["h"], d["r"]
    ke, kn = np.round(E * 10), np.round(N * 10)
    u1, u2, u3 = hash01(ke, kn, np.full_like(ke, 1)), hash01(ke, kn, np.full_like(ke, 2)), hash01(ke, kn, np.full_like(ke, 3))
    p_w = 1 - smooth(d["wint"], 0.05, 0.12)
    p_s = smooth(d["sharp"], 0.3, 0.55)
    p_n = 1 - smooth(d["nir"], 0.18, 0.26)
    p_con = np.clip(0.5 * p_w + 0.3 * p_s + 0.2 * p_n, 0, 1)
    conifer = u1 < p_con
    sp = np.full(len(E), ASPEN, dtype=np.uint8)
    dw = d["dwater"]
    urban = d["urban"].astype(bool)
    # Conifers.
    bs = conifer & (dw < 60) & (h < 14)
    pine = conifer & ~bs & (d["sharp"] < 0.4) & (u2 < 0.6)
    sp[conifer] = WSPRUCE
    sp[bs] = BSPRUCE
    sp[pine] = PINE
    # Deciduous.
    dec = ~conifer
    sp[dec & (u2 < 0.1)] = BIRCH
    sp[dec & (dw < 200) & (h > 18) & (u2 < 0.6)] = POPLAR
    sp[dec & ~(dw < 200) & (u2 > 0.9)] = POPLAR
    sp[dec & (h < 7) & (dw < 80)] = WILLOW
    sp[dec & (h < 6) & (dw >= 80) & (u3 < 0.3)] = ALDER
    # Town yards.
    sp[urban & conifer & (u3 < 0.7)] = BLUESPRUCE
    sp[urban & dec & (h < 8) & (u3 < 0.5)] = MAYDAY
    sp[urban & dec & (h < 8) & (u3 >= 0.5) & (u3 < 0.75)] = MTNASH
    seed = (u3 * 255).astype(np.uint8)
    import collections
    names = ["aspen", "poplar", "birch", "white spruce", "black spruce", "pine", "willow", "alder", "blue spruce", "mayday", "mtn ash"]
    c = collections.Counter(sp.tolist())
    print({names[k]: v for k, v in sorted(c.items())})
    return {"E": E, "N": N, "base": d["base"], "h": h, "r": r, "sp": sp, "seed": seed}


def shrubs():
    g = Grid()
    aux = np.load(CACHE / "lidar" / "aux.npz")
    chm = np.clip(np.nan_to_num(aux["chm"]), 0, 60)
    masks = np.load(CACHE / "ground" / "masks.npz")
    shrub = masks["shrub"] & ~masks["bld_vec"] & ~masks["water"]
    urban = masks["urban"]
    water = masks["water"]
    # Poisson-ish: jittered grid with spacing 3 m (wild) / 1.6 m (urban hedges).
    out = []
    for spacing, region, kind in ((3.0, ~urban, "wild"), (1.6, urban, "urban")):
        H, W = chm.shape
        gy, gx = np.mgrid[0:H:spacing, 0:W:spacing]
        gy = gy.ravel() + np.random.default_rng(1).uniform(0, spacing, gy.size)
        gx = gx.ravel() + np.random.default_rng(2).uniform(0, spacing, gx.size)
        ri = np.clip(gy.astype(int), 0, H - 1)
        ci = np.clip(gx.astype(int), 0, W - 1)
        keep = shrub[ri, ci] & region[ri, ci]
        ri, ci, gyk, gxk = ri[keep], ci[keep], gy[keep], gx[keep]
        hh = np.clip(ndimage.maximum_filter(chm, 3)[ri, ci], 0.5, 3.0)
        t = g.transform
        E = t.c + gxk * t.a
        N = t.f + gyk * t.e
        dwat = ndimage.distance_transform_edt(~water)[ri, ci]
        u = hash01(np.round(E * 10), np.round(N * 10), np.full(E.shape, 7.0))
        sp = np.where(dwat < 40, SH_WILLOW, np.where(u < 0.6, SH_ROSE, SH_DOGWOOD)).astype(np.uint8)
        if kind == "urban":
            sp[:] = np.where(u < 0.7, SH_HEDGE, SH_ROSE)
        out.append((E, N, hh, sp))
    E = np.concatenate([o[0] for o in out])
    N = np.concatenate([o[1] for o in out])
    hh = np.concatenate([o[2] for o in out])
    sp = np.concatenate([o[3] for o in out])
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
        dem = f.read(1)
        r, c = rasterio.transform.rowcol(f.transform, E, N)
    base = dem[np.clip(np.asarray(r), 0, dem.shape[0] - 1), np.clip(np.asarray(c), 0, dem.shape[1] - 1)]
    print("shrubs", len(E))
    return {"E": E, "N": N, "base": base, "h": hh, "r": hh * 0.6 + 0.4, "sp": sp,
            "seed": (hash01(np.round(E * 10), np.round(N * 10), np.full(E.shape, 9.0)) * 255).astype(np.uint8)}


def finalize():
    t = species()
    s = shrubs()
    np.savez_compressed(CACHE / "trees" / "trees.npz", **{f"t_{k}": v for k, v in t.items()}, **{f"s_{k}": v for k, v in s.items()})
    print("saved", len(t["E"]), "trees", len(s["E"]), "shrubs")


if __name__ == "__main__":
    (CACHE / "trees").mkdir(exist_ok=True)
    main()
    finalize()
