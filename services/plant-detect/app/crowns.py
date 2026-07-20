"""OWNER: be-detect — individual crown delineation for `tree` / `bush`.

The well-trodden label-free ITC recipe, exactly as frozen in docs/API-PLANT.md §"Pipeline
stages" → Detection:

    CHM → smooth → local maxima ≥ `min_spacing_m` apart → watershed on the inverted CHM
    → drop crowns outside 0.5–80 m² → one detection per crown.

No training data, no model download: the only "labels" are the physics of a canopy.
"""

from typing import Dict, List, Optional, Tuple

import numpy as np
from scipy import ndimage
from skimage.feature import peak_local_max
from skimage.segmentation import watershed

from . import chm as chm_mod
from . import geo
from .config import Params
from .geo import Detection, PixelSize

#: Score weights. Height dominates (a tall blob is a tree), shape guards against watershed
#: leakage across a hedge, vigour only nudges. Documented in README §Scoring.
W_HEIGHT, W_SHAPE = 0.6, 0.4
W_HEIGHT_VEG, W_SHAPE_VEG, W_VEG = 0.5, 0.3, 0.2


def _score(
    height_m: float,
    min_height_m: float,
    area_m2: float,
    perimeter_m: float,
    veg_mean: Optional[float],
    veg: Optional[chm_mod.Veg],
) -> float:
    """Detector confidence in 0..1 — no probability calibration is claimed, it is a ranking."""
    span = max(min_height_m, 0.5)
    h_norm = geo.clamp01((height_m - min_height_m) / span)
    shape = geo.compactness(area_m2, perimeter_m)
    if veg is None or veg_mean is None:
        return geo.clamp01(W_HEIGHT * h_norm + W_SHAPE * shape)
    v_norm = geo.clamp01((veg_mean - veg.vmin) / max(veg.vhi - veg.vmin, 1e-6))
    return geo.clamp01(W_HEIGHT_VEG * h_norm + W_SHAPE_VEG * shape + W_VEG * v_norm)


def detect_crowns(
    chm: np.ndarray,
    px: PixelSize,
    p: Params,
    veg: Optional[chm_mod.Veg] = None,
    clip: Optional[np.ndarray] = None,
) -> Tuple[List[Detection], Dict[str, int]]:
    """Delineate crowns in a canopy height model (metres above ground).

    `veg` gates the canopy mask (and nudges the score) when an ortho was supplied; `clip`
    restricts the search to the parcel.
    """
    stats: Dict[str, int] = {"seeds": 0, "crowns": 0, "dropped_small": 0, "dropped_large": 0}
    chm = np.asarray(chm, dtype=np.float32)
    smoothed = chm_mod.smooth(chm, px.mean_m, p.smooth_sigma_m)

    canopy = smoothed >= p.min_height_m
    if veg is not None:
        canopy &= veg.mask()
    if clip is not None:
        canopy &= clip
    stats["canopy_px"] = int(canopy.sum())
    if not canopy.any():
        return [], stats

    # One seed per crown apex. peak_local_max walks maxima strongest-first, so the enforced
    # spacing keeps the apex and drops the shoulder.
    min_distance = max(1, int(round(p.min_spacing_m / px.mean_m)))
    seeds = peak_local_max(
        smoothed,
        min_distance=min_distance,
        threshold_abs=float(p.min_height_m),
        labels=canopy,
        exclude_border=False,
    )
    stats["seeds"] = int(len(seeds))
    if len(seeds) == 0:
        return [], stats

    markers = np.zeros(smoothed.shape, dtype=np.int32)
    markers[tuple(seeds.T)] = np.arange(1, len(seeds) + 1, dtype=np.int32)
    # Watershed on the *inverted* CHM: apexes are basins, the ridge between two crowns is the
    # divide. `mask` stops the flood at the canopy edge.
    labels = watershed(-smoothed, markers, mask=canopy)

    counts = np.bincount(labels.ravel(), minlength=len(seeds) + 1)
    areas = counts * px.area_m2
    slices = ndimage.find_objects(labels)

    detections: List[Detection] = []
    for label in range(1, len(seeds) + 1):
        area = float(areas[label])
        if area < p.min_crown_m2:
            stats["dropped_small"] += 1
            continue
        if area > p.max_crown_m2:
            stats["dropped_large"] += 1
            continue
        window = slices[label - 1] if label - 1 < len(slices) else None
        if window is None:  # a marker the flood never claimed
            continue
        sub = labels[window] == label
        r0, c0 = window[0].start, window[1].start
        rows, cols = np.nonzero(sub)
        ring = geo.mask_to_ring(sub, offset=(r0, c0))
        # Prefer the polygon's own area so `canopy_m2` and `crown_geom` always agree.
        area_m2 = geo.ring_area_m2(ring, px) if ring is not None else area
        perimeter_m = geo.ring_perimeter_m(ring, px) if ring is not None else 0.0
        height_m = float(chm[window][sub].max())
        veg_mean = float(veg.array[window][sub].mean()) if veg is not None else None
        detections.append(
            Detection(
                row=float(rows.mean() + r0),
                col=float(cols.mean() + c0),
                score=round(_score(height_m, p.min_height_m, area_m2, perimeter_m, veg_mean, veg), 4),
                ring=ring,
                height_m=round(height_m, 3),
                canopy_m2=round(area_m2, 3),
            )
        )

    stats["crowns"] = len(detections)
    return detections, stats
