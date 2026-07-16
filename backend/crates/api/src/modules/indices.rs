//! Vegetation index endpoints (docs/API.md §Imagery — indices):
//! series, latest (all 5), dashboard batch latest, and CSV export.
use std::fmt::Write as _;

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::security::AuthUser;
use crate::state::AppState;

const INDEX_NAMES: [&str; 5] = ["ndvi", "ndre", "gndvi", "ndmi", "savi"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parcels/{id}/indices", get(series))
        .route("/parcels/{id}/indices/latest", get(latest))
        .route("/parcels/{id}/indices.csv", get(export_csv))
        .route("/indices/latest", get(batch_latest))
}

/// One point in a per-index time series (matches `IndexPoint` in the contract).
#[derive(Serialize, sqlx::FromRow)]
struct IndexPoint {
    observed_at: DateTime<Utc>,
    mean: f64,
    median: Option<f64>,
    p10: Option<f64>,
    p90: Option<f64>,
    stddev: Option<f64>,
    pixel_count: Option<i32>,
    cloud_pct: Option<f64>,
    scene_id: Option<Uuid>,
    source: String,
}

/// A series point tagged with its index (for the `latest` / batch queries).
#[derive(sqlx::FromRow)]
struct NamedPoint {
    index_name: String,
    observed_at: DateTime<Utc>,
    mean: f64,
    median: Option<f64>,
    p10: Option<f64>,
    p90: Option<f64>,
    stddev: Option<f64>,
    pixel_count: Option<i32>,
    cloud_pct: Option<f64>,
    scene_id: Option<Uuid>,
    source: String,
}

impl NamedPoint {
    fn into_value(self) -> Value {
        json!({
            "observed_at": self.observed_at,
            "mean": self.mean,
            "median": self.median,
            "p10": self.p10,
            "p90": self.p90,
            "stddev": self.stddev,
            "pixel_count": self.pixel_count,
            "cloud_pct": self.cloud_pct,
            "scene_id": self.scene_id,
            "source": self.source,
        })
    }
}

#[derive(Deserialize)]
struct SeriesQuery {
    index: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

/// GET /parcels/{id}/indices?index=&from=&to= — one index series, ascending by time.
async fn series(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SeriesQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state, id, user.org_id).await?;
    let index = normalize_index(q.index.as_deref())?;
    let from = parse_ts(q.from.as_deref());
    let to = parse_ts(q.to.as_deref());

    let points = sqlx::query_as::<_, IndexPoint>(
        "SELECT observed_at, mean, median, p10, p90, stddev, pixel_count, cloud_pct, scene_id, source
         FROM index_observations
         WHERE parcel_id = $1 AND index_name = $2
           AND ($3::timestamptz IS NULL OR observed_at >= $3)
           AND ($4::timestamptz IS NULL OR observed_at <= $4)
         ORDER BY observed_at ASC",
    )
    .bind(id)
    .bind(index)
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({ "index": index, "series": points })))
}

/// GET /parcels/{id}/indices/latest — newest point for each of the five indices.
async fn latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state, id, user.org_id).await?;
    let rows = sqlx::query_as::<_, NamedPoint>(
        "SELECT DISTINCT ON (index_name)
                index_name, observed_at, mean, median, p10, p90, stddev, pixel_count,
                cloud_pct, scene_id, source
         FROM index_observations
         WHERE parcel_id = $1
         ORDER BY index_name, observed_at DESC",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(latest_object(rows)))
}

#[derive(Deserialize)]
struct BatchQuery {
    parcel_ids: Option<String>,
}

/// GET /indices/latest?parcel_ids=a,b,c — dashboard batch: latest-of-each per parcel.
async fn batch_latest(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<BatchQuery>,
) -> ApiResult<Json<Value>> {
    let ids: Vec<Uuid> = q
        .parcel_ids
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|s| Uuid::parse_str(s.trim()).ok())
        .collect();

    let mut out = serde_json::Map::new();
    if ids.is_empty() {
        return Ok(Json(Value::Object(out)));
    }

    // Restrict to parcels the caller's org actually owns (silently drop the rest).
    let owned: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM parcels WHERE id = ANY($1) AND org_id = $2")
            .bind(&ids)
            .bind(user.org_id)
            .fetch_all(&state.pool)
            .await?;
    if owned.is_empty() {
        return Ok(Json(Value::Object(out)));
    }

    let rows = sqlx::query_as::<_, BatchRow>(
        "SELECT DISTINCT ON (parcel_id, index_name)
                parcel_id, index_name, observed_at, mean, median, p10, p90, stddev, pixel_count,
                cloud_pct, scene_id, source
         FROM index_observations
         WHERE parcel_id = ANY($1)
         ORDER BY parcel_id, index_name, observed_at DESC",
    )
    .bind(&owned)
    .fetch_all(&state.pool)
    .await?;

    // Group rows by parcel, then fold each group into the {ndvi, ...} object.
    use std::collections::HashMap;
    let mut by_parcel: HashMap<Uuid, Vec<NamedPoint>> = HashMap::new();
    for r in rows {
        by_parcel.entry(r.parcel_id).or_default().push(r.point);
    }
    for pid in owned {
        let points = by_parcel.remove(&pid).unwrap_or_default();
        out.insert(pid.to_string(), latest_object(points));
    }

    Ok(Json(Value::Object(out)))
}

#[derive(sqlx::FromRow)]
struct BatchRow {
    parcel_id: Uuid,
    #[sqlx(flatten)]
    point: NamedPoint,
}

/// GET /parcels/{id}/indices.csv?index= — CSV export of one index series.
async fn export_csv(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SeriesQuery>,
) -> ApiResult<impl IntoResponse> {
    assert_owned(&state, id, user.org_id).await?;
    let index = normalize_index(q.index.as_deref())?;

    let points = sqlx::query_as::<_, IndexPoint>(
        "SELECT observed_at, mean, median, p10, p90, stddev, pixel_count, cloud_pct, scene_id, source
         FROM index_observations
         WHERE parcel_id = $1 AND index_name = $2
         ORDER BY observed_at ASC",
    )
    .bind(id)
    .bind(index)
    .fetch_all(&state.pool)
    .await?;

    let mut csv = String::from("observed_at,mean,median,p10,p90,stddev,cloud_pct,source\n");
    for p in &points {
        let _ = writeln!(
            csv,
            "{},{},{},{},{},{},{},{}",
            p.observed_at.to_rfc3339(),
            p.mean,
            num(p.median),
            num(p.p10),
            num(p.p90),
            num(p.stddev),
            num(p.cloud_pct),
            p.source,
        );
    }

    Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8")], csv))
}

// --- helpers ---------------------------------------------------------------

/// 404 unless the parcel belongs to the caller's org (no existence leak).
async fn assert_owned(state: &AppState, parcel_id: Uuid, org_id: Uuid) -> ApiResult<()> {
    let ok: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM parcels WHERE id = $1 AND org_id = $2")
            .bind(parcel_id)
            .bind(org_id)
            .fetch_optional(&state.pool)
            .await?;
    ok.map(|_| ()).ok_or(ApiError::NotFound)
}

/// Validate/normalize the `index` param; default `ndvi`.
fn normalize_index(index: Option<&str>) -> ApiResult<&'static str> {
    match index.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok("ndvi"),
        Some(v) => INDEX_NAMES
            .into_iter()
            .find(|n| n.eq_ignore_ascii_case(v))
            .ok_or_else(|| ApiError::BadRequest(format!("unknown index: {v}"))),
    }
}

/// Parse a query timestamp: RFC3339, or a bare `YYYY-MM-DD` (treated as UTC midnight).
fn parse_ts(s: Option<&str>) -> Option<DateTime<Utc>> {
    let s = s?.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Utc));
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap()));
    }
    None
}

/// Build the `{ndvi, ndre, gndvi, ndmi, savi}` object, null where a series is absent.
fn latest_object(points: Vec<NamedPoint>) -> Value {
    let mut map = serde_json::Map::new();
    for name in INDEX_NAMES {
        map.insert(name.to_string(), Value::Null);
    }
    for p in points {
        if map.contains_key(&p.index_name) {
            let key = p.index_name.clone();
            map.insert(key, p.into_value());
        }
    }
    Value::Object(map)
}

fn num(v: Option<f64>) -> String {
    v.map(|x| x.to_string()).unwrap_or_default()
}
