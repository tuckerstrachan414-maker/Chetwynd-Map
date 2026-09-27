"""Road, parking and marking meshes per chunk (public/world/roads/i_j.bin, gzip).

Surfaces: OSM centerlines buffered to lane-accurate widths, unioned per surface type, clipped to
the 256 m chunk, triangulated (constrained Delaunay) and draped on the smoothed LiDAR DEM.
Markings: yellow centrelines, white edge/lane lines on arterials, crosswalk bars.

Bridges (OSM bridge=yes) are not draped: they become decks at the approach-road heights with a gentle
camber, concrete slab and parapets (timber for footbridges) and piers on long spans, and are flagged
as physics colliders.

Binary layout: magic 'CWR1', nGroups u32, then per group:
  type u8 (0 asphalt, 1 gravel, 2 dirt, 3 concrete, 10 white paint, 11 yellow paint, 20 structural
  concrete, 22 timber), flags u8 (bit0: collider), pad[2],
  nVerts u32, nIdx u32, pos f32[3n] (x, y, z engine), attr f32[2n] (lateral 0..1, along m), idx u32[m]
Triangles face up (or outwards) in engine space.
"""
import gzip
import math
import struct
from collections import defaultdict

import numpy as np
import rasterio
import triangle
from scipy import ndimage
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.ops import substring, unary_union
from shapely.strtree import STRtree

from . import osm
from .config import CACHE, DETAIL, HORIZON_HALF, NEAR, NODE_BASE, ORIGIN_E, ORIGIN_N, OUT

H = HORIZON_HALF
ASPHALT, GRAVEL, DIRT, CONCRETE, WHITE, YELLOW = 0, 1, 2, 3, 10, 11
STRUCT, TIMBER = 20, 22
COLLIDER = 1
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
    """Road draping surface: the carved 1 m DEM inside its box, the 2 m DEM elsewhere, lightly smoothed."""

    def __init__(self):
        self.srcs = []
        for name, sigma in (("dem1", 1.2), ("dem2", 0.6)):
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
                del idx
            a = ndimage.gaussian_filter(a, sigma)
            h, w = a.shape
            self.srcs.append((a, t, (t.c + 3 * t.a, t.f - (h - 3) * t.a, t.c + (w - 3) * t.a, t.f - 3 * t.a)))

    def __call__(self, E, N):
        E = np.atleast_1d(np.asarray(E, np.float64))
        N = np.atleast_1d(np.asarray(N, np.float64))
        out = np.empty(E.shape)
        todo = np.ones(E.shape, bool)
        for a, t, (x0, y0, x1, y1) in self.srcs:
            m = todo & (E > x0) & (E < x1) & (N > y0) & (N < y1)
            if m.any():
                c = (E[m] - t.c) / t.a - 0.5
                r = (t.f - N[m]) / -t.e - 0.5
                out[m] = ndimage.map_coordinates(a, [r, c], order=1, mode="nearest")
                todo &= ~m
        if todo.any():
            a, t, _ = self.srcs[-1]
            c = (E[todo] - t.c) / t.a - 0.5
            r = (t.f - N[todo]) / -t.e - 0.5
            out[todo] = ndimage.map_coordinates(a, [r, c], order=1, mode="nearest")
        return out


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


def is_bridge(t):
    return t.get("bridge") not in (None, "no") and t.get("layer", "1") not in ("-1", "-2")


class Mesh3:
    """Engine-space triangle soup for one material group."""

    def __init__(self):
        self.pos, self.attr, self.idx = [], [], []
        self.n = 0

    def add(self, pos, attr, tris):
        self.pos.append(np.asarray(pos, np.float64))
        self.attr.append(np.asarray(attr, np.float64))
        self.idx.append(np.asarray(tris, np.int64) + self.n)
        self.n += len(pos)

    def arrays(self):
        return np.concatenate(self.pos), np.concatenate(self.attr), np.concatenate(self.idx)


def extrude(mesh: Mesh3, P, R, Y, profile, closed=False):
    """Sweep a cross-section along stations. P: (n,2) engine xz, R: (n,2) right vectors, Y: (n,) heights.
    `profile` lists (lateral, vertical) points traversed clockwise in the (right, up) plane, so faces point out."""
    prof = list(profile) + ([profile[0]] if closed else [])
    n = len(P)
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    for (l0, v0), (l1, v1) in zip(prof[:-1], prof[1:]):
        a = np.column_stack([P[:, 0] + R[:, 0] * l0, Y + v0, P[:, 1] + R[:, 1] * l0])
        b = np.column_stack([P[:, 0] + R[:, 0] * l1, Y + v1, P[:, 1] + R[:, 1] * l1])
        pos = np.vstack([a, b])
        seglen = math.hypot(l1 - l0, v1 - v0)
        attr = np.column_stack([np.concatenate([np.zeros(n), np.full(n, seglen)]), np.concatenate([along, along])])
        tris = []
        for k in range(n - 1):
            A, B, C, D = k, n + k, n + k + 1, k + 1
            tris += [(A, B, C), (A, C, D)]
        mesh.add(pos, attr, tris)


def box_mesh(mesh: Mesh3, c, ax, hx, hz, y0, y1):
    """Upright box: centre c (x, z), unit axis ax along x-extent, half sizes hx/hz, from y0 to y1."""
    ux = np.array(ax, float)
    uz = np.array([-ux[1], ux[0]])
    corners = [c + ux * sx * hx + uz * sz * hz for sx, sz in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    # Walk the footprint so each wall faces out, whichever way the corners wind.
    area = sum(corners[i][0] * corners[(i + 1) % 4][1] - corners[(i + 1) % 4][0] * corners[i][1] for i in range(4))
    if area > 0:
        corners = corners[::-1]
    for i in range(4):
        p0, p1 = corners[i], corners[(i + 1) % 4]
        pos = [(p0[0], y0, p0[1]), (p1[0], y0, p1[1]), (p1[0], y1, p1[1]), (p0[0], y1, p0[1])]
        w = float(np.linalg.norm(p1 - p0))
        mesh.add(pos, [(0, 0), (w, 0), (w, y1 - y0), (0, y1 - y0)], [(0, 2, 1), (0, 3, 2)])


def bridge_meshes(f_geom, t, w, dem):
    """Deck, structure and railing meshes for one bridge way. Returns {type: Mesh3}."""
    line = f_geom
    L = line.length
    if L < 2:
        return {}
    step = 2.0
    n = max(2, int(math.ceil(L / step)) + 1)
    d = np.linspace(0, L, n)
    pts = np.array([line.interpolate(v).coords[0] for v in d])
    tang = np.gradient(pts, axis=0)
    tang /= np.maximum(np.linalg.norm(tang, axis=1, keepdims=True), 1e-9)
    # Engine xz and right vectors (x = E, z = -N; right = T x up = (-tz, tx)).
    P = np.column_stack([pts[:, 0] - ORIGIN_E, ORIGIN_N - pts[:, 1]])
    T = np.column_stack([tang[:, 0], -tang[:, 1]])
    R = np.column_stack([-T[:, 1], T[:, 0]])
    # Deck heights: approach-road heights at both ends plus a camber.
    back = np.array(line.interpolate(0).coords[0]) - tang[0] * 2.0
    fwd = np.array(line.interpolate(L).coords[0]) + tang[-1] * 2.0
    y0 = float(dem(np.array([pts[0, 0], back[0]]), np.array([pts[0, 1], back[1]])).mean()) + 0.03
    y1 = float(dem(np.array([pts[-1, 0], fwd[0]]), np.array([pts[-1, 1], fwd[1]])).mean()) + 0.03
    u = d / L
    Y = y0 + (y1 - y0) * u + min(0.012 * L, 0.6) * 4 * u * (1 - u)
    hw = t.get("highway")
    foot = hw in ("footway", "path", "cycleway", "pedestrian", "steps", "bridleway", "track")
    rail = t.get("railway") is not None
    out = defaultdict(Mesh3)
    if foot:
        w = max(w, 1.8)
        half = w / 2
        depth = 0.45
        deck = Mesh3()
        # Deck boards with the along coordinate for plank joints.
        extrude(deck, P, R, Y, [(-half, 0.0), (half, 0.0)])
        out[TIMBER] = deck
        extrude(out[TIMBER], P, R, Y, [(half, 0.0), (half, -depth), (-half, -depth), (-half, 0.0)])
        # Railings: posts every ~2 m, a top rail and a mid rail on each side.
        for side in (-1, 1):
            off = side * (half - 0.06)
            for k in range(0, n, 1):
                c = P[k] + R[k] * off
                box_mesh(out[TIMBER], c, T[k], 0.05, 0.05, Y[k], Y[k] + 1.1)
            for hgt, th in ((1.05, 0.06), (0.55, 0.04)):
                prof = [(off - 0.04, hgt - th), (off - 0.04, hgt + th), (off + 0.04, hgt + th), (off + 0.04, hgt - th)]
                extrude(out[TIMBER], P, R, Y, prof, closed=True)
        surf_type = TIMBER
    else:
        half = w / 2
        depth = 1.5 if rail else (0.9 if L < 30 else 1.4)
        par = 0.0 if rail else 0.85
        pw = 0.35
        top = ASPHALT if not rail else GRAVEL
        s_ = surface_of(t) if not rail else GRAVEL
        top = s_ if s_ in (ASPHALT, CONCRETE, GRAVEL, DIRT) else top
        road = Mesh3()
        inner = half - (pw if par else 0.0)
        extrude(road, P, R, Y, [(-inner, 0.0), (inner, 0.0)])
        # Lateral coordinate 0..1 across the roadway for the road shader.
        pos, attr, tris = road.arrays()
        attr[:, 0] = np.concatenate([np.zeros(n), np.ones(n)])
        road = Mesh3()
        road.add(pos, attr, tris)
        out[top] = road
        if par:
            prof = [(inner, 0.0), (inner, par - 0.05), (inner + 0.05, par), (half + 0.05, par), (half + 0.05, -depth),
                    (-half - 0.05, -depth), (-half - 0.05, par), (-inner - 0.05, par), (-inner, par - 0.05), (-inner, 0.0)]
        else:
            prof = [(half, 0.0), (half, -depth), (-half, -depth), (-half, 0.0)]
        extrude(out[STRUCT], P, R, Y, prof)
        surf_type = top
    # Piers on long spans: every ~26 m, down to the ground.
    if L > 22:
        m = int(L // 26)
        for k in range(1, m + 1):
            s_at = L * k / (m + 1)
            i = int(round(s_at / L * (n - 1)))
            g = float(dem(np.array([pts[i, 0]]), np.array([pts[i, 1]]))[0])
            top_y = Y[i] - (0.45 if foot else depth)
            if top_y - g < 1.0:
                continue
            box_mesh(out[STRUCT if not foot else TIMBER], P[i], R[i], max(w * 0.33, 0.3) if not foot else 0.12,
                     0.6 if not foot else 0.12, g - 0.8, top_y)
    del surf_type
    return out


def face_up(pos, tris):
    """Orient draped triangles so they face up in engine space (x = E, z = -N)."""
    tris = np.asarray(tris).copy()
    a, b, c = pos[tris[:, 0]], pos[tris[:, 1]], pos[tris[:, 2]]
    ny = (b[:, 2] - a[:, 2]) * (c[:, 0] - a[:, 0]) - (b[:, 0] - a[:, 0]) * (c[:, 2] - a[:, 2])
    down = ny < 0
    tris[down] = tris[down][:, ::-1]
    return tris


def main():
    dem = Dem()
    feats = osm.load()
    town = box(DETAIL[0] - 1000, DETAIL[1] - 1000, DETAIL[2] + 1000, DETAIL[3] + 1000)
    near_box = box(*NEAR)

    def in_town(g):
        return g.intersects(town)

    ways = []
    bridges = []
    for f in feats:
        t = f.tags
        hw = t.get("highway")
        if not hw or not isinstance(f.geom, LineString) or not f.geom.intersects(near_box):
            continue
        if hw in ("proposed", "construction", "abandoned", "platform", "corridor", "elevator", "raceway"):
            continue
        w = width_of(t)
        if w <= 0:
            continue
        # Beyond the town box only real roads and tracks (no footpaths) are meshed.
        if not in_town(f.geom) and hw not in DRIVE:
            continue
        if is_bridge(t):
            bridges.append((f.geom, t, w))
            continue
        ways.append((f.geom, t, w))
    for f in feats:
        t = f.tags
        if (t.get("railway") in ("rail", "siding", "spur") and isinstance(f.geom, LineString) and is_bridge(t)
                and f.geom.intersects(near_box)):
            bridges.append((f.geom, t, 4.6))
    bridge_zone = unary_union([g.buffer(w / 2 + 0.2, cap_style=2) for g, t, w in bridges]) if bridges else None
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
        if bridge_zone is not None:
            u = u.difference(bridge_zone)
        if taken is not None:
            u = u.difference(taken)
        unions[s] = u
        taken = u if taken is None else unary_union([taken, u])
    trees = {s: STRtree([g for g, _ in lat_lines[s]]) for s in lat_lines}
    marks = marking_lines(ways, unary_union([z for z in (junction_zones, bridge_zone) if z is not None]) or None)
    # Bridge meshes, assigned to the chunk holding their midpoint.
    bridge_by_chunk = defaultdict(list)
    for g, t, w in bridges:
        mid = g.interpolate(0.5, normalized=True)
        ci = int((mid.x - ORIGIN_E + H) // NODE_BASE)
        cj = int((ORIGIN_N - mid.y + H) // NODE_BASE)
        bridge_by_chunk[(ci, cj)].append(bridge_meshes(g, t, w, dem))
    print("bridges", len(bridges))
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
    zone = NEAR
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
            if maxE < zone[0] or minE > zone[2] or maxN < zone[1] or minN > zone[3]:
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
            packed = []
            for s_, xy, y, lat, alg, idx in groups:
                pos = np.stack([xy[:, 0] - ORIGIN_E, y, ORIGIN_N - xy[:, 1]], 1)
                attr = np.stack([lat, alg], 1)
                packed.append((s_, 0, pos, attr, face_up(pos, idx.reshape(-1, 3))))
            merged = defaultdict(Mesh3)
            for bm in bridge_by_chunk.get((i, j), []):
                for s_, m3 in bm.items():
                    if m3.n:
                        merged[s_].add(*m3.arrays())
            for s_, m3 in merged.items():
                pos, attr, tris = m3.arrays()
                packed.append((s_, COLLIDER, pos, attr, tris))
            if not packed:
                continue
            buf = [b"CWR1", struct.pack("<I", len(packed))]
            for s_, flags, pos, attr, tris in packed:
                tris = np.asarray(tris, np.uint32)
                buf.append(struct.pack("<BBxxII", s_, flags, len(pos), tris.size))
                buf.append(pos.astype(np.float32).tobytes())
                buf.append(attr.astype(np.float32).tobytes())
                buf.append(tris.astype(np.uint32).tobytes())
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
