"""The load-bearing test: a synthetic orchard with N obvious trees → exactly N detections."""

import numpy as np
import pytest

from app import chm as chm_mod
from app import crowns
from app.config import resolve_params
from app.geo import PixelSize
from tests.synthetic import add_box, make_orchard


def _chm(orchard, params):
    return chm_mod.canopy_height_model(
        orchard.dsm, orchard.pixel_m, params.terrain_window_m, params.terrain_percentile
    )


def _px(orchard):
    return PixelSize(orchard.pixel_m, orchard.pixel_m)


def _nearest_distance_m(detections, centres_rc, pixel_m):
    """Distance from every true tree to the closest detection, in metres."""
    found = np.array([[d.row, d.col] for d in detections])
    out = []
    for row, col in centres_rc:
        out.append(np.hypot(found[:, 0] - row, found[:, 1] - col).min() * pixel_m)
    return np.asarray(out)


def test_finds_every_synthetic_tree():
    orchard = make_orchard()
    params = resolve_params("tree")
    detections, stats = crowns.detect_crowns(_chm(orchard, params), _px(orchard), params)

    assert len(detections) == orchard.n == 48
    assert stats["seeds"] == orchard.n
    # Every planted tree has a detection on top of it (crown radius 1.6 m).
    assert _nearest_distance_m(detections, orchard.centres_rc, orchard.pixel_m).max() < 1.0
    for d in detections:
        assert 0.0 <= d.score <= 1.0
        assert d.height_m == pytest.approx(orchard.tree_h_m, abs=0.4)
        assert 3.0 < d.canopy_m2 < 15.0  # dome cut at 1 m → ~7.5 m²
        assert d.ring is not None and len(d.ring) >= 4
        assert np.allclose(d.ring[0], d.ring[-1])  # closed


def test_watershed_splits_touching_crowns():
    # 3 m spacing with 1.7 m crowns: the canopy is continuous, only the watershed separates them.
    orchard = make_orchard(n_rows=5, n_cols=5, spacing_m=3.0, crown_r_m=1.7, margin_m=3.0)
    params = resolve_params("tree")
    detections, _ = crowns.detect_crowns(_chm(orchard, params), _px(orchard), params)

    assert len(detections) == orchard.n == 25
    assert _nearest_distance_m(detections, orchard.centres_rc, orchard.pixel_m).max() < 1.0


def test_bare_ground_detects_nothing():
    orchard = make_orchard(n_rows=0, n_cols=0, margin_m=20.0)
    params = resolve_params("tree")
    chm = _chm(orchard, params)

    assert chm.max() < 0.3  # the ramp is gone: CHM is height above *local* ground
    detections, _ = crowns.detect_crowns(chm, _px(orchard), params)
    assert detections == []


def test_area_filters_drop_out_of_range_crowns():
    orchard = make_orchard(n_rows=3, n_cols=3)
    px = _px(orchard)

    small = resolve_params("tree", {"max_crown_m2": 2.0})
    detections, stats = crowns.detect_crowns(_chm(orchard, small), px, small)
    assert detections == [] and stats["dropped_large"] == orchard.n

    large = resolve_params("tree", {"min_crown_m2": 50.0})
    detections, stats = crowns.detect_crowns(_chm(orchard, large), px, large)
    assert detections == [] and stats["dropped_small"] == orchard.n


def test_min_height_separates_bush_from_tree_defaults():
    # 0.7 m shrubs: below the `tree` threshold (1.0 m), above the `bush` one (0.4 m).
    orchard = make_orchard(n_rows=3, n_cols=3, crown_r_m=0.9, tree_h_m=0.7, spacing_m=3.0)
    px = _px(orchard)

    as_tree = resolve_params("tree")
    assert crowns.detect_crowns(_chm(orchard, as_tree), px, as_tree)[0] == []

    as_bush = resolve_params("bush")
    detections, _ = crowns.detect_crowns(_chm(orchard, as_bush), px, as_bush)
    assert len(detections) == orchard.n


def test_vegetation_gate_rejects_a_shed():
    orchard = make_orchard(n_rows=3, n_cols=3, margin_m=8.0)
    params = resolve_params("tree")
    px = _px(orchard)
    # A 3 m × 3 m, 3.5 m tall block clear of the planting grid — tree-sized, tree-height.
    shed_c, shed_r = 3.0, 1.5
    dsm = add_box(orchard.dsm, orchard.pixel_m, centre_m=(shed_c, shed_c), size_m=2 * shed_r, height_m=3.5)
    chm = chm_mod.canopy_height_model(
        dsm, orchard.pixel_m, params.terrain_window_m, params.terrain_percentile
    )

    without_veg, _ = crowns.detect_crowns(chm, px, params)
    assert len(without_veg) == orchard.n + 1  # height alone cannot tell a shed from a tree

    # NDVI: high over canopy, near zero over the roof.
    ndvi = np.where(chm > 0.5, 0.72, 0.05).astype(np.float32)
    yy, xx = np.mgrid[0 : chm.shape[0], 0 : chm.shape[1]] * orchard.pixel_m
    ndvi[(np.abs(xx - shed_c) <= shed_r) & (np.abs(yy - shed_c) <= shed_r)] = 0.04
    veg = chm_mod.Veg(name="ndvi", array=ndvi, vmin=0.25, vhi=0.85)

    with_veg, stats = crowns.detect_crowns(chm, px, params, veg=veg)
    assert len(with_veg) == orchard.n
    assert stats["dropped_small"] == 0


def test_clip_mask_limits_detection_to_the_parcel():
    orchard = make_orchard()
    params = resolve_params("tree")
    clip = np.zeros(orchard.dsm.shape, dtype=bool)
    clip[:, : orchard.dsm.shape[1] // 2] = True  # west half only

    detections, _ = crowns.detect_crowns(_chm(orchard, params), _px(orchard), params, clip=clip)
    assert 0 < len(detections) < orchard.n
    assert all(d.col < orchard.dsm.shape[1] / 2 + 20 for d in detections)


def test_score_rewards_a_taller_rounder_crown():
    tall = make_orchard(n_rows=1, n_cols=1, tree_h_m=5.0, margin_m=6.0)
    short = make_orchard(n_rows=1, n_cols=1, tree_h_m=1.6, margin_m=6.0)
    params = resolve_params("tree")

    tall_det, _ = crowns.detect_crowns(_chm(tall, params), _px(tall), params)
    short_det, _ = crowns.detect_crowns(_chm(short, params), _px(short), params)
    assert len(tall_det) == len(short_det) == 1
    assert tall_det[0].score > short_det[0].score
    assert 0.0 <= short_det[0].score <= tall_det[0].score <= 1.0
