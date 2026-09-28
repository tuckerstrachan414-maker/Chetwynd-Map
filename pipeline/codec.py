"""Binary codecs shared by pipeline outputs (mirrored in src/world/codec.ts).

Height grid (CWH1): quantized to `step` metres above `hmin`, planar predictor
(left + up - upleft), zigzag, little-endian byte planes, gzip.
Header: magic[4] level:u8 planes:u8 i:u16 j:u16 n:u16 hmin:f32 step:f32  (20 bytes)
"""
import gzip
import struct

import numpy as np

MAGIC_HEIGHT = b"CWH1"


def encode_height(h: np.ndarray, level: int, i: int, j: int, step: float = 0.02) -> tuple[bytes, float, float]:
    n = h.shape[0]
    assert h.shape == (n, n) and not np.isnan(h).any()
    hmin = float(np.floor(h.min() / step) * step)
    hmax = float(h.max())
    step = max(step, (hmax - hmin) / 65000.0)
    q = np.round((h - hmin) / step).astype(np.int32)
    pred = np.zeros_like(q)
    pred[0, 1:] = q[0, :-1]
    pred[1:, 0] = q[:-1, 0]
    pred[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    r = q - pred
    zz = ((r << 1) ^ (r >> 31)).astype(np.uint32)
    planes = 1 if zz.max() < 256 else (2 if zz.max() < 65536 else 3)
    b = zz.astype("<u4").view(np.uint8).reshape(-1, 4)[:, :planes].T.copy()
    header = MAGIC_HEIGHT + struct.pack("<BBHHHff", level, planes, i, j, n, hmin, step)
    return gzip.compress(header + b.tobytes(), 9, mtime=0), hmin, hmax


def decode_height(data: bytes) -> np.ndarray:
    raw = gzip.decompress(data)
    assert raw[:4] == MAGIC_HEIGHT
    level, planes, i, j, n, hmin, step = struct.unpack("<BBHHHff", raw[4:20])
    b = np.frombuffer(raw[20:], dtype=np.uint8).reshape(planes, n * n)
    zz = np.zeros(n * n, dtype=np.int64)
    for p in range(planes):
        zz |= b[p].astype(np.int64) << (8 * p)
    r = ((zz >> 1) ^ -(zz & 1)).reshape(n, n)
    # Invert the planar predictor: q = cumsum over both axes of r with the boundary terms.
    q = np.cumsum(np.cumsum(r, axis=0), axis=1)
    return hmin + q.astype(np.float64) * step
