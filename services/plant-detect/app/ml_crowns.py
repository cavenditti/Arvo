"""Deep-learning crown detection on high-resolution RGB satellite/ortho imagery.

DeepForest is deliberately imported and its weights loaded lazily: the service can still start,
report health, and use the deterministic DSM/vegetation paths when the optional ML image is not
installed or the model registry is temporarily unavailable.
"""

import importlib.util
import logging
import os
import threading
from typing import Any, Dict, List, Tuple

import numpy as np

from . import geo
from .config import Params
from .errors import DetectError
from .geo import Detection, PixelSize

log = logging.getLogger("plant-detect.ml")

MODEL_ID = os.environ.get("PLANT_DETECT_ML_MODEL", "weecology/deepforest-tree")
_MODEL = None
_MODEL_LOCK = threading.Lock()


class MlUnavailable(RuntimeError):
    """The optional ML backend cannot be used; callers may choose the classical fallback."""


def mode() -> str:
    value = os.environ.get("PLANT_DETECT_ML", "auto").strip().lower()
    return value if value in {"auto", "deepforest", "off"} else "auto"


def status() -> Dict[str, Any]:
    installed = importlib.util.find_spec("deepforest") is not None
    return {
        "backend": "deepforest" if installed else "classical",
        "mode": mode(),
        "available": installed and mode() != "off",
        "loaded": _MODEL is not None,
        "model": MODEL_ID if installed else None,
    }


def _model():
    global _MODEL
    if mode() == "off":
        raise MlUnavailable("ML detection is disabled")
    if importlib.util.find_spec("deepforest") is None:
        raise MlUnavailable("DeepForest is not installed")
    if _MODEL is None:
        with _MODEL_LOCK:
            if _MODEL is None:
                try:
                    from deepforest import main

                    # DeepForest creates its Lightning trainer during construction. Override
                    # its relative `./lightning_logs` default before that happens, and pin CPU
                    # explicitly so a developer laptop never probes an unavailable accelerator.
                    candidate = main.deepforest(
                        config_args={
                            "log_root": os.path.join(
                                os.environ.get("XDG_CACHE_HOME", "/tmp"), "lightning"
                            ),
                            "accelerator": "cpu",
                            "devices": 1,
                            "model": {"name": MODEL_ID, "revision": "main"},
                        }
                    )
                    _MODEL = candidate
                    log.info("loaded ML crown model %s", MODEL_ID)
                except Exception as exc:  # model download/cache/import errors are recoverable in auto mode
                    raise MlUnavailable(f"could not load {MODEL_ID}: {exc}") from exc
    return _MODEL


def _byte_channel(array: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Robustly stretch uint, reflectance, or display-valued pixels into one 8-bit channel."""
    values = np.asarray(array, dtype=np.float32)
    good = valid & np.isfinite(values)
    if not good.any():
        return np.zeros(values.shape, dtype=np.uint8)
    sample = values[good]
    lo, hi = np.nanpercentile(sample, (1.0, 99.0))
    if hi <= lo:
        lo = float(np.nanmin(sample))
        hi = float(np.nanmax(sample))
    if hi <= lo:
        return np.zeros(values.shape, dtype=np.uint8)
    scaled = np.clip((values - lo) * (255.0 / (hi - lo)), 0.0, 255.0)
    scaled[~good] = 0.0
    return scaled.astype(np.uint8)


def bgr_image(bands: Dict[str, np.ndarray], valid: np.ndarray) -> np.ndarray:
    missing = [name for name in ("red", "green", "blue") if name not in bands]
    if missing:
        raise MlUnavailable(f"RGB bands are required for ML detection (missing {', '.join(missing)})")
    rgb = np.stack([_byte_channel(bands[name], valid) for name in ("red", "green", "blue")], axis=-1)
    return np.ascontiguousarray(rgb[..., ::-1])


def _patch_size(shape: Tuple[int, int], gsd_m: float) -> int:
    # DeepForest's documented aerial-image window is 400–800 px at 0.1 m. Keep roughly a
    # 60 m context window, with conservative bounds for sub-metre satellite products.
    desired = int(round(60.0 / max(gsd_m, 0.01)))
    desired = max(400, min(800, desired))
    return max(32, min(desired, max(shape)))


def _row_value(row: Any, name: str) -> float:
    try:
        return float(row[name])
    except (KeyError, TypeError, ValueError) as exc:
        raise MlUnavailable(f"DeepForest result has no valid {name!r} column") from exc


def detect(
    bands: Dict[str, np.ndarray],
    valid: np.ndarray,
    px: PixelSize,
    params: Params,
    clip: np.ndarray | None = None,
) -> Tuple[List[Detection], Dict[str, Any]]:
    """Run tiled RGB feature detection and convert predicted boxes to crown polygons."""
    image = bgr_image(bands, valid)
    patch_size = _patch_size(image.shape[:2], px.mean_m)
    overlap = float(os.environ.get("PLANT_DETECT_ML_PATCH_OVERLAP", "0.25"))
    score_min = float(os.environ.get("PLANT_DETECT_ML_SCORE", "0.20"))
    try:
        predictions = _model().predict_tile(
            image=image, patch_size=patch_size, patch_overlap=overlap
        )
    except MlUnavailable:
        raise
    except Exception as exc:
        raise MlUnavailable(f"DeepForest inference failed: {exc}") from exc

    stats: Dict[str, Any] = {
        "method": "deepforest_rgb_boxes",
        "ml_model": MODEL_ID,
        "patch_size_px": patch_size,
        "patch_overlap": overlap,
        "score_min": score_min,
        "raw_predictions": 0,
        "crowns": 0,
        "dropped_score": 0,
        "dropped_small": 0,
        "dropped_large": 0,
        "dropped_outside": 0,
    }
    if predictions is None:
        return [], stats
    stats["raw_predictions"] = int(len(predictions))

    height, width = image.shape[:2]
    detections: List[Detection] = []
    for _, row in predictions.iterrows():
        score = _row_value(row, "score")
        if score < score_min:
            stats["dropped_score"] += 1
            continue
        x0 = max(0, min(width, int(np.floor(_row_value(row, "xmin")))))
        y0 = max(0, min(height, int(np.floor(_row_value(row, "ymin")))))
        x1 = max(0, min(width, int(np.ceil(_row_value(row, "xmax")))))
        y1 = max(0, min(height, int(np.ceil(_row_value(row, "ymax")))))
        if x1 <= x0 or y1 <= y0:
            stats["dropped_outside"] += 1
            continue

        crown = valid[y0:y1, x0:x1].copy()
        if clip is not None:
            crown &= clip[y0:y1, x0:x1]
        if not crown.any():
            stats["dropped_outside"] += 1
            continue
        ring = geo.mask_to_ring(crown, offset=(y0, x0))
        if ring is None:
            stats["dropped_outside"] += 1
            continue
        area_m2 = geo.ring_area_m2(ring, px)
        if area_m2 < params.min_crown_m2:
            stats["dropped_small"] += 1
            continue
        if area_m2 > params.max_crown_m2:
            stats["dropped_large"] += 1
            continue
        rows, cols = np.nonzero(crown)
        detections.append(
            Detection(
                row=float(rows.mean() + y0),
                col=float(cols.mean() + x0),
                score=round(geo.clamp01(score), 4),
                ring=ring,
                height_m=None,
                canopy_m2=round(area_m2, 3),
            )
        )

    stats["crowns"] = len(detections)
    return detections, stats
