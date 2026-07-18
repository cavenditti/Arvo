//! Earth Search STAC client (Sentinel-2 L2A). Searches scenes intersecting a parcel and
//! upserts them into `scenes` (shared, not org-scoped). No pixel compute here — that lives
//! in `worker.rs` behind the `imagery` feature.
use std::collections::HashMap;
use std::time::Duration;

use anyhow::Context;
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

const SEARCH_URL: &str = "https://earth-search.aws.element84.com/v1/search";
/// Asset keys we persist hrefs for (the bands the worker needs + the SCL cloud mask).
const ASSET_KEYS: [&str; 7] = ["red", "green", "nir", "nir08", "rededge1", "swir16", "scl"];

/// A scene row after upsert — carries the asset href map for the worker.
/// Its fields are consumed by the GDAL worker, so they read as dead in the default build.
#[derive(Debug, Clone)]
#[cfg_attr(not(feature = "imagery"), allow(dead_code))]
pub struct SceneRow {
    pub id: Uuid,
    pub stac_id: String,
    pub acquired_at: DateTime<Utc>,
    /// Persisted via SQL; kept on the struct for logging/debug context.
    #[allow(dead_code)]
    pub cloud_cover: Option<f64>,
    pub assets: Value,
    /// Earth Search harmonization flag: when true the -1000 BOA offset is already baked
    /// into the DNs and reflectance conversion must NOT subtract it again.
    pub boa_offset_applied: Option<bool>,
}

pub struct StacResult {
    pub found: usize,
    pub new: usize,
    /// Upserted scenes, consumed by the feature-gated worker.
    #[cfg_attr(not(feature = "imagery"), allow(dead_code))]
    pub scenes: Vec<SceneRow>,
}

/// Build a reqwest client with the standard 15s timeout (AGENTS §Backend patterns).
pub fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("build http client")
}

#[derive(Deserialize)]
struct FeatureCollection {
    #[serde(default)]
    features: Vec<Feature>,
}

#[derive(Deserialize)]
struct Feature {
    id: String,
    #[serde(default)]
    bbox: Option<Vec<f64>>,
    #[serde(default)]
    properties: Properties,
    #[serde(default)]
    assets: HashMap<String, Asset>,
}

#[derive(Deserialize, Default)]
struct Properties {
    datetime: Option<String>,
    #[serde(rename = "eo:cloud_cover")]
    cloud_cover: Option<f64>,
    #[serde(rename = "earthsearch:boa_offset_applied")]
    boa_offset_applied: Option<bool>,
}

#[derive(Deserialize)]
struct Asset {
    href: String,
}

/// POST the STAC search and upsert every returned scene. `geometry_geojson` is the parcel
/// geometry as a GeoJSON string (from `ST_AsGeoJSON`). Errors bubble up (network/parse) —
/// callers decide whether to treat them as fatal (endpoint) or best-effort (ingest).
pub async fn search_and_upsert(
    pool: &PgPool,
    client: &reqwest::Client,
    geometry_geojson: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> anyhow::Result<StacResult> {
    let geometry: Value =
        serde_json::from_str(geometry_geojson).context("parse parcel geometry geojson")?;
    let body = json!({
        "collections": ["sentinel-2-l2a"],
        "intersects": geometry,
        "datetime": format!(
            "{}/{}",
            from.to_rfc3339_opts(SecondsFormat::Secs, true),
            to.to_rfc3339_opts(SecondsFormat::Secs, true),
        ),
        "query": { "eo:cloud_cover": { "lt": 60 } },
        "limit": 100,
    });

    let fc: FeatureCollection = client
        .post(SEARCH_URL)
        .json(&body)
        .send()
        .await
        .context("stac search request")?
        .error_for_status()
        .context("stac search status")?
        .json()
        .await
        .context("stac search decode")?;

    let found = fc.features.len();
    if found >= 100 {
        // Page-full: Earth Search returned exactly the limit — results are likely truncated.
        // Long windows should be narrowed (the API clamps `days`), or pagination added here.
        tracing::warn!(
            found,
            "STAC search hit the page limit — older scenes may be missing"
        );
    }
    let mut new = 0usize;
    let mut scenes = Vec::with_capacity(found);

    for f in fc.features {
        let Some(dt) = f.properties.datetime.as_deref() else {
            continue; // no acquisition time → can't store (acquired_at NOT NULL)
        };
        let Ok(acquired_at) = DateTime::parse_from_rfc3339(dt) else {
            continue;
        };
        let acquired_at = acquired_at.with_timezone(&Utc);

        let mut assets = serde_json::Map::new();
        for key in ASSET_KEYS {
            if let Some(a) = f.assets.get(key) {
                assets.insert(key.to_string(), Value::String(a.href.clone()));
            }
        }
        let assets = Value::Object(assets);

        // Item bbox [w, s, e, n] → footprint polygon (drives per-parcel scene listing).
        let bbox = f.bbox.as_ref().filter(|b| b.len() == 4);
        // Upsert on stac_id; (xmax = 0) is true only for freshly inserted rows. bbox and the
        // offset flag are refreshed too, so pre-existing rows self-heal on the next refresh.
        let row: (Uuid, bool) = sqlx::query_as(
            "INSERT INTO scenes (source, stac_id, acquired_at, cloud_cover, assets, bbox, boa_offset_applied)
             VALUES ('sentinel-2-l2a', $1, $2, $3, $4,
                     CASE WHEN $5::float8 IS NULL THEN NULL
                          ELSE ST_MakeEnvelope($5, $6, $7, $8, 4326) END,
                     $9)
             ON CONFLICT (stac_id) DO UPDATE
               SET acquired_at = EXCLUDED.acquired_at,
                   cloud_cover = EXCLUDED.cloud_cover,
                   assets = EXCLUDED.assets,
                   bbox = COALESCE(EXCLUDED.bbox, scenes.bbox),
                   boa_offset_applied = COALESCE(EXCLUDED.boa_offset_applied, scenes.boa_offset_applied)
             RETURNING id, (xmax = 0) AS inserted",
        )
        .bind(&f.id)
        .bind(acquired_at)
        .bind(f.properties.cloud_cover)
        .bind(&assets)
        .bind(bbox.map(|b| b[0]))
        .bind(bbox.map(|b| b[1]))
        .bind(bbox.map(|b| b[2]))
        .bind(bbox.map(|b| b[3]))
        .bind(f.properties.boa_offset_applied)
        .fetch_one(pool)
        .await
        .context("upsert scene")?;

        if row.1 {
            new += 1;
        }
        scenes.push(SceneRow {
            id: row.0,
            stac_id: f.id,
            acquired_at,
            cloud_cover: f.properties.cloud_cover,
            assets,
            boa_offset_applied: f.properties.boa_offset_applied,
        });
    }

    Ok(StacResult { found, new, scenes })
}
