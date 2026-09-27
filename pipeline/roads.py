"""Road, parking and marking meshes per chunk (public/world/roads/i_j.bin, gzip).

Surfaces: OSM centerlines buffered to lane-accurate widths, unioned per surface type, clipped to
the 256 m chunk, triangulated (constrained Delaunay) and draped on the smoothed LiDAR DEM.
Markings: yellow centrelines, white edge/lane lines on arterials, crosswalk bars.

Binary layout: magic 'CWR1', nGroups u32, then per group:
  type u8 (0 asphalt, 1 gravel, 2 dirt, 3 concrete, 10 white paint, 11 yellow paint), pad[3],
  nVerts u32, nIdx u32, pos f32[3n] (x, y, z engine), attr f32[2n] (lateral 0..1, along m), idx u32[m]
"""
import gzip
import math
import struct
from collections import defaultdict

import numpy as np
import rasterio
import triangle
from scipy import ndimage
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, box
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

from . import osm
from .config import CACHE, DETAIL, HORIZON_HALF, NODE_BASE, ORIGIN_E, ORIGIN_N, OUT

H = HORIZON_HALF
ASPHALT, GRAVEL, DIRT, CONCRETE, WHITE, YELLOW = 0, 1, 2, 3, 10, 11
DRIVE = {"motorway", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link", "tertiary",
         "tertiary_link", "residential", "unclassified", "service", "living_street", "track", "road"}
ARTERIAL = {"trunk", "primary", "secondary", "tertiary", "trunk_link", "primary_link"}
PAVED = {"asphalt", "paved", "concrete", "chipseal", "paving_stones"}


def width_of(t):
    hw = t.get("highway")
    try:
        lanes = int(str(t.get("lanes", "0")).split(";")[0])
    except ValueError:
        lanes = 0
    oneway = t.get("oneway") == "yes"
    if hw in ("trunk", "primary", "secondary", "motorway"):
        n = lanes or (1 if oneway else 2)
        return n * 3.65 + (2.6 if oneway else 3.0)
    if hw in ("trunk_link", "primary_link", "secondary_link", "tertiary_link"):
        return 5.5
    if hw == "tertiary":
        return 9.5
    if hw == "residential":
        return 8.5
    if hw in ("unclassified", "road"):
        return 7.0
    if hw == "living_street":
        return 6.0
    if hw == "service":
        return 5.5 if t.get("service") not in ("driveway", "parking_aisle") else (3.6 if t.get("service") == "driveway" else 6.5)
    if hw == "track":
        return 3.4
    if hw in ("footway", "cycleway"):
        return 1.8
    if hw in ("path", "bridleway"):
        return 1.1
    if hw == "pedestrian":
        return 4.0
    if hw == "steps":
        return 1.6
    return 0


def surface_of(t):
    s = t.get("surface")
    hw = t.get("highway")
    if s in PAVED:
        return CONCRETE if s in ("concrete", "paving_stones") and hw in ("footway", "pedestrian") else ASPHALT
    if s in ("dirt", "ground", "earth", "grass", "mud", "sand"):
        return DIRT
    if s in ("gravel", "fine_gravel", "compacted", "unpaved", "pebblestone"):
        return GRAVEL
    if hw in ARTERIAL or hw in ("residential", "living_street", "pedestrian"):
        return ASPHALT
    if hw in ("track", "path", "bridleway"):
        return DIRT
    if hw in ("footway", "cycleway"):
        return CONCRETE if t.get("footway") == "sidewalk" else DIRT
    return GRAVEL


class Dem:
    def __init__(self):
        with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
            a = f.read(1)
            self.t = f.transform
        a = np.where(np.isnan(a), np.nanmean(a), a)
        self.a = ndimage.gaussian_filter(a, 1.2)

    def __call__(self, E, N):
        c = (np.asarray(E) - self.t.c) / self.t.a - 0.5
        r = (self.t.f - np.asarray(N)) / -self.t.e - 0.5
        return ndimage.map_coordinates(self.a, [r, c], order=1, mode="nearest")


def densify(coords, step=2.0):
    out = []
    n = len(coords)
    for k in range(n):
        a = coords[k]
        b = coords[(k + 1) % n]
        out.append(a)
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        m = int(d // step)
        for s in range(1, m + 1):
            f = s / (m + 1)
            out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def triangulate(poly: Polygon, max_area=6.0):
    verts = []
    segs = []
    holes = []
    for ri, ring in enumerate([poly.exterior] + list(poly.interiors)):
        pts = densify(list(ring.coords)[:-1])
        if len(pts) < 3:
            continue
        base = len(verts)
        verts += pts
        segs += [(base + k, base + (k + 1) % len(pts)) for k in range(len(pts))]
        if ri > 0:
            rp = Polygon(ring)
            holes.append(rp.representative_point().coords[0])
    if len(verts) < 3:
        return None, None
    data = {"vertices": np.array(verts), "segments": np.array(segs)}
    if holes:
        data["holes"] = np.array(holes)
    try:
        t = triangle.triangulate(data, f"pq25a{max_area}")
    except Exception:  # noqa: BLE001
        return None, None
    if "triangles" not in t or len(t["triangles"]) == 0:
        return None, None
    return t["vertices"], t["triangles"]


def marking_lines(ways, junction_zones):
    """Paint lines (LineStrings with colour, width and dash pattern) for arterial roads."""
    out = []
    for g, t, w in ways:
        hw = t.get("highway")
        if hw not in ARTERIAL or surface_of(t) != ASPHALT:
            continue
        oneway = t.get("oneway") == "yes"
        try:
            lanes = int(str(t.get("lanes", "0")).split(";")[0]) or (1 if oneway else 2)
        except ValueError:
            lanes = 1 if oneway else 2
        half = w / 2
        edge = half - 0.9
        lines = []
        if not oneway:
            lines += [(g.offset_curve(0.1), YELLOW, 0.11, None), (g.offset_curve(-0.1), YELLOW, 0.11, None)]
            per = max(lanes // 2, 1)
            for k in range(1, per):
                off = k * 3.65
                lines += [(g.offset_curve(off), WHITE, 0.1, (3.0, 9.0)), (g.offset_curve(-off), WHITE, 0.1, (3.0, 9.0))]
            lines += [(g.offset_curve(edge), WHITE, 0.12, None), (g.offset_curve(-edge), WHITE, 0.12, None)]
        else:
            lw = 3.65
            left = -lanes * lw / 2
            lines.append((g.offset_curve(left - 0.05), YELLOW, 0.11, None))
            for k in range(1, lanes):
                lines.append((g.offset_curve(left + k * lw), WHITE, 0.1, (3.0, 9.0)))
            lines.append((g.offset_curve(-left + 0.05), WHITE, 0.12, None))
        for ln, col, wd, dash in lines:
            if ln.is_empty:
                continue
            ln = ln.difference(junction_zones) if junction_zones is not None else ln
            parts = [ln] if isinstance(ln, LineString) else list(getattr(ln, "geoms", []))
            for p in parts:
                if p.length < 1.0:
                    continue
                if dash:
                    on, off = dash
                    d = 0.0
                    while d < p.length:
                        seg = substring(p, d, min(d + on, p.length))
                        if seg.length > 0.3:
                            out.append((seg, col, wd))
                        d += on + off
                else:
                    out.append((p, col, wd))
    return out


def strip_mesh(line: LineString, width, dem, y_off=0.035):
    coords = np.array(line.coords)
    if len(coords) < 2:
        return None
    # Densify to <= 2 m.
    pts = [coords[0]]
    for a, b in zip(coords[:-1], coords[1:]):
        d = np.linalg.norm(b - a)
        n = max(1, int(d // 2.0))
        for s in range(1, n + 1):
            pts.append(a + (b - a) * s / n)
    pts = np.array(pts)
    tang = np.gradient(pts, axis=0)
    tang /= np.maximum(np.linalg.norm(tang, axis=1, keepdims=True), 1e-9)
    nrm = np.stack([-tang[:, 1], tang[:, 0]], 1)
    left = pts + nrm * width / 2
    right = pts - nrm * width / 2
    xy = np.empty((len(pts) * 2, 2))
    xy[0::2] = left
    xy[1::2] = right
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    lat = np.tile([0.0, 1.0], len(pts))
    alg = np.repeat(along, 2)
    idx = []
    for k in range(len(pts) - 1):
        a, b, c, d = 2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 3
        idx += [a, c, b, b, c, d]
    y = dem(xy[:, 0], xy[:, 1]) + y_off
    return xy, y, lat, alg, np.array(idx, dtype=np.uint32)


def main():
    dem = Dem()
    feats = osm.load()
    ways = []
    for f in feats:
        t = f.tags
        hw = t.get("highway")
        if not hw or not isinstance(f.geom, LineString):
            continue
        if hw in ("proposed", "construction", "abandoned", "platform", "corridor", "elevator", "raceway"):
            continue
        w = width_of(t)
        if w <= 0:
            continue
        ways.append((f.geom, t, w))
    # Junction zones: nodes shared by >= 3 way ends/vertices of drivable roads.
    cnt = defaultdict(int)
    for g, t, w in ways:
        if t.get("highway") in DRIVE:
            for c in set(map(lambda p: (round(p[0], 1), round(p[1], 1)), g.coords)):
                cnt[c] += 1
    jz = [Point(c).buffer(9.0) for c, n in cnt.items() if n >= 2]
    junction_zones = unary_union(jz) if jz else None
    by_surface = defaultdict(list)
    lat_lines = defaultdict(list)
    for g, t, w in ways:
        s = surface_of(t)
        cap = 2 if t.get("highway") not in DRIVE else 1
        by_surface[s].append(g.buffer(w / 2, cap_style=cap, join_style=1, quad_segs=4))
        lat_lines[s].append((g, w / 2))
    for f in feats:
        if f.tags.get("amenity") == "parking" and isinstance(f.geom, (Polygon, MultiPolygon)):
            s = GRAVEL if f.tags.get("surface") in ("gravel", "unpaved", "compacted", "dirt", "ground") else ASPHALT
            by_surface[s].append(f.geom)
    # Higher-priority surfaces win where they overlap: asphalt > concrete > gravel > dirt.
    order = [ASPHALT, CONCRETE, GRAVEL, DIRT]
    unions = {}
    taken = None
    for s in order:
        if not by_surface[s]:
            continue
        u = unary_union(by_surface[s]).buffer(0)
        if taken is not None:
            u = u.difference(taken)
        unions[s] = u
        taken = u if taken is None else unary_union([taken, u])
    trees = {s: STRtree([g for g, _ in lat_lines[s]]) for s in lat_lines}
    marks = marking_lines(ways, junction_zones)
    mark_tree = STRtree([m[0] for m in marks]) if marks else None
    # Crosswalk bars at mapped crossings on arterials.
    for f in feats:
        if f.type == "node" and f.tags.get("highway") == "crossing" and f.tags.get("crossing") in ("marked", "zebra", "traffic_signals", "uncontrolled"):
            p = f.geom
            near = [(g, t, w) for g, t, w in ways if t.get("highway") in DRIVE and g.distance(p) < 1.0]
            if not near:
                continue
            g, t, w = near[0]
            d = g.project(p)
            a = np.array(g.interpolate(max(d - 0.5, 0)).coords[0])
            b = np.array(g.interpolate(min(d + 0.5, g.length)).coords[0])
            tang = (b - a) / max(np.linalg.norm(b - a), 1e-6)
            nrm = np.array([-tang[1], tang[0]])
            c = np.array(p.coords[0])
            for k in np.arange(-w / 2 + 0.6, w / 2 - 0.4, 1.0):
                q = c + nrm * k
                marks.append((LineString([q - tang * 1.5, q + tang * 1.5]), WHITE, 0.5))
    mark_tree = STRtree([m[0] for m in marks]) if marks else None

    out = OUT / "roads"
    out.mkdir(parents=True, exist_ok=True)
    zone = DETAIL
    n = int(2 * H / NODE_BASE)
    total = 0
    count = 0
    keys = []
    for j in range(n):
        for i in range(n):
            x0 = -H + i * NODE_BASE
            z0 = -H + j * NODE_BASE
            minE, maxE = ORIGIN_E + x0, ORIGIN_E + x0 + NODE_BASE
            minN, maxN = ORIGIN_N - (z0 + NODE_BASE), ORIGIN_N - z0
            if maxE < zone[0] - 1000 or minE > zone[2] + 1000 or maxN < zone[1] - 1000 or minN > zone[3] + 1000:
                continue
            cb = box(minE, minN, maxE, maxN)
            groups = []
            for s, u in unions.items():
                clip = u.intersection(cb)
                if clip.is_empty:
                    continue
                polys = [clip] if isinstance(clip, Polygon) else [g for g in getattr(clip, "geoms", []) if isinstance(g, Polygon)]
                P, Y, L, A, I = [], [], [], [], []
                off = 0
                for poly in polys:
                    if poly.area < 0.5:
                        continue
                    v, tri = triangulate(poly)
                    if v is None:
                        continue
                    y = dem(v[:, 0], v[:, 1]) + (0.03 if s in (ASPHALT, CONCRETE) else 0.02)
                    lat = np.ones(len(v))
                    if s in trees:
                        tr = trees[s]
                        for k2, (vx, vy) in enumerate(v):
                            pt = Point(vx, vy)
                            best = 1.0
                            for gi in tr.query(pt.buffer(12)):
                                g, hw = lat_lines[s][gi]
                                best = min(best, g.distance(pt) / max(hw, 0.5))
                            lat[k2] = best
                    P.append(v)
                    Y.append(y)
                    L.append(lat)
                    A.append(np.zeros(len(v)))
                    I.append(tri + off)
                    off += len(v)
                if P:
                    groups.append((s, np.concatenate(P), np.concatenate(Y), np.concatenate(L), np.concatenate(A), np.concatenate(I)))
            if mark_tree is not None:
                cand = mark_tree.query(cb)
                bycol = defaultdict(lambda: [[], [], [], [], [], 0])
                for mi in cand:
                    line, col, wd = marks[mi]
                    seg = line.intersection(cb)
                    parts = [seg] if isinstance(seg, LineString) else [g for g in getattr(seg, "geoms", []) if isinstance(g, LineString)]
                    for p in parts:
                        if p.length < 0.3:
                            continue
                        r = strip_mesh(p, wd, dem, 0.045)
                        if r is None:
                            continue
                        xy, y, lat, alg, idx = r
                        acc = bycol[col]
                        acc[0].append(xy)
                        acc[1].append(y)
                        acc[2].append(lat)
                        acc[3].append(alg)
                        acc[4].append(idx + acc[5])
                        acc[5] += len(xy)
                for col, acc in bycol.items():
                    if acc[0]:
                        groups.append((col, np.concatenate(acc[0]), np.concatenate(acc[1]), np.concatenate(acc[2]), np.concatenate(acc[3]), np.concatenate(acc[4])))
            if not groups:
                continue
            buf = [b"CWR1", struct.pack("<I", len(groups))]
            for s, xy, y, lat, alg, idx in groups:
                pos = np.stack([xy[:, 0] - ORIGIN_E, y, ORIGIN_N - xy[:, 1]], 1).astype(np.float32)
                attr = np.stack([lat, alg], 1).astype(np.float32)
                # Flip winding because z = -N mirrors the plane.
                idx = idx.reshape(-1, 3)[:, [0, 2, 1]].astype(np.uint32)
                buf.append(struct.pack("<BxxxII", s, len(pos), idx.size))
                buf.append(pos.tobytes())
                buf.append(attr.tobytes())
                buf.append(idx.tobytes())
            data = gzip.compress(b"".join(buf), 6)
            (out / f"{i}_{j}.bin").write_bytes(data)
            total += len(data)
            count += 1
            keys.append(f"{i}_{j}")
    import json
    (out / "index.json").write_text(json.dumps({"size": NODE_BASE, "half": H, "chunks": keys}))
    print("road chunks", count, "MB", round(total / 1e6, 2))


if __name__ == "__main__":
    main()
