"""Procedural leafy-twig atlases for the deciduous species and shrubs of the Chetwynd area.

Each atlas is 1024x1024 with four 512x512 twig variants (cells.json lists the cell rects). Leaves are
rasterised at 2x and filtered down: species-specific outline (with serrated margins), midrib and
lateral veins, petioles, per-leaf tone and tilt, a soft cross-leaf curvature in the normal map, and
darker, paler undersides where a leaf is turned over. Output PNGs (albedo sRGB + alpha, tangent-space
normal) go to pipeline/cache/treetex/out for build_tree_textures.mjs.

  aspen   trembling aspen: round, abruptly pointed, finely crenate, long flat petioles
  poplar  balsam poplar: ovate, long-pointed, finely toothed, darker and larger
  birch   paper birch: ovate-triangular, doubly serrate
  willow  willow shrubs: narrow lanceolate, entire
  shrub   saskatoon / rose / dogwood mix: small oval, toothed near the tip

Conifer sprays (python gen_leaf_atlases.py conifers):
  spruce  white spruce: flat, pinnately branched sprays densely clothed in short 4-sided needles,
          blue-green with paler new growth at the shoot tips
  pine    lodgepole pine: stout twigs ending in bottlebrush tufts of paired, twisted needles
"""
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "pipeline" / "cache" / "treetex" / "out"
CELL = 512
SS = 2  # supersampling


def srgb(c):
    return np.asarray(c, np.float64) / 255.0


SPECIES = {
    # leaf length (fraction of cell), width ratio, colours (top, underside), leaves per twig, petiole ratio
    "aspen": dict(L=(0.1, 0.145), wr=0.95, top=(92, 128, 52), under=(118, 140, 82), n=(46, 58), pet=0.5,
                  shape="round", teeth=(34, 0.025), gloss=0.35),
    "poplar": dict(L=(0.15, 0.21), wr=0.62, top=(52, 86, 36), under=(120, 124, 92), n=(30, 38), pet=0.28,
                   shape="ovate", teeth=(40, 0.012), gloss=0.45),
    "birch": dict(L=(0.1, 0.135), wr=0.7, top=(80, 118, 44), under=(112, 132, 78), n=(48, 60), pet=0.25,
                  shape="triangular", teeth=(26, 0.035), gloss=0.25),
    "willow": dict(L=(0.14, 0.2), wr=0.2, top=(84, 116, 60), under=(128, 142, 118), n=(64, 80), pet=0.06,
                   shape="lanceolate", teeth=(0, 0.0), gloss=0.2),
    "shrub": dict(L=(0.075, 0.1), wr=0.62, top=(70, 104, 42), under=(104, 122, 76), n=(64, 80), pet=0.12,
                  shape="oval", teeth=(18, 0.03), gloss=0.2),
}


def half_width(shape, u):
    """Leaf half-width profile along the midrib, u in [0, 1] from base to tip (unit max ~0.5)."""
    u = np.clip(u, 0.0, 1.0)
    if shape == "round":
        # Broad, nearly circular blade with a short abrupt tip.
        w = np.sqrt(np.clip(u * (1.0 - u), 0, None)) * 1.05
        w *= 1.0 - 0.55 * np.clip((u - 0.8) / 0.2, 0, 1) ** 2
    elif shape == "ovate":
        w = np.sqrt(np.clip(u, 0, None)) * (1.0 - u) ** 0.8 * 0.95
    elif shape == "triangular":
        w = np.clip(u / 0.25, 0, 1) ** 0.6 * (1.0 - u) ** 1.1 * 0.78
    elif shape == "lanceolate":
        w = np.sin(np.pi * np.clip(u, 0, 1)) ** 0.9 * (1.0 - 0.3 * u) * 0.5
    else:  # oval
        w = np.sqrt(np.clip(u * (1.0 - u), 0, None)) * 0.98
    return w


class Canvas:
    def __init__(self, size):
        self.n = size
        self.col = np.zeros((size, size, 3))
        self.alpha = np.zeros((size, size))
        self.nrm = np.zeros((size, size, 3))
        self.nrm[..., 2] = 1.0
        self.depth = np.full((size, size), -1e9)

    def stroke(self, pts, width, color, depth, rng):
        """Tapered brown/green twig or petiole as a sequence of discs."""
        pts = np.asarray(pts)
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        total = seg.sum()
        if total <= 0:
            return
        steps = max(2, int(total / (width * 0.35 + 0.5)))
        s = np.linspace(0, total, steps)
        cum = np.concatenate([[0], np.cumsum(seg)])
        xs = np.interp(s, cum, pts[:, 0])
        ys = np.interp(s, cum, pts[:, 1])
        ws = width * (1.0 - 0.45 * s / total)
        for x, y, w in zip(xs, ys, ws):
            r = max(w / 2, 0.8)
            x0, x1 = int(max(0, x - r - 1)), int(min(self.n, x + r + 2))
            y0, y1 = int(max(0, y - r - 1)), int(min(self.n, y + r + 2))
            if x1 <= x0 or y1 <= y0:
                continue
            yy, xx = np.mgrid[y0:y1, x0:x1]
            d = np.hypot(xx + 0.5 - x, yy + 0.5 - y) / r
            m = (d < 1.0) & (depth > self.depth[y0:y1, x0:x1])
            if not m.any():
                continue
            # Round cross-section normal.
            ox = (xx + 0.5 - x) / r
            oy = (yy + 0.5 - y) / r
            nz = np.sqrt(np.clip(1 - ox * ox - oy * oy, 0, 1))
            shade = 0.75 + 0.25 * nz
            c = np.asarray(color) * shade[..., None]
            self.col[y0:y1, x0:x1][m] = c[m]
            self.alpha[y0:y1, x0:x1][m] = 1.0
            self.nrm[y0:y1, x0:x1][m] = np.stack([ox * 0.6, oy * 0.6, nz + 0.4], -1)[m]
            self.depth[y0:y1, x0:x1][m] = depth

    def leaf(self, base, angle, length, sp, rng, depth, flip):
        """Rasterise one leaf blade with its base at `base`, midrib along `angle`."""
        wr = sp["wr"] * rng.uniform(0.85, 1.1)
        # Tilt about the midrib foreshortens the blade; roll gives a view of the curvature.
        tilt = rng.uniform(0.0, 1.1)
        squash = max(math.cos(tilt), 0.25)
        bend = rng.uniform(-0.12, 0.12)  # midrib curvature
        L = length
        W = L * wr * squash
        ca, sa = math.cos(angle), math.sin(angle)
        r = L * 0.6 + W
        x0, x1 = int(max(0, base[0] - r)), int(min(self.n, base[0] + r + 1))
        y0, y1 = int(max(0, base[1] - r)), int(min(self.n, base[1] + r + 1))
        if x1 <= x0 or y1 <= y0:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1]
        dx = xx + 0.5 - base[0]
        dy = yy + 0.5 - base[1]
        u = (dx * ca + dy * sa) / L
        v = (-dx * sa + dy * ca)
        v = v - bend * L * u * u  # curved midrib
        hw = half_width(sp["shape"], u) * L * wr * squash
        nt, amp = sp["teeth"]
        if nt:
            # Serrated/crenate margin: saw teeth pointing towards the tip.
            ph = (u * nt) % 1.0
            teeth = (1.0 - ph) * amp * L * squash * np.clip(u * 3.0, 0, 1) * np.clip((1 - u) * 6.0, 0, 1)
            hw = hw + teeth - amp * L * squash * 0.5
        inside = (u >= 0) & (u <= 1) & (np.abs(v) <= hw)
        m = inside & (depth > self.depth[y0:y1, x0:x1])
        if not m.any():
            return
        vn = np.where(hw > 1e-6, v / np.maximum(hw, 1e-6), 0.0)
        top = srgb(sp["top"]) if not flip else srgb(sp["under"])
        tone = rng.uniform(0.72, 1.15)
        hue = rng.uniform(-0.06, 0.06)
        base_col = np.clip(top * tone + np.array([hue, hue * 0.4, -hue * 0.5]), 0, 1)
        # Veins: midrib and pinnate laterals.
        mid = np.exp(-(v / (0.018 * L + 0.6)) ** 2)
        lat_ang = 0.9
        lat = np.abs(((u * 7.0 - np.abs(vn) * lat_ang * 2.2) % 1.0) - 0.5)
        lateral = np.exp(-(lat / 0.05) ** 2) * np.clip(1 - np.abs(vn), 0, 1) * (u > 0.08)
        vein = np.clip(mid * 1.0 + lateral * 0.5, 0, 1)
        vein_col = base_col * (1.25 if not flip else 1.1) + 0.03
        # Curvature shading across the blade and a sheen near the midrib for glossy species.
        curve = 1.0 - 0.22 * vn * vn
        sheen = sp["gloss"] * np.exp(-((vn - 0.35) / 0.35) ** 2) * (0.6 + 0.4 * u) * (not flip)
        speck = rng.normal(0, 0.02, size=u.shape)
        edge_dark = 1.0 - 0.18 * np.clip((np.abs(vn) - 0.8) / 0.2, 0, 1)
        c = (base_col[None, None] * (curve * edge_dark + speck)[..., None]) * (1 - vein[..., None] * 0.6) \
            + vein_col[None, None] * vein[..., None] * 0.6
        c = c + sheen[..., None] * 0.12
        # Tangent-space normal: blade tilt (roll about the midrib), cross curvature, vein grooves.
        roll = tilt * (1 if rng.random() < 0.5 else -1)
        nxl = vn * 0.35 + math.sin(roll) * 0.6
        nyl = -vein * 0.25 + (u - 0.5) * 0.1
        # Rotate local (across, along) into canvas axes.
        nx = -nxl * sa + nyl * ca
        ny = nxl * ca + nyl * sa
        nz = np.ones_like(nx)
        n = np.stack([nx, ny, nz], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        sub = (slice(y0, y1), slice(x0, x1))
        self.col[sub][m] = np.clip(c[m], 0, 1)
        self.alpha[sub][m] = 1.0
        self.nrm[sub][m] = n[m]
        self.depth[sub][m] = depth


def twig(species, seed):
    sp = SPECIES[species]
    rng = np.random.default_rng(seed)
    n = CELL * SS
    cv = Canvas(n)
    stem_col = np.array([0.33, 0.24, 0.16]) if species != "willow" else np.array([0.45, 0.32, 0.18])
    if species == "aspen":
        stem_col = np.array([0.42, 0.36, 0.26])
    # Main twig from the bottom centre, gently curving up, with alternate side shoots filling the card.
    start = np.array([n * rng.uniform(0.45, 0.55), n * 0.995])
    ang = -math.pi / 2 + rng.uniform(-0.15, 0.15)
    main = [start]
    p = start.copy()
    steps = 16
    for k in range(steps):
        ang += rng.uniform(-0.1, 0.1)
        p = p + np.array([math.cos(ang), math.sin(ang)]) * n * 0.9 / steps
        main.append(p.copy())
    main = np.array(main)
    shoots = [main]
    n_sh = int(rng.integers(5, 9))
    for k in range(n_sh):
        i = int(3 + (steps - 5) * (k + rng.uniform(0.1, 0.9)) / n_sh)
        base_a = math.atan2(main[i + 1][1] - main[i][1], main[i + 1][0] - main[i][0])
        a = base_a + (1 if k % 2 else -1) * rng.uniform(0.6, 1.1)
        q = main[i].copy()
        sh = [q.copy()]
        # Lower shoots reach further out, like a real spray.
        ln = n * rng.uniform(0.28, 0.46) * (1.15 - 0.5 * k / n_sh)
        for s_ in range(7):
            a += (base_a - a) * 0.08 + rng.uniform(-0.08, 0.08)
            q = q + np.array([math.cos(a), math.sin(a)]) * ln / 7
            q = np.clip(q, n * 0.04, n * 0.96)
            sh.append(q.copy())
        shoots.append(np.array(sh))
    for k, sh in enumerate(shoots):
        cv.stroke(sh, n * (0.012 if k == 0 else 0.007), stem_col, depth=-5.0 + k * 0.01, rng=rng)
    # Leaves: attached along shoots (alternate), on petioles, oriented outwards and upwards.
    count = int(rng.integers(*sp["n"]))
    order = []
    weights = np.array([np.linalg.norm(np.diff(sh, axis=0), axis=1).sum() for sh in shoots])
    weights[0] *= 0.6
    weights /= weights.sum()
    for i in range(count):
        sh = shoots[int(rng.choice(len(shoots), p=weights))]
        t = rng.uniform(0.25, 1.0) ** 0.7
        seg = np.linalg.norm(np.diff(sh, axis=0), axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)])
        s = t * cum[-1]
        j = min(int(np.searchsorted(cum, s)) - 1, len(sh) - 2)
        j = max(j, 0)
        f = (s - cum[j]) / max(seg[j], 1e-6)
        at = sh[j] * (1 - f) + sh[j + 1] * f
        tang = math.atan2(sh[j + 1][1] - sh[j][1], sh[j + 1][0] - sh[j][0])
        side = 1 if i % 2 else -1
        a = tang + side * rng.uniform(0.5, 1.3)
        L = n * rng.uniform(*sp["L"])
        pet = L * sp["pet"] * rng.uniform(0.7, 1.2)
        depth = rng.uniform(0, 1)
        order.append((depth, at, a, L, pet, i))
    order.sort(key=lambda o: o[0])
    for depth, at, a, L, pet, i in order:
        tip = at + np.array([math.cos(a), math.sin(a)]) * pet
        if pet > 2:
            cv.stroke([at, (at + tip) / 2 + rng.normal(0, 1.5, 2), tip], max(n * 0.0035, 1.5), stem_col * 1.15, depth, rng)
        la = a + rng.uniform(-0.35, 0.35)
        # Keep the whole blade inside the cell so no leaf is cut by the card edge.
        for _ in range(4):
            far = tip + np.array([math.cos(la), math.sin(la)]) * L
            if (far > n * 0.015).all() and (far < n * 0.985).all():
                break
            L *= 0.75
        else:
            continue
        flip = rng.random() < 0.12
        cv.leaf(tip, la, L, sp, rng, depth + 1e-3, flip)
    return cv


def needle(cv, p0, p1, w, color, depth, lift=0.0):
    """Anti-aliased needle from p0 to p1 (canvas px), width w, cylindrical normal, tip taper."""
    x0, x1 = int(max(0, min(p0[0], p1[0]) - w - 1)), int(min(cv.n, max(p0[0], p1[0]) + w + 2))
    y0, y1 = int(max(0, min(p0[1], p1[1]) - w - 1)), int(min(cv.n, max(p0[1], p1[1]) + w + 2))
    if x1 <= x0 or y1 <= y0:
        return
    yy, xx = np.mgrid[y0:y1, x0:x1]
    px, py = xx + 0.5 - p0[0], yy + 0.5 - p0[1]
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L2 = dx * dx + dy * dy + 1e-9
    t = np.clip((px * dx + py * dy) / L2, 0, 1)
    ex, ey = px - t * dx, py - t * dy
    d = np.hypot(ex, ey)
    hw = w * 0.5 * (1.0 - 0.75 * t ** 3)
    m = (d < hw) & (depth > cv.depth[y0:y1, x0:x1])
    if not m.any():
        return
    L = math.sqrt(L2)
    nx, ny = -dy / L, dx / L
    across = (ex * nx + ey * ny) / np.maximum(hw, 1e-3)
    nz = np.sqrt(np.clip(1 - across * across, 0, 1))
    shade = (0.7 + 0.3 * nz) * (0.85 + 0.3 * t) + lift
    c = np.asarray(color)[None, None] * shade[..., None]
    sub = (slice(y0, y1), slice(x0, x1))
    cv.col[sub][m] = np.clip(c[m], 0, 1)
    cv.alpha[sub][m] = 1.0
    cv.nrm[sub][m] = np.stack([across * nx * 0.8, across * ny * 0.8, nz + 0.3], -1)[m]
    cv.depth[sub][m] = depth


def path(start, ang, length, steps, rng, wander=0.06, pull=None):
    pts = [np.asarray(start, float)]
    p = pts[0].copy()
    for _ in range(steps):
        ang += rng.uniform(-wander, wander)
        if pull is not None:
            ang += (pull - ang) * 0.05
        p = p + np.array([math.cos(ang), math.sin(ang)]) * length / steps
        pts.append(p.copy())
    return np.array(pts)


def along(pts, t):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    s = t * cum[-1]
    j = int(np.clip(np.searchsorted(cum, s) - 1, 0, len(pts) - 2))
    f = (s - cum[j]) / max(seg[j], 1e-6)
    pos = pts[j] * (1 - f) + pts[j + 1] * f
    tang = pts[j + 1] - pts[j]
    return pos, math.atan2(tang[1], tang[0])


def spruce_spray(seed):
    """White spruce: a flat pinnate spray, every twig clothed in short stiff needles."""
    rng = np.random.default_rng(seed)
    n = CELL * SS
    cv = Canvas(n)
    twig_col = np.array([0.36, 0.25, 0.15])
    old = srgb((44, 66, 56))
    new = srgb((62, 90, 64))
    main = path([n * rng.uniform(0.47, 0.53), n * 0.995], -math.pi / 2 + rng.uniform(-0.12, 0.12), n * 0.93, 18, rng, 0.05)
    twigs = [(main, 0)]
    n_side = int(rng.integers(11, 15))
    for k in range(n_side):
        t = 0.08 + 0.84 * (k + rng.uniform(0.2, 0.8)) / n_side
        at, ta = along(main, t)
        side = 1 if k % 2 else -1
        a = ta + side * rng.uniform(0.75, 1.05)
        ln = n * (0.5 * (1 - t) + 0.08) * rng.uniform(0.85, 1.15)
        tw = path(at, a, ln, 8, rng, 0.07, pull=ta)
        twigs.append((tw, 1))
        # Third-order twiglets on the longer side shoots.
        if ln > n * 0.16:
            nj = int(rng.integers(3, 6))
            for j in range(nj):
                t2 = 0.15 + 0.7 * (j + rng.uniform(0.2, 0.8)) / nj
                at2, ta2 = along(tw, t2)
                a2 = ta2 + (1 if j % 2 else -1) * rng.uniform(0.7, 1.0)
                twigs.append((path(at2, a2, ln * 0.35 * (1 - t2 * 0.5), 5, rng, 0.08, pull=ta2), 2))
    for tw, order in twigs:
        cv.stroke(tw, n * (0.009, 0.006, 0.004)[order], twig_col, depth=-4.0 + order * 0.01, rng=rng)
    # Needles: all around each twig; seen from above they fan out at 35-80 degrees either side,
    # some pointing at the viewer (short, foreshortened). New growth at the outer 30 % is paler.
    for tw, order in twigs:
        seg = np.linalg.norm(np.diff(tw, axis=0), axis=1).sum()
        count = int(seg * 1.6)
        for i in range(count):
            t = rng.uniform(0.02, 1.0)
            at, ta = along(tw, t)
            side = 1 if rng.random() < 0.5 else -1
            fore = rng.uniform(0.25, 1.0)
            a = ta + side * rng.uniform(0.6, 1.4)
            L = n * rng.uniform(0.026, 0.036) * fore
            tip = at + np.array([math.cos(a), math.sin(a)]) * L
            fresh = np.clip((t - 0.8) / 0.2, 0, 1) * (0.5 if order == 0 else 0.8)
            col = old * rng.uniform(0.8, 1.15) * (1 - fresh) + new * fresh * rng.uniform(0.9, 1.1)
            needle(cv, at, tip, n * 0.0042, col, depth=rng.uniform(-1, 1) + (0.5 if fore < 0.5 else 0), lift=0.04 * fore)
    return cv


def pine_spray(seed):
    """Lodgepole pine: twig ending in dense tufts of paired 3-6 cm needles."""
    rng = np.random.default_rng(seed)
    n = CELL * SS
    cv = Canvas(n)
    twig_col = np.array([0.42, 0.3, 0.2])
    base = srgb((70, 98, 46))
    main = path([n * rng.uniform(0.45, 0.55), n * 0.995], -math.pi / 2 + rng.uniform(-0.15, 0.15), n * 0.62, 10, rng, 0.08)
    shoots = [main]
    nsh = int(rng.integers(2, 4))
    for k in range(nsh):
        at, ta = along(main, 0.3 + 0.4 * (k + rng.uniform(0.2, 0.8)) / nsh)
        a = ta + (1 if k % 2 else -1) * rng.uniform(0.55, 0.85)
        shoots.append(path(at, a, n * rng.uniform(0.3, 0.4), 6, rng, 0.08))
    for k, sh in enumerate(shoots):
        cv.stroke(sh, n * (0.02 if k == 0 else 0.014), twig_col, depth=-4.0 + k * 0.01, rng=rng)
    for sh in shoots:
        seg = np.linalg.norm(np.diff(sh, axis=0), axis=1).sum()
        count = int(seg * 1.4)
        for i in range(count):
            # Needles cluster towards the shoot end (the last few years of growth).
            t = 1 - rng.uniform(0, 1) ** 1.8 * 0.85
            at, ta = along(sh, t)
            spread = rng.uniform(-1.0, 1.0) * (0.5 + 0.5 * t)
            a = ta + spread * 0.95 + rng.normal(0, 0.12)
            fore = rng.uniform(0.35, 1.0)
            L = n * rng.uniform(0.09, 0.14) * fore
            mid = at + np.array([math.cos(a), math.sin(a)]) * L * 0.5 + rng.normal(0, n * 0.004, 2)
            tip = at + np.array([math.cos(a + rng.normal(0, 0.1)), math.sin(a + rng.normal(0, 0.1))]) * L
            col = base * rng.uniform(0.75, 1.2)
            d = rng.uniform(-1, 1)
            needle(cv, at, mid, n * 0.0048, col, d, 0.05 * fore)
            needle(cv, mid, tip, n * 0.0042, col, d, 0.05 * fore)
    return cv


def build_conifer(name, gen):
    size = CELL * 2
    col = np.zeros((size, size, 3))
    alpha = np.zeros((size, size))
    nrm = np.zeros((size, size, 3))
    cells = []
    for k in range(4):
        cv = gen(sum(map(ord, name)) * 131 + k * 97)
        a = downsample(cv.alpha, SS)
        c = downsample(cv.col * cv.alpha[..., None], SS) / np.maximum(a[..., None], 1e-6)
        nn = downsample(cv.nrm, SS)
        nn /= np.maximum(np.linalg.norm(nn, axis=-1, keepdims=True), 1e-6)
        oy, ox = (k // 2) * CELL, (k % 2) * CELL
        col[oy:oy + CELL, ox:ox + CELL] = c
        alpha[oy:oy + CELL, ox:ox + CELL] = a
        nrm[oy:oy + CELL, ox:ox + CELL] = nn
        cells.append([ox / size, oy / size, CELL / size, CELL / size])
        print(name, k, "coverage", round(float(a.mean()), 3), flush=True)
    return finish(name, col, alpha, nrm, cells)


def downsample(a, f):
    h, w = a.shape[:2]
    return a.reshape(h // f, f, w // f, f, *a.shape[2:]).mean((1, 3))


def build(species):
    size = CELL * 2
    col = np.zeros((size, size, 3))
    alpha = np.zeros((size, size))
    nrm = np.zeros((size, size, 3))
    cells = []
    for k in range(4):
        cv = twig(species, seed=sum(map(ord, species)) * 131 + k * 97)
        a = downsample(cv.alpha, SS)
        c = downsample(cv.col * cv.alpha[..., None], SS) / np.maximum(a[..., None], 1e-6)
        nn = downsample(cv.nrm, SS)
        nn /= np.maximum(np.linalg.norm(nn, axis=-1, keepdims=True), 1e-6)
        oy, ox = (k // 2) * CELL, (k % 2) * CELL
        col[oy:oy + CELL, ox:ox + CELL] = c
        alpha[oy:oy + CELL, ox:ox + CELL] = a
        nrm[oy:oy + CELL, ox:ox + CELL] = nn
        cells.append([ox / size, oy / size, CELL / size, CELL / size])
    return finish(species, col, alpha, nrm, cells)


def finish(species, col, alpha, nrm, cells):
    # Bleed leaf colour into transparent texels so mipmaps do not darken the edges.
    from scipy import ndimage
    solid = alpha > 0.02
    idx = ndimage.distance_transform_edt(~solid, return_distances=False, return_indices=True)
    col = col[idx[0], idx[1]]
    nrm_b = nrm[idx[0], idx[1]]
    nrm = np.where(solid[..., None], nrm, nrm_b)
    # The foliage shader tints by species colour and keeps only luminance detail: normalise the
    # mean leaf luminance (linear) to 0.35 so every atlas shades alike.
    lum = col @ np.array([0.2126, 0.7152, 0.0722])
    solid_px = alpha > 0.5
    col = col * (0.35 / max(float(lum[solid_px].mean()), 1e-3))
    rgba = np.concatenate([np.clip(col, 0, 1) ** (1 / 2.2), alpha[..., None]], -1)
    Image.fromarray((rgba * 255 + 0.5).astype(np.uint8), "RGBA").save(OUT / f"{species}_albedo.png")
    # KTX2 rows run top-down with v, like canvas y, so the green channel keeps its sign.
    nrgb = np.stack([nrm[..., 0] * 0.5 + 0.5, nrm[..., 1] * 0.5 + 0.5, nrm[..., 2] * 0.5 + 0.5], -1)
    Image.fromarray((np.clip(nrgb, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(OUT / f"{species}_normal.png")
    return cells


def main():
    import sys
    OUT.mkdir(parents=True, exist_ok=True)
    cj = OUT / "cells.json"
    cells = json.loads(cj.read_text()) if cj.exists() else {}
    if "conifers" in sys.argv[1:]:
        cells["spruce"] = build_conifer("spruce", spruce_spray)
        cells["pine"] = build_conifer("pine", pine_spray)
    else:
        for sp in SPECIES:
            cells[sp] = build(sp)
            print(sp, "done", flush=True)
    cells.pop("leafy", None)
    cj.write_text(json.dumps(cells, indent=1))


if __name__ == "__main__":
    main()
