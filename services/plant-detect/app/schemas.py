"""OWNER: be-detect — the wire contract (pydantic v2).

Request/response shapes are documented in README.md §Contract; they exist so the Rust worker
(`crates/worker/src/detect.rs`) can fill `plant_detections` straight from the response:
`geom` and `crown_geom` go into `ST_GeomFromGeoJSON`, the rest are columns.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import BAND_NAMES, UNIT_TYPES

GEOMETRY_TYPES = ("Polygon", "MultiPolygon")
VEG_INDEX_KINDS = ("auto", "ndvi", "exg", "none")


class DetectParams(BaseModel):
    """Tuning knobs. Every field is optional — `None` means "use the crop default"
    (`config.DEFAULTS` + `config.UNIT_OVERRIDES`). Unknown keys are rejected: a typo in a
    tuning parameter silently ruins a detection run."""

    model_config = ConfigDict(extra="forbid")

    target_gsd_cm: Optional[float] = Field(None, gt=0.0, le=200.0)
    max_pixels: Optional[int] = Field(None, ge=10_000, le=400_000_000)
    clip_buffer_m: Optional[float] = Field(None, ge=0.0, le=100.0)

    terrain_window_m: Optional[float] = Field(None, ge=1.0, le=200.0)
    terrain_percentile: Optional[float] = Field(None, ge=0.0, le=100.0)
    smooth_sigma_m: Optional[float] = Field(None, ge=0.0, le=10.0)
    min_height_m: Optional[float] = Field(None, ge=0.0, le=50.0)

    min_spacing_m: Optional[float] = Field(None, gt=0.0, le=50.0)
    min_crown_m2: Optional[float] = Field(None, ge=0.0, le=1000.0)
    max_crown_m2: Optional[float] = Field(None, gt=0.0, le=10_000.0)

    veg_index: Optional[str] = None
    veg_min: Optional[float] = Field(None, ge=-1.0, le=1.0)

    row_angle_deg: Optional[float] = Field(None, ge=-360.0, le=360.0)
    row_spacing_m: Optional[float] = Field(None, gt=0.0, le=50.0)
    plant_spacing_m: Optional[float] = Field(None, gt=0.0, le=50.0)
    segment_length_m: Optional[float] = Field(None, gt=0.0, le=200.0)
    min_row_length_m: Optional[float] = Field(None, ge=0.0, le=1000.0)

    max_detections: Optional[int] = Field(None, ge=1, le=1_000_000)

    @field_validator("veg_index")
    @classmethod
    def _known_index(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in VEG_INDEX_KINDS:
            raise ValueError(f"veg_index must be one of {', '.join(VEG_INDEX_KINDS)}")
        return value


class DetectRequest(BaseModel):
    """`POST /detect` body. Extra envelope fields are ignored so the caller can pass its own
    correlation ids."""

    model_config = ConfigDict(extra="ignore")

    capture_id: Optional[str] = None
    unit_type: str = "tree"
    #: Store keys (`captures/{id}/ortho.tif`), not absolute paths — see README §Storage.
    ortho_path: Optional[str] = None
    dsm_path: Optional[str] = None
    #: `Capture.bands`: reflectance band name → 1-based band index in the ortho.
    bands: Dict[str, int] = Field(default_factory=dict)
    #: GeoJSON Polygon/MultiPolygon in EPSG:4326; detection is clipped to it.
    parcel_geometry: Optional[Dict[str, Any]] = None
    params: DetectParams = Field(default_factory=DetectParams)

    @field_validator("unit_type")
    @classmethod
    def _known_unit(cls, value: str) -> str:
        if value not in UNIT_TYPES:
            raise ValueError(f"unit_type must be one of {', '.join(UNIT_TYPES)}")
        return value

    @field_validator("bands")
    @classmethod
    def _known_bands(cls, value: Dict[str, int]) -> Dict[str, int]:
        for name, index in value.items():
            if name not in BAND_NAMES:
                raise ValueError(f"unknown band {name!r} (expected {', '.join(BAND_NAMES)})")
            if not 1 <= int(index) <= 16:
                raise ValueError(f"band {name!r} index must be 1..16")
        return value

    @field_validator("parcel_geometry")
    @classmethod
    def _geometry_shape(cls, value: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if value is None:
            return None
        if value.get("type") not in GEOMETRY_TYPES or not value.get("coordinates"):
            raise ValueError("parcel_geometry must be a GeoJSON Polygon or MultiPolygon")
        return value


class DetectionOut(BaseModel):
    """One row of `plant_detections`, minus the ids the worker owns."""

    model_config = ConfigDict(protected_namespaces=())

    geom: Dict[str, Any]
    crown_geom: Optional[Dict[str, Any]] = None
    score: float
    height_m: Optional[float] = None
    canopy_m2: Optional[float] = None


class DetectResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    model_ver: str
    unit_type: str
    capture_id: Optional[str] = None
    count: int
    truncated: bool = False
    pixel_size_m: Optional[float] = None
    bbox: Optional[List[float]] = None
    params: Dict[str, Any] = Field(default_factory=dict)
    stats: Dict[str, Any] = Field(default_factory=dict)
    detections: List[DetectionOut] = Field(default_factory=list)


class HealthResponse(BaseModel):
    model_config = ConfigDict(protected_namespaces=())

    status: str
    model_ver: str
    unit_types: List[str]
    rasterio: Optional[str] = None
    gdal: Optional[str] = None
