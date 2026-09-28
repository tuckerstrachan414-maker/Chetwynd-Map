"""Shared configuration for the Chetwynd world-building pipeline.

World frame: NAD83(CSRS) / UTM zone 10N (EPSG:3157), the native frame of the
LidarBC data. Engine coordinates are metres relative to ORIGIN:
    x = easting - ORIGIN_E,   z = -(northing - ORIGIN_N),   y = elevation (CGVD2013)
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
CACHE = ROOT / "cache"
OUT = REPO / "public" / "world"

WORLD_CRS = "EPSG:3157"
WGS84 = "EPSG:4326"

# Town centre (rounded) used as the engine origin.
ORIGIN_E = 587000.0
ORIGIN_N = 6172500.0

# Terrain pyramid: node L covers NODE_BASE * 2**L metres with NODE_RES samples per side
# (+1 overlap sample). Level 0 is 1 m/sample.
NODE_RES = 256
NODE_BASE = 256.0
ROOT_LEVEL = 9  # 131 km root

# Zones as (minE, minN, maxE, maxN) in EPSG:3157.
DETAIL = (583000.0, 6169500.0, 591000.0, 6176500.0)   # full detail, 1 m terrain near features
NEAR = (578000.0, 6164000.0, 596000.0, 6182000.0)     # LiDAR terrain, individual trees
HORIZON_HALF = 65536.0                                # root node half-size around origin

# Overpass mirrors that respond from this environment, tried in order.
OVERPASS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

OVERTURE_RELEASE = "2026-09-23.1"
OVERTURE_BUCKET = "overturemaps-us-west-2"

LIDAR_BASE = "https://nrs.objectstore.gov.bc.ca/gdwuts/"


def bbox_wgs84(zone):
    """Return (minlon, minlat, maxlon, maxlat) covering a UTM zone box."""
    from pyproj import Transformer

    t = Transformer.from_crs(WORLD_CRS, WGS84, always_xy=True)
    xs, ys = [], []
    minE, minN, maxE, maxN = zone
    for e in (minE, maxE):
        for n in (minN, maxN):
            x, y = t.transform(e, n)
            xs.append(x)
            ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)
