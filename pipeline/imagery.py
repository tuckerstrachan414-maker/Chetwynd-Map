"""Export Sentinel-2 surface reflectance as sRGB-encoded albedo JPEGs for terrain macro colour.

near.jpg: NEAR zone at 5 m. root.jpg: horizon root node at 32 m.
Pixel row 0 is the north edge. Values are linear reflectance encoded with the sRGB curve.
"""
import json

import numpy as np
import rasterio
from PIL import Image

from .config import CACHE, HORIZON_HALF, NEAR, ORIGIN_E, ORIGIN_N, OUT


def srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def export(name, max_size=None):
    with rasterio.open(CACHE / "s2" / f"{name}.tif") as f:
        a = f.read().astype(np.float32) / 10000.0
    rgb = np.dstack([a[0], a[1], a[2]])
    # L2A reflectance can exceed 1 on bright roofs/clouds; clamp. Missing -> median.
    miss = rgb.sum(-1) <= 0
    if miss.any():
        rgb[miss] = np.median(rgb[~miss], axis=0)
    img = Image.fromarray((srgb(rgb) * 255 + 0.5).astype(np.uint8))
    if max_size and max(img.size) > max_size:
        img = img.resize((max_size, max_size), Image.LANCZOS)
    out = OUT / "imagery"
    out.mkdir(parents=True, exist_ok=True)
    img.save(out / f"{name}.jpg", quality=90, optimize=True, progressive=True)
    return img.size


def main():
    near = export("near")
    root = export("root")
    meta = {
        "near": {"x0": NEAR[0] - ORIGIN_E, "z0": ORIGIN_N - NEAR[3], "size": NEAR[2] - NEAR[0], "px": near[0]},
        "root": {"x0": -HORIZON_HALF, "z0": -HORIZON_HALF, "size": 2 * HORIZON_HALF, "px": root[0]},
    }
    (OUT / "imagery" / "index.json").write_text(json.dumps(meta))
    print(meta)


if __name__ == "__main__":
    main()
