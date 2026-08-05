"""ML adapter tests use a tiny fake model: CI never downloads model weights."""

import numpy as np
import pytest

from app import ml_crowns
from app.config import resolve_params
from app.geo import PixelSize


class _Predictions:
    def __init__(self, rows):
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def iterrows(self):
        return iter(enumerate(self.rows))


class _Model:
    def __init__(self, rows):
        self.rows = rows
        self.call = None

    def predict_tile(self, **kwargs):
        self.call = kwargs
        return _Predictions(self.rows)


def test_rgb_feature_boxes_become_filtered_crown_detections(monkeypatch):
    shape = (100, 120)
    bands = {
        "red": np.tile(np.arange(shape[1], dtype=np.float32), (shape[0], 1)),
        "green": np.full(shape, 80.0, dtype=np.float32),
        "blue": np.full(shape, 20.0, dtype=np.float32),
    }
    valid = np.ones(shape, dtype=bool)
    model = _Model(
        [
            {"xmin": 10, "ymin": 20, "xmax": 40, "ymax": 50, "score": 0.91},
            {"xmin": 60, "ymin": 20, "xmax": 62, "ymax": 22, "score": 0.10},
        ]
    )
    monkeypatch.setattr(ml_crowns, "_model", lambda: model)

    detections, stats = ml_crowns.detect(
        bands, valid, PixelSize(0.1, 0.1), resolve_params("tree")
    )

    assert len(detections) == 1
    assert detections[0].score == 0.91
    assert detections[0].height_m is None
    # `canopy_m2` follows the simplified emitted polygon, not the unsimplified pixel count.
    assert detections[0].canopy_m2 == pytest.approx(9.0, abs=0.5)
    assert detections[0].ring.shape == (5, 2)
    assert stats["method"] == "deepforest_rgb_boxes"
    assert stats["raw_predictions"] == 2
    assert stats["dropped_score"] == 1
    assert model.call["image"].dtype == np.uint8
    assert model.call["image"].shape == (*shape, 3)
    assert model.call["patch_overlap"] == 0.25


def test_ml_boxes_are_clipped_to_the_parcel(monkeypatch):
    shape = (80, 80)
    bands = {name: np.arange(80 * 80, dtype=np.float32).reshape(shape) for name in ("red", "green", "blue")}
    valid = np.ones(shape, dtype=bool)
    clip = np.zeros(shape, dtype=bool)
    clip[20:40, 20:35] = True
    monkeypatch.setattr(
        ml_crowns,
        "_model",
        lambda: _Model([{"xmin": 10, "ymin": 10, "xmax": 50, "ymax": 50, "score": 0.8}]),
    )

    detections, _ = ml_crowns.detect(
        bands, valid, PixelSize(0.2, 0.2), resolve_params("tree"), clip=clip
    )

    assert len(detections) == 1
    assert detections[0].canopy_m2 == pytest.approx(12.0, abs=0.8)
    assert 20 <= detections[0].row < 40
    assert 20 <= detections[0].col < 35


def test_missing_rgb_is_an_available_fallback_signal():
    try:
        ml_crowns.bgr_image({"red": np.ones((2, 2))}, np.ones((2, 2), dtype=bool))
    except ml_crowns.MlUnavailable as exc:
        assert "RGB bands" in str(exc)
    else:  # pragma: no cover - documents the required adapter behaviour
        raise AssertionError("missing RGB should not reach the model")
