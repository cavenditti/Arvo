"""OWNER: be-detect — service config, model version, and the per-crop detector defaults.

Every constant that also exists on the Rust side (`backend/crates/worker/src/detect.rs`) is
repeated here with the *same value*: the two implementations are the same detector, so the
frozen numbers of docs/API-PLANT.md §"Pipeline stages" → Detection (1.5 m spacing, 0.5–80 m²
crowns, p10 terrain baseline over a 15 m window) must not drift. `tests/test_contract.py`
diffs them.
"""

import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

# `model_ver` stamped on every detection — "<detector>-<semver>", the format frozen in
# docs/API-PLANT.md; mirrors `DETECTOR_VER` in worker/detect.rs.
DETECTOR_VER = "cv-chm-0.1.0"

UNIT_TYPES = ("tree", "vine", "row_segment", "bush")
#: CHM local-maxima + watershed crown delineation.
CROWN_UNITS = ("tree", "bush")
#: Row-line detection + regular point placement along the row.
ROW_UNITS = ("vine", "row_segment")

#: Reflectance band names a `Capture.bands` map may carry (docs/API-PLANT.md §Captures).
BAND_NAMES = ("red", "green", "blue", "rededge", "nir", "swir")
#: What the API assumes when a capture omits `bands` — a plain RGB ortho.
DEFAULT_BANDS: Dict[str, int] = {"red": 1, "green": 2, "blue": 3}

#: Vegetation-index thresholds. `ndvi` 0.25 is the same canopy cut the `extract` stage uses.
VEG_MIN = {"ndvi": 0.25, "exg": 0.05}
#: Index value treated as "fully vigorous" when scoring a detection.
VEG_HI = {"ndvi": 0.85, "exg": 0.35}

# --- parameter defaults ------------------------------------------------------

#: Baseline for every unit type; `UNIT_OVERRIDES` then tunes the crop-specific ones.
DEFAULTS: Dict[str, Any] = {
    # read/resample
    "target_gsd_cm": 10.0,
    "max_pixels": 40_000_000,
    "clip_buffer_m": 2.0,
    # canopy height model
    "terrain_window_m": 15.0,
    "terrain_percentile": 10.0,
    "smooth_sigma_m": 0.6,
    "min_height_m": 1.0,
    # crown delineation
    "min_spacing_m": 1.5,
    "min_crown_m2": 0.5,
    "max_crown_m2": 80.0,
    # vegetation gate
    "veg_index": "auto",
    "veg_min": None,  # None → VEG_MIN[index]
    # rows (vine / row_segment)
    "row_angle_deg": None,  # None → Hough estimate
    "row_spacing_m": None,  # None → autocorrelation estimate
    "plant_spacing_m": 1.0,
    "segment_length_m": 5.0,
    "min_row_length_m": 3.0,
    # output
    "max_detections": 200_000,
}

#: Per-crop deltas. Keep these small and explainable — they are what a grower's agronomist
#: tunes first (see README §Tuning).
UNIT_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "tree": {},
    "bush": {
        "min_height_m": 0.4,
        "min_spacing_m": 1.0,
        "min_crown_m2": 0.2,
        "max_crown_m2": 20.0,
        "smooth_sigma_m": 0.3,
        "target_gsd_cm": 5.0,
    },
    "vine": {
        "min_height_m": 0.6,
        "min_spacing_m": 0.8,
        "target_gsd_cm": 5.0,
    },
    "row_segment": {
        "min_height_m": 0.3,
        "min_spacing_m": 0.5,
        "target_gsd_cm": 5.0,
    },
}


@dataclass(frozen=True)
class Params:
    """Effective parameters for one request (defaults + unit override + caller override)."""

    target_gsd_cm: float
    max_pixels: int
    clip_buffer_m: float
    terrain_window_m: float
    terrain_percentile: float
    smooth_sigma_m: float
    min_height_m: float
    min_spacing_m: float
    min_crown_m2: float
    max_crown_m2: float
    veg_index: str
    veg_min: Optional[float]
    row_angle_deg: Optional[float]
    row_spacing_m: Optional[float]
    plant_spacing_m: float
    segment_length_m: float
    min_row_length_m: float
    max_detections: int

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


def resolve_params(unit_type: str, overrides: Optional[Dict[str, Any]] = None) -> Params:
    """Merge defaults → unit override → caller override. `None` never overrides a default."""
    merged: Dict[str, Any] = dict(DEFAULTS)
    merged.update(UNIT_OVERRIDES.get(unit_type, {}))
    for key, value in (overrides or {}).items():
        if value is not None and key in merged:
            merged[key] = value
    # The Rust constant is a fraction (`TERRAIN_PERCENTILE = 0.10`) while the wire field is a
    # percentile; accept both so a caller mirroring the Rust side cannot silently ask for p0.1.
    pct = float(merged["terrain_percentile"])
    merged["terrain_percentile"] = pct * 100.0 if pct <= 1.0 else pct
    merged["max_pixels"] = int(merged["max_pixels"])
    merged["max_detections"] = int(merged["max_detections"])
    return Params(**merged)


# --- environment -------------------------------------------------------------

#: Same layout the API and the worker resolve independently (docs/API-PLANT.md §Storage layout).
DEFAULT_STORE_DIR = "./var/store"
#: A store key is a `/`-joined run of `[A-Za-z0-9._-]` segments — the exact rule
#: `crates/api/src/storage/mod.rs::validate_key` enforces, so `..` cannot be expressed.
KEY_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
MAX_KEY_LEN = 512


def store_root() -> Path:
    """Object-store root (`STORE_DIR`). Read per call so tests can point it at a tmpdir."""
    return Path(os.environ.get("STORE_DIR", DEFAULT_STORE_DIR))


def allow_abs_paths() -> bool:
    """Absolute paths in a request are off by default — keys are the contract."""
    return os.environ.get("PLANT_DETECT_ALLOW_ABS_PATHS", "0").strip().lower() in {"1", "true", "yes"}
