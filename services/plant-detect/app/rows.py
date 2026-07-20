"""OWNER: be-detect — row-line detection for `vine` / `row_segment`.

A trellised vineyard has no separable crowns: neighbouring vines touch, so watershed would
carve arbitrary slices. The label-free method that does work is the row geometry itself
(docs/PHASE-PLANT.md §3):

    vegetation mask → dominant row angle → across-row profile → row centre lines
    → `vine`: a point every `plant_spacing_m` along each row
    → `row_segment`: the row tiled into `segment_length_m` chunks, point = segment midpoint

The angle search is a Radon/Hough projection done directly in metric space: for a candidate
angle the across-row histogram **is** the Hough accumulator column for that angle, and the
true row direction is the one whose accumulator is most sharply peaked (max Σ h²). Doing it
in metres rather than pixels keeps it correct on a non-square-pixel raster.

`crown_geom` is `None` for both units — the frozen contract says row units place points and
the extraction stage buffers them.
"""

import math
from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy import ndimage
from scipy.signal import find_peaks

from .config import Params
from .geo import Detection, PixelSize, clamp01

#: Work cell for the angle/profile stage. Rows are ~0.5 m wide, so 25 cm resolves them while
#: keeping the projection cheap on a hectare-scale ortho.
ROW_CELL_M = 0.25
#: Across-row histogram bin.
PROFILE_BIN_M = 0.1
#: Empty margin added at both ends of the profile so the outermost row still has a flank to be
#: a peak on (`find_peaks` never reports index 0).
PROFILE_PAD_M = 0.5
#: A row projects as a ~0.6 m wide *top hat*, not a spike; smoothing turns each plateau into
#: one rounded peak with a real prominence. Without it `find_peaks` trips over plateau ties.
PROFILE_SMOOTH_M = 0.2
#: Candidate angles: 1° coarse sweep, then ±1.5° at 0.1° (0.1° over a 150 m row = 26 cm drift,
#: well inside the row half-width).
COARSE_STEP_DEG, FINE_STEP_DEG, FINE_SPAN_DEG = 1.0, 0.1, 1.5
#: Cells sampled for the coarse sweep — the angle does not need every pixel.
ANGLE_SAMPLE_CAP = 40_000
#: Plausible row spacing (m) for the autocorrelation estimate, and its fallback.
SPACING_RANGE_M = (0.8, 6.0)
FALLBACK_SPACING_M = 2.5
#: Half-width of the band of pixels assigned to a row centre line.
MAX_HALF_WIDTH_M = 0.75
#: A gap longer than this along a row splits it (headland, missing block).
ROW_GAP_M = 3.0


def _downsample_any(mask: np.ndarray, factor: int) -> np.ndarray:
    """Block-OR: a cell is vegetated if any of its pixels is."""
    if factor <= 1:
        return mask
    h = mask.shape[0] // factor * factor
    w = mask.shape[1] // factor * factor
    if h == 0 or w == 0:
        return mask
    return mask[:h, :w].reshape(h // factor, factor, w // factor, factor).any(axis=(1, 3))


def _profile(x: np.ndarray, y: np.ndarray, phi: float, bin_m: float) -> Tuple[np.ndarray, float]:
    """Across-row histogram for row direction `phi`. Returns (counts, v of the first bin edge)."""
    v = -x * math.sin(phi) + y * math.cos(phi)
    v_min = float(v.min()) - PROFILE_PAD_M
    span = float(v.max()) + PROFILE_PAD_M - v_min
    bins = max(2, int(math.ceil(span / bin_m)) + 1)
    hist, _ = np.histogram(v, bins=bins, range=(v_min, v_min + bins * bin_m))
    return hist.astype(np.float64), v_min


def _smooth_profile(profile: np.ndarray, bin_m: float) -> np.ndarray:
    return ndimage.gaussian_filter1d(profile, sigma=max(PROFILE_SMOOTH_M / bin_m, 0.5), mode="constant")


def estimate_angle(x: np.ndarray, y: np.ndarray, bin_m: float = PROFILE_BIN_M) -> float:
    """Row direction (radians, from the +col axis toward +row) maximising profile energy."""
    if len(x) > ANGLE_SAMPLE_CAP:
        step = len(x) // ANGLE_SAMPLE_CAP + 1
        x, y = x[::step], y[::step]

    def energy(phi: float) -> float:
        hist, _ = _profile(x, y, phi, bin_m)
        return float(np.dot(hist, hist))

    coarse = np.arange(0.0, 180.0, COARSE_STEP_DEG)
    best = max(coarse, key=lambda d: energy(math.radians(d)))
    fine = np.arange(best - FINE_SPAN_DEG, best + FINE_SPAN_DEG + 1e-9, FINE_STEP_DEG)
    best = max(fine, key=lambda d: energy(math.radians(d)))
    return math.radians(float(best) % 180.0)


def estimate_spacing(profile: np.ndarray, bin_m: float) -> Optional[float]:
    """Row spacing from the first autocorrelation peak inside the plausible range."""
    centred = profile - profile.mean()
    ac = np.correlate(centred, centred, mode="full")[len(centred) - 1 :]
    lo = int(SPACING_RANGE_M[0] / bin_m)
    hi = min(len(ac) - 1, int(SPACING_RANGE_M[1] / bin_m))
    if hi <= lo:
        return None
    k = lo + int(np.argmax(ac[lo : hi + 1]))
    return k * bin_m if ac[k] > 0 else None


def _height_at(chm: Optional[np.ndarray], row: float, col: float, radius_px: int) -> Optional[float]:
    if chm is None:
        return None
    r0 = max(0, int(row) - radius_px)
    r1 = min(chm.shape[0], int(row) + radius_px + 1)
    c0 = max(0, int(col) - radius_px)
    c1 = min(chm.shape[1], int(col) + radius_px + 1)
    if r1 <= r0 or c1 <= c0:
        return None
    return round(float(chm[r0:r1, c0:c1].max()), 3)


def detect_rows(
    mask: np.ndarray,
    px: PixelSize,
    p: Params,
    unit_type: str,
    chm: Optional[np.ndarray] = None,
) -> Tuple[List[Detection], Dict[str, float]]:
    """Place plant points along the detected rows of a vegetation mask."""
    stats: Dict[str, float] = {"rows": 0, "points": 0, "mask_px": int(mask.sum())}
    if not mask.any():
        return [], stats

    factor = max(1, int(round(ROW_CELL_M / px.mean_m)))
    cells = _downsample_any(mask, factor)
    cell = PixelSize(px.row_m * factor, px.col_m * factor)
    cy, cx = np.nonzero(cells)
    if len(cy) < 3:
        return [], stats
    x = cx * cell.col_m
    y = cy * cell.row_m

    phi = (
        math.radians(p.row_angle_deg)
        if p.row_angle_deg is not None
        else estimate_angle(x, y)
    )
    sin_p, cos_p = math.sin(phi), math.cos(phi)
    u = x * cos_p + y * sin_p  # along-row
    v = -x * sin_p + y * cos_p  # across-row

    raw, v_min = _profile(x, y, phi, PROFILE_BIN_M)
    profile = _smooth_profile(raw, PROFILE_BIN_M)
    spacing = p.row_spacing_m or estimate_spacing(profile, PROFILE_BIN_M) or FALLBACK_SPACING_M
    stats["angle_deg"] = round(math.degrees(phi), 3)
    stats["row_spacing_m"] = round(float(spacing), 3)

    peaks, _ = find_peaks(
        profile,
        distance=max(1, int(0.6 * spacing / PROFILE_BIN_M)),
        prominence=max(1.0, 0.15 * float(profile.max())),
    )
    if len(peaks) == 0:
        return [], stats

    half_width = min(spacing / 3.0, MAX_HALF_WIDTH_M)
    step_m = p.plant_spacing_m if unit_type == "vine" else p.segment_length_m
    step_m = max(step_m, 0.1)
    cell_area = cell.area_m2
    height_radius_px = max(1, int(round(min(half_width, 1.0) / px.mean_m)))

    detections: List[Detection] = []
    for peak in peaks:
        v0 = v_min + (float(peak) + 0.5) * PROFILE_BIN_M
        band = np.abs(v - v0) <= half_width
        if int(band.sum()) < 3:
            continue
        us = np.sort(u[band])
        # A long gap means a headland or a missing stretch: two rows, not one.
        breaks = np.nonzero(np.diff(us) > ROW_GAP_M)[0]
        starts = np.concatenate([[0], breaks + 1])
        ends = np.concatenate([breaks, [len(us) - 1]])
        for s, e in zip(starts, ends):
            u0, u1 = float(us[s]), float(us[e])
            length = u1 - u0
            if length < p.min_row_length_m:
                continue
            stats["rows"] += 1
            n = max(1, int(round(length / step_m)))
            seg = length / n
            for k in range(n):
                uk = u0 + (k + 0.5) * seg
                lo, hi = np.searchsorted(us, [uk - seg / 2.0, uk + seg / 2.0])
                filled = float(hi - lo) * cell_area
                expected = max(seg * 2.0 * half_width, cell_area)
                # Back to array space: rotate, then undo the block downsample.
                xk = uk * cos_p - v0 * sin_p
                yk = uk * sin_p + v0 * cos_p
                col = (xk / cell.col_m) * factor + (factor - 1) / 2.0
                row = (yk / cell.row_m) * factor + (factor - 1) / 2.0
                if not (0 <= row < mask.shape[0] and 0 <= col < mask.shape[1]):
                    continue
                detections.append(
                    Detection(
                        row=row,
                        col=col,
                        score=round(clamp01(filled / expected), 4),
                        ring=None,
                        height_m=_height_at(chm, row, col, height_radius_px),
                        canopy_m2=round(filled, 3),
                    )
                )

    stats["points"] = len(detections)
    return detections, stats
