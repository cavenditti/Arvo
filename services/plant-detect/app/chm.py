"""OWNER: be-detect — canopy height model and vegetation index (numpy + scipy only).

CHM = DSM − a **rolling terrain baseline** (p10 over a 15 m window), the label-free trick that
removes the need for a DTM: over an orchard, the lowest decile of a 15 m neighbourhood is
inter-row ground even where the canopy is closed. Frozen in docs/API-PLANT.md §"Pipeline
stages" → Detection.
"""

from dataclasses import dataclass
from typing import Dict, Optional, Tuple

import numpy as np
from scipy import ndimage

from .config import VEG_HI, VEG_MIN
from .errors import DetectError

#: The percentile filter is O(window²) per pixel, so the baseline is computed on a coarse grid
#: (~window/12) and bilinearly resampled back — at 5 cm GSD that is a 3000× saving and the
#: terrain it models has no detail at that scale anyway.
TERRAIN_COARSE_CELLS = 12
#: Never run a percentile filter narrower than this (in coarse cells).
MIN_TERRAIN_WINDOW_CELLS = 3


def _resize_bilinear(arr: np.ndarray, shape: Tuple[int, int]) -> np.ndarray:
    """Resample to an exact shape. `ndimage.zoom` can land one row/col short — pad by edge."""
    if arr.shape == shape:
        return arr
    zoom = (shape[0] / arr.shape[0], shape[1] / arr.shape[1])
    out = ndimage.zoom(arr, zoom, order=1, mode="nearest")
    if out.shape != shape:
        pad = [(0, max(0, shape[i] - out.shape[i])) for i in (0, 1)]
        out = np.pad(out, pad, mode="edge")[: shape[0], : shape[1]]
    return out


def terrain_baseline(
    dsm: np.ndarray, pixel_m: float, window_m: float, percentile: float
) -> np.ndarray:
    """Rolling low-percentile surface (the "ground") under a NaN-free DSM."""
    coarse_cell_m = max(pixel_m, window_m / TERRAIN_COARSE_CELLS)
    step = max(1, int(round(coarse_cell_m / pixel_m)))
    coarse = dsm[::step, ::step]
    win = int(round(window_m / (pixel_m * step)))
    win = max(MIN_TERRAIN_WINDOW_CELLS, win)
    win = min(win, max(MIN_TERRAIN_WINDOW_CELLS, min(coarse.shape)))
    base = ndimage.percentile_filter(coarse, percentile=percentile, size=win, mode="nearest")
    return _resize_bilinear(base.astype(np.float32), dsm.shape)


def canopy_height_model(
    dsm: np.ndarray,
    pixel_m: float,
    window_m: float,
    percentile: float,
    valid: Optional[np.ndarray] = None,
) -> np.ndarray:
    """DSM → CHM in metres above local ground. Invalid pixels come back as 0 (never NaN, so
    downstream filters and the watershed stay total)."""
    dsm = np.asarray(dsm, dtype=np.float32)
    if valid is None:
        valid = np.isfinite(dsm)
    filled = np.where(valid, dsm, np.nan)
    if not valid.any():
        return np.zeros_like(filled, dtype=np.float32)
    # A NaN inside the percentile window would poison it; fill holes with the global median
    # (they are nodata gaps, i.e. ground-ish by construction).
    filled = np.nan_to_num(filled, nan=float(np.nanmedian(filled)))
    chm = filled - terrain_baseline(filled, pixel_m, window_m, percentile)
    chm[~valid] = 0.0
    return np.maximum(chm, 0.0, dtype=np.float32)


def smooth(chm: np.ndarray, pixel_m: float, sigma_m: float) -> np.ndarray:
    """Gaussian smoothing in ground units — a crown must become one local maximum, not twenty."""
    sigma_px = sigma_m / pixel_m if pixel_m > 0 else 0.0
    if sigma_px < 0.3:  # below this the kernel is a no-op
        return chm
    return ndimage.gaussian_filter(chm, sigma=sigma_px, mode="nearest")


@dataclass
class Veg:
    """A continuous vegetation index over the working grid, plus its canopy cut."""

    name: str
    array: np.ndarray
    vmin: float
    vhi: float

    def mask(self) -> np.ndarray:
        return self.array >= self.vmin


def _ratio(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(a−b)/(a+b) with a zero-denominator guard."""
    num = a - b
    den = a + b
    return np.divide(num, den, out=np.zeros_like(num, dtype=np.float32), where=np.abs(den) > 1e-6)


def vegetation(
    bands: Dict[str, np.ndarray], kind: str = "auto", vmin: Optional[float] = None
) -> Optional[Veg]:
    """NDVI when the ortho carries NIR, else ExG (excess green) from plain RGB.

    Both are ratios, so raw DN values need no reflectance scaling. `kind="none"` disables the
    vegetation gate; `kind="auto"` picks the best available index.
    """
    if kind == "none":
        return None
    have = {k: np.asarray(v, dtype=np.float32) for k, v in bands.items()}
    ndvi_ok = "nir" in have and "red" in have
    exg_ok = all(b in have for b in ("red", "green", "blue"))

    if kind in ("auto", "ndvi") and ndvi_ok:
        arr = _ratio(have["nir"], have["red"])
        name = "ndvi"
    elif kind in ("auto", "exg") and exg_ok:
        r, g, b = have["red"], have["green"], have["blue"]
        total = r + g + b
        arr = np.divide(
            2.0 * g - r - b, total, out=np.zeros_like(total, dtype=np.float32), where=total > 1e-6
        )
        name = "exg"
    elif kind == "auto":
        return None
    else:
        raise DetectError("bad_request", f"ortho has no bands for vegetation index {kind!r}")

    return Veg(name=name, array=arr, vmin=VEG_MIN[name] if vmin is None else float(vmin), vhi=VEG_HI[name])
