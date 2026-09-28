"""Download raw OpenStreetMap data (all tags) for the NEAR zone via Overpass."""
import json
import time
import urllib.parse
import urllib.request

from .config import CACHE, NEAR, OVERPASS, bbox_wgs84


def overpass(query: str, timeout=600):
    last = None
    for ep in OVERPASS:
        for attempt in range(3):
            try:
                data = urllib.parse.urlencode({"data": query}).encode()
                req = urllib.request.Request(ep, data=data, headers={"User-Agent": "chetwynd-map/0.1"})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.load(r)
            except Exception as e:  # noqa: BLE001 - try next mirror
                last = e
                time.sleep(2 ** attempt)
    raise RuntimeError(f"all Overpass mirrors failed: {last}")


def main():
    w, s, e, n = bbox_wgs84(NEAR)
    q = f"[out:json][timeout:500][bbox:{s},{w},{n},{e}];(node;way;relation;);out body;>;out skel qt;"
    d = overpass(q)
    out = CACHE / "osm"
    out.mkdir(parents=True, exist_ok=True)
    (out / "near.json").write_text(json.dumps(d))
    print("elements", len(d["elements"]), d.get("osm3s", {}).get("timestamp_osm_base"))


if __name__ == "__main__":
    main()
