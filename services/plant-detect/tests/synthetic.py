"""Synthetic fixtures — the whole suite runs without a byte of real drone data.

`make_orchard` builds a DSM the way an orchard actually looks to a photogrammetry pipeline:
sloping ground plus dome-shaped crowns on a planting grid. The detector must recover exactly
the trees that were planted.
"""

import math
from dataclasses import dataclass

import numpy as np


@dataclass
class Orchard:
    dsm: np.ndarray  # metres above sea level
    pixel_m: float
    centres_rc: np.ndarray  # (N, 2) true crown apexes in array coordinates
    tree_h_m: float
    crown_r_m: float

    @property
    def n(self) -> int:
        return len(self.centres_rc)


def make_orchard(
    n_rows: int = 6,
    n_cols: int = 8,
    spacing_m: float = 5.0,
    pixel_m: float = 0.1,
    crown_r_m: float = 1.6,
    tree_h_m: float = 4.0,
    slope: float = 0.02,
    noise_m: float = 0.02,
    margin_m: float = 4.0,
    seed: int = 7,
) -> Orchard:
    """A planted grid of dome crowns over a tilted, slightly noisy ground plane."""
    height_m = 2 * margin_m + (n_rows - 1) * spacing_m
    width_m = 2 * margin_m + (n_cols - 1) * spacing_m
    h = int(round(height_m / pixel_m))
    w = int(round(width_m / pixel_m))
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) * pixel_m

    # A 2 % ramp: the CHM must remove it, otherwise the uphill end drowns the downhill trees.
    ground = 100.0 + slope * xx + 0.5 * slope * yy
    dsm = ground.copy()

    centres = []
    for i in range(n_rows):
        for j in range(n_cols):
            cy = margin_m + i * spacing_m
            cx = margin_m + j * spacing_m
            d = np.hypot(xx - cx, yy - cy)
            cap = tree_h_m * np.sqrt(np.clip(1.0 - (d / crown_r_m) ** 2, 0.0, 1.0))
            dsm = np.maximum(dsm, ground + cap)
            centres.append((cy / pixel_m, cx / pixel_m))

    if noise_m > 0:
        dsm = dsm + np.random.default_rng(seed).normal(0.0, noise_m, dsm.shape).astype(np.float32)

    return Orchard(
        dsm=dsm.astype(np.float32),
        pixel_m=pixel_m,
        centres_rc=np.asarray(centres, dtype=float),
        tree_h_m=tree_h_m,
        crown_r_m=crown_r_m,
    )


def add_box(dsm: np.ndarray, pixel_m: float, centre_m, size_m: float, height_m: float) -> np.ndarray:
    """A flat-topped block — the shed/polytunnel that a height-only detector mistakes for a tree."""
    cy, cx = centre_m
    r = size_m / 2.0
    yy, xx = np.mgrid[0 : dsm.shape[0], 0 : dsm.shape[1]].astype(np.float32) * pixel_m
    inside = (np.abs(xx - cx) <= r) & (np.abs(yy - cy) <= r)
    out = dsm.copy()
    out[inside] += height_m
    return out


def make_rows_mask(
    n_rows: int = 5,
    row_length_m: float = 30.0,
    spacing_m: float = 2.5,
    row_width_m: float = 0.6,
    angle_deg: float = 20.0,
    pixel_m: float = 0.1,
    extent_m: float = 44.0,
):
    """A vineyard vegetation mask: `n_rows` straight rows at a known angle and spacing.

    Returns `(mask, centres_v)` where `centres_v` are the across-row offsets of the rows in the
    rotated frame, so a test can check the detector landed on the real lines.
    """
    side = int(round(extent_m / pixel_m))
    yy, xx = np.mgrid[0:side, 0:side].astype(np.float32) * pixel_m
    phi = math.radians(angle_deg)
    u = xx * math.cos(phi) + yy * math.sin(phi)
    v = -xx * math.sin(phi) + yy * math.cos(phi)

    u_mid = float(u.mean())
    v_mid = float(v.mean())
    centres_v = [v_mid + (k - (n_rows - 1) / 2.0) * spacing_m for k in range(n_rows)]

    along = np.abs(u - u_mid) <= row_length_m / 2.0
    mask = np.zeros(u.shape, dtype=bool)
    for v0 in centres_v:
        mask |= along & (np.abs(v - v0) <= row_width_m / 2.0)
    return mask, centres_v
