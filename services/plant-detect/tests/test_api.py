"""End-to-end over HTTP: store key → GeoTIFF → detections in EPSG:4326.

Everything is generated here — no drone data, no network. Skipped when rasterio/fastapi are
not installed (`pip install -r requirements-dev.txt`).
"""

import numpy as np
import pytest

rasterio = pytest.importorskip("rasterio")
pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402
from rasterio.transform import from_origin  # noqa: E402
from rasterio.warp import transform_bounds  # noqa: E402

from app.config import DETECTOR_VER  # noqa: E402
from app.main import app  # noqa: E402
from tests.synthetic import make_orchard, make_rows_mask  # noqa: E402

client = TestClient(app)

#: UTM 33N over the seeded demo farm (Foggia plain) — a projected, metre-based CRS, which is
#: what ODM emits.
CRS = "EPSG:32633"
ORIGIN_X, ORIGIN_Y = 570_000.0, 4_590_000.0


def _write_tif(path, arrays, pixel_m, dtype="float32"):
    bands = np.asarray(arrays, dtype=dtype)
    if bands.ndim == 2:
        bands = bands[None, ...]
    height, width = bands.shape[1], bands.shape[2]
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=height,
        width=width,
        count=bands.shape[0],
        dtype=dtype,
        crs=CRS,
        transform=from_origin(ORIGIN_X, ORIGIN_Y, pixel_m, pixel_m),
    ) as dst:
        dst.write(bands)
    return path


def _parcel_of(shape, pixel_m):
    """The raster's own footprint as a GeoJSON Polygon in EPSG:4326."""
    height, width = shape
    west, north = ORIGIN_X, ORIGIN_Y
    east, south = west + width * pixel_m, north - height * pixel_m
    w, s, e, n = transform_bounds(CRS, "EPSG:4326", west, south, east, north)
    return {"type": "Polygon", "coordinates": [[[w, s], [e, s], [e, n], [w, n], [w, s]]]}


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("STORE_DIR", str(tmp_path))
    monkeypatch.delenv("PLANT_DETECT_ALLOW_ABS_PATHS", raising=False)
    (tmp_path / "captures" / "c1").mkdir(parents=True)
    return tmp_path


def test_health_reports_the_model_version():
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["model_ver"] == DETECTOR_VER
    assert "tree" in body["unit_types"]


def test_detects_every_tree_of_a_geotiff_orchard(store):
    orchard = make_orchard()
    _write_tif(store / "captures/c1/dsm.tif", orchard.dsm, orchard.pixel_m)

    response = client.post(
        "/detect",
        json={
            "capture_id": "11111111-1111-4111-8111-111111111111",
            "unit_type": "tree",
            "dsm_path": "captures/c1/dsm.tif",
            "parcel_geometry": _parcel_of(orchard.dsm.shape, orchard.pixel_m),
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["count"] == orchard.n == 48
    assert body["model_ver"] == DETECTOR_VER
    assert body["truncated"] is False
    assert body["capture_id"] == "11111111-1111-4111-8111-111111111111"
    assert body["pixel_size_m"] == pytest.approx(0.1, abs=0.01)
    assert body["params"]["min_spacing_m"] == 1.5

    west, south, east, north = body["bbox"]
    for d in body["detections"]:
        assert d["geom"]["type"] == "Point"
        lon, lat = d["geom"]["coordinates"]
        assert west <= lon <= east and south <= lat <= north
        assert d["crown_geom"]["type"] == "Polygon"
        ring = d["crown_geom"]["coordinates"][0]
        assert len(ring) >= 4 and ring[0] == ring[-1]
        assert 0.0 <= d["score"] <= 1.0
        assert d["height_m"] == pytest.approx(4.0, abs=0.4)
        assert 3.0 < d["canopy_m2"] < 15.0

    # Detections are ~5 m apart on the planting grid, i.e. metres — not degrees, not pixels.
    lons = sorted(d["geom"]["coordinates"][0] for d in body["detections"])
    assert 0.0 < lons[-1] - lons[0] < 0.001


def test_ndvi_from_a_coarser_ortho_is_warped_onto_the_dsm_grid(store):
    orchard = make_orchard(n_rows=3, n_cols=3)
    _write_tif(store / "captures/c1/dsm.tif", orchard.dsm, orchard.pixel_m)

    # Ortho at half the DSM resolution → exercises the reprojection path.
    half = orchard.dsm[::2, ::2]
    canopy = (half - half.min()) > 1.0
    red = np.where(canopy, 0.05, 0.30)
    nir = np.where(canopy, 0.60, 0.32)
    _write_tif(
        store / "captures/c1/ortho.tif",
        np.stack([red, red * 1.2, red * 0.9, nir]),
        orchard.pixel_m * 2,
    )

    body = client.post(
        "/detect",
        json={
            "unit_type": "tree",
            "dsm_path": "captures/c1/dsm.tif",
            "ortho_path": "captures/c1/ortho.tif",
            "bands": {"red": 1, "green": 2, "blue": 3, "nir": 4},
            "parcel_geometry": _parcel_of(orchard.dsm.shape, orchard.pixel_m),
        },
    ).json()

    assert body["stats"]["veg_index"] == "ndvi"
    assert body["count"] == orchard.n


def test_vine_rows_from_an_rgb_ortho_only(store):
    mask, _ = make_rows_mask(n_rows=4, row_length_m=25.0, spacing_m=2.5, angle_deg=15.0)
    green = np.where(mask, 0.55, 0.20)
    other = np.where(mask, 0.10, 0.22)
    _write_tif(store / "captures/c1/ortho.tif", np.stack([other, green, other]), 0.1)

    body = client.post(
        "/detect",
        json={
            "unit_type": "vine",
            "ortho_path": "captures/c1/ortho.tif",
            "bands": {"red": 1, "green": 2, "blue": 3},
            "params": {"plant_spacing_m": 1.0},
            "parcel_geometry": _parcel_of(mask.shape, 0.1),
        },
    ).json()

    assert body["stats"]["veg_index"] == "exg"  # no NIR: excess green
    assert body["stats"]["rows"] == 4
    assert body["count"] == pytest.approx(4 * 25, abs=6)
    assert all(d["crown_geom"] is None for d in body["detections"])  # rows place points


def test_max_detections_truncates_by_score(store):
    orchard = make_orchard(n_rows=4, n_cols=4)
    _write_tif(store / "captures/c1/dsm.tif", orchard.dsm, orchard.pixel_m)

    body = client.post(
        "/detect",
        json={
            "unit_type": "tree",
            "dsm_path": "captures/c1/dsm.tif",
            "params": {"max_detections": 5},
        },
    ).json()

    assert body["truncated"] is True and body["count"] == 5
    scores = [d["score"] for d in body["detections"]]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.parametrize(
    "path,status",
    [
        ("../../etc/passwd", 400),
        ("captures/../../etc/passwd", 400),
        ("/etc/passwd", 400),
        ("captures/c1/ nope.tif", 400),
        ("captures/c1/missing.tif", 404),
    ],
)
def test_store_keys_cannot_escape_the_store(store, path, status):
    response = client.post("/detect", json={"unit_type": "tree", "dsm_path": path})
    assert response.status_code == status
    assert set(response.json()["error"]) == {"code", "message"}


def test_absolute_paths_need_the_env_opt_in(store, monkeypatch, tmp_path):
    orchard = make_orchard(n_rows=1, n_cols=1)
    outside = _write_tif(tmp_path / "elsewhere.tif", orchard.dsm, orchard.pixel_m)

    denied = client.post("/detect", json={"unit_type": "tree", "dsm_path": str(outside)})
    assert denied.status_code == 400

    monkeypatch.setenv("PLANT_DETECT_ALLOW_ABS_PATHS", "1")
    allowed = client.post("/detect", json={"unit_type": "tree", "dsm_path": str(outside)})
    assert allowed.status_code == 200


@pytest.mark.parametrize(
    "payload",
    [
        {"unit_type": "banana", "dsm_path": "captures/c1/dsm.tif"},
        {"unit_type": "tree"},  # no dsm_path
        {"unit_type": "tree", "dsm_path": "captures/c1/dsm.tif", "params": {"min_heigth_m": 2}},
        {"unit_type": "tree", "dsm_path": "captures/c1/dsm.tif", "bands": {"purple": 1}},
        {"unit_type": "tree", "dsm_path": "captures/c1/dsm.tif", "parcel_geometry": {"type": "Point"}},
    ],
)
def test_bad_requests_use_the_arvo_error_shape(store, payload):
    response = client.post("/detect", json=payload)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "bad_request"
    assert response.json()["error"]["message"]
