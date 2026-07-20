"""OWNER: be-detect — the only module that needs rasterio/GDAL.

Reads the capture's COGs, clips them to the parcel, decimates them to the working GSD, and
converts detections back to GeoJSON in EPSG:4326. Paths arriving on the wire are **store keys**
(docs/API-PLANT.md §"Storage layout") resolved against `STORE_DIR` with the same segment rule
`crates/api/src/storage/mod.rs` enforces, so a request cannot walk out of the store.
"""

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
import rasterio
from affine import Affine
from rasterio import features, transform as rio_transform, warp, windows
from rasterio.crs import CRS
from rasterio.enums import Resampling
from scipy import ndimage

from . import geo
from .config import KEY_SEGMENT_RE, MAX_KEY_LEN, Params, allow_abs_paths, store_root
from .errors import DetectError
from .geo import Detection, PixelSize

WGS84 = CRS.from_epsg(4326)
#: Metres per degree, good to ~0.5 % — only used when a raster is delivered in EPSG:4326
#: (ODM/UTM output is projected and takes the exact path).
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0


@dataclass
class Grid:
    """The working raster: one band, its georeferencing, and the parcel clip."""

    array: np.ndarray  # float32, NaN where invalid
    valid: np.ndarray  # bool
    clip: Optional[np.ndarray]  # bool, True inside the parcel (+buffer); None when unclipped
    transform: Affine
    crs: CRS
    px: PixelSize

    @property
    def shape(self) -> Tuple[int, int]:
        return self.array.shape

    def bbox_4326(self) -> List[float]:
        bounds = rio_transform.array_bounds(self.shape[0], self.shape[1], self.transform)
        west, south, east, north = warp.transform_bounds(self.crs, WGS84, *bounds)
        return [round(v, 8) for v in (west, south, east, north)]


# --- paths -------------------------------------------------------------------


def resolve_store_path(raw: str) -> Path:
    """Store key → absolute path. Absolute inputs need `PLANT_DETECT_ALLOW_ABS_PATHS=1`."""
    if not raw or len(raw) > MAX_KEY_LEN:
        raise DetectError("bad_request", "invalid store key")
    candidate = Path(raw)
    if candidate.is_absolute():
        if not allow_abs_paths():
            raise DetectError(
                "bad_request",
                "absolute paths are disabled; pass the store key (captures/{id}/ortho.tif)",
            )
        path = candidate.resolve()
    else:
        if not all(KEY_SEGMENT_RE.match(seg) for seg in raw.split("/")):
            raise DetectError("bad_request", "invalid store key")
        root = store_root().resolve()
        path = (root / raw).resolve()
        # Defence in depth: the segment rule already forbids `..`, this also catches a symlink
        # planted inside the store.
        if root != path and root not in path.parents:
            raise DetectError("bad_request", "invalid store key")
    if not path.is_file():
        raise DetectError("not_found", f"asset not found: {raw}")
    return path


# --- reading -----------------------------------------------------------------


def _pixel_size(transform: Affine, crs: CRS, lat: float) -> PixelSize:
    col_m = math.hypot(transform.a, transform.d)
    row_m = math.hypot(transform.b, transform.e)
    if crs.is_geographic:
        return PixelSize(row_m=row_m * M_PER_DEG_LAT, col_m=col_m * M_PER_DEG_LON * math.cos(math.radians(lat)))
    factor = 1.0
    try:  # projected CRS in feet (rare, but silently wrong if ignored)
        units = crs.linear_units_factor
        factor = float(units[1]) if units else 1.0
    except Exception:  # pragma: no cover - proj build without unit metadata
        factor = 1.0
    return PixelSize(row_m=row_m * factor, col_m=col_m * factor)


def _window_for(src, geom_src: Optional[dict], margin_m: float) -> windows.Window:
    """Pixel window covering the geometry (plus a margin), clipped to the raster."""
    full = windows.Window(0, 0, src.width, src.height)
    if geom_src is None:
        return full
    west, south, east, north = features.bounds(geom_src)
    if margin_m > 0:
        # Margin in CRS units = margin in metres × (pixel size in CRS units / in metres).
        px = _pixel_size(src.transform, src.crs, (south + north) / 2.0)
        mx = margin_m * math.hypot(src.transform.a, src.transform.d) / max(px.col_m, 1e-9)
        my = margin_m * math.hypot(src.transform.b, src.transform.e) / max(px.row_m, 1e-9)
        west, east = west - mx, east + mx
        south, north = south - my, north + my
    inverse = ~src.transform
    corners = [inverse * (x, y) for x, y in ((west, south), (west, north), (east, south), (east, north))]
    cols = [c for c, _ in corners]
    rows = [r for _, r in corners]
    col_off = max(0, int(math.floor(min(cols))))
    row_off = max(0, int(math.floor(min(rows))))
    width = min(src.width, int(math.ceil(max(cols)))) - col_off
    height = min(src.height, int(math.ceil(max(rows)))) - row_off
    if width <= 0 or height <= 0:
        raise DetectError("bad_request", "parcel geometry does not intersect the raster")
    return windows.Window(col_off, row_off, width, height)


def _decimation(win: windows.Window, px: PixelSize, target_gsd_cm: float, max_pixels: int) -> int:
    """Integer read factor: coarsen to the working GSD, then further if the array is too big."""
    factor = 1
    target_m = (target_gsd_cm or 0.0) / 100.0
    if target_m > 0:
        factor = max(1, int(math.floor(target_m / max(px.mean_m, 1e-9))))
    while (int(win.height) // factor) * (int(win.width) // factor) > max_pixels:
        factor += 1
    return factor


def _read_window(src, band: int, win: windows.Window, factor: int) -> Tuple[np.ndarray, np.ndarray, Affine]:
    out_h = max(1, int(win.height) // factor)
    out_w = max(1, int(win.width) // factor)
    data = src.read(
        band,
        window=win,
        out_shape=(out_h, out_w),
        # Averaging is the right decimation for a surface model: it suppresses SfM speckle,
        # and the crown apex survives because the working GSD stays far below crown size.
        resampling=Resampling.average if factor > 1 else Resampling.nearest,
        masked=True,
    )
    mask = np.ma.getmaskarray(data)
    array = np.ma.filled(data, np.nan).astype(np.float32)
    valid = ~mask & np.isfinite(array)
    transform = windows.transform(win, src.transform) * Affine.scale(
        int(win.width) / out_w, int(win.height) / out_h
    )
    return array, valid, transform


def read_grid(path: Path, geometry: Optional[dict], p: Params) -> Grid:
    """Open a DSM/ortho, clip to the parcel, decimate to the working GSD."""
    with rasterio.open(path) as src:
        if src.crs is None:
            raise DetectError("bad_request", f"raster has no CRS: {path.name}")
        geom_src = warp.transform_geom(WGS84, src.crs, geometry) if geometry else None
        win = _window_for(src, geom_src, p.clip_buffer_m)
        native = _pixel_size(windows.transform(win, src.transform), src.crs, _center_lat(src, win))
        factor = _decimation(win, native, p.target_gsd_cm, p.max_pixels)
        array, valid, transform = _read_window(src, 1, win, factor)
        crs = src.crs

    px = _pixel_size(transform, crs, _center_lat_from(transform, array.shape, crs))
    clip = None
    if geom_src is not None:
        clip = features.geometry_mask(
            [geom_src], out_shape=array.shape, transform=transform, invert=True, all_touched=True
        )
        if p.clip_buffer_m > 0 and clip.any():
            # Edge trees straddle the parcel boundary — grow the mask by the buffer instead of
            # buffering the polygon (no shapely, exact Euclidean distance).
            distance = ndimage.distance_transform_edt(~clip, sampling=(px.row_m, px.col_m))
            clip = distance <= p.clip_buffer_m
        if not clip.any():
            raise DetectError("bad_request", "parcel geometry does not intersect the raster")
    return Grid(array=array, valid=valid, clip=clip, transform=transform, crs=crs, px=px)


def _center_lat(src, win: windows.Window) -> float:
    bounds = windows.bounds(win, src.transform)
    if src.crs.is_geographic:
        return (bounds[1] + bounds[3]) / 2.0
    try:
        _, south, _, north = warp.transform_bounds(src.crs, WGS84, *bounds)
        return (south + north) / 2.0
    except Exception:  # pragma: no cover - unusual CRS without a WGS84 path
        return 0.0


def _center_lat_from(transform: Affine, shape: Tuple[int, int], crs: CRS) -> float:
    bounds = rio_transform.array_bounds(shape[0], shape[1], transform)
    if crs.is_geographic:
        return (bounds[1] + bounds[3]) / 2.0
    try:
        _, south, _, north = warp.transform_bounds(crs, WGS84, *bounds)
        return (south + north) / 2.0
    except Exception:  # pragma: no cover
        return 0.0


def read_bands_on_grid(path: Path, grid: Grid, bands: Dict[str, int], p: Params) -> Dict[str, np.ndarray]:
    """Read the named ortho bands and warp them onto `grid` (ortho and DSM need not share a
    grid — a vendor ortho often does not)."""
    out: Dict[str, np.ndarray] = {}
    with rasterio.open(path) as src:
        if src.crs is None:
            raise DetectError("bad_request", f"raster has no CRS: {path.name}")
        for name, index in bands.items():
            if not 1 <= int(index) <= src.count:
                raise DetectError(
                    "bad_request", f"band {name!r} index {index} is out of range (ortho has {src.count})"
                )
        bounds = rio_transform.array_bounds(grid.shape[0], grid.shape[1], grid.transform)
        geom = _bounds_geom(warp.transform_bounds(grid.crs, src.crs, *bounds))
        win = _window_for(src, geom, 0.0)
        native = _pixel_size(windows.transform(win, src.transform), src.crs, _center_lat(src, win))
        # Read at (roughly) the working GSD — never the native 2 cm of a 2 GB ortho.
        factor = max(1, int(math.floor(grid.px.mean_m / max(native.mean_m, 1e-9))))
        factor = max(factor, _decimation(win, native, 0.0, p.max_pixels))
        for name, index in bands.items():
            array, _, transform = _read_window(src, int(index), win, factor)
            if src.crs == grid.crs and array.shape == grid.shape and transform.almost_equals(grid.transform):
                out[name] = array  # ODM emits ortho and DSM on the same grid
                continue
            destination = np.full(grid.shape, np.nan, dtype=np.float32)
            warp.reproject(
                source=array,
                destination=destination,
                src_transform=transform,
                src_crs=src.crs,
                src_nodata=np.nan,
                dst_transform=grid.transform,
                dst_crs=grid.crs,
                dst_nodata=np.nan,
                resampling=Resampling.bilinear,
            )
            out[name] = destination
    return out


def _bounds_geom(bounds: Sequence[float]) -> dict:
    west, south, east, north = bounds
    return {
        "type": "Polygon",
        "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    }


# --- output ------------------------------------------------------------------


def rowcol_to_lonlat(grid: Grid, rows: np.ndarray, cols: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Array indices (integer index = pixel centre) → EPSG:4326, one proj call for the batch."""
    t = grid.transform
    xs = t.c + t.a * (cols + 0.5) + t.b * (rows + 0.5)
    ys = t.f + t.d * (cols + 0.5) + t.e * (rows + 0.5)
    if grid.crs == WGS84:
        return xs, ys
    lon, lat = warp.transform(grid.crs, WGS84, xs.tolist(), ys.tolist())
    return np.asarray(lon), np.asarray(lat)


def detections_to_geojson(grid: Grid, detections: List[Detection]) -> List[Dict[str, Any]]:
    """Detections → the wire shape: `geom` (Point), `crown_geom` (Polygon|null), score, metrics."""
    if not detections:
        return []
    rows: List[float] = [d.row for d in detections]
    cols: List[float] = [d.col for d in detections]
    spans: List[Optional[Tuple[int, int]]] = []
    for d in detections:
        if d.ring is None or len(d.ring) < geo.MIN_RING_POINTS:
            spans.append(None)
            continue
        spans.append((len(rows), len(d.ring)))
        rows.extend(d.ring[:, 0].tolist())
        cols.extend(d.ring[:, 1].tolist())

    lon, lat = rowcol_to_lonlat(grid, np.asarray(rows, dtype=float), np.asarray(cols, dtype=float))
    out: List[Dict[str, Any]] = []
    for i, d in enumerate(detections):
        crown = None
        if spans[i] is not None:
            start, length = spans[i]
            crown = geo.polygon_geojson(
                [[float(x), float(y)] for x, y in zip(lon[start : start + length], lat[start : start + length])]
            )
        out.append(
            {
                "geom": geo.point_geojson(float(lon[i]), float(lat[i])),
                "crown_geom": crown,
                "score": d.score,
                "height_m": d.height_m,
                "canopy_m2": d.canopy_m2,
            }
        )
    return out
