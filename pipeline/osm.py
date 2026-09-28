"""Load raw Overpass JSON into shapely geometries in the world CRS."""
import json
from functools import lru_cache

from pyproj import Transformer
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import linemerge, polygonize, unary_union

from .config import CACHE, WGS84, WORLD_CRS

AREA_KEYS = {"building", "landuse", "natural", "leisure", "amenity", "area", "water", "man_made",
             "parking", "place", "shop", "tourism", "boundary", "aeroway", "power"}
LINEAR_OVERRIDES = {("natural", "tree_row"), ("natural", "cliff"), ("barrier", "fence"), ("barrier", "wall"),
                    ("barrier", "hedge"), ("barrier", "retaining_wall"), ("man_made", "cutline"),
                    ("man_made", "pipeline"), ("man_made", "embankment"), ("power", "line"),
                    ("power", "minor_line"), ("natural", "coastline"), ("man_made", "dyke")}


class Feature:
    __slots__ = ("id", "type", "tags", "geom")

    def __init__(self, id_, type_, tags, geom):
        self.id, self.type, self.tags, self.geom = id_, type_, tags, geom

    def __repr__(self):
        return f"Feature({self.type}/{self.id}, {self.tags}, {self.geom.geom_type})"


def _is_area(tags, closed):
    if not closed:
        return False
    if tags.get("area") == "no":
        return False
    if tags.get("area") == "yes":
        return True
    for k, v in tags.items():
        if (k, v) in LINEAR_OVERRIDES:
            return False
    if "highway" in tags or "barrier" in tags or "railway" in tags or "waterway" in tags:
        return tags.get("waterway") == "riverbank"
    return any(k in AREA_KEYS for k in tags)


@lru_cache(maxsize=2)
def load(name="near"):
    d = json.load(open(CACHE / "osm" / f"{name}.json"))
    t = Transformer.from_crs(WGS84, WORLD_CRS, always_xy=True)
    nodes = {}
    for e in d["elements"]:
        if e["type"] == "node":
            nodes[e["id"]] = t.transform(e["lon"], e["lat"])
    ways, feats = {}, []
    for e in d["elements"]:
        if e["type"] == "node" and e.get("tags"):
            feats.append(Feature(e["id"], "node", e["tags"], Point(nodes[e["id"]])))
        elif e["type"] == "way":
            coords = [nodes[n] for n in e["nodes"] if n in nodes]
            if len(coords) < 2:
                continue
            ways[e["id"]] = (coords, e["nodes"])
            tags = e.get("tags")
            if not tags:
                continue
            closed = e["nodes"][0] == e["nodes"][-1] and len(coords) >= 4
            if _is_area(tags, closed):
                g = Polygon(coords)
                if not g.is_valid:
                    g = g.buffer(0)
            else:
                g = LineString(coords)
            feats.append(Feature(e["id"], "way", tags, g))
    for e in d["elements"]:
        if e["type"] != "relation" or not e.get("tags"):
            continue
        tags = e["tags"]
        if tags.get("type") not in ("multipolygon", "boundary"):
            continue
        outers, inners = [], []
        for m in e.get("members", []):
            if m["type"] != "way" or m["ref"] not in ways:
                continue
            (outers if m.get("role") != "inner" else inners).append(LineString(ways[m["ref"]][0]))
        try:
            op = list(polygonize(linemerge(outers))) if outers else []
            ip = list(polygonize(linemerge(inners))) if inners else []
            if not op:
                continue
            g = unary_union(op)
            if ip:
                g = g.difference(unary_union(ip))
            if isinstance(g, Polygon):
                g = MultiPolygon([g])
            feats.append(Feature(e["id"], "relation", tags, g))
        except Exception:  # noqa: BLE001 - skip broken relations
            continue
    return feats


def select(pred, name="near"):
    return [f for f in load(name) if pred(f.tags)]
