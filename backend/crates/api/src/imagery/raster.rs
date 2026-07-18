//! Shared GDAL raster primitives for the `imagery` feature — used by the pixel `worker`
//! (STAC ingest) and the `tiles` module (XYZ tiles + GeoTIFF export). Kept dependency-free of
//! the rest of the app so the mask/reflectance conventions live in exactly one place.
use anyhow::Context;
use gdal::Dataset;
use serde_json::Value;

/// SCL classes to exclude: 3 = cloud shadow, 8 = cloud (medium), 9 = cloud (high), 10 = cirrus.
pub const SCL_CLOUD_CLASSES: [i64; 4] = [3, 8, 9, 10];

/// Reflectance-band asset keys the five indices need (SCL is fetched separately for masking).
pub const BAND_KEYS: [&str; 6] = ["red", "green", "nir", "nir08", "rededge1", "swir16"];

/// Tune GDAL's `/vsicurl/` HTTP access once per process (retries, no bucket listing, block cache).
/// Cheap and idempotent — called at the top of each blocking render.
pub fn configure() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        for (k, v) in [
            ("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR"),
            ("GDAL_HTTP_MAX_RETRY", "3"),
            ("GDAL_HTTP_RETRY_DELAY", "1"),
            ("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif"),
            ("VSI_CACHE", "TRUE"),
        ] {
            let _ = gdal::config::set_config_option(k, v);
        }
    });
}

/// Open a COG over `/vsicurl/` (public `sentinel-cogs` bucket).
pub fn open_vsicurl(href: &str) -> anyhow::Result<Dataset> {
    let path = format!("/vsicurl/{href}");
    Dataset::open(std::path::Path::new(&path)).with_context(|| format!("open {path}"))
}

/// Href of an asset key in a scene's `assets` json map, if present.
pub fn asset_href<'a>(assets: &'a Value, key: &str) -> Option<&'a str> {
    assets.get(key)?.as_str()
}

/// Surface reflectance from an L2A DN. Processing baseline ≥ 04.00 added a +1000 offset to
/// DNs; Earth Search reports whether its harmonization already removed it via
/// `earthsearch:boa_offset_applied`. When that flag is true the offset is already baked in
/// and must NOT be subtracted again (doing so shifts every band down by 0.1 reflectance and
/// clamps dark bands to 0 → NDVI pinned at 1.0).
pub fn to_reflectance(dn: f64, boa_offset_applied: bool) -> f64 {
    let v = if boa_offset_applied {
        dn / 10000.0
    } else {
        (dn - 1000.0) / 10000.0
    };
    v.max(0.0)
}

/// True for SCL nodata (0): outside the scene footprint — "no data", not "cloudy".
pub fn scl_nodata(scl: f64) -> bool {
    scl.round() as i64 == 0
}

/// True when an SCL sample must be masked out: nodata (0) or a cloud/shadow/cirrus class.
/// The worker distinguishes nodata (not covered) from cloud (covered but excluded) via
/// `scl_nodata`; tile/GeoTIFF rendering has no polygon mask and treats both as transparent.
pub fn scl_masked(scl: f64) -> bool {
    scl_nodata(scl) || SCL_CLOUD_CLASSES.contains(&(scl.round() as i64))
}
