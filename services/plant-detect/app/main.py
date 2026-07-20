"""OWNER: be-detect — `services/plant-detect`, the label-free plant detector.

One endpoint (`POST /detect`) behind which the two detection families live: CHM watershed
crowns for `tree`/`bush`, row-line point placement for `vine`/`row_segment`
(docs/PHASE-PLANT.md §3, docs/API-PLANT.md §"Pipeline stages" → Detection). Classical CV only:
no training, no weights to download, CPU-only.

Handlers are deliberately **sync** `def` — the CV work is CPU-bound, so Starlette runs them in
its threadpool instead of stalling the event loop. Scale with `uvicorn --workers N`.
"""

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import chm as chm_mod
from . import crowns, raster, rows
from .config import CROWN_UNITS, DEFAULT_BANDS, DETECTOR_VER, UNIT_TYPES, Params, resolve_params
from .errors import DetectError
from .geo import Detection
from .schemas import DetectRequest, DetectResponse, HealthResponse

log = logging.getLogger("plant-detect")

app = FastAPI(title="arvo plant-detect", version=DETECTOR_VER)


@app.exception_handler(DetectError)
def _handle_detect_error(_: Request, exc: DetectError) -> JSONResponse:
    return JSONResponse(status_code=exc.status, content=exc.body())


@app.exception_handler(RequestValidationError)
def _handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ())[1:]) or "body"
    return JSONResponse(
        status_code=400,
        content=DetectError("bad_request", f"{where}: {first.get('msg', 'invalid request')}").body(),
    )


@app.exception_handler(StarletteHTTPException)
def _handle_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = {400: "bad_request", 404: "not_found", 405: "bad_request"}.get(exc.status_code, "internal")
    return JSONResponse(status_code=exc.status_code, content=DetectError(code, str(exc.detail)).body())


@app.exception_handler(Exception)
def _handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
    log.exception("detect failed: %s", exc)
    return JSONResponse(status_code=500, content=DetectError("internal", "detection failed").body())


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    try:
        import rasterio

        rio_ver: Optional[str] = rasterio.__version__
        gdal_ver: Optional[str] = rasterio.__gdal_version__
    except Exception:  # pragma: no cover - rasterio is a hard dependency, this is belt & braces
        rio_ver = gdal_ver = None
    return HealthResponse(
        status="ok",
        model_ver=DETECTOR_VER,
        unit_types=list(UNIT_TYPES),
        rasterio=rio_ver,
        gdal=gdal_ver,
    )


@app.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest) -> DetectResponse:
    started = time.perf_counter()
    params = resolve_params(req.unit_type, req.params.model_dump(exclude_none=True))

    if req.unit_type in CROWN_UNITS:
        detections, grid, stats = _detect_crowns(req, params)
    else:
        detections, grid, stats = _detect_rows(req, params)

    truncated = len(detections) > params.max_detections
    if truncated:
        # Keep the most confident ones when the cap bites, not an arbitrary spatial slice.
        detections = sorted(detections, key=lambda d: d.score, reverse=True)[: params.max_detections]

    features = raster.detections_to_geojson(grid, detections)
    stats["elapsed_ms"] = int((time.perf_counter() - started) * 1000)
    log.info(
        "detect capture=%s unit=%s -> %d detections in %d ms",
        req.capture_id,
        req.unit_type,
        len(features),
        stats["elapsed_ms"],
    )
    return DetectResponse(
        model_ver=DETECTOR_VER,
        unit_type=req.unit_type,
        capture_id=req.capture_id,
        count=len(features),
        truncated=truncated,
        pixel_size_m=round(grid.px.mean_m, 4),
        bbox=grid.bbox_4326(),
        params=params.as_dict(),
        stats=stats,
        detections=features,
    )


# --- the two detection families ---------------------------------------------


def _vegetation(req: DetectRequest, grid: raster.Grid, params: Params) -> Optional[chm_mod.Veg]:
    """Vegetation index over the working grid, when the capture has an ortho."""
    if not req.ortho_path or params.veg_index == "none":
        return None
    ortho = raster.resolve_store_path(req.ortho_path)
    bands = raster.read_bands_on_grid(ortho, grid, req.bands or DEFAULT_BANDS, params)
    return chm_mod.vegetation(bands, params.veg_index, params.veg_min)


def _detect_crowns(req: DetectRequest, params: Params) -> Tuple[List[Detection], raster.Grid, Dict[str, Any]]:
    """`tree` / `bush`: canopy height model → local maxima → watershed crowns."""
    if not req.dsm_path:
        raise DetectError("bad_request", f"dsm_path is required for unit_type {req.unit_type!r}")
    grid = raster.read_grid(raster.resolve_store_path(req.dsm_path), req.parcel_geometry, params)
    veg = _vegetation(req, grid, params)
    canopy = chm_mod.canopy_height_model(
        grid.array, grid.px.mean_m, params.terrain_window_m, params.terrain_percentile, valid=grid.valid
    )
    detections, stats = crowns.detect_crowns(canopy, grid.px, params, veg=veg, clip=grid.clip)
    stats["veg_index"] = veg.name if veg else None
    return detections, grid, stats


def _detect_rows(req: DetectRequest, params: Params) -> Tuple[List[Detection], raster.Grid, Dict[str, Any]]:
    """`vine` / `row_segment`: vegetation mask → row lines → points at a fixed spacing."""
    if not req.dsm_path and not req.ortho_path:
        raise DetectError("bad_request", f"ortho_path or dsm_path is required for unit_type {req.unit_type!r}")
    # The DSM is the better reference grid (it carries height); fall back to the ortho.
    reference = req.dsm_path or req.ortho_path
    grid = raster.read_grid(raster.resolve_store_path(reference), req.parcel_geometry, params)

    canopy = None
    if req.dsm_path:
        canopy = chm_mod.canopy_height_model(
            grid.array, grid.px.mean_m, params.terrain_window_m, params.terrain_percentile, valid=grid.valid
        )
    veg = _vegetation(req, grid, params)
    if veg is not None:
        mask = veg.mask()
    elif canopy is not None:
        mask = canopy >= params.min_height_m
    else:
        raise DetectError("bad_request", "ortho has no usable bands for a vegetation mask")
    if grid.clip is not None:
        mask = mask & grid.clip

    detections, stats = rows.detect_rows(mask, grid.px, params, req.unit_type, chm=canopy)
    stats["veg_index"] = veg.name if veg else None
    return detections, grid, stats
