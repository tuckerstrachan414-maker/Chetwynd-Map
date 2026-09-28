"""Extract Overture Maps features for the NEAR zone into local GeoJSON-ish JSON.

Reads GeoParquet directly from the public S3 bucket with a bbox predicate so only
matching row groups are downloaded.
"""
import json
import sys

import pyarrow.compute as pc
import pyarrow.dataset as ds
import pyarrow.fs as pafs
from shapely import wkb

from .config import CACHE, NEAR, OVERTURE_BUCKET, OVERTURE_RELEASE, bbox_wgs84

TYPES = {
    "buildings/building": None,
    "buildings/building_part": None,
    "transportation/segment": None,
    "transportation/connector": None,
    "base/land": None,
    "base/land_use": None,
    "base/land_cover": None,
    "base/water": None,
    "base/infrastructure": None,
    "places/place": None,
    "addresses/address": None,
}


def fetch(type_path: str, bbox):
    theme, typ = type_path.split("/")
    fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    path = f"{OVERTURE_BUCKET}/release/{OVERTURE_RELEASE}/theme={theme}/type={typ}/"
    dset = ds.dataset(path, filesystem=fs, format="parquet")
    minx, miny, maxx, maxy = bbox
    f = (
        (pc.field("bbox", "xmin") < maxx)
        & (pc.field("bbox", "xmax") > minx)
        & (pc.field("bbox", "ymin") < maxy)
        & (pc.field("bbox", "ymax") > miny)
    )
    table = dset.to_table(filter=f)
    rows = table.to_pylist()
    feats = []
    for r in rows:
        g = r.pop("geometry")
        geom = wkb.loads(g).__geo_interface__ if g is not None else None
        r.pop("bbox", None)
        feats.append({"type": "Feature", "geometry": geom, "properties": r})
    return feats


def default(o):
    if isinstance(o, (bytes, bytearray)):
        return o.hex()
    return str(o)


def main(types=None):
    out = CACHE / "overture"
    out.mkdir(parents=True, exist_ok=True)
    bbox = bbox_wgs84(NEAR)
    for t in types or TYPES:
        feats = fetch(t, bbox)
        fn = out / (t.replace("/", "__") + ".json")
        fn.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, default=default))
        print(t, len(feats), "->", fn, flush=True)


if __name__ == "__main__":
    main(sys.argv[1:] or None)
