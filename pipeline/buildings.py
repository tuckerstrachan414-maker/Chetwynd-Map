"""Buildings: merge OSM + Overture (Microsoft ML) footprints, align them to LiDAR roofs, add
LiDAR-detected structures missing from both, and fit roof models from the 1 m DSM.

Output: cache/buildings/buildings.json (world coords) consumed by chunks.py.
"""
import hashlib
import json
import math

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio import features
from scipy import ndimage
from shapely import affinity
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.ops import transform as stransform
from shapely.strtree import STRtree

from . import osm
from .config import CACHE
from .grid import Grid, load_pc_stats

HOUSE_TAGS = {"house", "detached", "semidetached_house", "residential", "bungalow", "terrace", "static_caravan"}
SMALL_TAGS = {"garage", "garages", "carport", "shed", "hut", "cabin", "roof", "greenhouse", "kiosk"}
APT_TAGS = {"apartments", "dormitory", "hotel", "motel"}
COM_TAGS = {"commercial", "retail", "supermarket", "office", "restaurant", "bank"}
IND_TAGS = {"industrial", "warehouse", "manufacture", "hangar", "service", "storage_tank", "barn", "farm_auxiliary",
            "transportation", "train_station"}
CIVIC_TAGS = {"school", "college", "university", "kindergarten", "public", "civic", "government", "hospital",
              "fire_station", "sports_hall", "sports_centre"}
CHURCH_TAGS = {"church", "chapel", "cathedral", "religious"}


def h32(s: str) -> int:
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)


def clean(g):
    if g is None or g.is_empty:
        return None
    g = g.buffer(0)
    if isinstance(g, MultiPolygon):
        g = max(g.geoms, key=lambda p: p.area)
    if not isinstance(g, Polygon) or g.area < 4:
        return None
    return g.simplify(0.15, preserve_topology=True)


def load_footprints():
    out = []
    for f in osm.load():
        t = f.tags
        if "building" not in t or t.get("building") in ("no", "construction", "ruins", "demolished"):
            continue
        g = clean(f.geom) if f.geom.geom_type in ("Polygon", "MultiPolygon") else None
        if g is None:
            continue
        out.append({"geom": g, "tags": t, "src": "osm", "id": f"osm{f.type[0]}{f.id}"})
    tree = STRtree([b["geom"] for b in out])
    ov = json.load(open(CACHE / "overture" / "buildings__building.json"))
    tr = Transformer.from_crs(4326, 3157, always_xy=True).transform
    added = 0
    for ft in ov["features"]:
        srcs = [s.get("dataset") for s in (ft["properties"].get("sources") or [])]
        if "OpenStreetMap" in srcs:
            continue
        g = clean(stransform(tr, shape(ft["geometry"])))
        if g is None:
            continue
        hits = tree.query(g)
        if any(out[k]["geom"].intersection(g).area > 0.25 * g.area for k in hits):
            continue
        out.append({"geom": g, "tags": {"building": "yes"}, "src": "msml", "id": f"ov{ft['properties']['id'][:12]}"})
        added += 1
    print("footprints: osm", len(out) - added, "overture-ml", added)
    return out


class Rasters:
    def __init__(self):
        self.g = Grid()
        pc = load_pc_stats(self.g)
        aux = np.load(CACHE / "lidar" / "aux.npz")
        self.chm = aux["chm"]
        self.veg = ndimage.uniform_filter(pc["vegfrac"], 3)
        self.fin = pc["fin"]
        with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
            self.dem = f.read(1)
        with rasterio.open(CACHE / "lidar" / "dsm1.tif") as f:
            self.dsm = f.read(1)
        self.roof = (self.chm > 2.0) & (self.veg < 0.22)

    def window(self, geom, pad):
        minx, miny, maxx, maxy = geom.bounds
        t = self.g.transform
        c0 = int(math.floor((minx - pad - t.c) / t.a))
        c1 = int(math.ceil((maxx + pad - t.c) / t.a))
        r0 = int(math.floor((t.f - (maxy + pad)) / -t.e))
        r1 = int(math.ceil((t.f - (miny - pad)) / -t.e))
        H, W = self.dem.shape
        if c0 < 0 or r0 < 0 or c1 >= W or r1 >= H:
            return None
        return r0, r1, c0, c1

    def mask(self, geom, win, all_touched=False):
        r0, r1, c0, c1 = win
        t = self.g.transform
        from rasterio.transform import Affine
        wt = Affine(t.a, 0, t.c + c0 * t.a, 0, t.e, t.f + r0 * t.e)
        return features.rasterize([(geom, 1)], out_shape=(r1 - r0, c1 - c0), transform=wt, all_touched=all_touched).astype(bool)


def align(b, R: Rasters, max_shift=5):
    """Shift a footprint to best match the LiDAR roof mask (whole-metre then half-metre search)."""
    g = b["geom"]
    win = R.window(g, max_shift + 2)
    if win is None:
        return g, 0.0, (0, 0)
    r0, r1, c0, c1 = win
    roof = R.roof[r0:r1, c0:c1]
    best = (-1.0, 0.0, 0.0)
    base = None
    for dy in np.arange(-max_shift, max_shift + 0.01, 1.0):
        for dx in np.arange(-max_shift, max_shift + 0.01, 1.0):
            m = R.mask(affinity.translate(g, dx, dy), win)
            if m.sum() == 0:
                continue
            s = (m & roof).sum() / m.sum()
            if dx == 0 and dy == 0:
                base = s
            if s > best[0]:
                best = (s, dx, dy)
    s, bx, by = best
    for dy in (by - 0.5, by, by + 0.5):
        for dx in (bx - 0.5, bx, bx + 0.5):
            m = R.mask(affinity.translate(g, dx, dy), win)
            if m.sum() == 0:
                continue
            sc = (m & roof).sum() / m.sum()
            if sc > best[0] + 1e-6:
                best = (sc, dx, dy)
    s, bx, by = best
    base = base or 0.0
    # Only move when the roof evidence clearly improves.
    if s > 0.35 and s > base + 0.05:
        return affinity.translate(g, bx, by), s, (bx, by)
    return g, base, (0, 0)


def lidar_structures(R: Rasters, known):
    """Roof-like LiDAR blobs not explained by any footprint -> regularized rectangles."""
    kn = R.g.rasterize([(b["geom"].buffer(1.5), 1) for b in known]).astype(bool)
    cand = R.roof & ~kn
    cand = ndimage.binary_opening(cand, iterations=1)
    lab, n = ndimage.label(cand)
    objs = ndimage.find_objects(lab)
    out = []
    t = R.g.transform
    for k, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        m = lab[sl] == k
        area = m.sum()
        if area < 9 or area > 5000:
            continue
        rows, cols = np.nonzero(m)
        xs = t.c + (cols + sl[1].start + 0.5) * t.a
        ys = t.f + (rows + sl[0].start + 0.5) * t.e
        from shapely.geometry import MultiPoint
        mp = MultiPoint(list(zip(xs, ys)))
        rect = mp.minimum_rotated_rectangle.buffer(0.5, join_style=2)
        if not isinstance(rect, Polygon):
            continue
        rectangularity = area / max(rect.area, 1)
        chm = R.chm[sl][m]
        if rectangularity < 0.55 or np.median(chm) > 25 or np.median(chm) < 2.2:
            continue
        # Reject vehicles/trailers under 3.2 m tall and small.
        if area < 25 and np.median(chm) < 3.0:
            continue
        out.append({"geom": rect.simplify(0.1), "tags": {"building": "yes"}, "src": "lidar", "id": f"li{k}"})
    print("lidar-only structures", len(out))
    return out


def fit_roof(b, R: Rasters):
    g = b["geom"]
    win = R.window(g, 3)
    if win is None:
        return None
    r0, r1, c0, c1 = win
    inner = g.buffer(-0.6)
    if inner.is_empty or inner.area < 3:
        inner = g
    m_in = R.mask(inner, win)
    ring = R.mask(g.buffer(2.5), win) & ~R.mask(g.buffer(0.8), win)
    dem = R.dem[r0:r1, c0:c1]
    dsm = R.dsm[r0:r1, c0:c1]
    ground_vals = dem[ring & ~np.isnan(dem)]
    if ground_vals.size == 0:
        ground_vals = dem[m_in & ~np.isnan(dem)]
    if ground_vals.size == 0:
        return None
    base = float(np.percentile(ground_vals, 20))
    base_min = float(np.percentile(ground_vals, 2))
    z = dsm[m_in] - base
    ok = ~np.isnan(z)
    if ok.sum() < 3:
        return None
    rows, cols = np.nonzero(m_in)
    t = R.g.transform
    xs = t.c + (cols + c0 + 0.5) * t.a
    ys = t.f + (rows + r0 + 0.5) * t.e
    xs, ys, z = xs[ok], ys[ok], z[ok]
    # Principal axes from the minimum rotated rectangle.
    rect = g.minimum_rotated_rectangle
    rc = np.array(rect.exterior.coords)[:4]
    e1 = rc[1] - rc[0]
    e2 = rc[2] - rc[1]
    if np.linalg.norm(e1) < np.linalg.norm(e2):
        e1, e2 = e2, e1
    L, W = np.linalg.norm(e1), np.linalg.norm(e2)
    ax = e1 / max(L, 1e-6)
    ay = np.array([-ax[1], ax[0]])
    cx, cy = np.array(rect.centroid.coords[0])
    u = (xs - cx) * ax[0] + (ys - cy) * ax[1]
    v = (xs - cx) * ay[0] + (ys - cy) * ay[1]
    zmax = float(np.percentile(z, 98))
    zmin = float(np.percentile(z, 5))
    fits = {}

    def rms(pred):
        return float(np.sqrt(np.mean((pred - z) ** 2)))

    fits["flat"] = (rms(np.full_like(z, np.median(z))), {"h": float(np.median(z))})
    # Gable, ridge along the long axis: z = r - s*|v|.
    A = np.stack([np.ones_like(v), -np.abs(v)], 1)
    sol, *_ = np.linalg.lstsq(A, z, rcond=None)
    fits["gable"] = (rms(A @ sol), {"ridge": float(sol[0]), "slope": float(sol[1]), "axis": 0})
    A2 = np.stack([np.ones_like(u), -np.abs(u)], 1)
    sol2, *_ = np.linalg.lstsq(A2, z, rcond=None)
    fits["gable_x"] = (rms(A2 @ sol2), {"ridge": float(sol2[0]), "slope": float(sol2[1]), "axis": 1})
    # Hip: distance to the ridge segment.
    half = max(L - W, 0) / 2
    dh = np.maximum(np.abs(v), np.abs(u) - half)
    A3 = np.stack([np.ones_like(dh), -dh], 1)
    sol3, *_ = np.linalg.lstsq(A3, z, rcond=None)
    fits["hip"] = (rms(A3 @ sol3), {"ridge": float(sol3[0]), "slope": float(sol3[1])})
    # Shed: plane.
    A4 = np.stack([np.ones_like(u), u, v], 1)
    sol4, *_ = np.linalg.lstsq(A4, z, rcond=None)
    fits["shed"] = (rms(A4 @ sol4), {"a": float(sol4[0]), "bu": float(sol4[1]), "bv": float(sol4[2])})
    penalty = {"flat": 0.0, "gable": 0.05, "gable_x": 0.07, "hip": 0.08, "shed": 0.1}
    kind = min(fits, key=lambda k: fits[k][0] + penalty[k])
    rmsv, p = fits[kind]
    rect_fill = g.area / max(rect.area, 1)
    roof = {"type": "flat"}
    eave = zmin
    if kind in ("gable", "gable_x", "hip") and p["slope"] > 0.08:
        half_span = (W if kind != "gable_x" else L) / 2
        pitch = math.degrees(math.atan(p["slope"]))
        ridge = p["ridge"]
        eave = max(ridge - p["slope"] * half_span, 1.8)
        if pitch > 60 or ridge - eave < 0.3:
            kind = "flat"
        else:
            az = math.degrees(math.atan2(ax[0], ax[1])) if kind != "gable_x" else math.degrees(math.atan2(ay[0], ay[1]))
            roof = {"type": "hipped" if kind == "hip" else "gabled", "pitch": round(pitch, 1), "ridgeAz": round(az % 180, 1),
                    "ridge": round(ridge, 2)}
            if rect_fill < 0.8:
                roof["type"] = "hipped" if kind == "hip" else "gabled"
                roof["complex"] = True
    elif kind == "shed" and math.hypot(p["bu"], p["bv"]) > 0.08:
        slope = math.hypot(p["bu"], p["bv"])
        dirv = (p["bu"] * ax + p["bv"] * ay) / slope
        roof = {"type": "skillion", "pitch": round(math.degrees(math.atan(slope)), 1),
                "dirAz": round(math.degrees(math.atan2(dirv[0], dirv[1])) % 360, 1)}
        eave = zmin
    if roof["type"] == "flat":
        eave = float(np.percentile(z, 70))
    height = max(zmax, eave)
    # Roof brightness (NIR intensity) hints at the roof material.
    fin = R.fin[r0:r1, c0:c1][m_in]
    fin = fin[~np.isnan(fin)]
    rint = float(np.median(fin)) if fin.size else 1.0
    return {"base": round(base, 2), "baseMin": round(base_min, 2), "eave": round(float(max(eave, 2.0)), 2),
            "height": round(float(max(height, 2.2)), 2), "roof": roof, "rms": round(rmsv, 2),
            "roofInt": round(rint, 3), "L": round(float(L), 2), "W": round(float(W), 2)}


MAX_PITCH = {"shed": 35.0, "garage": 40.0, "carport": 20.0, "house": 45.0, "mobile": 25.0, "church": 60.0}
MAX_HEIGHT = {"shed": 4.5, "garage": 6.5, "carport": 4.0, "house": 12.0, "mobile": 5.0}


def long_axis_az(poly):
    """Azimuth (degrees from north, 0-180) of a footprint's long axis."""
    rect = Polygon(poly).minimum_rotated_rectangle
    rc = np.array(rect.exterior.coords)[:4]
    e1, e2 = rc[1] - rc[0], rc[2] - rc[1]
    e = e1 if np.linalg.norm(e1) >= np.linalg.norm(e2) else e2
    return round(math.degrees(math.atan2(e[0], e[1])) % 180, 1)


def sanitize_fit(rec):
    """Keep roof fits physically plausible for the building class.

    Overhanging tree canopy leaks into the DSM over small outbuildings and produces 50-70 degree
    'roofs' reaching tree height. Out-of-range fits (or very noisy ones on small buildings) are
    replaced by class defaults built on the fitted eave, clamped to a sensible height.
    """
    fit = rec.get("fit")
    if not fit or fit.get("sanitized"):
        return False
    cls = rec["cls"]
    roof = fit["roof"]
    W, L = fit["W"], fit["L"]
    area = W * L
    max_p = MAX_PITCH.get(cls, 35.0)
    max_h = MAX_HEIGHT.get(cls)
    if max_h is None and area < 120:
        max_h = 9.0
    pitch = roof.get("pitch", 0.0)
    bad = pitch > max_p or (max_h is not None and fit["height"] > max_h) or (area < 150 and fit["rms"] > 1.2)
    if not bad:
        return False
    eave = min(fit["eave"], (max_h or fit["eave"] + 3) - 1.0, 3.2 if cls in ("shed", "garage", "carport", "mobile") else 6.5)
    eave = max(eave, 2.2)
    az = long_axis_az(rec["poly"])
    if cls == "shed":
        p = 12.0
        roof = {"type": "skillion", "pitch": p, "dirAz": round((az + 90) % 360, 1)}
        top = eave + math.tan(math.radians(p)) * W
    elif cls == "carport":
        roof = {"type": "flat"}
        top = eave
    else:
        p = min(max(pitch, 18.0), max_p, 32.0)
        top = eave + math.tan(math.radians(p)) * W / 2
        roof = {"type": "gabled", "pitch": round(p, 1), "ridgeAz": az, "ridge": round(top, 2)}
    fit["roof"] = roof
    fit["eave"] = round(eave, 2)
    fit["height"] = round(min(top, max_h) if max_h else top, 2)
    fit["sanitized"] = True
    return True


def classify(b, fit, landuse_tree, landuse, pois_tree, pois):
    t = b["tags"].get("building", "yes")
    g = b["geom"]
    area = g.area
    if t in HOUSE_TAGS:
        cls = "house"
    elif t in SMALL_TAGS:
        cls = "carport" if t == "carport" else ("garage" if t.startswith("garage") else "shed")
    elif t in APT_TAGS:
        cls = "apartments"
    elif t in COM_TAGS:
        cls = "commercial"
    elif t in IND_TAGS:
        cls = "industrial"
    elif t in CIVIC_TAGS:
        cls = "civic"
    elif t in CHURCH_TAGS:
        cls = "church"
    else:
        lu = None
        for k in landuse_tree.query(g.centroid):
            if landuse[k][0].contains(g.centroid):
                lu = landuse[k][1]
                break
        has_poi = any(pois[k][0].within(g.buffer(2)) for k in pois_tree.query(g.buffer(2)))
        h = fit["height"] if fit else 5
        if area < 45:
            cls = "garage" if area > 18 else "shed"
        elif lu in ("industrial", "railway", "quarry") or area > 900:
            cls = "industrial"
        elif lu in ("commercial", "retail") or has_poi:
            cls = "commercial"
        elif fit and fit["W"] < 6.2 and fit["L"] / max(fit["W"], 1) > 2.3 and h < 5.5 and area < 200:
            cls = "mobile"
        elif area < 350 and h < 10:
            cls = "house"
        else:
            cls = "commercial"
    if cls == "house" and fit and fit["W"] < 6.2 and fit["L"] / max(fit["W"], 1) > 2.3 and fit["height"] < 5.5:
        cls = "mobile"
    return cls


def main():
    R = Rasters()
    fps = load_footprints()
    # Keep only footprints inside the 1 m LiDAR zone (others get flat default heights in chunks.py).
    moved = 0
    for b in fps:
        g, score, (dx, dy) = align(b, R)
        if dx or dy:
            moved += 1
        b["geom"] = g
        b["score"] = round(float(score), 2)
    print("aligned (moved)", moved, "of", len(fps))
    fps += lidar_structures(R, fps)
    feats = osm.load()
    landuse = [(f.geom, f.tags["landuse"]) for f in feats if "landuse" in f.tags and f.geom.geom_type in ("Polygon", "MultiPolygon")]
    landuse_tree = STRtree([x[0] for x in landuse])
    pois = [(f.geom, f.tags) for f in feats if f.type == "node" and ("shop" in f.tags or "amenity" in f.tags or "tourism" in f.tags or "office" in f.tags)]
    pois_tree = STRtree([x[0] for x in pois])
    out = []
    for b in fps:
        fit = fit_roof(b, R)
        cls = classify(b, fit, landuse_tree, landuse, pois_tree, pois)
        t = b["tags"]
        name = t.get("name")
        if not name:
            for k in pois_tree.query(b["geom"].buffer(3)):
                if pois[k][0].within(b["geom"].buffer(3)) and pois[k][1].get("name"):
                    name = pois[k][1]["name"]
                    break
        coords = [list(map(lambda v: round(v, 2), c)) for c in b["geom"].exterior.coords[:-1]]
        holes = [[list(map(lambda v: round(v, 2), c)) for c in r.coords[:-1]] for r in b["geom"].interiors]
        rec = {"id": b["id"], "src": b["src"], "cls": cls, "poly": coords, "holes": holes, "seed": h32(b["id"]),
               "levels": t.get("building:levels"), "name": name, "fit": fit, "score": b.get("score"),
               "tag": t.get("building"), "roofShapeTag": t.get("roof:shape")}
        sanitize_fit(rec)
        out.append(rec)
    (CACHE / "buildings").mkdir(exist_ok=True)
    (CACHE / "buildings" / "buildings.json").write_text(json.dumps(out))
    import collections
    print("classes", collections.Counter(r["cls"] for r in out))
    print("roofs", collections.Counter(r["fit"]["roof"]["type"] if r["fit"] else None for r in out))


def resanitize():
    """Apply sanitize_fit to an existing buildings.json without refitting."""
    path = CACHE / "buildings" / "buildings.json"
    recs = json.loads(path.read_text())
    fixed = 0
    for r in recs:
        # Re-derive ridge orientation for records sanitized by an earlier version.
        if r.get("fit") and r["fit"].get("sanitized") and r["fit"]["roof"].get("type") == "gabled":
            r["fit"]["roof"]["ridgeAz"] = long_axis_az(r["poly"])
        fixed += sanitize_fit(r)
    path.write_text(json.dumps(recs))
    print("sanitized", fixed, "of", len(recs))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "sanitize":
        resanitize()
        raise SystemExit

    main()
