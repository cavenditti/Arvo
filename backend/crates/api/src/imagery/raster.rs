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

/// Harmonized surface reflectance from an L2A DN (processing baseline ≥ 04.00 offset of −1000).
pub fn to_reflectance(dn: f64) -> f64 {
    ((dn - 1000.0) / 10000.0).max(0.0)
}

/// True when an SCL sample must be masked out: nodata (0) or a cloud/shadow/cirrus class.
/// Unlike the worker (which additionally clips to the parcel polygon), tile/GeoTIFF rendering
/// has no polygon mask, so nodata (outside the scene footprint) is treated as masked here.
pub fn scl_masked(scl: f64) -> bool {
    let c = scl.round() as i64;
    c == 0 || SCL_CLOUD_CLASSES.contains(&c)
}
