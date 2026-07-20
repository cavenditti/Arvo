"""OWNER: be-detect — pure pixel-space geometry (numpy + skimage.measure only).

Everything here works in **array index space**: `(row, col)` floats where an integer index is
the pixel centre, exactly the convention `skimage.measure.find_contours` returns. `raster.py`
owns the affine/CRS step to EPSG:4326, which keeps this module testable without GDAL.
"""

import math
from dataclasses import dataclass
from typing import List, Optional, Sequence

import numpy as np
from skimage.measure import approximate_polygon, find_contours

#: Douglas–Peucker tolerance for a crown outline. Half a pixel keeps the shape honest while
#: dropping the marching-squares staircase (a 60-px crown ring → ~15 vertices).
RING_SIMPLIFY_PX = 0.5
#: A GeoJSON LinearRing needs 4 positions with the first repeated as the last.
MIN_RING_POINTS = 4


@dataclass(frozen=True)
class PixelSize:
    """Ground size of one pixel. Kept per axis: a raster in EPSG:4326 is not square."""

    row_m: float
    col_m: float

    @property
    def mean_m(self) -> float:
        """Isotropic size used for distances (spacing, smoothing sigma)."""
        return math.sqrt(self.row_m * self.col_m)

    @property
    def area_m2(self) -> float:
        return self.row_m * self.col_m


@dataclass
class Detection:
    """One detected plant, still in array space — `raster.py` turns it into GeoJSON.

    `ring` is the delineated crown outline for `tree`/`bush` and `None` for the row units,
    whose extraction geometry is a point plus a fixed buffer (docs/API-PLANT.md §3).
    """

    row: float
    col: float
    score: float
    ring: Optional[np.ndarray] = None
    height_m: Optional[float] = None
    canopy_m2: Optional[float] = None


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else float(x))


def close_ring(ring: np.ndarray) -> np.ndarray:
    """Append the first vertex when the ring is not already closed."""
    if len(ring) == 0:
        return ring
    if not np.allclose(ring[0], ring[-1]):
        ring = np.vstack([ring, ring[:1]])
    return ring


def bbox_ring(mask: np.ndarray) -> np.ndarray:
    """Closed ring around a mask's bounding box — the fallback for a 1–2 px blob."""
    rows, cols = np.nonzero(mask)
    r0, r1 = rows.min() - 0.5, rows.max() + 0.5
    c0, c1 = cols.min() - 0.5, cols.max() + 0.5
    return np.array([[r0, c0], [r0, c1], [r1, c1], [r1, c0], [r0, c0]], dtype=float)


def mask_to_ring(
    mask: np.ndarray,
    offset: Sequence[float] = (0.0, 0.0),
    simplify_px: float = RING_SIMPLIFY_PX,
) -> Optional[np.ndarray]:
    """Outer boundary of a single-blob boolean mask as a closed `(row, col)` ring.

    `offset` is added to every vertex, so callers can pass a crown's sub-window and get the
    ring back in full-array coordinates.
    """
    if mask.size == 0 or not mask.any():
        return None
    # Pad so a blob touching the window edge still yields a closed contour.
    padded = np.pad(mask.astype(np.float32), 1)
    contours = find_contours(padded, 0.5)
    if not contours:
        return None
    ring = max(contours, key=len) - 1.0  # undo the pad
    if simplify_px > 0:
        simplified = approximate_polygon(ring, tolerance=simplify_px)
        if len(simplified) >= MIN_RING_POINTS:
            ring = simplified
    ring = close_ring(ring)
    if len(ring) < MIN_RING_POINTS:
        ring = bbox_ring(mask)
    return ring + np.asarray(offset, dtype=float)


def ring_area_m2(ring: np.ndarray, px: PixelSize) -> float:
    """Shoelace area of a `(row, col)` ring. Matches `ST_Area(geography)` of the polygon the
    service emits, so `canopy_m2` and `crown_geom` can never disagree."""
    if ring is None or len(ring) < MIN_RING_POINTS:
        return 0.0
    r = ring[:, 0]
    c = ring[:, 1]
    twice = float(np.dot(c[:-1], r[1:]) - np.dot(c[1:], r[:-1]))
    return abs(twice) * 0.5 * px.area_m2


def ring_perimeter_m(ring: np.ndarray, px: PixelSize) -> float:
    if ring is None or len(ring) < 2:
        return 0.0
    d = np.diff(ring, axis=0)
    return float(np.hypot(d[:, 0] * px.row_m, d[:, 1] * px.col_m).sum())


def compactness(area_m2: float, perimeter_m: float) -> float:
    """Isoperimetric quotient `4πA/P²` — 1 for a disc, low for a leaked watershed basin."""
    if perimeter_m <= 0.0:
        return 0.0
    return clamp01(4.0 * math.pi * area_m2 / (perimeter_m * perimeter_m))


def ensure_ccw(coords: List[List[float]]) -> List[List[float]]:
    """RFC 7946 wants a counter-clockwise exterior ring (PostGIS accepts either, clients don't
    all agree)."""
    if len(coords) < MIN_RING_POINTS:
        return coords
    twice = 0.0
    for (x0, y0), (x1, y1) in zip(coords[:-1], coords[1:]):
        twice += (x1 - x0) * (y1 + y0)
    return coords if twice < 0 else coords[::-1]


def point_geojson(lon: float, lat: float) -> dict:
    return {"type": "Point", "coordinates": [round(lon, 8), round(lat, 8)]}


def polygon_geojson(coords: List[List[float]]) -> Optional[dict]:
    """`coords` = exterior ring as `[[lon, lat], …]`; returns None when it is degenerate."""
    ring = [[round(x, 8), round(y, 8)] for x, y in coords]
    if len(ring) >= 2 and ring[0] != ring[-1]:
        ring.append(list(ring[0]))
    if len(ring) < MIN_RING_POINTS:
        return None
    return {"type": "Polygon", "coordinates": [ensure_ccw(ring)]}
