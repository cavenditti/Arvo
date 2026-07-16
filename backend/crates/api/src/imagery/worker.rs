//! Real Sentinel-2 pixel compute. Behind the `imagery` feature (gated at `mod.rs`), so the
//! default build never references GDAL. Reads the asset COGs over `/vsicurl/`, clips to the
//! parcel bbox, resamples every band to a common 10 m grid, masks clouds (SCL) and the parcel
//! polygon, computes the five indices via `arvo_core::indices`, and inserts observations.
//!
//! NOTE: this cannot be built/tested without a system GDAL, so it is reviewed rather than run.
use anyhow::{anyhow, Context};
use arvo_core::indices;
use gdal::raster::ResampleAlg;
use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use gdal::Dataset;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::imagery::raster::{asset_href, open_vsicurl, to_reflectance, BAND_KEYS, SCL_CLOUD_CLASSES};
use crate::imagery::stac::SceneRow;

/// Common output grid resolution (metres). S2 bands are 10–20 m; we resample to 10 m.
const TARGET_RES_M: f64 = 10.0;

struct Computed {
    cloud_pct: f64,
    stats: Vec<(&'static str, indices::Stats)>,
}

/// Compute + persist the five indices for one scene over one parcel. Returns how many index
/// observations were inserted (0 if the parcel isn't covered or the scene lacks assets).
pub async fn compute_scene(
    pool: &PgPool,
    parcel_id: Uuid,
    geometry_geojson: String,
    scene: SceneRow,
) -> anyhow::Result<usize> {
    let assets = scene.assets.clone();
    // GDAL is blocking — keep it off the async runtime.
    let computed =
        tokio::task::spawn_blocking(move || compute_pixels(&assets, &geometry_geojson)).await??;
    let Some(c) = computed else { return Ok(0) };

    let mut inserted = 0usize;
    for (index_name, st) in c.stats {
        let res = sqlx::query(
            "INSERT INTO index_observations
               (parcel_id, scene_id, index_name, observed_at, mean, median, p10, p90, stddev,
                pixel_count, cloud_pct, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sentinel-2')
             ON CONFLICT (parcel_id, index_name, observed_at) DO NOTHING",
        )
        .bind(parcel_id)
        .bind(scene.id)
        .bind(index_name)
        .bind(scene.acquired_at)
        .bind(st.mean)
        .bind(st.median)
        .bind(st.p10)
        .bind(st.p90)
        .bind(st.stddev)
        .bind(st.count as i32)
        .bind(c.cloud_pct)
        .execute(pool)
        .await?;
        if res.rows_affected() > 0 {
            inserted += 1;
        }
    }
    Ok(inserted)
}

/// All GDAL/pixel work (blocking, pure). Returns None when the parcel is not covered.
fn compute_pixels(assets: &Value, geometry_geojson: &str) -> anyhow::Result<Option<Computed>> {
    let rings = parse_exterior_rings(geometry_geojson)?;
    if rings.is_empty() {
        return Ok(None);
    }
    let (min_lon, min_lat, max_lon, max_lat) = lonlat_bbox(&rings);

    let scl_href = asset_href(assets, "scl").ok_or_else(|| anyhow!("scene missing scl asset"))?;
    let scl_ds = open_vsicurl(scl_href)?;
    let ds_srs = scl_ds.spatial_ref().context("scl srs")?;

    // WGS84 in traditional (lon, lat) axis order so our coord arrays are [x=lon, y=lat].
    let mut wgs84 = SpatialRef::from_epsg(4326)?;
    wgs84.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let to_ds = CoordTransform::new(&wgs84, &ds_srs)?;
    let to_wgs = CoordTransform::new(&ds_srs, &wgs84)?;

    // Parcel bbox → dataset CRS (metres). Transform all four corners (projection isn't affine).
    let mut xs = vec![min_lon, max_lon, min_lon, max_lon];
    let mut ys = vec![min_lat, min_lat, max_lat, max_lat];
    let mut zs = vec![0.0f64; 4];
    to_ds.transform_coords(&mut xs, &mut ys, &mut zs)?;
    let ds_min_x = xs.iter().cloned().fold(f64::MAX, f64::min);
    let ds_max_x = xs.iter().cloned().fold(f64::MIN, f64::max);
    let ds_min_y = ys.iter().cloned().fold(f64::MAX, f64::min);
    let ds_max_y = ys.iter().cloned().fold(f64::MIN, f64::max);

    // Common output grid at TARGET_RES_M.
    let out_w = (((ds_max_x - ds_min_x) / TARGET_RES_M).round() as usize).max(1);
    let out_h = (((ds_max_y - ds_min_y) / TARGET_RES_M).round() as usize).max(1);

    // Read SCL and every reflectance band, each resampled onto the same out_w × out_h grid.
    let scl = read_grid(&scl_ds, ds_min_x, ds_max_y, ds_max_x, ds_min_y, out_w, out_h, true)?;
    let mut bands = std::collections::HashMap::new();
    for key in BAND_KEYS {
        let Some(href) = asset_href(assets, key) else { continue };
        let ds = open_vsicurl(href)?;
        let g = read_grid(&ds, ds_min_x, ds_max_y, ds_max_x, ds_min_y, out_w, out_h, false)?;
        bands.insert(key, g);
    }

    // Pixel-center coordinates (dataset CRS) → lon/lat for the polygon mask, in one bulk transform.
    let n = out_w * out_h;
    let mut px = Vec::with_capacity(n);
    let mut py = Vec::with_capacity(n);
    for row in 0..out_h {
        for col in 0..out_w {
            px.push(ds_min_x + (col as f64 + 0.5) * TARGET_RES_M);
            py.push(ds_max_y - (row as f64 + 0.5) * TARGET_RES_M);
        }
    }
    let mut pz = vec![0.0f64; n];
    to_wgs.transform_coords(&mut px, &mut py, &mut pz)?;

    let band = |k: &str| bands.get(k).map(|v| v.as_slice());
    let (red, green, nir, nir08, rededge1, swir16) = (
        band("red"),
        band("green"),
        band("nir"),
        band("nir08"),
        band("rededge1"),
        band("swir16"),
    );

    let mut ndvi = vec![f32::NAN; n];
    let mut ndre = vec![f32::NAN; n];
    let mut gndvi = vec![f32::NAN; n];
    let mut ndmi = vec![f32::NAN; n];
    let mut savi = vec![f32::NAN; n];

    let mut parcel_px = 0usize;
    let mut cloud_px = 0usize;
    for i in 0..n {
        if !point_in_rings(px[i], py[i], &rings) {
            continue; // outside the parcel polygon
        }
        parcel_px += 1;
        if SCL_CLOUD_CLASSES.contains(&(scl[i].round() as i64)) {
            cloud_px += 1;
            continue; // clouded — excluded from index stats
        }
        let g = |b: Option<&[f64]>| b.map(|s| to_reflectance(s[i]));
        let (r, gr, n8, ni, re, sw) =
            (g(red), g(green), g(nir08), g(nir), g(rededge1), g(swir16));
        if let (Some(ni), Some(r)) = (ni, r) {
            ndvi[i] = indices::ndvi(ni as f32, r as f32);
            savi[i] = indices::savi(ni as f32, r as f32);
        }
        if let (Some(ni), Some(re)) = (ni, re) {
            ndre[i] = indices::ndre(ni as f32, re as f32);
        }
        if let (Some(ni), Some(gr)) = (ni, gr) {
            gndvi[i] = indices::gndvi(ni as f32, gr as f32);
        }
        if let (Some(n8), Some(sw)) = (n8, sw) {
            ndmi[i] = indices::ndmi(n8 as f32, sw as f32);
        }
    }

    if parcel_px == 0 {
        return Ok(None); // scene footprint doesn't cover this parcel
    }
    let cloud_pct = 100.0 * cloud_px as f64 / parcel_px as f64;

    let mut stats = Vec::new();
    for (name, buf) in [
        ("ndvi", &ndvi),
        ("ndre", &ndre),
        ("gndvi", &gndvi),
        ("ndmi", &ndmi),
        ("savi", &savi),
    ] {
        if let Some(s) = indices::stats(buf) {
            stats.push((name, s));
        }
    }
    if stats.is_empty() {
        return Ok(None);
    }
    Ok(Some(Computed { cloud_pct, stats }))
}

/// Read a band clipped to the dataset-CRS bbox and resampled to `out_w × out_h` (row-major).
/// `categorical` uses nearest-neighbour (SCL classes); reflectance uses bilinear.
#[allow(clippy::too_many_arguments)]
fn read_grid(
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
    // Invert the (north-up) geotransform: col = (x - ox)/px, row = (y - oy)/py (py < 0).
    let col = |x: f64| (x - gt[0]) / gt[1];
    let row = |y: f64| (y - gt[3]) / gt[5];
    let c0 = col(ds_min_x).floor().clamp(0.0, rw as f64) as isize;
    let c1 = col(ds_max_x).ceil().clamp(0.0, rw as f64) as isize;
    let r0 = row(ds_max_y).floor().clamp(0.0, rh as f64) as isize;
    let r1 = row(ds_min_y).ceil().clamp(0.0, rh as f64) as isize;
    let win = (c0.min(c1), r0.min(r1));
    let win_size = (
        ((c1 - c0).unsigned_abs()).max(1),
        ((r1 - r0).unsigned_abs()).max(1),
    );

    let alg = if categorical { ResampleAlg::NearestNeighbour } else { ResampleAlg::Bilinear };
    let band = ds.rasterband(1).context("rasterband(1)")?;
    let buf = band
        .read_as::<f64>(win, win_size, (out_w, out_h), Some(alg))
        .context("read_as")?;
    Ok(buf.data().to_vec())
}

/// Exterior rings (lon/lat) of a GeoJSON Polygon or MultiPolygon geometry.
fn parse_exterior_rings(geojson: &str) -> anyhow::Result<Vec<Vec<[f64; 2]>>> {
    let v: Value = serde_json::from_str(geojson).context("parse geometry")?;
    let coords = v.get("coordinates").ok_or_else(|| anyhow!("geometry has no coordinates"))?;
    let mut rings = Vec::new();
    match v.get("type").and_then(|t| t.as_str()) {
        Some("Polygon") => {
            if let Some(ext) = coords.as_array().and_then(|r| r.first()) {
                rings.push(ring_from(ext));
            }
        }
        Some("MultiPolygon") => {
            for poly in coords.as_array().into_iter().flatten() {
                if let Some(ext) = poly.as_array().and_then(|r| r.first()) {
                    rings.push(ring_from(ext));
                }
            }
        }
        other => return Err(anyhow!("unsupported geometry type: {other:?}")),
    }
    Ok(rings.into_iter().filter(|r: &Vec<[f64; 2]>| r.len() >= 3).collect())
}

fn ring_from(v: &Value) -> Vec<[f64; 2]> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let a = p.as_array()?;
            Some([a.first()?.as_f64()?, a.get(1)?.as_f64()?])
        })
        .collect()
}

fn lonlat_bbox(rings: &[Vec<[f64; 2]>]) -> (f64, f64, f64, f64) {
    let (mut min_lon, mut min_lat, mut max_lon, mut max_lat) =
        (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for r in rings {
        for p in r {
            min_lon = min_lon.min(p[0]);
            max_lon = max_lon.max(p[0]);
            min_lat = min_lat.min(p[1]);
            max_lat = max_lat.max(p[1]);
        }
    }
    (min_lon, min_lat, max_lon, max_lat)
}

/// Even-odd ray-casting point-in-polygon over the exterior rings (holes ignored for MVP).
fn point_in_rings(lon: f64, lat: f64, rings: &[Vec<[f64; 2]>]) -> bool {
    rings.iter().any(|ring| {
        let mut inside = false;
        let mut j = ring.len() - 1;
        for i in 0..ring.len() {
            let (xi, yi) = (ring[i][0], ring[i][1]);
            let (xj, yj) = (ring[j][0], ring[j][1]);
            if (yi > lat) != (yj > lat)
                && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    })
}
