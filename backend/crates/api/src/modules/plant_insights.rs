//! OWNER: be-plant-insights — per-plant analytics (FR-P-040/042/043/044) and plant alerts
//! (FR-P-061). Contract: docs/API-PLANT.md §"Plant insights", §"Plant alerts".
//! Migration 0100_plant_alerts.sql (`ALTER alerts ADD plant_id` + index + kind constraint).
//!
//! Two detectors run over the plant tier and they answer different questions:
//! `arvo_core::plant_anomaly` judges a plant against its **neighbours** (a failing tree in a
//! healthy row), `arvo_core::anomaly` judges a plant against its **own past** (a tree that was
//! fine last flight). Neither subsumes the other, so both feed alerts.
//!
//! The spatial work stays in PostGIS: neighbour selection is `ST_DWithin` + the `<->` KNN
//! order against the `plants` gist index, and Rust only does the (pure, unit-tested)
//! median + MAD maths on the values that come back. `modules/alerts.rs` is NOT edited — plant
//! alerts are ordinary `alerts` rows and reuse the existing ack/snooze/assign/dismiss endpoints.
use std::collections::HashMap;
use std::fmt::Write as _;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use arvo_core::anomaly;
use arvo_core::plant_anomaly as pa;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::modules::parcels::assert_owned;
use crate::security::{authenticate_bearer_or_media, AuthUser, Role};
use crate::state::AppState;
use crate::util::{self, Lang};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parcels/{id}/plants/summary", get(summary))
        .route("/parcels/{id}/plants/ranking", get(ranking))
        .route("/parcels/{id}/plants/outliers", get(outliers))
        .route("/parcels/{id}/plants/replant", get(replant))
        .route("/parcels/{id}/plants/replant.csv", get(replant_csv))
        .route("/parcels/{id}/plants/replant.geojson", get(replant_geojson))
        .route("/parcels/{id}/plants/growth", get(growth))
        .route("/plants/{id}/series", get(series))
        .route("/plants/{id}/metrics/latest", get(metrics_latest))
        .route("/plants/{id}/captures", get(plant_captures))
        .route("/plants/{id}/alerts", get(alerts_for_plant))
        .route("/plant-alerts", get(plant_alerts))
        .route("/alerts/detect/plants", post(detect_plants))
}

/// The seven per-plant metrics (docs/API-PLANT.md §Types → `PlantMetric`).
const PLANT_METRICS: [&str; 7] = [
    "ndvi",
    "ndre",
    "gndvi",
    "ndmi",
    "savi",
    "canopy_m2",
    "height_m",
];
/// The metric the alert detector watches — NDVI is the vigor proxy the whole product speaks.
const ALERT_METRIC: &str = "ndvi";
/// Only temporal drops this recent become alerts (older ones are history, not something to act
/// on) — same rule as the Tier-0 parcel detector in `jobs/detect.rs`.
const RECENT_DAYS: i64 = 14;
/// Ceiling on the rows the temporal detector loads per parcel, so one enormous parcel cannot
/// exhaust memory. Rows arrive ordered by plant, so a truncation can only shorten the last
/// plant's baseline — it can never invent an event.
const DROP_SCAN_MAX_ROWS: i64 = 200_000;
/// Cap on an unpaginated replant export (the JSON route is paginated instead).
const REPLANT_EXPORT_MAX: usize = 100_000;

// --- shared helpers --------------------------------------------------------

/// Validate/normalize `?metric=`; default `ndvi`.
fn normalize_metric(metric: Option<&str>) -> ApiResult<&'static str> {
    match metric.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(ALERT_METRIC),
        Some(v) => PLANT_METRICS
            .into_iter()
            .find(|m| m.eq_ignore_ascii_case(v))
            .ok_or_else(|| ApiError::BadRequest(format!("unknown metric: {v}"))),
    }
}

/// Parse a query timestamp: RFC3339, or a bare `YYYY-MM-DD` (UTC midnight). Garbage is a 400 —
/// silently dropping a filter would return the full series as if it had applied.
fn parse_ts(field: &str, s: Option<&str>) -> ApiResult<Option<DateTime<Utc>>> {
    let Some(s) = s.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(Some(dt.with_timezone(&Utc)));
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(Some(
            Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).unwrap()),
        ));
    }
    Err(ApiError::BadRequest(format!(
        "invalid {field}: expected RFC3339 or YYYY-MM-DD, got {s:?}"
    )))
}

#[derive(Debug, Clone, Copy, sqlx::FromRow)]
struct CaptureRef {
    id: Uuid,
    captured_at: DateTime<Utc>,
}

/// Resolve `?capture=`: `latest` (or absent) → the parcel's newest `extracted` capture that
/// actually carries an observation for `metric`; otherwise the named capture, org- and
/// parcel-checked. `Ok(None)` means "no such capture" — every insight endpoint answers that
/// with an empty result and `capture_id: null`, never a 404: a parcel with no flight yet is a
/// normal state, not an error.
async fn resolve_capture(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    metric: &str,
    capture: Option<&str>,
) -> ApiResult<Option<CaptureRef>> {
    let wanted = capture.map(str::trim).filter(|s| !s.is_empty());
    if let Some(v) = wanted {
        if !v.eq_ignore_ascii_case("latest") {
            let id = Uuid::parse_str(v).map_err(|_| {
                ApiError::BadRequest("invalid capture: expected a UUID or 'latest'".into())
            })?;
            return Ok(sqlx::query_as::<_, CaptureRef>(
                "SELECT id, captured_at FROM captures
                 WHERE id = $1 AND parcel_id = $2 AND org_id = $3",
            )
            .bind(id)
            .bind(parcel_id)
            .bind(org_id)
            .fetch_optional(&state.pool)
            .await?);
        }
    }
    Ok(sqlx::query_as::<_, CaptureRef>(
        "SELECT c.id, c.captured_at FROM captures c
         WHERE c.parcel_id = $1 AND c.org_id = $2 AND c.status = 'extracted'
           AND EXISTS (SELECT 1 FROM plant_observations o
                       WHERE o.capture_id = c.id AND o.metric = $3)
         ORDER BY c.captured_at DESC
         LIMIT 1",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(metric)
    .fetch_optional(&state.pool)
    .await?)
}

/// A plant plus the values of its k nearest same-parcel neighbours, straight from PostGIS.
#[derive(Debug, sqlx::FromRow)]
struct NeighbourRow {
    plant_id: Uuid,
    label: Option<String>,
    lon: f64,
    lat: f64,
    block_id: Option<Uuid>,
    row_id: Option<Uuid>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    status: String,
    value: f64,
    model_ver: Option<String>,
    neighbours: Vec<f64>,
}

/// Neighbour selection (FR-P-040), done entirely in SQL: for each `alive` plant with a value on
/// this capture, the `k` nearest other `alive` plants of the same parcel within `radius_m`.
///
/// Two distance predicates on purpose. The metric one (`geography`) is the contract's, but it
/// cannot use the `plants(geom)` gist index, so a degree-space `ST_DWithin` runs first as an
/// index-backed bbox prefilter. Its radius divides by `cos(lat)` (floored, so a pole cannot
/// blow it up), which over-expands north–south — always a superset, so the exact geography test
/// still decides. `<->` then orders the small candidate set by true distance.
#[allow(clippy::too_many_arguments)]
async fn neighbour_rows(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    capture_id: Uuid,
    metric: &str,
    k: i64,
    radius_m: f64,
    block_id: Option<Uuid>,
    only: Option<&[Uuid]>,
) -> ApiResult<Vec<NeighbourRow>> {
    let rows = sqlx::query_as::<_, NeighbourRow>(
        "SELECT p.id AS plant_id, p.label, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat,
                p.block_id, p.row_id, p.row_index, p.col_index, p.status::text AS status,
                o.value, o.model_ver,
                ARRAY(
                    SELECT o2.value
                    FROM plants n
                    JOIN plant_observations o2
                      ON o2.plant_id = n.id AND o2.capture_id = $3 AND o2.metric = $4
                    WHERE n.parcel_id = p.parcel_id AND n.org_id = p.org_id
                      AND n.id <> p.id AND n.status = 'alive'
                      AND ST_DWithin(n.geom, p.geom,
                            $6 / (111320.0 * greatest(cos(radians(ST_Y(p.geom))), 0.2)))
                      AND ST_DWithin(n.geom::geography, p.geom::geography, $6)
                    ORDER BY n.geom <-> p.geom
                    LIMIT $5
                ) AS neighbours
         FROM plants p
         JOIN plant_observations o
           ON o.plant_id = p.id AND o.capture_id = $3 AND o.metric = $4
         WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status = 'alive'
           AND ($7::uuid IS NULL OR p.block_id = $7)
           AND ($8::uuid[] IS NULL OR p.id = ANY($8))",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(capture_id)
    .bind(metric)
    .bind(k)
    .bind(radius_m)
    .bind(block_id)
    .bind(only.map(<[Uuid]>::to_vec))
    .fetch_all(&state.pool)
    .await?;
    Ok(rows)
}

/// Org-scoped plant guard for the `/plants/{id}/…` routes. Cross-tenant → 404, never a 403:
/// another org must not be able to learn that the id exists at all.
async fn assert_plant_owned(state: &AppState, org_id: Uuid, plant_id: Uuid) -> ApiResult<()> {
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM plants WHERE id = $1 AND org_id = $2")
            .bind(plant_id)
            .bind(org_id)
            .fetch_optional(&state.pool)
            .await?;
    found.map(|_| ()).ok_or(ApiError::NotFound)
}

/// `Page<T>` envelope (docs/API-PLANT.md §Types).
fn page<T: Serialize>(items: Vec<T>, total: i64, limit: i64, offset: i64) -> Value {
    let has_more = offset + (items.len() as i64) < total;
    json!({
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
    })
}

/// Tile/legend normalisation, so a ranking row and a map pixel agree on how weak "weak" is:
/// `clamp((value − p5) / (p95 − p5), 0, 1)`, and 0.5 for a degenerate parcel distribution.
fn normalized(value: f64, p5: Option<f64>, p95: Option<f64>) -> f64 {
    match (p5, p95) {
        (Some(lo), Some(hi)) if (hi - lo).abs() > f64::EPSILON => {
            ((value - lo) / (hi - lo)).clamp(0.0, 1.0)
        }
        _ => 0.5,
    }
}

/// `100 · (value − median) / |median|`; `None` when the median is zero (no meaningful percent).
fn vs_pct(value: f64, median: Option<f64>) -> Option<f64> {
    median
        .filter(|m| m.abs() > f64::EPSILON)
        .map(|m| 100.0 * (value - m) / m.abs())
}

/// Human handle for a plant: its label, else its grid position, else a short id.
fn plant_name(
    label: Option<&str>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    id: Uuid,
) -> String {
    if let Some(l) = label.map(str::trim).filter(|l| !l.is_empty()) {
        return l.to_string();
    }
    match (row_index, col_index) {
        (Some(r), Some(c)) => format!("R{r}-P{c}"),
        _ => format!("#{}", &id.simple().to_string()[..8]),
    }
}

// --- summary ---------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct StatusCount {
    status: String,
    n: i64,
}

#[derive(sqlx::FromRow)]
struct MetricStats {
    metric: String,
    observed_at: DateTime<Utc>,
    capture_id: Option<Uuid>,
    mean: Option<f64>,
    median: Option<f64>,
    p10: Option<f64>,
    p90: Option<f64>,
    stddev: Option<f64>,
    plant_count: i64,
}

#[derive(sqlx::FromRow)]
struct LastCapture {
    id: Uuid,
    captured_at: DateTime<Utc>,
    status: String,
}

/// GET /parcels/{id}/plants/summary — the plant-tier header for the parcel screen.
async fn summary(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;

    let counts: Vec<StatusCount> = sqlx::query_as(
        "SELECT status::text AS status, count(*) AS n FROM plants
         WHERE parcel_id = $1 AND org_id = $2 GROUP BY status",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;
    let mut by_status = serde_json::Map::new();
    for s in ["alive", "dead", "missing", "replanted", "removed"] {
        by_status.insert(s.into(), json!(0));
    }
    let mut total = 0i64;
    for c in &counts {
        total += c.n;
        by_status.insert(c.status.clone(), json!(c.n));
    }

    let unit_types: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT unit_type::text FROM plants
         WHERE parcel_id = $1 AND org_id = $2 ORDER BY 1",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;

    let (block_count, row_count): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM plant_blocks WHERE parcel_id = $1 AND org_id = $2),
                (SELECT count(*) FROM plant_rows   WHERE parcel_id = $1 AND org_id = $2)",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_one(&state.pool)
    .await?;

    let last_capture: Option<LastCapture> = sqlx::query_as(
        "SELECT id, captured_at, status FROM captures
         WHERE parcel_id = $1 AND org_id = $2 ORDER BY captured_at DESC LIMIT 1",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&state.pool)
    .await?;

    // Newest observation set per metric, aggregated over the parcel's non-removed plants.
    let stats: Vec<MetricStats> = sqlx::query_as(
        "WITH newest AS (
             SELECT metric, max(observed_at) AS observed_at
             FROM plant_observations WHERE parcel_id = $1 AND org_id = $2 GROUP BY metric
         )
         SELECT o.metric, o.observed_at, (array_agg(o.capture_id))[1] AS capture_id,
                avg(o.value) AS mean,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY o.value) AS median,
                percentile_cont(0.1) WITHIN GROUP (ORDER BY o.value) AS p10,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY o.value) AS p90,
                stddev_samp(o.value) AS stddev,
                count(*) AS plant_count
         FROM plant_observations o
         JOIN newest n ON n.metric = o.metric AND n.observed_at = o.observed_at
         JOIN plants p ON p.id = o.plant_id AND p.status <> 'removed'
         WHERE o.parcel_id = $1 AND o.org_id = $2
         GROUP BY o.metric, o.observed_at",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;

    let mut latest = serde_json::Map::new();
    for m in PLANT_METRICS {
        latest.insert(m.into(), Value::Null);
    }
    for s in stats {
        if !latest.contains_key(&s.metric) {
            continue;
        }
        let key = s.metric.clone();
        latest.insert(
            key,
            json!({
                "observed_at": s.observed_at,
                "capture_id": s.capture_id,
                "mean": s.mean,
                "median": s.median,
                "p10": s.p10,
                "p90": s.p90,
                "stddev": s.stddev,
                "plant_count": s.plant_count,
            }),
        );
    }

    Ok(Json(json!({
        "parcel_id": id,
        "total": total,
        "by_status": by_status,
        "unit_types": unit_types,
        "block_count": block_count,
        "row_count": row_count,
        "last_capture": last_capture.map(|c| json!({
            "id": c.id, "captured_at": c.captured_at, "status": c.status
        })),
        "latest": latest,
    })))
}

// --- ranking (FR-P-042) ----------------------------------------------------

#[derive(Debug, Deserialize)]
struct RankingQuery {
    metric: Option<String>,
    capture: Option<String>,
    block_id: Option<Uuid>,
    row_id: Option<Uuid>,
    order: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RankingRow {
    plant_id: Uuid,
    label: Option<String>,
    lon: f64,
    lat: f64,
    block_id: Option<Uuid>,
    row_id: Option<Uuid>,
    status: String,
    value: f64,
    rank: i64,
    total: i64,
    p5: Option<f64>,
    p95: Option<f64>,
    block_median: Option<f64>,
}

/// GET /parcels/{id}/plants/ranking — weakest-N (or strongest-N) plants for a capture.
/// `rank` is computed over the whole filtered set so it survives paging; `normalized` uses the
/// parcel-wide p5–p95 scale the map tiles colour with, so the list and the map agree.
/// `vs_block_pct` compares against the plant's own block (block-less plants share one group).
async fn ranking(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<RankingQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let offset = q.offset.unwrap_or(0).max(0);
    let order = match q.order.as_deref().map(str::trim).unwrap_or("asc") {
        "" | "asc" => "asc",
        "desc" => "desc",
        other => return Err(ApiError::BadRequest(format!("invalid order: {other}"))),
    };

    let Some(cap) = resolve_capture(&state, user.org_id, id, metric, q.capture.as_deref()).await?
    else {
        return Ok(Json(json!({
            "metric": metric, "capture_id": null, "observed_at": null, "order": order,
            "page": page(Vec::<Value>::new(), 0, limit, offset),
        })));
    };

    // `dir` is one of two literals from the match above — never client text.
    let dir = if order == "desc" { "DESC" } else { "ASC" };
    let sql = format!(
        "WITH pv AS (
             SELECT p.id, p.label, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat,
                    p.block_id, p.row_id, p.status::text AS status, o.value
             FROM plants p
             JOIN plant_observations o
               ON o.plant_id = p.id AND o.capture_id = $3 AND o.metric = $4
             WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status = 'alive'
         ),
         scale AS (
             SELECT percentile_cont(0.05) WITHIN GROUP (ORDER BY value) AS p5,
                    percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
             FROM pv
         ),
         bmed AS (
             SELECT block_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS med
             FROM pv GROUP BY block_id
         ),
         ranked AS (
             SELECT pv.*, ROW_NUMBER() OVER (ORDER BY pv.value {dir}, pv.id) AS rank,
                    COUNT(*) OVER () AS total
             FROM pv
             WHERE ($5::uuid IS NULL OR pv.block_id = $5)
               AND ($6::uuid IS NULL OR pv.row_id = $6)
         )
         SELECT r.id AS plant_id, r.label, r.lon, r.lat, r.block_id, r.row_id, r.status,
                r.value, r.rank, r.total, s.p5, s.p95, b.med AS block_median
         FROM ranked r
         CROSS JOIN scale s
         LEFT JOIN bmed b ON b.block_id IS NOT DISTINCT FROM r.block_id
         ORDER BY r.rank
         LIMIT $7 OFFSET $8"
    );
    let rows: Vec<RankingRow> = sqlx::query_as(&sql)
        .bind(id)
        .bind(user.org_id)
        .bind(cap.id)
        .bind(metric)
        .bind(q.block_id)
        .bind(q.row_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(&state.pool)
        .await?;

    // The neighbour z is computed for the page only — the KNN is per-plant work, and nobody
    // reads a `neighbour_z` on a row they cannot see.
    let ids: Vec<Uuid> = rows.iter().map(|r| r.plant_id).collect();
    let mut z_by_plant: HashMap<Uuid, f64> = HashMap::new();
    if !ids.is_empty() {
        let nb = neighbour_rows(
            &state,
            user.org_id,
            id,
            cap.id,
            metric,
            pa::DEFAULT_K as i64,
            pa::DEFAULT_RADIUS_M,
            None,
            Some(&ids),
        )
        .await?;
        for r in nb {
            if let Some(o) = pa::assess(r.value, &r.neighbours) {
                z_by_plant.insert(r.plant_id, o.z);
            }
        }
    }

    let total = rows.first().map(|r| r.total).unwrap_or(0);
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "plant_id": r.plant_id,
                "label": r.label,
                "lon": r.lon,
                "lat": r.lat,
                "block_id": r.block_id,
                "row_id": r.row_id,
                "status": r.status,
                "value": r.value,
                "normalized": normalized(r.value, r.p5, r.p95),
                "rank": r.rank,
                "vs_block_pct": vs_pct(r.value, r.block_median),
                "neighbour_z": z_by_plant.get(&r.plant_id),
            })
        })
        .collect();

    Ok(Json(json!({
        "metric": metric,
        "capture_id": cap.id,
        "observed_at": cap.captured_at,
        "order": order,
        "page": page(items, total, limit, offset),
    })))
}

// --- neighbour outliers (FR-P-040) -----------------------------------------

#[derive(Debug, Deserialize)]
struct OutlierQuery {
    metric: Option<String>,
    capture: Option<String>,
    block_id: Option<Uuid>,
    k: Option<i64>,
    radius_m: Option<f64>,
    z: Option<f64>,
    limit: Option<i64>,
}

/// GET /parcels/{id}/plants/outliers — plants below their own neighbourhood, worst first.
async fn outliers(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<OutlierQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let k =
        q.k.unwrap_or(pa::DEFAULT_K as i64)
            .clamp(pa::K_MIN as i64, pa::K_MAX as i64);
    let radius_m = q
        .radius_m
        .unwrap_or(pa::DEFAULT_RADIUS_M)
        .clamp(pa::RADIUS_MIN_M, pa::RADIUS_MAX_M);
    let threshold =
        q.z.unwrap_or(pa::DEFAULT_THRESHOLD_Z)
            .clamp(pa::THRESHOLD_Z_MIN, pa::THRESHOLD_Z_MAX);
    let limit = q.limit.unwrap_or(200).clamp(1, 1000) as usize;

    let cap = resolve_capture(&state, user.org_id, id, metric, q.capture.as_deref()).await?;
    let mut items: Vec<Value> = Vec::new();
    if let Some(cap) = cap {
        let rows = neighbour_rows(
            &state,
            user.org_id,
            id,
            cap.id,
            metric,
            k,
            radius_m,
            q.block_id,
            None,
        )
        .await?;
        let mut scored: Vec<(f64, Value)> = rows
            .iter()
            .filter_map(|r| {
                let o = pa::evaluate(r.value, &r.neighbours, threshold)?;
                Some((
                    o.z,
                    json!({
                        "plant_id": r.plant_id,
                        "label": r.label,
                        "lon": r.lon,
                        "lat": r.lat,
                        "block_id": r.block_id,
                        "row_id": r.row_id,
                        "status": r.status,
                        "value": r.value,
                        "neighbour_median": o.neighbour_median,
                        "neighbour_mad": o.neighbour_mad,
                        "neighbour_count": o.neighbour_count,
                        "z": o.z,
                        "severity": o.severity.as_str(),
                    }),
                ))
            })
            .collect();
        // Worst first; `total_cmp` keeps the float ordering total (and the result stable).
        scored.sort_by(|a, b| a.0.total_cmp(&b.0));
        items = scored.into_iter().take(limit).map(|(_, v)| v).collect();
    }

    Ok(Json(json!({
        "metric": metric,
        "capture_id": cap.map(|c| c.id),
        "observed_at": cap.map(|c| c.captured_at),
        "k": k,
        "radius_m": radius_m,
        "threshold": threshold,
        "items": items,
    })))
}

// --- replant list (FR-P-043) -----------------------------------------------

const REPLANT_COLS: &str = "p.id AS plant_id, p.label, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat, \
     p.block_id, b.name AS block_name, p.row_id, r.name AS row_name, p.row_index, p.col_index, \
     p.status::text AS status, p.missing_streak AS captures_absent, \
     (SELECT max(o.observed_at) FROM plant_observations o WHERE o.plant_id = p.id) AS last_seen_at, \
     (SELECT o.value FROM plant_observations o WHERE o.plant_id = p.id AND o.metric = 'ndvi' \
        ORDER BY o.observed_at DESC LIMIT 1) AS last_value";
const REPLANT_FROM: &str = "FROM plants p LEFT JOIN plant_blocks b ON b.id = p.block_id \
     LEFT JOIN plant_rows r ON r.id = p.row_id";

#[derive(Debug, Serialize, sqlx::FromRow)]
struct ReplantRow {
    plant_id: Uuid,
    label: Option<String>,
    lon: f64,
    lat: f64,
    block_id: Option<Uuid>,
    block_name: Option<String>,
    row_id: Option<Uuid>,
    /// CSV-only — `ReplantEntry` carries `row_id`, not the row's name.
    #[serde(skip)]
    row_name: Option<String>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    status: String,
    captures_absent: i32,
    last_seen_at: Option<DateTime<Utc>>,
    last_value: Option<f64>,
    /// Filled in Rust: why this plant is on the list.
    #[sqlx(default)]
    reason: String,
}

#[derive(Debug, Deserialize)]
struct ReplantQuery {
    block_id: Option<Uuid>,
    limit: Option<i64>,
    offset: Option<i64>,
    token: Option<String>,
}

/// The full replant set for a parcel: every `missing`/`dead` plant, plus the `alive` plants
/// whose latest NDVI has collapsed against their neighbours (z ≤ critical). Ordered as a field
/// walk — block, then row, then position — so a crew can work straight down the list.
async fn replant_entries(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    block_id: Option<Uuid>,
) -> ApiResult<Vec<ReplantRow>> {
    let sql = format!(
        "SELECT {REPLANT_COLS} {REPLANT_FROM}
         WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status IN ('missing', 'dead')
           AND ($3::uuid IS NULL OR p.block_id = $3)"
    );
    let mut rows: Vec<ReplantRow> = sqlx::query_as(&sql)
        .bind(parcel_id)
        .bind(org_id)
        .bind(block_id)
        .fetch_all(&state.pool)
        .await?;
    for r in &mut rows {
        r.reason = r.status.clone();
    }

    // Vigor collapse: still standing and still `alive`, but so far below its neighbours that it
    // belongs on the replant list rather than in a "go and look at this plant" alert.
    if let Some(cap) =
        resolve_capture(state, org_id, parcel_id, ALERT_METRIC, Some("latest")).await?
    {
        let scored = neighbour_rows(
            state,
            org_id,
            parcel_id,
            cap.id,
            ALERT_METRIC,
            pa::DEFAULT_K as i64,
            pa::DEFAULT_RADIUS_M,
            block_id,
            None,
        )
        .await?;
        let collapsed: Vec<Uuid> = scored
            .iter()
            .filter(|r| pa::evaluate(r.value, &r.neighbours, pa::CRITICAL_Z).is_some())
            .map(|r| r.plant_id)
            .collect();
        if !collapsed.is_empty() {
            let sql = format!(
                "SELECT {REPLANT_COLS} {REPLANT_FROM}
                 WHERE p.id = ANY($1::uuid[]) AND p.org_id = $2"
            );
            let mut extra: Vec<ReplantRow> = sqlx::query_as(&sql)
                .bind(&collapsed)
                .bind(org_id)
                .fetch_all(&state.pool)
                .await?;
            for r in &mut extra {
                r.reason = "vigor_collapse".into();
            }
            rows.append(&mut extra);
        }
    }

    rows.sort_by(|a, b| walk_key(a).cmp(&walk_key(b)));
    Ok(rows)
}

/// Field-walk order with NULLs last, matching the `plants` list order convention.
fn walk_key(e: &ReplantRow) -> (bool, &str, bool, i32, bool, i32, Uuid) {
    (
        e.block_name.is_none(),
        e.block_name.as_deref().unwrap_or(""),
        e.row_index.is_none(),
        e.row_index.unwrap_or(0),
        e.col_index.is_none(),
        e.col_index.unwrap_or(0),
        e.plant_id,
    )
}

/// GET /parcels/{id}/plants/replant — paginated replant list.
async fn replant(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<ReplantQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let offset = q.offset.unwrap_or(0).max(0);

    let all = replant_entries(&state, user.org_id, id, q.block_id).await?;
    let total = all.len() as i64;
    let items: Vec<ReplantRow> = all
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    Ok(Json(page(items, total, limit, offset)))
}

/// GET /parcels/{id}/plants/replant.csv — media token or Bearer (browser downloads).
async fn replant_csv(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<ReplantQuery>,
) -> ApiResult<impl IntoResponse> {
    let user = authenticate_bearer_or_media(&state.cfg.jwt_secret, &headers, q.token.as_deref())?;
    assert_owned(&state.pool, user.org_id, id).await?;
    let rows = replant_entries(&state, user.org_id, id, q.block_id).await?;

    let mut csv = String::from(
        "plant_id,label,block,row,row_index,col_index,lon,lat,status,reason,last_seen_at,last_value\n",
    );
    for e in rows.iter().take(REPLANT_EXPORT_MAX) {
        let _ = writeln!(
            csv,
            "{},{},{},{},{},{},{:.7},{:.7},{},{},{},{}",
            e.plant_id,
            csv_field(e.label.as_deref()),
            csv_field(e.block_name.as_deref()),
            csv_field(e.row_name.as_deref()),
            e.row_index.map(|v| v.to_string()).unwrap_or_default(),
            e.col_index.map(|v| v.to_string()).unwrap_or_default(),
            e.lon,
            e.lat,
            e.status,
            e.reason,
            e.last_seen_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
            e.last_value.map(|v| v.to_string()).unwrap_or_default(),
        );
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"replant-{id}.csv\""),
            ),
        ],
        csv,
    ))
}

/// GET /parcels/{id}/plants/replant.geojson — the same list as map-ready points.
async fn replant_geojson(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Query(q): Query<ReplantQuery>,
) -> ApiResult<impl IntoResponse> {
    let user = authenticate_bearer_or_media(&state.cfg.jwt_secret, &headers, q.token.as_deref())?;
    assert_owned(&state.pool, user.org_id, id).await?;
    let rows = replant_entries(&state, user.org_id, id, q.block_id).await?;

    let features: Vec<Value> = rows
        .iter()
        .take(REPLANT_EXPORT_MAX)
        .map(|e| {
            json!({
                "type": "Feature",
                "geometry": { "type": "Point", "coordinates": [e.lon, e.lat] },
                "properties": {
                    "plant_id": e.plant_id,
                    "label": e.label,
                    "block_id": e.block_id,
                    "block_name": e.block_name,
                    "row_id": e.row_id,
                    "row_index": e.row_index,
                    "col_index": e.col_index,
                    "status": e.status,
                    "reason": e.reason,
                    "last_seen_at": e.last_seen_at,
                    "last_value": e.last_value,
                    "captures_absent": e.captures_absent,
                },
            })
        })
        .collect();
    let body = json!({ "type": "FeatureCollection", "features": features }).to_string();
    Ok((
        [
            (header::CONTENT_TYPE, "application/geo+json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"replant-{id}.geojson\""),
            ),
        ],
        body,
    ))
}

/// Quote a CSV field only when it needs it; `None` becomes empty.
fn csv_field(v: Option<&str>) -> String {
    let Some(v) = v else {
        return String::new();
    };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_string()
    }
}

// --- growth curve (FR-P-044) -----------------------------------------------

#[derive(Debug, Deserialize)]
struct GrowthQuery {
    metric: Option<String>,
    block_id: Option<Uuid>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct GrowthPoint {
    observed_at: DateTime<Utc>,
    capture_id: Option<Uuid>,
    plant_count: i64,
    mean: Option<f64>,
    median: Option<f64>,
    p10: Option<f64>,
    p90: Option<f64>,
    min: Option<f64>,
    max: Option<f64>,
}

/// GET /parcels/{id}/plants/growth — block/parcel trajectory across captures.
/// Removed plants are excluded (same rule as the parcel rollup); dead and missing ones are
/// kept, so a block that is losing plants shows the decline instead of hiding it.
async fn growth(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<GrowthQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let from = parse_ts("from", q.from.as_deref())?;
    let to = parse_ts("to", q.to.as_deref())?;

    let points: Vec<GrowthPoint> = sqlx::query_as(
        "SELECT o.observed_at, (array_agg(o.capture_id))[1] AS capture_id,
                count(*) AS plant_count, avg(o.value) AS mean,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY o.value) AS median,
                percentile_cont(0.1) WITHIN GROUP (ORDER BY o.value) AS p10,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY o.value) AS p90,
                min(o.value) AS min, max(o.value) AS max
         FROM plant_observations o
         JOIN plants p ON p.id = o.plant_id AND p.status <> 'removed'
         WHERE o.parcel_id = $1 AND o.org_id = $2 AND o.metric = $3
           AND ($4::uuid IS NULL OR p.block_id = $4)
           AND ($5::timestamptz IS NULL OR o.observed_at >= $5)
           AND ($6::timestamptz IS NULL OR o.observed_at <= $6)
         GROUP BY o.observed_at
         ORDER BY o.observed_at ASC",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(metric)
    .bind(q.block_id)
    .bind(from)
    .bind(to)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(json!({ "metric": metric, "points": points })))
}

// --- per-plant series / history --------------------------------------------

#[derive(Serialize, sqlx::FromRow)]
struct PlantObservation {
    observed_at: DateTime<Utc>,
    value: f64,
    capture_id: Uuid,
    quality: Option<i16>,
    model_ver: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SeriesQuery {
    metric: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: Option<i64>,
}

/// GET /plants/{id}/series — one metric's history for one plant. This *is* the growth curve for
/// `canopy_m2`/`height_m` (FR-P-044). The limit keeps the newest points and the result is then
/// re-sorted ascending: truncating a chart's recent end would be the wrong half to lose.
async fn series(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<SeriesQuery>,
) -> ApiResult<Json<Value>> {
    assert_plant_owned(&state, user.org_id, id).await?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let from = parse_ts("from", q.from.as_deref())?;
    let to = parse_ts("to", q.to.as_deref())?;
    let limit = q.limit.unwrap_or(2000).clamp(1, 2000);

    let points: Vec<PlantObservation> = sqlx::query_as(
        "SELECT observed_at, value, capture_id, quality, model_ver FROM (
             SELECT observed_at, value, capture_id, quality, model_ver
             FROM plant_observations
             WHERE plant_id = $1 AND org_id = $2 AND metric = $3
               AND ($4::timestamptz IS NULL OR observed_at >= $4)
               AND ($5::timestamptz IS NULL OR observed_at <= $5)
             ORDER BY observed_at DESC
             LIMIT $6
         ) recent
         ORDER BY observed_at ASC",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(metric)
    .bind(from)
    .bind(to)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(
        json!({ "plant_id": id, "metric": metric, "series": points }),
    ))
}

#[derive(sqlx::FromRow)]
struct NamedObservation {
    metric: String,
    observed_at: DateTime<Utc>,
    value: f64,
    capture_id: Uuid,
    quality: Option<i16>,
    model_ver: Option<String>,
}

/// GET /plants/{id}/metrics/latest — newest value of each of the seven metrics.
async fn metrics_latest(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    assert_plant_owned(&state, user.org_id, id).await?;
    let rows: Vec<NamedObservation> = sqlx::query_as(
        "SELECT DISTINCT ON (metric) metric, observed_at, value, capture_id, quality, model_ver
         FROM plant_observations
         WHERE plant_id = $1 AND org_id = $2
         ORDER BY metric, observed_at DESC",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;

    let mut out = serde_json::Map::new();
    for m in PLANT_METRICS {
        out.insert(m.into(), Value::Null);
    }
    for r in rows {
        if !out.contains_key(&r.metric) {
            continue;
        }
        let key = r.metric.clone();
        out.insert(
            key,
            json!({
                "observed_at": r.observed_at,
                "value": r.value,
                "capture_id": r.capture_id,
                "quality": r.quality,
                "model_ver": r.model_ver,
            }),
        );
    }
    Ok(Json(Value::Object(out)))
}

#[derive(Serialize, sqlx::FromRow)]
struct PlantCapture {
    capture_id: Uuid,
    captured_at: DateTime<Utc>,
    observed_at: DateTime<Utc>,
    quality: Option<i16>,
    model_ver: Option<String>,
    metrics: Value,
}

#[derive(Debug, Deserialize)]
struct LimitQuery {
    limit: Option<i64>,
}

/// GET /plants/{id}/captures — the plant-detail history table, one row per flight.
async fn plant_captures(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<LimitQuery>,
) -> ApiResult<Json<Vec<PlantCapture>>> {
    assert_plant_owned(&state, user.org_id, id).await?;
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    let rows: Vec<PlantCapture> = sqlx::query_as(
        "SELECT o.capture_id, c.captured_at, max(o.observed_at) AS observed_at,
                max(o.quality) AS quality,
                (array_agg(o.model_ver ORDER BY o.metric))[1] AS model_ver,
                jsonb_object_agg(o.metric, o.value) AS metrics
         FROM plant_observations o
         JOIN captures c ON c.id = o.capture_id
         WHERE o.plant_id = $1 AND o.org_id = $2
         GROUP BY o.capture_id, c.captured_at
         ORDER BY c.captured_at DESC
         LIMIT $3",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

// --- plant alerts (FR-P-061) -----------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
struct PlantAlert {
    id: Uuid,
    parcel_id: Option<Uuid>,
    plant_id: Option<Uuid>,
    plant_label: Option<String>,
    kind: String,
    severity: String,
    title: String,
    message: String,
    data: Value,
    state: String,
    snoozed_until: Option<DateTime<Utc>>,
    assigned_to: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const PLANT_ALERT_COLS: &str = "a.id, a.parcel_id, a.plant_id, p.label AS plant_label, a.kind, \
    a.severity, a.title, a.message, a.data, a.state::text AS state, a.snoozed_until, \
    a.assigned_to, a.created_at, a.updated_at";

/// Elapsed snoozes flip back to `open` before any read — identical to `GET /alerts`, so the two
/// lists can never disagree about an alert's state.
async fn reopen_elapsed_snoozes(state: &AppState, org_id: Uuid) -> ApiResult<()> {
    sqlx::query(
        "UPDATE alerts SET state = 'open', snoozed_until = NULL, updated_at = now()
         WHERE org_id = $1 AND state = 'snoozed'
           AND snoozed_until IS NOT NULL AND snoozed_until <= now()",
    )
    .bind(org_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct PlantAlertQuery {
    parcel_id: Option<Uuid>,
    plant_id: Option<Uuid>,
    state: Option<String>,
    kind: Option<String>,
    limit: Option<i64>,
}

/// GET /plant-alerts — plant-scoped alerts across the org.
async fn plant_alerts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<PlantAlertQuery>,
) -> ApiResult<Json<Vec<PlantAlert>>> {
    reopen_elapsed_snoozes(&state, user.org_id).await?;
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let sql = format!(
        "SELECT {PLANT_ALERT_COLS}
         FROM alerts a LEFT JOIN plants p ON p.id = a.plant_id
         WHERE a.org_id = $1 AND a.plant_id IS NOT NULL
           AND ($2::text IS NULL OR a.state::text = $2)
           AND ($3::uuid IS NULL OR a.parcel_id = $3)
           AND ($4::uuid IS NULL OR a.plant_id = $4)
           AND ($5::text IS NULL OR a.kind = $5)
         ORDER BY a.created_at DESC
         LIMIT $6"
    );
    let rows: Vec<PlantAlert> = sqlx::query_as(&sql)
        .bind(user.org_id)
        .bind(&q.state)
        .bind(q.parcel_id)
        .bind(q.plant_id)
        .bind(&q.kind)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
struct AlertsForPlantQuery {
    state: Option<String>,
    limit: Option<i64>,
}

/// GET /plants/{id}/alerts — the plant-detail alert strip.
async fn alerts_for_plant(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<AlertsForPlantQuery>,
) -> ApiResult<Json<Vec<PlantAlert>>> {
    assert_plant_owned(&state, user.org_id, id).await?;
    reopen_elapsed_snoozes(&state, user.org_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let sql = format!(
        "SELECT {PLANT_ALERT_COLS}
         FROM alerts a LEFT JOIN plants p ON p.id = a.plant_id
         WHERE a.org_id = $1 AND a.plant_id = $2
           AND ($3::text IS NULL OR a.state::text = $3)
         ORDER BY a.created_at DESC
         LIMIT $4"
    );
    let rows: Vec<PlantAlert> = sqlx::query_as(&sql)
        .bind(user.org_id)
        .bind(id)
        .bind(&q.state)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(rows))
}

// --- the plant alert detector ----------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct DetectReq {
    parcel_id: Option<Uuid>,
    capture_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct LangQuery {
    lang: Option<String>,
}

/// POST /alerts/detect/plants [agronomist+] — run all four plant detectors now.
/// The pipeline never writes alerts; this endpoint does, so re-processing a capture cannot
/// quietly spray notifications at the whole org.
async fn detect_plants(
    State(state): State<AppState>,
    user: AuthUser,
    Query(lq): Query<LangQuery>,
    body: Option<Json<DetectReq>>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Agronomist)?;
    let req = body.map(|Json(b)| b).unwrap_or_default();
    let lang = util::resolve_lang(&state, user.user_id, lq.lang).await;

    let parcels: Vec<Uuid> = match req.parcel_id {
        Some(pid) => {
            assert_owned(&state.pool, user.org_id, pid).await?;
            vec![pid]
        }
        None => {
            sqlx::query_scalar("SELECT id FROM parcels WHERE org_id = $1 AND archived = false")
                .bind(user.org_id)
                .fetch_all(&state.pool)
                .await?
        }
    };

    let mut scanned = 0u32;
    let mut created = 0u32;
    let mut updated = 0u32;
    for parcel_id in parcels {
        let (s, c, u) =
            detect_for_parcel(&state, user.org_id, parcel_id, req.capture_id, lang).await?;
        scanned += s;
        created += c;
        updated += u;
    }

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "alert.detect_plants",
        "org",
        user.org_id,
        json!({
            "parcel_id": req.parcel_id, "capture_id": req.capture_id,
            "scanned": scanned, "created": created, "updated": updated,
        }),
    )
    .await;

    Ok(Json(
        json!({ "scanned": scanned, "created": created, "updated": updated }),
    ))
}

/// The four detectors for one parcel. `scanned` counts the plants actually examined: the alive
/// plants carrying a value on the evaluated capture, plus every missing/dead one.
async fn detect_for_parcel(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    capture_id: Option<Uuid>,
    lang: Lang,
) -> ApiResult<(u32, u32, u32)> {
    let (mut scanned, mut created, mut updated) = (0u32, 0u32, 0u32);

    // 1. Neighbour-relative vigor outliers (FR-P-040).
    let capture = match capture_id {
        Some(cid) => {
            resolve_capture(
                state,
                org_id,
                parcel_id,
                ALERT_METRIC,
                Some(&cid.to_string()),
            )
            .await?
        }
        None => resolve_capture(state, org_id, parcel_id, ALERT_METRIC, None).await?,
    };
    if let Some(cap) = capture {
        let rows = neighbour_rows(
            state,
            org_id,
            parcel_id,
            cap.id,
            ALERT_METRIC,
            pa::DEFAULT_K as i64,
            pa::DEFAULT_RADIUS_M,
            None,
            None,
        )
        .await?;
        scanned += rows.len() as u32;
        let date = cap.captured_at.date_naive();
        for r in &rows {
            let Some(o) = pa::evaluate(r.value, &r.neighbours, pa::DEFAULT_THRESHOLD_Z) else {
                continue;
            };
            let name = plant_name(r.label.as_deref(), r.row_index, r.col_index, r.plant_id);
            let (title, message) = outlier_text(lang, &name, r.value, &o);
            let inserted = upsert_plant_alert(
                state,
                org_id,
                parcel_id,
                r.plant_id,
                "plant_vigor_outlier",
                o.severity.as_str(),
                &title,
                &message,
                json!({
                    "metric": ALERT_METRIC,
                    "value": r.value,
                    "neighbour_median": o.neighbour_median,
                    "neighbour_mad": o.neighbour_mad,
                    "z": o.z,
                    "capture_id": cap.id,
                    "model_ver": r.model_ver,
                }),
                &format!("plant_vigor_outlier:{}:{}", r.plant_id, date),
            )
            .await?;
            if inserted {
                created += 1;
            } else {
                updated += 1;
            }
        }
    }

    // 2. Temporal drop on the plant's own series (FR-P-041) — the Tier-0 detector, per plant.
    // Only the window the detector can actually use is loaded (baseline + reporting span).
    let since = Utc::now() - Duration::days(anomaly::BASELINE_WINDOW_DAYS + RECENT_DAYS);
    let drop_rows: Vec<(Uuid, DateTime<Utc>, f64)> = sqlx::query_as(
        "SELECT o.plant_id, o.observed_at, o.value
         FROM plant_observations o
         JOIN plants p ON p.id = o.plant_id AND p.status = 'alive'
         WHERE o.parcel_id = $1 AND o.org_id = $2 AND o.metric = $3 AND o.observed_at >= $4
         ORDER BY o.plant_id, o.observed_at
         LIMIT $5",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(ALERT_METRIC)
    .bind(since)
    .bind(DROP_SCAN_MAX_ROWS)
    .fetch_all(&state.pool)
    .await?;

    let cutoff = Utc::now() - Duration::days(RECENT_DAYS);
    let mut by_plant: Vec<(Uuid, Vec<anomaly::SeriesPoint>)> = Vec::new();
    for (plant_id, observed_at, value) in drop_rows {
        let point = anomaly::SeriesPoint {
            observed_at,
            mean: value,
        };
        match by_plant.last_mut() {
            Some((id, series)) if *id == plant_id => series.push(point),
            _ => by_plant.push((plant_id, vec![point])),
        }
    }
    for (plant_id, series) in &by_plant {
        for event in anomaly::scan_series(series) {
            if event.observed_at < cutoff {
                continue;
            }
            let name = plant_label_for(state, org_id, *plant_id).await?;
            let (title, message) = drop_text(lang, &name, &event);
            // Severity is `warning` by contract even for a large drop: a single plant's own
            // series is short and noisy, so only the neighbour detector may say `critical`.
            let inserted = upsert_plant_alert(
                state,
                org_id,
                parcel_id,
                *plant_id,
                "plant_drop",
                "warning",
                &title,
                &message,
                json!({
                    "metric": ALERT_METRIC,
                    "value": event.value,
                    "baseline": event.baseline,
                    "drop_pct": event.drop_pct,
                    "observed_at": event.observed_at,
                }),
                &format!("plant_drop:{}:{}", plant_id, event.observed_at.date_naive()),
            )
            .await?;
            if inserted {
                created += 1;
            } else {
                updated += 1;
            }
        }
    }

    // 3 + 4. Plants the register stage has already given up on.
    let gone: Vec<GoneRow> = sqlx::query_as(
        "SELECT id, label, row_index, col_index, status::text AS status, missing_streak
         FROM plants
         WHERE parcel_id = $1 AND org_id = $2 AND status IN ('missing', 'dead')",
    )
    .bind(parcel_id)
    .bind(org_id)
    .fetch_all(&state.pool)
    .await?;
    scanned += gone.len() as u32;
    for g in &gone {
        let name = plant_name(g.label.as_deref(), g.row_index, g.col_index, g.id);
        let dead = g.status == "dead";
        let (title, message) = if dead {
            dead_text(lang, &name)
        } else {
            missing_text(lang, &name, g.missing_streak)
        };
        let kind = if dead { "plant_dead" } else { "plant_missing" };
        let inserted = upsert_plant_alert(
            state,
            org_id,
            parcel_id,
            g.id,
            kind,
            if dead { "critical" } else { "warning" },
            &title,
            &message,
            json!({
                "metric": Value::Null,
                "value": Value::Null,
                "status": g.status,
                "captures_absent": g.missing_streak,
            }),
            &format!("{kind}:{}", g.id),
        )
        .await?;
        if inserted {
            created += 1;
        } else {
            updated += 1;
        }
    }

    Ok((scanned, created, updated))
}

#[derive(sqlx::FromRow)]
struct GoneRow {
    id: Uuid,
    label: Option<String>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    status: String,
    missing_streak: i32,
}

/// Upsert one plant alert on its dedupe key. Re-running refreshes severity/title/message/data
/// but never touches `state`, so an alert somebody already acked or dismissed stays that way.
/// Returns `true` when the row was newly inserted (`xmax = 0` marks a fresh tuple).
#[allow(clippy::too_many_arguments)]
async fn upsert_plant_alert(
    state: &AppState,
    org_id: Uuid,
    parcel_id: Uuid,
    plant_id: Uuid,
    kind: &str,
    severity: &str,
    title: &str,
    message: &str,
    data: Value,
    dedupe_key: &str,
) -> ApiResult<bool> {
    let inserted: bool = sqlx::query_scalar(
        "INSERT INTO alerts (org_id, parcel_id, plant_id, kind, severity, title, message,
                             data, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE
           SET severity = EXCLUDED.severity, title = EXCLUDED.title,
               message = EXCLUDED.message, data = EXCLUDED.data, updated_at = now()
         RETURNING (xmax = 0) AS inserted",
    )
    .bind(org_id)
    .bind(parcel_id)
    .bind(plant_id)
    .bind(kind)
    .bind(severity)
    .bind(title)
    .bind(message)
    .bind(data)
    .bind(dedupe_key)
    .fetch_one(&state.pool)
    .await?;
    Ok(inserted)
}

/// Display name for a plant the caller only has an id for (the temporal detector's path).
async fn plant_label_for(state: &AppState, org_id: Uuid, plant_id: Uuid) -> ApiResult<String> {
    let row: Option<(Option<String>, Option<i32>, Option<i32>)> = sqlx::query_as(
        "SELECT label, row_index, col_index FROM plants WHERE id = $1 AND org_id = $2",
    )
    .bind(plant_id)
    .bind(org_id)
    .fetch_optional(&state.pool)
    .await?;
    let (label, row_index, col_index) = row.unwrap_or((None, None, None));
    Ok(plant_name(label.as_deref(), row_index, col_index, plant_id))
}

// --- alert copy (it default, FR-0-052 decision-support tone, NFR-CMP-030) ---
//
// Every message says what was measured, what it was measured against, and where a person might
// go and look. None of them prescribes a treatment: the software reports and points, the
// agronomist decides.

fn outlier_text(lang: Lang, name: &str, value: f64, o: &pa::Outlier) -> (String, String) {
    let critical = o.severity == pa::Severity::Critical;
    match lang {
        Lang::It => {
            let mut message = format!(
                "{name}: NDVI {value:.2} contro {:.2} delle {} piante più vicine \
                 (scarto robusto z {:.1}). ",
                o.neighbour_median, o.neighbour_count, o.z
            );
            message.push_str(if critical {
                "Divario molto marcato rispetto al vicinato: conviene un sopralluogo \
                 prioritario per verificare irrigazione, danni al fusto o apparato radicale."
            } else {
                "Le piante intorno stanno bene, quindi la causa è probabilmente locale: \
                 verificare in campo irrigazione, danni al fusto o apparato radicale."
            });
            ("Pianta più debole delle vicine".into(), message)
        }
        Lang::En => {
            let mut message = format!(
                "{name}: NDVI {value:.2} against {:.2} for its {} nearest plants \
                 (robust z {:.1}). ",
                o.neighbour_median, o.neighbour_count, o.z
            );
            message.push_str(if critical {
                "A very wide gap against the neighbourhood: worth a priority field check on \
                 irrigation, trunk damage or roots."
            } else {
                "The plants around it are doing fine, so the cause is likely local: check \
                 irrigation, trunk damage or roots in the field."
            });
            ("Plant weaker than its neighbours".into(), message)
        }
    }
}

fn drop_text(lang: Lang, name: &str, e: &anomaly::AnomalyEvent) -> (String, String) {
    let pct = (e.drop_pct * 100.0).round() as i64;
    match lang {
        Lang::It => (
            "Calo di vigore su una pianta".into(),
            format!(
                "{name}: NDVI sceso a {:.2} dalla media di {:.2} dei rilievi precedenti \
                 (−{pct}%). Il calo riguarda la storia della singola pianta: verificare \
                 irrigazione e stato sanitario prima del prossimo volo.",
                e.value, e.baseline
            ),
        ),
        Lang::En => (
            "Vigor drop on a plant".into(),
            format!(
                "{name}: NDVI fell to {:.2} from a {:.2} average over the previous surveys \
                 (−{pct}%). The drop is in this plant's own history: check irrigation and \
                 plant health before the next flight.",
                e.value, e.baseline
            ),
        ),
    }
}

fn missing_text(lang: Lang, name: &str, captures_absent: i32) -> (String, String) {
    match lang {
        Lang::It => {
            let seen = if captures_absent > 0 {
                format!("non rilevata negli ultimi {captures_absent} rilievi")
            } else {
                "non rilevata nell'ultimo rilievo".into()
            };
            (
                "Pianta non rilevata".into(),
                format!(
                    "{name}: {seen}. Controllare in campo: se la pianta manca davvero resta \
                     nella lista di reimpianto del blocco, se invece c'è ancora correggere \
                     lo stato."
                ),
            )
        }
        Lang::En => {
            let seen = if captures_absent > 0 {
                format!("not detected in the last {captures_absent} surveys")
            } else {
                "not detected in the last survey".into()
            };
            (
                "Plant not detected".into(),
                format!(
                    "{name}: {seen}. Check in the field: if the plant really is gone it stays \
                     on the block's replant list, if it is still there correct its status."
                ),
            )
        }
    }
}

fn dead_text(lang: Lang, name: &str) -> (String, String) {
    match lang {
        Lang::It => (
            "Pianta segnata come morta".into(),
            format!(
                "{name}: stato \"morta\". È già nella lista di reimpianto del blocco — \
                 valutare espianto e reimpianto nella prossima finestra utile."
            ),
        ),
        Lang::En => (
            "Plant marked as dead".into(),
            format!(
                "{name}: status \"dead\". It is already on the block's replant list — consider \
                 removal and replanting in the next suitable window."
            ),
        ),
    }
}
