"""Street furniture and utilities: lamps, power poles and lines, transmission towers, hydrants,
stop and street-name signs, traffic signals, benches, bins and playgrounds.

OSM maps almost none of this for Chetwynd (no benches, lamps or hydrants; a few poles, towers, lines
and signals), so mapped objects are used as-is and the rest is inferred with explicit rules. Every
record carries `src` = "osm" | "rule" so the in-game editor can show and correct inferred items.

Rules (town streets = built-up blocks with >= 6 buildings within 60 m):
  lamps      arterials every 38 m staggered on both sides, collectors every 55 m, residential
             every 70 m on one side plus junction corners; 1.2 m behind the road edge, arm to the road
  poles      distribution line on the opposite side of residential/collector streets, every 45 m,
             wired in sequence; mapped power=pole/minor_line kept; power=tower + power=line mapped
  hydrants   every 120 m along town streets, 1.6 m behind the edge, preferring junction corners
  stop signs the minor approach of each junction between different road classes, 5 m back, right side
  names      one post per town junction carrying the two street names
  signals    four corner poles with mast arms at mapped highway=traffic_signals
  benches    along paths in parks, around pitches, downtown sidewalks every 60 m, carving sites; a bin
             beside every other bench
  playground one set per school and park, on open ground away from buildings

Output: public/world/props/props.json (engine coordinates, heights on the carved DEM).
"""
import json
import math
from collections import defaultdict

import numpy as np
import rasterio
from scipy import ndimage
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import osm
from .config import CACHE, DETAIL, NEAR, ORIGIN_E, ORIGIN_N, OUT
from .roads import DRIVE, width_of

RANK = {"trunk": 6, "primary": 5, "secondary": 4, "tertiary": 3, "unclassified": 2, "residential": 2,
        "living_street": 1, "service": 0, "trunk_link": 5, "primary_link": 4, "secondary_link": 3, "tertiary_link": 2}


class Ground:
    def __init__(self):
        srcs = []
        for name in ("dem1", "dem2"):
            path = CACHE / "lidar" / f"{name}_final.tif"
            if not path.exists():
                path = CACHE / "lidar" / f"{name}.tif"
            with rasterio.open(path) as f:
                a = f.read(1)
                t = f.transform
            nan = np.isnan(a)
            if nan.any():
                idx = ndimage.distance_transform_edt(nan, return_distances=False, return_indices=True)
                a = a[idx[0], idx[1]]
            srcs.append((a, t))
        self.srcs = srcs
        with rasterio.open(CACHE / "ground" / "mat1.tif") as f:
            self.mat = f.read(1)
            self.mt = f.transform

    def h(self, E, N):
        for a, t in self.srcs:
            c = (E - t.c) / t.a
            r = (t.f - N) / -t.e
            if 1 <= r < a.shape[0] - 1 and 1 <= c < a.shape[1] - 1:
                return float(ndimage.map_coordinates(a, [[r - 0.5], [c - 0.5]], order=1)[0])
        return float("nan")

    def material(self, E, N):
        c = int((E - self.mt.c) / self.mt.a)
        r = int((self.mt.f - N) / -self.mt.e)
        if 0 <= r < self.mat.shape[0] and 0 <= c < self.mat.shape[1]:
            return int(self.mat[r, c])
        return -1


def eng(E, N):
    return E - ORIGIN_E, ORIGIN_N - N


class Placer:
    """Collision-aware placement: keeps props off roads, out of buildings and water, and apart."""

    def __init__(self, blocked, ground):
        self.blocked = blocked
        self.btree = STRtree(blocked)
        self.ground = ground
        self.pts = defaultdict(list)
        self.grid = defaultdict(list)

    def free(self, E, N, clearance=1.0):
        p = Point(E, N)
        for i in self.btree.query(p.buffer(0.3)):
            if self.blocked[i].contains(p):
                return False
        if self.ground.material(E, N) == 8:  # river cobbles = water
            return False
        k = (int(E // 4), int(N // 4))
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q in self.grid[(k[0] + dx, k[1] + dy)]:
                    if math.hypot(q[0] - E, q[1] - N) < clearance:
                        return False
        return True

    def add(self, kind, E, N, rot, src, extra=None, clearance=1.0, search=2.0):
        """Place near (E, N), searching outwards a little if the spot is taken. Returns the record."""
        for r in np.arange(0, search + 0.01, 0.5):
            for a in (np.linspace(0, 2 * math.pi, 8, endpoint=False) if r > 0 else [0.0]):
                e, n = E + r * math.cos(a), N + r * math.sin(a)
                if self.free(e, n, clearance):
                    y = self.ground.h(e, n)
                    if not np.isfinite(y):
                        return None
                    x, z = eng(e, n)
                    rec = [round(x, 2), round(y, 2), round(z, 2), round(rot, 3), src]
                    if extra is not None:
                        rec.append(extra)
                    self.pts[kind].append(rec)
                    self.grid[(int(e // 4), int(n // 4))].append((e, n))
                    return rec
        return None


def heading_rot(dE, dN):
    """Engine yaw (radians about +y) that turns local +z to face along (dE, dN) in world terms."""
    # Engine x = E, z = -N; three.js yaw rotates +z towards +x.
    return math.atan2(dE, -dN)


def main():
    feats = osm.load()
    ground = Ground()
    town = box(*DETAIL)
    near_box = box(*NEAR)
    ways = []
    for f in feats:
        t = f.tags
        hw = t.get("highway")
        if hw in DRIVE and isinstance(f.geom, LineString) and f.geom.intersects(near_box) and t.get("bridge") is None:
            w = width_of(t)
            if w > 0:
                ways.append((f.geom, t, w))
    # All reconstructed buildings (OSM, Overture ML and LiDAR-only), not just OSM ones.
    brecs = json.loads((CACHE / "buildings" / "buildings.json").read_text())
    blds = [Polygon(b["poly"]) for b in brecs if len(b["poly"]) >= 3]
    blds = [b if b.is_valid else b.buffer(0) for b in blds]
    bxy = np.array([b.centroid.coords[0] for b in blds])
    from scipy.spatial import cKDTree
    btree = cKDTree(bxy)
    road_polys = [g.buffer(w / 2 + 0.4, cap_style=2) for g, t, w in ways]
    paths = [f.geom.buffer(1.0) for f in feats if f.tags.get("highway") in ("footway", "path", "cycleway") and isinstance(f.geom, LineString)]
    rails = [f.geom.buffer(3.0) for f in feats if f.tags.get("railway") in ("rail", "siding", "spur") and isinstance(f.geom, LineString)]
    drives = [g.buffer(2.0) for g, t, w in ways if t.get("service") in ("driveway", "parking_aisle")]
    parking = [f.geom for f in feats if f.tags.get("amenity") == "parking" and isinstance(f.geom, (Polygon, MultiPolygon))]
    blocked = [g.buffer(0.6) for g in blds] + road_polys + paths + rails + drives + parking
    placer = Placer(blocked, ground)

    def urban_at(E, N):
        return town.contains(Point(E, N)) and len(btree.query_ball_point((E, N), 80)) >= 3

    def urban(g):
        # Any part of the way in built-up blocks; placement loops re-check each station.
        L = g.length
        return any(urban_at(*g.interpolate(s).coords[0]) for s in np.linspace(0, L, max(2, int(L / 40))))

    # ---- junctions ----
    ends = defaultdict(list)
    for gi, (g, t, w) in enumerate(ways):
        cs = list(g.coords)
        for k, c in enumerate(cs):
            ends[(round(c[0], 1), round(c[1], 1))].append((gi, k))
    junctions = {c: v for c, v in ends.items() if len({gi for gi, _ in v}) >= 2}

    def approach(gi, k, dist):
        """Point `dist` metres back along way gi from its vertex k, and the unit direction into the junction."""
        g = ways[gi][0]
        cs = list(g.coords)
        s_at = g.project(Point(cs[k]))
        s_back = s_at - dist if s_at >= dist else s_at + dist
        if s_back < 0 or s_back > g.length:
            return None
        p = np.array(g.interpolate(s_back).coords[0])
        j = np.array(cs[k])
        d = j - p
        L = np.linalg.norm(d)
        if L < 1e-6:
            return None
        return p, d / L

    # ---- lamps and distribution poles along town streets ----
    lamp_sides = {}
    for gi, (g, t, w) in enumerate(ways):
        hw = t.get("highway")
        rank = RANK.get(hw, 0)
        if rank < 1 or not urban(g):
            continue
        spacing = 38 if rank >= 4 else 55 if rank == 3 else 70
        both = rank >= 4
        side0 = 1 if (gi % 2) else -1
        lamp_sides[gi] = side0
        L = g.length
        for k, s in enumerate(np.arange(spacing / 2, L, spacing)):
            p = np.array(g.interpolate(s).coords[0])
            if not urban_at(*p):
                continue
            q = np.array(g.interpolate(min(s + 1, L)).coords[0]) - np.array(g.interpolate(max(s - 1, 0)).coords[0])
            tng = q / max(np.linalg.norm(q), 1e-6)
            nrm = np.array([-tng[1], tng[0]])
            sides = [side0 if k % 2 == 0 else -side0] if both else [side0]
            if both:
                sides = [1, -1] if k % 2 == 0 else [-1, 1]
                sides = sides[:1]
            for sd in sides:
                pos = p + nrm * sd * (w / 2 + 1.2)
                # The arm reaches back over the road.
                rot = heading_rot(*(-nrm * sd))
                variant = 1 if rank >= 4 else 0
                placer.add("lamp", pos[0], pos[1], rot, "rule", variant, clearance=3.0)
        # Distribution line on the other side of residential/collector streets.
        if rank in (1, 2, 3):
            chain = []
            for s in np.arange(10, L, 45):
                p = np.array(g.interpolate(s).coords[0])
                if not urban_at(*p):
                    if len(chain) >= 2:
                        placer.pts.setdefault("_wires", []).append(chain)
                    chain = []
                    continue
                q = np.array(g.interpolate(min(s + 1, L)).coords[0]) - np.array(g.interpolate(max(s - 1, 0)).coords[0])
                tng = q / max(np.linalg.norm(q), 1e-6)
                nrm = np.array([-tng[1], tng[0]])
                pos = p + nrm * (-side0) * (w / 2 + 1.6)
                rec = placer.add("pole", pos[0], pos[1], heading_rot(*tng), "rule", None, clearance=2.0, search=3.0)
                if rec is not None:
                    chain.append(len(placer.pts["pole"]) - 1)
            if len(chain) >= 2:
                placer.pts.setdefault("_wires", []).append(chain)

    # ---- mapped power: poles along minor lines, towers along lines ----
    for f in feats:
        t = f.tags
        if t.get("power") in ("minor_line", "line") and isinstance(f.geom, LineString) and f.geom.intersects(near_box):
            kind = "tower" if t["power"] == "line" else "pole"
            chain = []
            cs = list(f.geom.coords)
            for k, c in enumerate(cs):
                a = np.array(cs[max(k - 1, 0)])
                b = np.array(cs[min(k + 1, len(cs) - 1)])
                d = b - a
                if np.linalg.norm(d) < 1e-6:
                    continue
                if not near_box.contains(Point(c)):
                    continue
                rec = placer.add(kind, c[0], c[1], heading_rot(d[0], d[1]), "osm", None, clearance=1.0, search=4.0)
                if rec is not None:
                    chain.append(len(placer.pts[kind]) - 1)
            if len(chain) >= 2:
                placer.pts.setdefault("_wires" if kind == "pole" else "_hv", []).append(chain)
    for f in feats:
        if f.tags.get("power") == "pole" and f.type == "node" and f.geom.intersects(near_box):
            placer.add("pole", f.geom.x, f.geom.y, 0.0, "osm", None, clearance=1.5, search=1.0)

    # ---- hydrants ----
    for gi, (g, t, w) in enumerate(ways):
        if RANK.get(t.get("highway"), 0) < 1 or not urban(g):
            continue
        for s in np.arange(15, g.length, 120):
            p = np.array(g.interpolate(s).coords[0])
            if not urban_at(*p):
                continue
            q = np.array(g.interpolate(min(s + 1, g.length)).coords[0]) - p
            tng = q / max(np.linalg.norm(q), 1e-6)
            nrm = np.array([-tng[1], tng[0]])
            sd = lamp_sides.get(gi, 1)
            pos = p + nrm * sd * (w / 2 + 1.6)
            placer.add("hydrant", pos[0], pos[1], heading_rot(*(-nrm * sd)), "rule", None, clearance=2.0)

    # ---- junction signs ----
    names_used = 0
    for c, lst in junctions.items():
        jp = Point(c)
        if not urban_at(*c):
            continue
        gis = sorted({gi for gi, _ in lst}, key=lambda gi: -RANK.get(ways[gi][1].get("highway"), 0))
        top = RANK.get(ways[gis[0]][1].get("highway"), 0)
        if top < 1:
            continue
        # Stop signs on minor approaches. Where every road has the same class, the shorter street
        # (the side street) stops for the longer one.
        ranks = {gi: RANK.get(ways[gi][1].get("highway"), 0) for gi, _ in lst}
        through = None
        if len(set(ranks.values())) == 1:
            names = defaultdict(float)
            for gi, _ in lst:
                names[ways[gi][1].get("name") or gi] += ways[gi][0].length
            through = max(names, key=names.get)
        for gi, k in lst:
            r = ranks[gi]
            if r < 1:
                continue
            if through is None and r >= top:
                continue
            if through is not None and (ways[gi][1].get("name") or gi) == through:
                continue
            ap = approach(gi, k, 6.0)
            if ap is None:
                continue
            p, d = ap
            w = ways[gi][2]
            right = np.array([d[1], -d[0]])
            pos = p + right * (w / 2 + 0.9)
            # Sign face turned towards approaching traffic.
            placer.add("stop", pos[0], pos[1], heading_rot(*(-d)), "rule", None, clearance=1.0)
        # Street name blades.
        nm = [ways[gi][1].get("name") for gi in gis if ways[gi][1].get("name")]
        uniq = list(dict.fromkeys(nm))
        if len(uniq) >= 2 and all(RANK.get(ways[gi][1].get("highway"), 0) >= 1 for gi in gis[:2]):
            gi, k = next(((g_, k_) for g_, k_ in lst if g_ == gis[-1]), lst[0])
            ap = approach(gi, k, 7.0)
            if ap is not None:
                p, d = ap
                w = ways[gi][2]
                right = np.array([d[1], -d[0]])
                pos = p + right * (w / 2 + 1.4)
                if placer.add("streetname", pos[0], pos[1], heading_rot(*d), "rule", uniq[:2], clearance=1.0):
                    names_used += 1

    # ---- traffic signals ----
    for f in feats:
        if f.tags.get("highway") == "traffic_signals" and f.type == "node" and f.geom.intersects(town):
            jp = f.geom
            near_ways = [gi for gi, (g, t, w) in enumerate(ways) if g.distance(jp) < 2]
            if not near_ways:
                continue
            g, t, w = ways[near_ways[0]]
            s = g.project(jp)
            q = np.array(g.interpolate(min(s + 1, g.length)).coords[0]) - np.array(g.interpolate(max(s - 1, 0)).coords[0])
            tng = q / max(np.linalg.norm(q), 1e-6)
            nrm = np.array([-tng[1], tng[0]])
            half = max(w / 2 + 2.5, 7.0)
            for sx, sy in ((1, 1), (1, -1), (-1, 1), (-1, -1)):
                pos = np.array([jp.x, jp.y]) + tng * sx * half + nrm * sy * half
                # Mast arm reaches over the lanes approaching this corner.
                arm = -(tng * sx)
                placer.add("signal", pos[0], pos[1], heading_rot(*arm), "osm", None, clearance=1.0, search=3.0)

    # ---- benches, bins, playgrounds ----
    parks = [f.geom for f in feats if f.tags.get("leisure") in ("park", "playground", "garden") and isinstance(f.geom, (Polygon, MultiPolygon))]
    pitches = [f.geom for f in feats if f.tags.get("leisure") in ("pitch", "track") and isinstance(f.geom, (Polygon, MultiPolygon))]
    schools = [f.geom for f in feats if f.tags.get("amenity") in ("school", "college", "kindergarten") and isinstance(f.geom, (Polygon, MultiPolygon))]
    commercial = unary_union([f.geom for f in feats if f.tags.get("landuse") in ("commercial", "retail") and isinstance(f.geom, (Polygon, MultiPolygon))])
    bench_n = 0

    def bench(E, N, rot):
        nonlocal bench_n
        if placer.add("bench", E, N, rot, "rule", None, clearance=2.5):
            bench_n += 1
            if bench_n % 2 == 0:
                placer.add("bin", E + 1.4 * math.cos(rot), N - 1.4 * math.sin(rot), rot, "rule", None, clearance=0.8)

    for poly in parks + pitches:
        ring = poly.exterior if isinstance(poly, Polygon) else max(poly.geoms, key=lambda x: x.area).exterior
        inner = ring.parallel_offset(3.0, "left") if ring.is_ccw else ring.parallel_offset(3.0, "right")
        lines = [inner] if isinstance(inner, LineString) else list(getattr(inner, "geoms", []))
        for ln in lines:
            for s in np.arange(10, ln.length, 45):
                p = ln.interpolate(s)
                c = poly.centroid
                bench(p.x, p.y, heading_rot(c.x - p.x, c.y - p.y))
    for g, t, w in ways:
        if not g.intersects(commercial) or RANK.get(t.get("highway"), 0) < 2:
            continue
        for s in np.arange(20, g.length, 60):
            p = np.array(g.interpolate(s).coords[0])
            if not commercial.contains(Point(p)):
                continue
            q = np.array(g.interpolate(min(s + 1, g.length)).coords[0]) - p
            tng = q / max(np.linalg.norm(q), 1e-6)
            nrm = np.array([-tng[1], tng[0]])
            for sd in (1, -1):
                pos = p + nrm * sd * (w / 2 + 1.1)
                bench(pos[0], pos[1], heading_rot(*(-nrm * sd)))
    carv_path = OUT / "props" / "carvings.json"
    if carv_path.exists():
        cv = json.loads(carv_path.read_text())["carvings"]
        for i, c in enumerate(cv[::3]):
            E, N = c["x"] + ORIGIN_E + 3.0, ORIGIN_N - c["z"]
            bench(E, N, heading_rot(-1.0, 0.0))
    for poly in schools + parks[:1]:
        c = poly.representative_point()
        for r in (0, 8, 16, 24):
            if placer.add("playground", c.x + r, c.y, 0.0, "rule", None, clearance=12.0, search=20.0):
                break

    out = {k: v for k, v in placer.pts.items() if not k.startswith("_")}
    out["wires"] = placer.pts.get("_wires", [])
    out["hv"] = placer.pts.get("_hv", [])
    counts = {k: len(v) for k, v in out.items()}
    print("props", counts, "street-name posts", names_used)
    dest = OUT / "props"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "props.json").write_text(json.dumps({
        "note": "src 'osm' = mapped in OpenStreetMap; 'rule' = inferred (see pipeline/props.py)",
        "fields": "[x, y, z, rotY, src, extra?]",
        **out}))


if __name__ == "__main__":
    main()
