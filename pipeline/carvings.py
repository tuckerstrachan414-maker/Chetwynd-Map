"""Chetwynd's chainsaw carvings from the District's official Chainsaw Carving Tour Map.

Source: https://www.gochetwynd.com/wp-content/uploads/2019/02/Chainsaw-Carving-Tour-Map.pdf
(fetched to cache/carvings/tour.pdf). Page 2 has a vector town map with numbered markers (1-154
outdoor carvings) and the table of carving name, carver, country, year, award and location.

1. The map's street strokes are registered to the OSM road network: a scale search with FFT
   cross-correlation for the translation, then iterative-closest-point refinement of an affine map.
2. Marker labels (following leader lines where a marker is drawn away from its spot) are mapped to
   engine coordinates, grouped by their table location, laid out tidily around each group's centre,
   and nudged off roads and out of buildings.

Output: public/world/props/carvings.json
"""
import json
import math
import re

import numpy as np
import pymupdf
import rasterio
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import osm
from .config import CACHE, DETAIL, ORIGIN_E, ORIGIN_N, OUT
from .roads import width_of

MAP_BOX = (585.0, 0.0, 1692.0, 735.0)  # PDF points: the map panel on page 2


def near(c, ref, tol=0.04):
    return c is not None and len(c) >= 3 and all(abs(a - b) < tol for a, b in zip(c, ref))


def path_points(d, step=2.0):
    pts = []
    for it in d["items"]:
        if it[0] == "l":
            a, b = np.array(it[1]), np.array(it[2])
            n = max(1, int(np.linalg.norm(b - a) / step))
            pts += [a + (b - a) * t for t in np.linspace(0, 1, n + 1)]
        elif it[0] == "c":
            p0, p1, p2, p3 = (np.array(x) for x in it[1:5])
            n = max(2, int((np.linalg.norm(p1 - p0) + np.linalg.norm(p2 - p1) + np.linalg.norm(p3 - p2)) / step))
            for t in np.linspace(0, 1, n + 1):
                pts.append((1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3)
    return pts


def extract_map(page):
    """Street sample points and leader-line segments inside the map panel."""
    x0, y0, x1, y1 = MAP_BOX
    streets, leaders = [], []
    for d in page.get_drawings():
        col = d.get("color")
        w = d.get("width") or 0
        if d["type"] != "s":
            continue
        r = d["rect"]
        if r.x0 < x0 or r.y1 > y1:
            continue
        if (near(col, (0.62, 0.62, 0.63)) and w >= 1.4) or near(col, (0.42, 0.34, 0.21)):
            streets += path_points(d)
        elif near(col, (0.14, 0.12, 0.13)) and w <= 0.6:
            for it in d["items"]:
                if it[0] == "l":
                    leaders.append((np.array(it[1]), np.array(it[2])))
    return np.array(streets), leaders


def extract_markers(page, leaders):
    x0, y0, x1, y1 = MAP_BOX
    out = {}
    for w in page.get_text("words"):
        if w[0] < x0 or w[3] > y1:
            continue
        t = w[4]
        if not re.fullmatch(r"\d{1,3}", t):
            continue
        n = int(t)
        if not 1 <= n <= 154:
            continue
        c = np.array([(w[0] + w[2]) / 2, (w[1] + w[3]) / 2])
        # A leader line starting at the marker points to the real spot.
        best, dmin = c, 7.0
        for a, b in leaders:
            for p, q in ((a, b), (b, a)):
                d = np.linalg.norm(p - c)
                if d < dmin and np.linalg.norm(q - c) > 10:
                    best, dmin = q, d
        out.setdefault(n, best)
    return out


def parse_table(page):
    """Rows of the outdoor carving tables: number -> dict of columns."""
    words = page.get_text("words")
    rows = {}
    for region in ((0, 40, 578, 1260), (578, 745, 1140, 1260)):
        rx0, ry0, rx1, ry1 = region
        ws = [w for w in words if rx0 <= w[0] < rx1 and ry0 <= w[1] < ry1]
        hdr = {}
        for w in ws:
            if w[4] in ("CARVING", "CARVER", "COUNTRY", "YEAR", "PLACED", "AWARDS", "LOCATION") and w[4] not in hdr:
                hdr[w[4]] = w[0]
        if "LOCATION" not in hdr:
            continue
        hy = min(w[1] for w in ws if w[4] == "LOCATION")
        cols = sorted([("name", hdr["CARVING"]), ("carver", hdr["CARVER"]), ("country", hdr["COUNTRY"]),
                       ("year", hdr["YEAR"]), ("placed", hdr["PLACED"]), ("awards", hdr["AWARDS"]),
                       ("location", hdr["LOCATION"])], key=lambda c: c[1])
        lines = {}
        for w in ws:
            if w[1] <= hy + 2:
                continue
            key = round((w[1] + w[3]) / 2 / 2.2)
            lines.setdefault(key, []).append(w)
        for key in sorted(lines):
            lw = sorted(lines[key], key=lambda w: w[0])
            if not lw or not re.fullmatch(r"\d{1,3}", lw[0][4]):
                continue
            n = int(lw[0][4])
            rec = {c: [] for c, _ in cols}
            for w in lw[1:]:
                col = cols[0][0]
                for c, cx in cols:
                    if w[0] >= cx - 2:
                        col = c
                rec[col].append(w[4])
            rows[n] = {k: " ".join(v) for k, v in rec.items()}
    return rows


def osm_road_points(feats, step=5.0):
    pts = []
    zone = box(DETAIL[0] - 1500, DETAIL[1] - 1500, DETAIL[2] + 1500, DETAIL[3] + 1500)
    for f in feats:
        t = f.tags
        if t.get("highway") not in ("trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "service",
                                    "living_street", "trunk_link", "primary_link"):
            continue
        if not isinstance(f.geom, LineString) or not f.geom.intersects(zone):
            continue
        g = f.geom
        for d in np.arange(0, g.length, step):
            p = g.interpolate(d)
            pts.append((p.x - ORIGIN_E, ORIGIN_N - p.y))
    return np.array(pts)


def register(M, O):
    """Affine map from PDF points (x right, y down) to engine (x east, z south)."""
    cell = 10.0
    ox0, oz0 = O.min(0) - 500
    ox1, oz1 = O.max(0) + 500
    W, H_ = int((ox1 - ox0) / cell), int((oz1 - oz0) / cell)
    grid = np.zeros((H_, W), np.float32)
    oi = ((O - [ox0, oz0]) / cell).astype(int)
    grid[oi[:, 1], oi[:, 0]] = 1
    grid = ndimage.gaussian_filter(grid, 1.5)
    best = (-1, None, None)
    mc = M.mean(0)
    for s in np.linspace(3.5, 10.0, 66):
        P = (M - mc) * s
        mgrid = np.zeros_like(grid)
        pi = ((P - P.min(0)) / cell).astype(int)
        ok = (pi[:, 0] < W) & (pi[:, 1] < H_)
        if not ok.all():
            continue
        mgrid[pi[:, 1], pi[:, 0]] = 1
        mgrid = ndimage.gaussian_filter(mgrid, 1.5)
        corr = np.fft.irfft2(np.fft.rfft2(grid) * np.conj(np.fft.rfft2(mgrid)), s=grid.shape)
        k = np.unravel_index(np.argmax(corr), corr.shape)
        score = corr[k] / (np.sqrt((mgrid ** 2).sum()) + 1e-9)
        if score > best[0]:
            dz, dx = k
            t = np.array([ox0 + dx * cell, oz0 + dz * cell]) - P.min(0)
            best = (score, s, t)
    _, s, t = best
    A = np.eye(2) * s
    b = t - mc * s
    tree = cKDTree(O)
    for it, thr in enumerate(np.linspace(80, 12, 40)):
        X = M @ A.T + b
        d, k = tree.query(X)
        sel = d < thr
        if sel.sum() < 50:
            break
        Mh = np.column_stack([M[sel], np.ones(sel.sum())])
        sol, *_ = np.linalg.lstsq(Mh, O[k[sel]], rcond=None)
        A, b = sol[:2].T, sol[2]
    X = M @ A.T + b
    d, _ = tree.query(X)
    print(f"map registration: scale {s:.2f} m/pt, median residual {np.median(d):.1f} m, p90 {np.percentile(d, 90):.1f} m")
    return A, b


def main():
    doc = pymupdf.open(CACHE / "carvings" / "tour.pdf")
    page = doc[1]
    M, leaders = extract_map(page)
    markers = extract_markers(page, leaders)
    table = parse_table(page)
    print("streets pts", len(M), "markers", len(markers), "table rows", len(table))
    feats = osm.load()
    O = osm_road_points(feats)
    A, b = register(M, O)
    # Group by table location so carvings at one site are laid out together.
    pos = {n: A @ p + b for n, p in markers.items()}
    groups = {}

    def loc_of(n):
        return (table.get(n, {}).get("location") or f"#{n}").strip().rstrip("*").strip()

    for n, p in pos.items():
        groups.setdefault(loc_of(n), []).append(n)
    # Carvings without a map marker: join their site's group, else the OSM place named in the table.
    named = [(f.tags["name"].lower(), f.geom) for f in feats if f.tags.get("name")]
    for n in sorted(set(table) - set(pos)):
        loc = loc_of(n)
        key = loc.lower().replace("pl", "place") if loc.lower().endswith(" pl") else loc.lower()
        if loc in groups:
            groups[loc].append(n)
            pos[n] = np.mean([pos[m] for m in groups[loc] if m in pos], axis=0)
            continue
        alias = {"cenetaph": "cenotaph", "downtown": "downtown rock", "boulevard": "district boulevard"}
        key = alias.get(key, key)
        if key in (g.lower() for g in groups):
            gname = next(g for g in groups if g.lower() == key)
            groups[gname].append(n)
            pos[n] = np.mean([pos[m] for m in groups[gname] if m in pos], axis=0)
            continue
        words = [w for w in re.split(r"[^a-z0-9]+", key.split(" - ")[0]) if len(w) > 2]
        hit = next((g for nm, g in named if words and all(w in nm for w in words)), None)
        if hit is not None:
            c = hit.centroid if not isinstance(hit, Point) else hit
            pos[n] = np.array([c.x - ORIGIN_E, ORIGIN_N - c.y])
            groups.setdefault(loc, []).append(n)
            print(f"  #{n} placed at OSM '{loc}'")
        else:
            print(f"  #{n} {table[n].get('name')!r} at {loc!r}: no position source, skipped")
    # Obstacles: road surfaces and building footprints.
    roads = []
    for f in feats:
        t = f.tags
        if "highway" in t and isinstance(f.geom, LineString) and width_of(t) > 0:
            roads.append(f.geom.buffer(width_of(t) / 2 + 1.0, cap_style=2))
    blds = [f.geom.buffer(1.0) for f in feats if "building" in f.tags and isinstance(f.geom, (Polygon, MultiPolygon))]
    obst = unary_union(roads + blds)
    otree = STRtree([obst] if isinstance(obst, Polygon) else list(obst.geoms))
    geoms = [obst] if isinstance(obst, Polygon) else list(obst.geoms)

    def free(E, N):
        pt = Point(E, N)
        return not any(geoms[i].contains(pt) for i in otree.query(pt))

    def nudge(E, N):
        if free(E, N):
            return E, N
        for r in np.arange(1.5, 30, 1.5):
            for a in np.linspace(0, 2 * math.pi, int(8 + r * 2), endpoint=False):
                e, n_ = E + r * math.cos(a), N + r * math.sin(a)
                if free(e, n_):
                    return e, n_
        return E, N

    with rasterio.open(CACHE / "lidar" / ("dem1_final.tif" if (CACHE / "lidar" / "dem1_final.tif").exists() else "dem1.tif")) as f:
        dem = f.read(1)
        dt = f.transform
    out = []
    for loc, ns in groups.items():
        c = np.mean([pos[n] for n in ns], axis=0)
        k = len(ns)
        for i, n in enumerate(sorted(ns)):
            # Several carvings at one site: a gentle arc 3.5 m apart around the site.
            if k > 1:
                ang = (i - (k - 1) / 2) * (3.5 / max(4.0, k * 1.2))
                off = np.array([math.sin(ang), -math.cos(ang)]) * max(4.0, k * 1.2) + np.array([0, max(4.0, k * 1.2)])
            else:
                off = np.zeros(2)
            x, z = c + off
            E, N = nudge(x + ORIGIN_E, ORIGIN_N - z)
            r = int((dt.f - N) / -dt.e)
            cc = int((E - dt.c) / dt.a)
            y = float(dem[r, cc]) if 0 <= r < dem.shape[0] and 0 <= cc < dem.shape[1] else float("nan")
            row = table.get(n, {})
            out.append({"n": n, "x": round(E - ORIGIN_E, 2), "y": round(y, 2), "z": round(ORIGIN_N - N, 2),
                        "name": row.get("name", ""), "carver": row.get("carver", ""), "country": row.get("country", ""),
                        "year": row.get("year", ""), "placed": row.get("placed", ""), "awards": row.get("awards", ""),
                        "location": row.get("location", "")})
    out.sort(key=lambda r: r["n"])
    dest = OUT / "props"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "carvings.json").write_text(json.dumps({
        "source": "District of Chetwynd, Chainsaw Carving Tour Map (gochetwynd.com); positions registered from the map",
        "carvings": out}, indent=0))
    print("carvings", len(out), "sites", len(groups))
    debug_png(M, A, b, O, out)
    missing = sorted(set(range(1, 155)) - set(markers))
    print("not on map:", missing[:40])


def debug_png(M, A, b, O, out):
    from PIL import Image, ImageDraw
    X = M @ A.T + b
    lo = np.minimum(X.min(0), O.min(0)) - 50
    hi = np.maximum(X.max(0), O.max(0)) + 50
    sc = 2400 / max(hi - lo)
    im = Image.new("RGB", (int((hi - lo)[0] * sc) + 1, int((hi - lo)[1] * sc) + 1), (20, 20, 24))
    dr = ImageDraw.Draw(im)
    for q in O:
        x, y = (q - lo) * sc
        dr.point((x, y), fill=(120, 120, 120))
    for q in X:
        x, y = (q - lo) * sc
        dr.point((x, y), fill=(230, 160, 40))
    for c in out:
        x, y = (np.array([c["x"], c["z"]]) - lo) * sc
        dr.ellipse((x - 3, y - 3, x + 3, y + 3), fill=(60, 200, 255))
    (CACHE / "debug").mkdir(exist_ok=True)
    im.save(CACHE / "debug" / "carvings_registration.png")


if __name__ == "__main__":
    main()
