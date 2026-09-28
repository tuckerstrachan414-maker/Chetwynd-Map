"""Download CC0 PBR texture sets (Poly Haven, ambientCG) into cache/textures/<name>/.

Each set provides albedo, normal (OpenGL), roughness, AO and height maps.
"""
import io
import json
import sys
import urllib.request
import zipfile

from .config import CACHE

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) chetwynd-map/0.1"}

# name -> (source, asset id)
TERRAIN = [
    ("lawn", "acg", "Grass002"),
    ("meadow", "acg", "Grass004"),
    ("forest_floor", "ph", "forrest_ground_01"),
    ("conifer_floor", "ph", "forest_leaves_04"),
    ("dirt", "ph", "rocky_trail_02"),
    ("gravel", "ph", "rock_ground"),
    ("asphalt", "ph", "asphalt_02"),
    ("concrete", "ph", "concrete_floor_02"),
    ("river_cobbles", "ph", "river_small_rocks"),
    ("cutbank", "ph", "dry_ground_01"),
    ("mud", "ph", "brown_mud_03"),
    ("moss", "acg", "Moss001"),
    ("ballast", "ph", "gravel_stones"),
    ("stubble", "ph", "withered_grass"),
    ("snow", "acg", "Snow010A"),
    ("sand", "ph", "gravelly_sand"),
]


def get(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=180).read()


def fetch_ph(asset, dst, res):
    files = json.loads(get(f"https://api.polyhaven.com/files/{asset}"))
    want = {"albedo": "Diffuse", "normal": "nor_gl", "rough": "Rough", "ao": "AO", "height": "Displacement"}
    for k, key in want.items():
        if key not in files:
            continue
        entry = files[key][res]
        url = (entry.get("jpg") or entry.get("png"))["url"]
        (dst / f"{k}.{url.rsplit('.', 1)[1]}").write_bytes(get(url))


def fetch_acg(asset, dst, res):
    data = get(f"https://ambientcg.com/get?file={asset}_{res.upper()}-JPG.zip")
    z = zipfile.ZipFile(io.BytesIO(data))
    mapping = {"_Color": "albedo", "_NormalGL": "normal", "_Roughness": "rough", "_AmbientOcclusion": "ao", "_Displacement": "height"}
    for n in z.namelist():
        for suffix, k in mapping.items():
            if suffix in n and n.lower().endswith((".jpg", ".png")):
                (dst / f"{k}.{n.rsplit('.', 1)[1].lower()}").write_bytes(z.read(n))


def main(res="1k"):
    root = CACHE / "textures"
    for name, src, asset in TERRAIN:
        dst = root / name
        if dst.exists() and any(dst.iterdir()):
            continue
        dst.mkdir(parents=True, exist_ok=True)
        (fetch_ph if src == "ph" else fetch_acg)(asset, dst, res)
        (dst / "source.json").write_text(json.dumps({"source": src, "asset": asset, "license": "CC0"}))
        print(name, sorted(p.name for p in dst.iterdir()), flush=True)


if __name__ == "__main__":
    main(*(sys.argv[1:] or []))
