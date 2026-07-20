"""Parameter resolution, and the numbers this service shares with the Rust worker.

`crates/worker/src/detect.rs` implements the same detector inside `arvo-worker`. Both are
bound by docs/API-PLANT.md §"Pipeline stages" → Detection, so the constants must not drift
apart: this test diffs them (and skips when the service is checked out on its own).
"""

import re
from pathlib import Path

import pytest

from app.config import DEFAULTS, DETECTOR_VER, UNIT_TYPES, resolve_params

WORKER_DETECT_RS = Path(__file__).resolve().parents[3] / "backend/crates/worker/src/detect.rs"
CONST_RE = re.compile(r"pub const (\w+)\s*:\s*(?:&str|f64)\s*=\s*\"?([^\";]+)\"?\s*;")


def _rust_constants():
    if not WORKER_DETECT_RS.is_file():
        pytest.skip(f"{WORKER_DETECT_RS} not present (standalone checkout)")
    return dict(CONST_RE.findall(WORKER_DETECT_RS.read_text()))


def test_model_version_matches_the_worker():
    assert _rust_constants()["DETECTOR_VER"] == DETECTOR_VER
    assert re.fullmatch(r"[a-z0-9-]+-\d+\.\d+\.\d+", DETECTOR_VER)  # "<detector>-<semver>"


@pytest.mark.parametrize(
    "rust_name,param",
    [
        ("MIN_SPACING_M", "min_spacing_m"),
        ("MIN_CROWN_M2", "min_crown_m2"),
        ("MAX_CROWN_M2", "max_crown_m2"),
        ("TERRAIN_WINDOW_M", "terrain_window_m"),
    ],
)
def test_frozen_detection_constants_match_the_worker(rust_name, param):
    assert float(_rust_constants()[rust_name]) == float(DEFAULTS[param])


def test_terrain_percentile_accepts_the_rust_fraction_and_a_percentile():
    # worker/detect.rs states it as a fraction (0.10); the wire field is a percentile (10).
    rust = float(_rust_constants()["TERRAIN_PERCENTILE"])
    assert resolve_params("tree", {"terrain_percentile": rust}).terrain_percentile == 10.0
    assert resolve_params("tree", {"terrain_percentile": 25.0}).terrain_percentile == 25.0
    assert resolve_params("tree").terrain_percentile == 10.0


def test_every_unit_type_resolves():
    for unit in UNIT_TYPES:
        params = resolve_params(unit)
        assert params.min_height_m > 0 and params.min_spacing_m > 0
        assert params.max_crown_m2 > params.min_crown_m2


def test_unit_defaults_then_caller_overrides_win():
    assert resolve_params("tree").min_height_m == 1.0
    assert resolve_params("bush").min_height_m == 0.4  # unit override
    assert resolve_params("bush", {"min_height_m": 2.0}).min_height_m == 2.0  # caller override
    assert resolve_params("bush", {"min_height_m": None}).min_height_m == 0.4  # None never wins
    assert resolve_params("tree", {"nonsense": 1}).min_height_m == 1.0  # unknown key ignored


def test_params_round_trip_as_json_types():
    params = resolve_params("vine").as_dict()
    assert params["plant_spacing_m"] == 1.0
    assert params["row_angle_deg"] is None
    assert isinstance(params["max_detections"], int)
