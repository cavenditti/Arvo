"""Pixel-space geometry: the crown outline and the numbers derived from it."""

import math

import numpy as np
import pytest

from app import geo
from app.geo import PixelSize

PX = PixelSize(0.1, 0.1)


def _disc(radius_px: int) -> np.ndarray:
    size = radius_px * 2 + 5
    yy, xx = np.mgrid[0:size, 0:size] - size // 2
    return np.hypot(yy, xx) <= radius_px


def test_ring_of_a_disc_matches_its_area_and_perimeter():
    radius_px = 16
    ring = geo.mask_to_ring(_disc(radius_px))
    r_m = radius_px * PX.col_m

    assert ring is not None and np.allclose(ring[0], ring[-1])
    assert geo.ring_area_m2(ring, PX) == pytest.approx(math.pi * r_m**2, rel=0.05)
    assert geo.ring_perimeter_m(ring, PX) == pytest.approx(2 * math.pi * r_m, rel=0.10)
    assert geo.compactness(geo.ring_area_m2(ring, PX), geo.ring_perimeter_m(ring, PX)) > 0.85


def test_ring_area_equals_the_pixel_count_it_came_from():
    """`canopy_m2` is the polygon's area, so the two can never disagree in a response."""
    mask = _disc(20)
    ring = geo.mask_to_ring(mask)
    assert geo.ring_area_m2(ring, PX) == pytest.approx(mask.sum() * PX.area_m2, rel=0.03)


def test_offset_places_the_ring_in_full_array_coordinates():
    ring = geo.mask_to_ring(_disc(6), offset=(100.0, 250.0))
    assert 90 < ring[:, 0].mean() < 110
    assert 240 < ring[:, 1].mean() < 260


def test_a_single_pixel_blob_falls_back_to_its_bounding_box():
    mask = np.zeros((7, 7), dtype=bool)
    mask[3, 3] = True
    ring = geo.mask_to_ring(mask)
    assert ring is not None and len(ring) >= geo.MIN_RING_POINTS
    assert geo.ring_area_m2(ring, PX) == pytest.approx(PX.area_m2, rel=0.5)


def test_empty_mask_has_no_ring():
    assert geo.mask_to_ring(np.zeros((5, 5), dtype=bool)) is None


def test_polygon_geojson_closes_and_orients_the_ring():
    clockwise = [[0.0, 0.0], [0.0, 1.0], [1.0, 1.0], [1.0, 0.0]]
    poly = geo.polygon_geojson(clockwise)
    ring = poly["coordinates"][0]

    assert poly["type"] == "Polygon"
    assert ring[0] == ring[-1]  # closed
    twice = sum((b[0] - a[0]) * (b[1] + a[1]) for a, b in zip(ring[:-1], ring[1:]))
    assert twice < 0  # RFC 7946 counter-clockwise exterior


def test_polygon_geojson_rejects_a_degenerate_ring():
    assert geo.polygon_geojson([[0.0, 0.0], [1.0, 1.0]]) is None


def test_pixel_size_handles_a_non_square_pixel():
    px = PixelSize(row_m=0.2, col_m=0.05)
    assert px.area_m2 == pytest.approx(0.01)
    assert px.mean_m == pytest.approx(0.1)


def test_clamp01():
    assert (geo.clamp01(-3.0), geo.clamp01(0.4), geo.clamp01(9.0)) == (0.0, 0.4, 1.0)
