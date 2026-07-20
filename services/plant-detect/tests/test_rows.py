"""Row detection for `vine` / `row_segment`: known rows in, the same rows out."""

import math

import numpy as np
import pytest

from app import rows
from app.config import resolve_params
from app.geo import PixelSize
from tests.synthetic import make_rows_mask

PX = PixelSize(0.1, 0.1)


def _v_of(detections, phi, pixel_m=0.1):
    """Across-row coordinate of each detection, for comparing against the true row lines."""
    x = np.array([d.col for d in detections]) * pixel_m
    y = np.array([d.row for d in detections]) * pixel_m
    return -x * math.sin(phi) + y * math.cos(phi)


def test_estimate_angle_recovers_a_known_direction():
    for angle in (0.0, 20.0, 63.0, 150.0):
        mask, _ = make_rows_mask(angle_deg=angle)
        cy, cx = np.nonzero(mask)
        found = math.degrees(rows.estimate_angle(cx * 0.1, cy * 0.1))
        assert min(abs(found - angle), 180 - abs(found - angle)) < 0.6


def test_estimate_spacing_recovers_a_known_period():
    mask, _ = make_rows_mask(spacing_m=2.5, angle_deg=0.0)
    cy, cx = np.nonzero(mask)
    profile, _ = rows._profile(cx * 0.1, cy * 0.1, 0.0, rows.PROFILE_BIN_M)
    assert rows.estimate_spacing(profile, rows.PROFILE_BIN_M) == pytest.approx(2.5, abs=0.15)


def test_vine_points_land_on_every_row_at_the_right_spacing():
    mask, centres_v = make_rows_mask(n_rows=5, row_length_m=30.0, spacing_m=2.5, angle_deg=20.0)
    params = resolve_params("vine", {"plant_spacing_m": 1.0})

    detections, stats = rows.detect_rows(mask, PX, params, "vine")

    assert stats["rows"] == 5
    assert stats["row_spacing_m"] == pytest.approx(2.5, abs=0.2)
    assert stats["angle_deg"] == pytest.approx(20.0, abs=0.6)
    # 30 m of row at 1 m spacing, five rows — allow one plant of slack per row for the ends.
    assert 5 * 29 <= len(detections) <= 5 * 31
    # Every point sits on one of the real row centre lines.
    v = _v_of(detections, math.radians(stats["angle_deg"]))
    residual = np.min(np.abs(v[:, None] - np.asarray(centres_v)[None, :]), axis=1)
    assert residual.max() < 0.4
    assert all(0.0 <= d.score <= 1.0 and d.ring is None for d in detections)


def test_row_segment_tiles_the_row_into_fixed_lengths():
    mask, _ = make_rows_mask(n_rows=3, row_length_m=30.0, angle_deg=0.0)
    params = resolve_params("row_segment", {"segment_length_m": 5.0})

    detections, stats = rows.detect_rows(mask, PX, params, "row_segment")

    assert stats["rows"] == 3
    assert len(detections) == pytest.approx(3 * 6, abs=3)  # 30 m / 5 m per row
    # Segment midpoints are one segment apart along the row.
    along = np.sort(np.array([d.col for d in detections[:6]]) * 0.1)
    assert np.diff(along).mean() == pytest.approx(5.0, abs=0.6)


def test_a_forced_angle_overrides_the_estimate():
    mask, _ = make_rows_mask(n_rows=4, angle_deg=35.0)
    params = resolve_params("vine", {"row_angle_deg": 35.0})

    detections, stats = rows.detect_rows(mask, PX, params, "vine")
    assert stats["angle_deg"] == pytest.approx(35.0, abs=0.001)
    assert stats["rows"] == 4 and len(detections) > 0


def test_a_short_stub_is_not_a_row():
    mask, _ = make_rows_mask(n_rows=2, row_length_m=2.0, angle_deg=0.0)
    params = resolve_params("vine", {"min_row_length_m": 5.0})

    detections, stats = rows.detect_rows(mask, PX, params, "vine")
    assert stats["rows"] == 0 and detections == []


def test_empty_mask_detects_nothing():
    detections, stats = rows.detect_rows(
        np.zeros((200, 200), dtype=bool), PX, resolve_params("vine"), "vine"
    )
    assert detections == [] and stats["points"] == 0


def test_height_comes_from_the_chm_when_a_dsm_was_supplied():
    mask, _ = make_rows_mask(n_rows=2, row_length_m=20.0, angle_deg=0.0)
    chm = np.where(mask, 1.9, 0.0).astype(np.float32)
    params = resolve_params("vine")

    detections, _ = rows.detect_rows(mask, PX, params, "vine", chm=chm)
    assert detections
    assert all(d.height_m == pytest.approx(1.9, abs=0.01) for d in detections)
