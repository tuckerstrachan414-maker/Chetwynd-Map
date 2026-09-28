"""Prepare foliage/bark source images for KTX2 encoding.

- Spruce: extract individual twig sprays from the Poly Haven fir twig atlas (alpha components),
  normalize each into a 512x512 cell (base at bottom centre) of a 1024x1024 atlas.
- Pine / aspen sprays (ez-tree, MIT) and Poly Haven leaves used as-is (resized).
- Bark: albedo RGB + roughness in A; normals RGB.
Writes pipeline/cache/treetex/out/*.png and cells.json (UV rects per foliage texture).
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

SRC = "pipeline/cache/treetex"
OUT = f"{SRC}/out"


def rgba(diff, alpha=None):
    im = Image.open(f"{SRC}/{diff}").convert("RGBA")
    if alpha:
        a = Image.open(f"{SRC}/{alpha}").convert("L").resize(im.size)
        im.putalpha(a)
    return im


def bleed(im: Image.Image) -> Image.Image:
    """Extend opaque colours into transparent areas so mip-mapping does not halo."""
    a = np.array(im).astype(np.float32)
    mask = a[..., 3] > 16
    if mask.all() or not mask.any():
        return im
    idx = ndimage.distance_transform_edt(~mask, return_distances=False, return_indices=True)
    rgb = a[..., :3][tuple(idx)]
    a[..., :3] = np.where(mask[..., None], a[..., :3], rgb)
    return Image.fromarray(a.astype(np.uint8))


def spruce():
    im = rgba("fir_tree_01_twig_diff.png", "fir_tree_01_twig_alpha.png")
    nrm = Image.open(f"{SRC}/fir_tree_01_twig_nor_gl.png").convert("RGB").resize(im.size)
    a = np.array(im)[..., 3] > 40
    lab, n = ndimage.label(ndimage.binary_closing(a, iterations=3))
    objs = ndimage.find_objects(lab)
    comps = []
    for k, sl in enumerate(objs, start=1):
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        area = (lab[sl] == k).sum()
        # Sprays are tall blobs away from the bark strips at the atlas edges.
        if area < 2000 or w > im.size[0] * 0.5 or h < 150:
            continue
        if sl[1].start < im.size[0] * 0.08:
            continue
        comps.append((area, sl, k))
    comps.sort(key=lambda c: -c[0])
    comps = comps[:4]
    atlas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    natlas = Image.new("RGB", (1024, 1024), (128, 128, 255))
    cells = []
    for c, (area, sl, k) in enumerate(comps):
        box = (sl[1].start, sl[0].start, sl[1].stop, sl[0].stop)
        crop = im.crop(box)
        m = (lab[sl] == k)
        ca = np.array(crop)
        ca[..., 3] = np.where(m, ca[..., 3], 0)
        crop = Image.fromarray(ca)
        ncrop = nrm.crop(box)
        w, h = crop.size
        s = 500 / max(w, h)
        crop = crop.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
        ncrop = ncrop.resize(crop.size, Image.LANCZOS)
        cx, cy = (c % 2) * 512, (c // 2) * 512
        ox = cx + (512 - crop.size[0]) // 2
        oy = cy + 512 - crop.size[1] - 6
        atlas.alpha_composite(crop, (ox, oy))
        natlas.paste(ncrop, (ox, oy), crop)
        cells.append([cx / 1024, cy / 1024, 0.5, 0.5])
    bleed(atlas).save(f"{OUT}/spruce_albedo.png")
    natlas.save(f"{OUT}/spruce_normal.png")
    print("spruce sprays", len(comps))
    return cells


def simple(name, src, alpha=None, size=1024):
    im = rgba(src, alpha).resize((size, size), Image.LANCZOS)
    bleed(im).save(f"{OUT}/{name}_albedo.png")
    Image.new("RGB", (size, size), (128, 128, 255)).save(f"{OUT}/{name}_normal.png")


def bark(name, diff, nor, rough=None, size=1024):
    im = Image.open(f"{SRC}/{diff}").convert("RGB").resize((size, size), Image.LANCZOS)
    r = Image.open(f"{SRC}/{rough}").convert("L").resize((size, size)) if rough else Image.new("L", (size, size), 230)
    im.putalpha(r)
    im.save(f"{OUT}/bark_{name}_albedo.png")
    Image.open(f"{SRC}/{nor}").convert("RGB").resize((size, size), Image.LANCZOS).save(f"{OUT}/bark_{name}_normal.png")


def main():
    cells = {"spruce": spruce()}
    simple("pine", "pine_color.png")
    simple("aspen", "aspen_color.png")
    im = rgba("tree_small_02_leaves_diff.png", "tree_small_02_leaves_alpha.png").resize((1024, 1024), Image.LANCZOS)
    bleed(im).save(f"{OUT}/leafy_albedo.png")
    Image.open(f"{SRC}/tree_small_02_leaves_nor_gl.png").convert("RGB").resize((1024, 1024), Image.LANCZOS).save(f"{OUT}/leafy_normal.png")
    cells["pine"] = [[0, 0, 1, 1]]
    cells["aspen"] = [[0, 0, 1, 1]]
    cells["leafy"] = [[0, 0, 1, 1]]
    bark("spruce", "fir_tree_01_bark_diff.png", "fir_tree_01_bark_nor_gl.png", "fir_tree_01_bark_rough.png")
    bark("pine", "pine_tree_01_bark_diff.png", "pine_tree_01_bark_nor_gl.png", "pine_tree_01_bark_rough.png")
    bark("birch", "birch_color_1k.jpg", "birch_normal_1k.jpg", "birch_roughness_1k.jpg")
    json.dump(cells, open(f"{OUT}/cells.json", "w"), indent=1)


if __name__ == "__main__":
    sys.exit(main())
