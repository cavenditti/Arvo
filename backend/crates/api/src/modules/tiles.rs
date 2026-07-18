//! Raster tiles + GeoTIFF export (docs/API.md §"Raster tiles & GeoTIFF export", FR-0-027).
//!
//! Feature-gated: the entire module only exists under `imagery` (it links GDAL + png), so the
//! default build stays dependency-free. Two endpoints:
//!   - `GET /tiles/{parcel}/{index}/{z}/{x}/{y}.png` — 256×256 RGBA PNG in Web-Mercator XYZ.
//!   - `GET /parcels/{id}/indices/{index}.tif`       — float32 GeoTIFF clipped to the parcel bbox.
//!
//! Auth is Bearer header **or** `?token=` query param (raster `<img>` clients can't set headers);
//! either way org scoping goes through the parcel row (cross-tenant → 404). Pixels are NOT clipped
//! to the parcel — Sentinel-2 is public; the parcel only gates access. `scene=latest` (default)
//! resolves the newest scene-backed index observation for the parcel+index.
//!
//! matchit 0.8 (axum 0.8) does not support dynamic suffixes like `{y}.png`, so the trailing
//! segment is captured as a param and the extension is stripped in the handler.
use std::path::PathBuf;

use anyhow::{anyhow, Context};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use gdal::raster::{Buffer, RasterCreationOptions, ResampleAlg};
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::{Dataset, DriverManager};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::imagery::raster;
use crate::modules::indices::normalize_index;
use crate::modules::parcels::assert_owned;
use crate::security::{self, AuthUser};
use crate::state::AppState;

/// Half the Web-Mercator (EPSG:3857) world extent, metres.
const ORIGIN_SHIFT: f64 = 20_037_508.342_789_244;
const TILE_PX: usize = 256;
/// Output/native grid resolution for the GeoTIFF export (metres).
const EXPORT_RES_M: f64 = 10.0;
/// Buffer (metres) added around the parcel bbox for the GeoTIFF export.
const EXPORT_BUFFER_M: f64 = 60.0;
/// Float sentinel written for masked/no-data cells in the GeoTIFF.
const NODATA: f32 = -9999.0;
/// Cap on the source read window (px) per axis, so low-zoom tiles decimate via COG overviews
/// instead of reading millions of native pixels.
const MAX_READ_PX: usize = 512;
/// Concurrent GDAL renders (each pulls up to 7 COG windows over HTTP). A cold map view fires
/// ~30 tile requests at once; without a cap they all spawn blocking tasks simultaneously.
const MAX_CONCURRENT_RENDERS: usize = 6;

fn render_permits() -> &'static tokio::sync::Semaphore {
    static SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    SEM.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_RENDERS))
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tiles/{parcel_id}/{index}/{z}/{x}/{y}", get(tile))
        .route("/parcels/{id}/indices/{index}", get(geotiff))
}

#[derive(Deserialize)]
struct RasterQuery {
    token: Option<String>,
    scene: Option<String>,
}

// --- endpoints -------------------------------------------------------------

/// `GET /tiles/{parcel}/{index}/{z}/{x}/{y}.png` — the `{y}` param carries the `.png` extension.
async fn tile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((parcel_id, index, z, x, y_ext)): Path<(Uuid, String, u32, u32, String)>,
    Query(q): Query<RasterQuery>,
) -> ApiResult<Response> {
    let auth = authenticate(&state, &headers, q.token.as_deref())?;
    let index = normalize_index(Some(&index))?;
    if z > 18 {
        return Err(ApiError::BadRequest("zoom out of range (0..=18)".into()));
    }
    let y = strip_ext(&y_ext, ".png")
        .parse::<u32>()
        .map_err(|_| ApiError::BadRequest("invalid tile y".into()))?;

    assert_owned(&state.pool, auth.org_id, parcel_id).await?;
    let scene = resolve_scene(&state, parcel_id, index, q.scene.as_deref()).await?;

    // Out-of-range tile coords → transparent (never touch GDAL or the cache).
    let n = 1u32 << z;
    if x >= n || y >= n {
        return Ok(png_response(transparent_png()?));
    }

    // Disk cache: var/tiles/{scene}/{index}/{z}/{x}/{y}.png (contract path).
    let cache = cache_path(&state, &scene.id, index, z, x, y);
    if let Ok(bytes) = tokio::fs::read(&cache).await {
        return Ok(png_response(bytes));
    }

    let assets = scene.assets.clone();
    let boa = scene.boa_offset_applied.unwrap_or(false);
    let _permit = render_permits()
        .acquire()
        .await
        .map_err(|e| ApiError::Internal(anyhow!(e)))?;
    let png = tokio::task::spawn_blocking(move || render_tile(&assets, index, z, x, y, boa))
        .await
        .map_err(|e| ApiError::Internal(anyhow!(e)))?
        .map_err(ApiError::Internal)?;
    drop(_permit);

    if let Some(parent) = cache.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
        let _ = tokio::fs::write(&cache, &png).await;
    }
    Ok(png_response(png))
}

/// `GET /parcels/{id}/indices/{index}.tif` — the `{index}` param carries the `.tif` extension.
/// (Sibling of the static `/indices/latest` route, which keeps priority in matchit.)
async fn geotiff(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((parcel_id, index_ext)): Path<(Uuid, String)>,
    Query(q): Query<RasterQuery>,
) -> ApiResult<Response> {
    // Only `<index>.tif` is ours; anything else under /indices/ is not this route.
    let Some(index_raw) = index_ext.strip_suffix(".tif") else {
        return Err(ApiError::NotFound);
    };
    let auth = authenticate(&state, &headers, q.token.as_deref())?;
    let index = normalize_index(Some(index_raw))?;

    // Org scope + parcel bbox (lon/lat) in one query.
    let bbox: Option<(f64, f64, f64, f64)> = sqlx::query_as(
        "SELECT ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)
         FROM (SELECT ST_Envelope(geom) e FROM parcels WHERE id = $1 AND org_id = $2) s",
    )
    .bind(parcel_id)
    .bind(auth.org_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(bbox) = bbox else {
        return Err(ApiError::NotFound);
    };

    let scene = resolve_scene(&state, parcel_id, index, q.scene.as_deref()).await?;
    let assets = scene.assets.clone();
    let boa = scene.boa_offset_applied.unwrap_or(false);
    let _permit = render_permits()
        .acquire()
        .await
        .map_err(|e| ApiError::Internal(anyhow!(e)))?;
    let tif = tokio::task::spawn_blocking(move || render_geotiff(&assets, index, bbox, boa))
        .await
        .map_err(|e| ApiError::Internal(anyhow!(e)))?
        .map_err(ApiError::Internal)?;

    let filename = format!("{parcel_id}_{index}.tif");
    Ok((
        [
            (header::CONTENT_TYPE, "image/tiff".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        tif,
    )
        .into_response())
}

// --- auth / scoping / scene resolution -------------------------------------

/// Bearer header carries a full session token; `?token=` accepts ONLY short-lived media
/// tokens (docs/API.md §"Media tokens") so long-lived credentials never ride in query
/// strings where access logs and referrers can capture them.
fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> ApiResult<AuthUser> {
    security::authenticate_bearer_or_media(&state.cfg.jwt_secret, headers, query_token)
}

struct ResolvedScene {
    id: Uuid,
    assets: Value,
    boa_offset_applied: Option<bool>,
}

/// Resolve `scene`: `latest`/absent → newest scene-backed index observation for parcel+index;
/// otherwise a specific scene UUID. 404 when nothing matches (the caller's parcel is validated
/// separately). Scenes are shared public source data, so an explicit id is fetched directly.
async fn resolve_scene(
    state: &AppState,
    parcel_id: Uuid,
    index: &str,
    scene: Option<&str>,
) -> ApiResult<ResolvedScene> {
    let row: Option<(Uuid, Value, Option<bool>)> =
        match scene.map(str::trim).filter(|s| !s.is_empty()) {
            None | Some("latest") => {
                sqlx::query_as(
                    "SELECT s.id, s.assets, s.boa_offset_applied
                 FROM index_observations io JOIN scenes s ON s.id = io.scene_id
                 WHERE io.parcel_id = $1 AND io.index_name = $2 AND io.scene_id IS NOT NULL
                 ORDER BY io.observed_at DESC
                 LIMIT 1",
                )
                .bind(parcel_id)
                .bind(index)
                .fetch_optional(&state.pool)
                .await?
            }
            Some(id) => {
                let scene_id = Uuid::parse_str(id)
                    .map_err(|_| ApiError::BadRequest("invalid scene id".into()))?;
                sqlx::query_as("SELECT id, assets, boa_offset_applied FROM scenes WHERE id = $1")
                    .bind(scene_id)
                    .fetch_optional(&state.pool)
                    .await?
            }
        };
    let (id, assets, boa_offset_applied) = row.ok_or(ApiError::NotFound)?;
    Ok(ResolvedScene {
        id,
        assets,
        boa_offset_applied,
    })
}

// --- rendering: XYZ tile ---------------------------------------------------

/// Render one 256×256 RGBA PNG tile. Blocking (GDAL). Fully-outside/masked → transparent PNG.
fn render_tile(
    assets: &Value,
    index: &str,
    z: u32,
    x: u32,
    y: u32,
    boa_offset_applied: bool,
) -> anyhow::Result<Vec<u8>> {
    raster::configure();

    // Web-Mercator bounds of the tile.
    let n = (1u64 << z) as f64;
    let tsize = (2.0 * ORIGIN_SHIFT) / n;
    let min_x = -ORIGIN_SHIFT + x as f64 * tsize;
    let max_y = ORIGIN_SHIFT - y as f64 * tsize;
    let px = tsize / TILE_PX as f64;

    // Pixel-centre coordinates (EPSG:3857), row-major from the top-left.
    let count = TILE_PX * TILE_PX;
    let mut xs = Vec::with_capacity(count);
    let mut ys = Vec::with_capacity(count);
    for row in 0..TILE_PX {
        for col in 0..TILE_PX {
            xs.push(min_x + (col as f64 + 0.5) * px);
            ys.push(max_y - (row as f64 + 0.5) * px);
        }
    }

    // Need a scene CRS to warp into: SCL is always present. If we can't even open it, the tile
    // is transparent rather than a hard error (keeps map overlays resilient).
    let Some(scl_href) = raster::asset_href(assets, "scl") else {
        return transparent_png();
    };
    let scl_ds = raster::open_vsicurl(scl_href)?;
    let ds_srs = scl_ds.spatial_ref().context("scl srs")?;
    let mut merc = SpatialRef::from_epsg(3857)?;
    merc.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let to_ds = CoordTransform::new(&merc, &ds_srs)?;
    let mut zs = vec![0.0f64; count];
    to_ds.transform_coords(&mut xs, &mut ys, &mut zs)?;

    // ds-CRS bbox of the tile (+ margin), then read each band over that window.
    let margin = 2.0 * px.max(EXPORT_RES_M);
    let ds_min_x = xs.iter().cloned().fold(f64::MAX, f64::min) - margin;
    let ds_max_x = xs.iter().cloned().fold(f64::MIN, f64::max) + margin;
    let ds_min_y = ys.iter().cloned().fold(f64::MAX, f64::min) - margin;
    let ds_max_y = ys.iter().cloned().fold(f64::MIN, f64::max) + margin;
    let bbox = (ds_min_x, ds_min_y, ds_max_x, ds_max_y);

    let scl = BandGrid::from_dataset(&scl_ds, bbox, true)?;
    let band = |key: &str| -> anyhow::Result<Option<BandGrid>> {
        match raster::asset_href(assets, key) {
            Some(href) => BandGrid::open(href, bbox, false),
            None => Ok(None),
        }
    };
    let red = band("red")?;
    let green = band("green")?;
    let nir = band("nir")?;
    let nir08 = band("nir08")?;
    let rededge1 = band("rededge1")?;
    let swir16 = band("swir16")?;

    let mut rgba = vec![0u8; count * 4];
    for i in 0..count {
        let (dx, dy) = (xs[i], ys[i]);
        // Footprint + cloud mask via SCL (nodata=0 → outside swath).
        match &scl {
            Some(g) => {
                let s = g.sample_nearest(dx, dy);
                if s.is_nan() || raster::scl_masked(s) {
                    continue; // transparent
                }
            }
            None => continue,
        }
        let refl = |b: &Option<BandGrid>| -> Option<f32> {
            b.as_ref()
                .map(|g| {
                    raster::to_reflectance(g.sample_bilinear(dx, dy), boa_offset_applied) as f32
                })
                .filter(|v| v.is_finite())
        };
        let v = index_value(
            index,
            refl(&red),
            refl(&green),
            refl(&nir),
            refl(&nir08),
            refl(&rededge1),
            refl(&swir16),
        );
        if let Some([r, g, b]) = colormap(index, v) {
            let o = i * 4;
            rgba[o] = r;
            rgba[o + 1] = g;
            rgba[o + 2] = b;
            rgba[o + 3] = 255;
        }
    }

    encode_png_rgba(&rgba, TILE_PX as u32, TILE_PX as u32)
}

// --- rendering: GeoTIFF export ---------------------------------------------

/// Render a single-band float32 GeoTIFF of `index`, in the scene's native CRS, clipped to the
/// parcel bbox + 60 m buffer. Masked cells are written as `NODATA`. Blocking (GDAL).
fn render_geotiff(
    assets: &Value,
    index: &str,
    (min_lon, min_lat, max_lon, max_lat): (f64, f64, f64, f64),
    boa_offset_applied: bool,
) -> anyhow::Result<Vec<u8>> {
    raster::configure();

    let scl_href =
        raster::asset_href(assets, "scl").ok_or_else(|| anyhow!("scene missing scl asset"))?;
    let scl_ds = raster::open_vsicurl(scl_href)?;
    let ds_srs = scl_ds.spatial_ref().context("scl srs")?;

    // Parcel bbox (lon/lat) → ds CRS; expand by the buffer. Transform all four corners.
    let mut wgs84 = SpatialRef::from_epsg(4326)?;
    wgs84.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let to_ds = CoordTransform::new(&wgs84, &ds_srs)?;
    let mut xs = vec![min_lon, max_lon, min_lon, max_lon];
    let mut ys = vec![min_lat, min_lat, max_lat, max_lat];
    let mut zs = vec![0.0f64; 4];
    to_ds.transform_coords(&mut xs, &mut ys, &mut zs)?;
    let ds_min_x = xs.iter().cloned().fold(f64::MAX, f64::min) - EXPORT_BUFFER_M;
    let ds_max_x = xs.iter().cloned().fold(f64::MIN, f64::max) + EXPORT_BUFFER_M;
    let ds_min_y = ys.iter().cloned().fold(f64::MAX, f64::min) - EXPORT_BUFFER_M;
    let ds_max_y = ys.iter().cloned().fold(f64::MIN, f64::max) + EXPORT_BUFFER_M;

    let out_w = (((ds_max_x - ds_min_x) / EXPORT_RES_M).round() as usize).clamp(1, 4096);
    let out_h = (((ds_max_y - ds_min_y) / EXPORT_RES_M).round() as usize).clamp(1, 4096);
    let count = out_w * out_h;

    // Aligned window reads (native CRS grid), like the ingest worker.
    let scl = read_aligned(
        &scl_ds, ds_min_x, ds_max_y, ds_max_x, ds_min_y, out_w, out_h, true,
    )?;
    let read_band = |key: &str| -> anyhow::Result<Option<Vec<f64>>> {
        match raster::asset_href(assets, key) {
            Some(href) => {
                let ds = raster::open_vsicurl(href)?;
                Ok(Some(read_aligned(
                    &ds, ds_min_x, ds_max_y, ds_max_x, ds_min_y, out_w, out_h, false,
                )?))
            }
            None => Ok(None),
        }
    };
    let red = read_band("red")?;
    let green = read_band("green")?;
    let nir = read_band("nir")?;
    let nir08 = read_band("nir08")?;
    let rededge1 = read_band("rededge1")?;
    let swir16 = read_band("swir16")?;

    let refl = |b: &Option<Vec<f64>>, i: usize| -> Option<f32> {
        b.as_ref()
            .map(|s| raster::to_reflectance(s[i], boa_offset_applied) as f32)
            .filter(|v| v.is_finite())
    };
    let mut buf = vec![NODATA; count];
    for i in 0..count {
        if raster::scl_masked(scl[i]) {
            continue;
        }
        let v = index_value(
            index,
            refl(&red, i),
            refl(&green, i),
            refl(&nir, i),
            refl(&nir08, i),
            refl(&rededge1, i),
            refl(&swir16, i),
        );
        if v.is_finite() {
            buf[i] = v;
        }
    }

    // MEM float32 dataset (native CRS, 10 m grid) → CreateCopy to an in-memory GeoTIFF.
    let mem = DriverManager::get_driver_by_name("MEM")?;
    let mut ds = mem.create_with_band_type::<f32, _>("", out_w, out_h, 1)?;
    ds.set_geo_transform(&[ds_min_x, EXPORT_RES_M, 0.0, ds_max_y, 0.0, -EXPORT_RES_M])?;
    ds.set_spatial_ref(&ds_srs)?;
    {
        let mut rb = ds.rasterband(1)?;
        rb.set_no_data_value(Some(NODATA as f64))?;
        let mut buffer = Buffer::new((out_w, out_h), buf);
        rb.write((0, 0), (out_w, out_h), &mut buffer)?;
    }

    let gtiff = DriverManager::get_driver_by_name("GTiff")?;
    let vsi_path = format!("/vsimem/arvo-{}.tif", Uuid::new_v4());
    let opts = RasterCreationOptions::from_iter(["COMPRESS=DEFLATE", "PREDICTOR=3"]);
    let out_ds = ds.create_copy(&gtiff, &vsi_path, &opts)?;
    out_ds.close()?; // flush the GeoTIFF fully into the /vsimem/ buffer before reading it back
                     // Takes ownership of the in-memory file and frees it.
    let bytes = gdal::vsi::get_vsi_mem_file_bytes_owned(&vsi_path)
        .map_err(|e| anyhow!("read {vsi_path}: {e}"))?;
    Ok(bytes)
}

/// Read a band clipped to the ds-CRS bbox, resampled to `out_w × out_h` (row-major). Categorical
/// (SCL) uses nearest-neighbour; reflectance uses bilinear. Missing coverage reads as-is (the SCL
/// nodata=0 then masks it). Mirrors the ingest worker's `read_grid`.
#[allow(clippy::too_many_arguments)]
fn read_aligned(
    ds: &Dataset,
    ds_min_x: f64,
    ds_max_y: f64,
    ds_max_x: f64,
    ds_min_y: f64,
    out_w: usize,
    out_h: usize,
    categorical: bool,
) -> anyhow::Result<Vec<f64>> {
    let gt = ds.geo_transform().context("geo_transform")?;
    let (rw, rh) = ds.raster_size();
    let col = |x: f64| (x - gt[0]) / gt[1];
    let row = |y: f64| (y - gt[3]) / gt[5];
    let c0 = col(ds_min_x).floor().clamp(0.0, rw as f64) as isize;
    let c1 = col(ds_max_x).ceil().clamp(0.0, rw as f64) as isize;
    let r0 = row(ds_max_y).floor().clamp(0.0, rh as f64) as isize;
    let r1 = row(ds_min_y).ceil().clamp(0.0, rh as f64) as isize;
    let win = (c0.min(c1), r0.min(r1));
    let win_size = (
        (c1 - c0).unsigned_abs().max(1),
        (r1 - r0).unsigned_abs().max(1),
    );
    let alg = if categorical {
        ResampleAlg::NearestNeighbour
    } else {
        ResampleAlg::Bilinear
    };
    let band = ds.rasterband(1).context("rasterband(1)")?;
    let buf = band
        .read_as::<f64>(win, win_size, (out_w, out_h), Some(alg))
        .context("read_as")?;
    Ok(buf.data().to_vec())
}

/// One band read over the tile's ds-CRS window, with per-output-pixel resampling back onto the
/// 3857 grid. Holds a decimated copy of the window (≤ `MAX_READ_PX` per axis).
struct BandGrid {
    buf: Vec<f64>,
    bw: usize,
    bh: usize,
    // source-pixel window (in the band's own grid)
    gt: [f64; 6],
    c0: f64,
    r0: f64,
    win_cols: f64,
    win_rows: f64,
}

impl BandGrid {
    fn open(
        href: &str,
        bbox: (f64, f64, f64, f64),
        categorical: bool,
    ) -> anyhow::Result<Option<Self>> {
        let ds = raster::open_vsicurl(href)?;
        Self::from_dataset(&ds, bbox, categorical)
    }

    fn from_dataset(
        ds: &Dataset,
        (ds_min_x, ds_min_y, ds_max_x, ds_max_y): (f64, f64, f64, f64),
        categorical: bool,
    ) -> anyhow::Result<Option<Self>> {
        let gt = ds.geo_transform().context("geo_transform")?;
        let (rw, rh) = ds.raster_size();
        let col = |x: f64| (x - gt[0]) / gt[1];
        let row = |y: f64| (y - gt[3]) / gt[5];
        let c_lo = (col(ds_min_x).floor() - 1.0).clamp(0.0, rw as f64) as isize;
        let c_hi = (col(ds_max_x).ceil() + 1.0).clamp(0.0, rw as f64) as isize;
        // gt[5] < 0 → row decreases as y increases; max_y gives the smaller row.
        let r_lo = (row(ds_max_y).floor() - 1.0).clamp(0.0, rh as f64) as isize;
        let r_hi = (row(ds_min_y).ceil() + 1.0).clamp(0.0, rh as f64) as isize;
        if c_hi <= c_lo || r_hi <= r_lo {
            return Ok(None); // window entirely outside the raster
        }
        let win_cols = (c_hi - c_lo) as usize;
        let win_rows = (r_hi - r_lo) as usize;
        let bw = win_cols.clamp(1, MAX_READ_PX);
        let bh = win_rows.clamp(1, MAX_READ_PX);
        let alg = if categorical {
            ResampleAlg::NearestNeighbour
        } else {
            ResampleAlg::Bilinear
        };
        let band = ds.rasterband(1).context("rasterband(1)")?;
        let buf = band
            .read_as::<f64>((c_lo, r_lo), (win_cols, win_rows), (bw, bh), Some(alg))
            .context("read_as")?;
        Ok(Some(Self {
            buf: buf.data().to_vec(),
            bw,
            bh,
            gt,
            c0: c_lo as f64,
            r0: r_lo as f64,
            win_cols: win_cols as f64,
            win_rows: win_rows as f64,
        }))
    }

    /// Fractional buffer coordinate (pixel-centre convention) for a ds-CRS point, or None if the
    /// point falls outside the read window (i.e. outside the raster).
    fn frac(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        let src_col = (x - self.gt[0]) / self.gt[1];
        let src_row = (y - self.gt[3]) / self.gt[5];
        if src_col < self.c0
            || src_col > self.c0 + self.win_cols
            || src_row < self.r0
            || src_row > self.r0 + self.win_rows
        {
            return None;
        }
        let fx = (src_col - self.c0) * (self.bw as f64 / self.win_cols) - 0.5;
        let fy = (src_row - self.r0) * (self.bh as f64 / self.win_rows) - 0.5;
        Some((fx, fy))
    }

    fn at(&self, cx: isize, cy: isize) -> f64 {
        let cx = cx.clamp(0, self.bw as isize - 1) as usize;
        let cy = cy.clamp(0, self.bh as isize - 1) as usize;
        self.buf[cy * self.bw + cx]
    }

    fn sample_bilinear(&self, x: f64, y: f64) -> f64 {
        let Some((fx, fy)) = self.frac(x, y) else {
            return f64::NAN;
        };
        let x0 = fx.floor();
        let y0 = fy.floor();
        let tx = fx - x0;
        let ty = fy - y0;
        let (x0, y0) = (x0 as isize, y0 as isize);
        let v00 = self.at(x0, y0);
        let v10 = self.at(x0 + 1, y0);
        let v01 = self.at(x0, y0 + 1);
        let v11 = self.at(x0 + 1, y0 + 1);
        v00 * (1.0 - tx) * (1.0 - ty)
            + v10 * tx * (1.0 - ty)
            + v01 * (1.0 - tx) * ty
            + v11 * tx * ty
    }

    fn sample_nearest(&self, x: f64, y: f64) -> f64 {
        let Some((fx, fy)) = self.frac(x, y) else {
            return f64::NAN;
        };
        self.at(fx.round() as isize, fy.round() as isize)
    }
}

// --- index + colormap ------------------------------------------------------

/// Compute the requested index from reflectances at one pixel; NaN when a required band is absent.
#[allow(clippy::too_many_arguments)]
fn index_value(
    index: &str,
    red: Option<f32>,
    green: Option<f32>,
    nir: Option<f32>,
    nir08: Option<f32>,
    rededge1: Option<f32>,
    swir16: Option<f32>,
) -> f32 {
    use arvo_core::indices;
    match index {
        "ndvi" => match (nir, red) {
            (Some(n), Some(r)) => indices::ndvi(n, r),
            _ => f32::NAN,
        },
        "savi" => match (nir, red) {
            (Some(n), Some(r)) => indices::savi(n, r),
            _ => f32::NAN,
        },
        "ndre" => match (nir, rededge1) {
            (Some(n), Some(re)) => indices::ndre(n, re),
            _ => f32::NAN,
        },
        "gndvi" => match (nir, green) {
            (Some(n), Some(g)) => indices::gndvi(n, g),
            _ => f32::NAN,
        },
        "ndmi" => match (nir08, swir16) {
            (Some(n8), Some(sw)) => indices::ndmi(n8, sw),
            _ => f32::NAN,
        },
        _ => f32::NAN,
    }
}

/// Contract colormaps. Returns opaque RGB, or `None` for masked/no-data (→ alpha 0).
/// ndvi/ndre/gndvi/savi: red→yellow→green over [-0.2, 0.9]; ndmi: brown→white→blue over [-0.4, 0.6].
fn colormap(index: &str, v: f32) -> Option<[u8; 3]> {
    if !v.is_finite() {
        return None;
    }
    let (lo, hi, stops): (f64, f64, [[f64; 3]; 3]) = if index == "ndmi" {
        (
            -0.4,
            0.6,
            [
                [166.0, 97.0, 26.0],
                [247.0, 247.0, 247.0],
                [44.0, 123.0, 182.0],
            ],
        )
    } else {
        (
            -0.2,
            0.9,
            [
                [215.0, 48.0, 39.0],
                [255.0, 255.0, 191.0],
                [26.0, 152.0, 80.0],
            ],
        )
    };
    let t = (((v as f64) - lo) / (hi - lo)).clamp(0.0, 1.0);
    let (a, b, tt) = if t < 0.5 {
        (stops[0], stops[1], t * 2.0)
    } else {
        (stops[1], stops[2], (t - 0.5) * 2.0)
    };
    let mix = |i: usize| (a[i] + (b[i] - a[i]) * tt).round().clamp(0.0, 255.0) as u8;
    Some([mix(0), mix(1), mix(2)])
}

// --- encoding / responses / small helpers ----------------------------------

fn encode_png_rgba(rgba: &[u8], w: u32, h: u32) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().context("png header")?;
        writer.write_image_data(rgba).context("png data")?;
    }
    Ok(out)
}

/// A fully-transparent 256×256 PNG (tiles outside the scene / masked). Encoded once.
fn transparent_png() -> anyhow::Result<Vec<u8>> {
    static PNG: std::sync::OnceLock<Vec<u8>> = std::sync::OnceLock::new();
    if let Some(bytes) = PNG.get() {
        return Ok(bytes.clone());
    }
    let bytes = encode_png_rgba(
        &vec![0u8; TILE_PX * TILE_PX * 4],
        TILE_PX as u32,
        TILE_PX as u32,
    )?;
    Ok(PNG.get_or_init(|| bytes).clone())
}

fn png_response(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    )
        .into_response()
}

fn cache_path(state: &AppState, scene_id: &Uuid, index: &str, z: u32, x: u32, y: u32) -> PathBuf {
    state
        .cfg
        .tile_cache_dir
        .join(scene_id.to_string())
        .join(index)
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{y}.png"))
}

/// Strip a known extension (case-insensitive) if present. The char-boundary check matters:
/// the segment is caller-controlled, and byte-slicing inside a multibyte char would panic.
fn strip_ext<'a>(s: &'a str, ext: &str) -> &'a str {
    if s.len() >= ext.len()
        && s.is_char_boundary(s.len() - ext.len())
        && s[s.len() - ext.len()..].eq_ignore_ascii_case(ext)
    {
        &s[..s.len() - ext.len()]
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_png_extension() {
        assert_eq!(strip_ext("12388.png", ".png"), "12388");
        assert_eq!(strip_ext("12388.PNG", ".png"), "12388");
        assert_eq!(strip_ext("12388", ".png"), "12388");
        // Multibyte tail: must not panic on a non-char-boundary slice.
        assert_eq!(strip_ext("1€38", ".png"), "1€38");
        assert_eq!(strip_ext("€", ".png"), "€");
    }

    #[test]
    fn normalizes_index_case_insensitively() {
        assert_eq!(normalize_index(Some("NDVI")).unwrap(), "ndvi");
        assert_eq!(normalize_index(Some(" ndmi ")).unwrap(), "ndmi");
        assert!(normalize_index(Some("bogus")).is_err());
    }

    #[test]
    fn colormap_masks_non_finite_and_ramps() {
        assert!(colormap("ndvi", f32::NAN).is_none());
        // low NDVI → reddish (r>g); high NDVI → greenish (g>r).
        let low = colormap("ndvi", -0.2).unwrap();
        let high = colormap("ndvi", 0.9).unwrap();
        assert!(low[0] > low[1]);
        assert!(high[1] > high[0]);
        // ndmi uses a different ramp (blue high end).
        let wet = colormap("ndmi", 0.6).unwrap();
        assert!(wet[2] > wet[0]);
    }

    #[test]
    fn index_value_needs_required_bands() {
        assert!(index_value("ndvi", Some(0.1), None, Some(0.5), None, None, None).is_finite());
        assert!(index_value("ndvi", None, None, Some(0.5), None, None, None).is_nan());
        assert!(index_value("ndmi", None, None, None, Some(0.4), None, Some(0.2)).is_finite());
    }
}
