"""Classify ground surfaces at 1 m over the LiDAR zone and export per-node material tiles.

Material IDs match assets-src/build_terrain_textures.mjs LAYERS.
Inputs: LiDAR DEM/DSM + point-cloud statistics, Sentinel-2 NDVI, OSM context.
Outputs: cache/ground/{mat1.tif, masks.npz}, public/world/material/0/i_j.bin (gzip uint8 257x257).
"""
import gzip
import json

import numpy as np
import rasterio
from scipy import ndimage
from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

from . import osm
from .config import CACHE, DETAIL, NODE_BASE, NODE_RES, ORIGIN_E, ORIGIN_N, OUT
from .grid import Grid, load_pc_stats

LAWN, MEADOW, FOREST, CONIFER, DIRT, GRAVEL, ASPHALT, CONCRETE, COBBLES, CUTBANK, MUD, MOSS, BALLAST, STUBBLE, SNOW, SAND = range(16)
NAMES = ["lawn", "meadow", "forest_floor", "conifer_floor", "dirt", "gravel", "asphalt", "concrete", "river_cobbles",
         "cutbank", "mud", "moss", "ballast", "stubble", "snow", "sand"]
COLORS = np.array([[92, 160, 60], [150, 170, 80], [70, 90, 40], [60, 55, 35], [140, 110, 75], [175, 170, 160],
                   [60, 60, 65], [205, 205, 200], [150, 140, 120], [185, 160, 120], [90, 70, 50], [100, 130, 70],
                   [110, 105, 100], [200, 185, 120], [250, 250, 250], [220, 200, 150]], dtype=np.uint8)

# Road widths (m, full paved/traveled width) by OSM highway class.
ROAD_WIDTH = {"motorway": 15, "trunk": 14, "trunk_link": 7, "primary": 11, "primary_link": 7, "secondary": 9,
              "secondary_link": 6, "tertiary": 8, "tertiary_link": 6, "residential": 8, "unclassified": 7,
              "service": 5, "living_street": 6, "track": 3.5, "footway": 1.8, "path": 1.2, "cycleway": 2.5,
              "pedestrian": 4, "steps": 2, "bridleway": 2}
PAVED_DEFAULT = {"motorway", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
                 "tertiary", "tertiary_link", "residential", "living_street", "pedestrian"}
PAVED = {"asphalt", "paved", "concrete", "concrete:plates", "paving_stones", "chipseal"}
UNPAVED = {"unpaved", "gravel", "fine_gravel", "compacted", "dirt", "ground", "earth", "grass", "sand", "mud"}


def road_width(t):
    try:
        if "width" in t:
            return max(1.0, float(str(t["width"]).split()[0]))
    except ValueError:
        pass
    w = ROAD_WIDTH.get(t.get("highway"), 0)
    if t.get("lanes") and t.get("highway") in ("trunk", "primary", "secondary"):
        try:
            w = max(w, 3.6 * int(t["lanes"]) + 3)
        except ValueError:
            pass
    return w


def road_surface(t):
    s = t.get("surface")
    hw = t.get("highway")
    if s in PAVED:
        return ASPHALT if s != "concrete" else CONCRETE
    if s in UNPAVED:
        return DIRT if s in ("dirt", "ground", "earth", "mud", "grass") or hw == "track" else GRAVEL
    if hw in PAVED_DEFAULT:
        return ASPHALT
    if hw in ("track", "path", "bridleway"):
        return DIRT
    if hw in ("footway", "cycleway"):
        return CONCRETE if t.get("footway") == "sidewalk" else DIRT
    return GRAVEL


def as_poly(g):
    if isinstance(g, (Polygon, MultiPolygon)):
        return g
    return None


def classify():
    g = Grid()
    pc = load_pc_stats(g)
    aux = np.load(CACHE / "lidar" / "aux.npz")
    ndvi = np.nan_to_num(aux["ndvi"], nan=0.5)
    chm = aux["chm"]
    with rasterio.open(CACHE / "lidar" / "dem1.tif") as f:
        dem = f.read(1)
    demf = np.where(np.isnan(dem), np.nanmean(dem), dem)
    gy, gx = np.gradient(ndimage.uniform_filter(demf, 3))
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    feats = osm.load()
    tags_of = lambda k, vals: [f for f in feats if f.tags.get(k) in vals]  # noqa: E731

    vegfrac = ndimage.uniform_filter(pc["vegfrac"], 3)
    lofrac = ndimage.uniform_filter(pc["lofrac"], 3)
    gin = pc["gin"].copy()
    gin_f = np.where(np.isnan(gin), pc["fin"], gin)
    gin_f = np.where(np.isnan(gin_f), 1.0, gin_f)
    gin_s = ndimage.median_filter(gin_f, 3)
    # Local grass reference: 60 m neighbourhood median of bright, high-NDVI, open pixels.
    ref_mask = (ndvi > 0.5) & (chm < 0.5)
    num = ndimage.uniform_filter(np.where(ref_mask, gin_s, 0).astype(np.float32), 61)
    den = ndimage.uniform_filter(ref_mask.astype(np.float32), 61)
    ref = np.where(den > 0.02, num / np.maximum(den, 1e-3), 1.05)
    rel = gin_s / np.maximum(ref, 0.3)

    # ---- vector context ----
    def rast(fs, buf=0.0, all_touched=False):
        shapes = []
        for f in fs:
            geom = f.geom.buffer(buf) if buf else f.geom
            if isinstance(geom, (Polygon, MultiPolygon)) or buf:
                shapes.append((geom, 1))
        return g.rasterize(shapes, all_touched=all_touched).astype(bool)

    bld_vec = rast([f for f in feats if "building" in f.tags])
    ov = json.load(open(CACHE / "overture" / "buildings__building.json"))
    from pyproj import Transformer
    from shapely.geometry import shape
    from shapely.ops import transform as stransform
    tr = Transformer.from_crs(4326, 3157, always_xy=True).transform
    ov_shapes = []
    for ft in ov["features"]:
        try:
            ov_shapes.append((stransform(tr, shape(ft["geometry"])), 1))
        except Exception:  # noqa: BLE001
            continue
    bld_vec |= g.rasterize(ov_shapes).astype(bool)
    urban = rast(tags_of("landuse", {"residential", "commercial", "retail", "cemetery", "recreation_ground", "grass",
                                     "religious", "institutional"}))
    urban |= rast(tags_of("leisure", {"park", "pitch", "playground", "garden", "sports_centre", "golf_course", "track"}))
    urban |= rast(tags_of("amenity", {"school", "hospital", "clinic", "place_of_worship", "townhall", "college",
                                      "community_centre", "library", "police", "fire_station"}))
    # Yards: within 35 m of any building counts as maintained grounds.
    near_bld = ndimage.distance_transform_edt(~bld_vec) < 35
    urban |= near_bld
    industrial = rast(tags_of("landuse", {"industrial", "railway", "quarry", "landfill", "construction", "brownfield"}))
    farmland = rast(tags_of("landuse", {"farmland", "meadow", "farmyard"}))
    wetland = rast(tags_of("natural", {"wetland"}))
    water_vec = rast([f for f in feats if f.tags.get("natural") == "water" or f.tags.get("waterway") == "riverbank"
                      or f.tags.get("landuse") in ("reservoir", "basin")])
    parking = [f for f in feats if f.tags.get("amenity") == "parking" and as_poly(f.geom)]

    # ---- LiDAR structure masks ----
    rough = ndimage.generic_filter(np.nan_to_num(chm), np.std, size=3) if False else None  # placeholder (costly)
    canopy = (chm >= 2.5) & (vegfrac >= 0.18) & ~bld_vec
    shrub = (chm >= 0.5) & (chm < 2.5) & ((vegfrac >= 0.15) | (lofrac >= 0.25)) & ~bld_vec
    # Water: mapped water, or near-empty returns on hydro-flattened (zero slope) ground.
    sparse = pc["f_cnt"] < 3
    flat = slope < 0.6
    water = water_vec | (sparse & flat & ndimage.binary_opening(sparse & flat, iterations=2))
    water = ndimage.binary_opening(water, iterations=1)

    # ---- base classification ----
    mat = np.full(g.shape, MEADOW, dtype=np.uint8)
    grass = ndvi >= 0.42
    bare = ~grass
    mat[bare] = DIRT
    mat[grass & urban] = LAWN
    mat[farmland & (ndvi < 0.5)] = STUBBLE
    # Paved/gravel yards and lots in urban or industrial context, by relative intensity.
    built = urban | industrial
    dark = rel < 0.82
    mat[bare & built & dark] = ASPHALT
    mat[bare & built & ~dark] = GRAVEL
    mat[industrial & ~canopy & (ndvi < 0.5)] = np.where(dark, ASPHALT, GRAVEL)[industrial & ~canopy & (ndvi < 0.5)]
    # Also dark, low-NDVI surfaces anywhere are likely paved lots/driveways.
    mat[(ndvi < 0.35) & (rel < 0.7) & ~canopy] = ASPHALT
    mat[wetland & ~canopy] = np.where((np.indices(g.shape).sum(0) % 7) < 3, MUD, MOSS)[wetland & ~canopy]
    # Low vegetation returns are understory in the bush; in town they are mostly parked cars,
    # trampolines, sheds and hedges standing on lawn or driveway, so keep the ground beneath.
    mat[shrub & ~urban & ~industrial] = MOSS
    # Canopy: forest floor unless it is an isolated yard tree over lawn.
    lab, n = ndimage.label(canopy)
    sizes = ndimage.sum(canopy, lab, index=np.arange(1, n + 1))
    small = np.zeros(n + 1, dtype=bool)
    small[1:] = sizes < 250
    yard_tree = small[lab] & urban
    mat[canopy & ~yard_tree] = FOREST
    mat[(slope > 32) & ~canopy & (ndvi < 0.55)] = CUTBANK

    # ---- mapped features override ----
    for f in parking:
        pass
    park_shapes_paved = [(f.geom, 1) for f in parking if f.tags.get("surface") not in UNPAVED]
    park_shapes_gravel = [(f.geom, 1) for f in parking if f.tags.get("surface") in UNPAVED]
    pp = g.rasterize(park_shapes_paved).astype(bool)
    pg = g.rasterize(park_shapes_gravel).astype(bool)
    mat[pp & ~canopy] = ASPHALT
    mat[pg & ~canopy] = GRAVEL
    rail = rast([f for f in feats if f.tags.get("railway") in ("rail", "siding", "spur", "yard")], buf=2.6)
    mat[rail] = BALLAST
    road_layers = {}
    for f in feats:
        t = f.tags
        if "highway" not in t or not isinstance(f.geom, LineString):
            continue
        if t.get("highway") in ("proposed", "construction", "abandoned", "platform", "corridor", "elevator"):
            continue
        if t.get("bridge") in ("yes", "viaduct") or t.get("tunnel") == "yes":
            continue
        w = road_width(t)
        if w <= 0:
            continue
        road_layers.setdefault(road_surface(t), []).append((f.geom.buffer(w / 2, cap_style=2), 1))
    for m in (DIRT, GRAVEL, CONCRETE, ASPHALT):
        if m in road_layers:
            mask = g.rasterize(road_layers[m]).astype(bool)
            mat[mask] = m
    mat[water] = COBBLES
    mat[bld_vec] = CONCRETE

    # Despeckle: 3x3 majority for natural classes only.
    natural = np.isin(mat, [LAWN, MEADOW, FOREST, DIRT, MOSS, STUBBLE, MUD])
    maj = ndimage.generic_filter(mat, lambda v: np.bincount(v.astype(np.int64), minlength=16).argmax(), size=3) if False else mat
    mat = np.where(natural, maj, mat)

    out = CACHE / "ground"
    out.mkdir(parents=True, exist_ok=True)
    prof = dict(driver="GTiff", width=g.shape[1], height=g.shape[0], count=1, dtype="uint8", crs=g.crs,
                transform=g.transform, compress="deflate", tiled=True)
    with rasterio.open(out / "mat1.tif", "w", **prof) as f:
        f.write(mat, 1)
    np.savez_compressed(out / "masks.npz", water=water, canopy=canopy, shrub=shrub, bld_vec=bld_vec, urban=urban,
                        industrial=industrial)
    counts = np.bincount(mat.ravel(), minlength=16)
    print({NAMES[k]: round(counts[k] / mat.size, 4) for k in range(16) if counts[k]})
    return g, mat


def export_tiles(g: Grid, mat: np.ndarray):
    """Write level-0 material tiles (vertex-aligned, 257x257) for nodes inside DETAIL."""
    from .terrain_pyramid import H, LEVEL_COVER, node_box, node_in

    out = OUT / "material" / "0"
    out.mkdir(parents=True, exist_ok=True)
    n = 2 ** 9
    count = 0
    left, top = g.transform.c, g.transform.f
    for j in range(n):
        for i in range(n):
            if not node_in(0, i, j, LEVEL_COVER[0]):
                continue
            x0, z0, S = node_box(0, i, j)
            k = np.arange(NODE_RES + 1)
            E = ORIGIN_E + x0 + k
            N = ORIGIN_N - (z0 + k)
            cols = np.clip(np.floor(E - left).astype(int), 0, mat.shape[1] - 1)
            rows = np.clip(np.floor(top - N).astype(int), 0, mat.shape[0] - 1)
            tile = mat[np.ix_(rows, cols)]
            (out / f"{i}_{j}.bin").write_bytes(gzip.compress(tile.astype(np.uint8).tobytes(), 9, mtime=0))
            count += 1
    print("material tiles", count)


def debug_png(mat):
    from PIL import Image
    img = COLORS[mat[::2, ::2]]
    Image.fromarray(img).save(CACHE / "debug" / "mat1.png")
    r0, c0 = 3800, 5000
    Image.fromarray(COLORS[mat[r0:r0 + 1200, c0:c0 + 1200]]).save(CACHE / "debug" / "mat1_downtown.png")


if __name__ == "__main__":
    grid, m = classify()
    debug_png(m)
    export_tiles(grid, m)
