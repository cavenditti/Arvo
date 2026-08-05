"""OWNER: be-detect — individual crown delineation for `tree` / `bush`.

Two label-free paths share the same crown geometry contract:

* DSM available: CHM → local maxima → watershed on the inverted CHM.
* Detailed ortho only: vegetation mask → distance transform → watershed on the inverted
  distance surface.

Both drop crowns outside the configured area range and emit one detection per crown. No
training data or model download is required.
"""

import math
from typing import Any, Dict, List, Optional, Tuple

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
#: RGB/NIR-only crowns have no height evidence. Shape and vegetation vigour are useful for
#: ranking, but the score is deliberately not presented as a calibrated probability.
W_ORTHO_SHAPE, W_ORTHO_VEG = 0.6, 0.4
#: Sentinel-2's 10 m pixels are appropriate for parcel crop/cover analysis, not individual
#: crowns. Sub-metre aerial/satellite products normally satisfy this guard.
MAX_ORTHO_CROWN_GSD_M = 1.0


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
) -> Tuple[List[Detection], Dict[str, Any]]:
    """Delineate crowns in a canopy height model (metres above ground).

    `veg` gates the canopy mask (and nudges the score) when an ortho was supplied; `clip`
    restricts the search to the parcel.
    """
    stats: Dict[str, Any] = {
        "method": "chm_watershed",
        "seeds": 0,
        "crowns": 0,
        "dropped_small": 0,
        "dropped_large": 0,
    }
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


def detect_crowns_from_vegetation(
    veg: chm_mod.Veg,
    px: PixelSize,
    p: Params,
    clip: Optional[np.ndarray] = None,
) -> Tuple[List[Detection], Dict[str, Any]]:
    """Delineate crowns from a detailed RGB/NIR orthophoto without a DSM.

    The distance transform acts as a height-free crown surface: the centre of each compact
    vegetation blob is high, its boundary is zero, and watershed divides touching blobs at
    their narrowest saddle. This is suitable for orchards visible at sub-metre GSD. It cannot
    estimate plant height, so emitted detections intentionally carry ``height_m=None``.
    """
    stats: Dict[str, Any] = {
        "method": "ortho_vegetation_watershed",
        "seeds": 0,
        "crowns": 0,
        "dropped_small": 0,
        "dropped_large": 0,
    }
    mask = np.asarray(veg.mask(), dtype=bool)
    if clip is not None:
        mask &= clip

    # Remove speckle before finding peaks. The final area check still runs after watershed,
    # because a large connected vegetation patch may divide into sub-threshold basins.
    components, component_count = ndimage.label(mask)
    if component_count:
        counts = np.bincount(components.ravel(), minlength=component_count + 1)
        min_component_px = max(1, int(math.ceil(p.min_crown_m2 / px.area_m2)))
        keep = counts >= min_component_px
        keep[0] = False
        mask = keep[components]
    stats["canopy_px"] = int(mask.sum())
    if not mask.any():
        return [], stats

    distance = ndimage.distance_transform_edt(mask, sampling=(px.row_m, px.col_m))
    min_distance = max(1, int(round(p.min_spacing_m / px.mean_m)))
    min_radius_m = math.sqrt(max(p.min_crown_m2, px.area_m2) / math.pi)
    seeds = peak_local_max(
        distance,
        min_distance=min_distance,
        threshold_abs=max(0.5 * px.mean_m, 0.35 * min_radius_m),
        labels=mask,
        exclude_border=False,
    )
    stats["seeds"] = int(len(seeds))
    if len(seeds) == 0:
        return [], stats

    markers = np.zeros(distance.shape, dtype=np.int32)
    markers[tuple(seeds.T)] = np.arange(1, len(seeds) + 1, dtype=np.int32)
    labels = watershed(-distance, markers, mask=mask)

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
        if window is None:
            continue
        sub = labels[window] == label
        r0, c0 = window[0].start, window[1].start
        rows, cols = np.nonzero(sub)
        ring = geo.mask_to_ring(sub, offset=(r0, c0))
        area_m2 = geo.ring_area_m2(ring, px) if ring is not None else area
        perimeter_m = geo.ring_perimeter_m(ring, px) if ring is not None else 0.0
        shape = geo.compactness(area_m2, perimeter_m)
        veg_mean = float(np.nanmean(veg.array[window][sub]))
        vigour = geo.clamp01((veg_mean - veg.vmin) / max(veg.vhi - veg.vmin, 1e-6))
        detections.append(
            Detection(
                row=float(rows.mean() + r0),
                col=float(cols.mean() + c0),
                score=round(geo.clamp01(W_ORTHO_SHAPE * shape + W_ORTHO_VEG * vigour), 4),
                ring=ring,
                height_m=None,
                canopy_m2=round(area_m2, 3),
            )
        )

    stats["crowns"] = len(detections)
    return detections, stats
