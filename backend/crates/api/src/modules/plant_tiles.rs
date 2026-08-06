//! Plant vector tiles (`ST_AsMVT`) and the colour-ramp domain behind them.
//! Contract: docs/API-PLANT.md §"Plant vector tiles" (FR-P-050). No migration of its own.
//!
//! ```text
//! GET /tiles/plants/{parcel_id}/{z}/{x}/{y}.mvt  → application/vnd.mapbox-vector-tile, 204 when empty
//! GET /parcels/{id}/plants/metric-scale          → MetricScale (legend domain for the same tiles)
//! ```
//!
//! Not feature-gated: `ST_AsMVT` is pure PostGIS, so the plant map works in a default (no-GDAL)
//! build. The whole tile — capture resolution, the parcel-wide p5/p95 scale, clipping and protobuf
//! encoding — is a single statement: this endpoint is the hot path (NFR-P-PERF: p95 < 300 ms at
//! 30k plants), so nothing is computed per feature in Rust.
//!
//! Reads tables owned by other Phase-P agents: `plants` (0070), `captures` (0080),
//! `plant_observations` (0090) and `alerts.plant_id` (0100).
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::modules::parcels::assert_owned;
use crate::security::{self, AuthUser};
use crate::state::AppState;

/// Every `PlantMetric` (docs/API-PLANT.md §Types). Kept local: the plant metrics are a superset of
/// `arvo_core::indices::INDEX_NAMES` (they add `canopy_m2`/`height_m`).
const PLANT_METRICS: [&str; 7] = [
    "ndvi",
    "ndre",
    "gndvi",
    "ndmi",
    "savi",
    "canopy_m2",
    "height_m",
];

/// Zoom window served as vectors. Below `Z_MIN` the app draws the parcel polygon instead — a whole
/// parcel in one tile is unreadable and expensive: at z10 a 30k-plant parcel encodes the full 12k
/// cap into ~1.2 MB, the one case that misses NFR-P-PERF. From z14 up the same parcel is 55–65 ms.
const Z_MIN: u32 = 10;
const Z_MAX: u32 = 22;
/// Per-tile feature cap. `ORDER BY p.id` makes the cut an unbiased sample (v4 UUIDs are random),
/// and the response carries `X-Arvo-Truncated: 1` when it bites.
const MAX_FEATURES: i64 = 12_000;

const MVT_CONTENT_TYPE: &str = "application/vnd.mapbox-vector-tile";
/// Private (the payload is org data) and short: a new capture changes every tile of the parcel.
const CACHE_CONTROL: &str = "private, max-age=60";

pub fn router() -> Router<AppState> {
    Router::new()
        // matchit 0.8 has no dynamic suffixes: `{y}` carries the `.mvt` extension (same trick as
        // modules/tiles.rs for `.png`). The imagery build's `/tiles/{parcel_id}/{index}/…` is a
        // sibling, not a conflict — matchit backtracks past the static `plants` segment.
        .route("/tiles/plants/{parcel_id}/{z}/{x}/{y}", get(tile))
        .route("/parcels/{id}/plants/metric-scale", get(metric_scale))
        .route("/diagnostics/plant-map", post(plant_map_diagnostic))
}

#[derive(Deserialize)]
struct TileQuery {
    token: Option<String>,
    metric: Option<String>,
    capture: Option<String>,
    /// Short client-generated correlation id. It contains no credentials and is logged only
    /// after authentication, so a TestFlight WebView trace can be joined to the exact MVT calls.
    diagnostic_id: Option<String>,
}

#[derive(Deserialize)]
struct ScaleQuery {
    metric: Option<String>,
    capture: Option<String>,
}

// --- capture resolution ----------------------------------------------------

/// The `cap` CTE, spliced verbatim into both statements below so the tiles and their legend can
/// never resolve different captures. Its predicate is the one docs/API-PLANT.md §"Plant insights"
/// freezes for `latest` — the parcel's newest capture with `status='extracted'` holding ≥ 1
/// observation for the requested metric — and is byte-for-byte the rule
/// `plant_insights.rs::resolve_capture` and `plants.rs::resolve_capture` apply, so the map and the
/// ranking/outliers/replant/export lists always read the same flight.
///
/// `c.status = 'extracted'` is load-bearing: "has observations" does **not** imply "extracted".
/// `POST /captures/{id}/process` and `/retry` rewind `captures.status` to the stage's input status
/// while the previous run's `plant_observations` rows are still in place (and a worker crash
/// between the extract commit and `finish_ok` leaves the same state) — without the filter the map
/// would colour every plant from a capture the lists correctly ignore.
///
/// Binds: `$1` parcel, `$2` org, `$3` metric, `$4` explicit capture id (NULL → `latest`).
/// A macro rather than a `const`, because `concat!` splices only literals.
macro_rules! cap_cte {
    () => {
        r#"cap AS (
    SELECT c.id
    FROM captures c
    WHERE c.parcel_id = $1 AND c.org_id = $2 AND c.status = 'extracted'
      AND ($4::uuid IS NULL OR c.id = $4::uuid)
      AND EXISTS (
          SELECT 1 FROM plant_observations po
          WHERE po.capture_id = c.id AND po.parcel_id = $1 AND po.metric = $3
      )
    ORDER BY c.captured_at DESC
    LIMIT 1
)"#
    };
}

// --- tile ------------------------------------------------------------------

/// One PostGIS round trip per tile. The CTEs, in order:
///   `cap`   — resolve `capture=latest|<uuid>` (shared `cap_cte!`, above).
///   `obs`   — that capture's value per plant, parcel-wide (referenced twice → PG materializes it,
///             so the scale and the features share one scan).
///   `scale` — `p5`/`p95` over **alive** plants only, parcel-wide, so `norm` — and therefore the
///             colour of a plant — is identical in every tile it appears in.
///   `feat`  — the tile's non-`removed` plants (missing/dead are drawn too: the replant view needs
///             them) clipped into MVT space.
///   `tile`  — the protobuf plus the drawn-feature count (204 vs 200).
/// `candidates` is counted before the NULL-geometry filter so truncation reflects the cap, not
/// clipping. NULL attributes are omitted by `ST_AsMVT`, which is exactly the contract's
/// "omitted when null" for `label`/`value`/`norm`.
const TILE_SQL: &str = concat!(
    "WITH ",
    cap_cte!(),
    r#",
obs AS (
    SELECT DISTINCT ON (po.plant_id) po.plant_id, po.value
    FROM plant_observations po
    WHERE po.org_id = $2 AND po.parcel_id = $1 AND po.metric = $3
      AND po.capture_id = (SELECT id FROM cap)
    ORDER BY po.plant_id, po.observed_at DESC
),
scale AS (
    SELECT percentile_cont(0.05) WITHIN GROUP (ORDER BY o.value) AS p5,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY o.value) AS p95
    FROM obs o
    JOIN plants ap ON ap.id = o.plant_id
    WHERE ap.parcel_id = $1 AND ap.org_id = $2 AND ap.status = 'alive'
),
open_alerts AS (
    SELECT DISTINCT a.plant_id
    FROM alerts a
    WHERE a.org_id = $2 AND a.state = 'open' AND a.plant_id IS NOT NULL
),
feat AS (
    SELECT p.id::text AS id,
           p.label,
           p.status::text AS status,
           o.value,
           CASE
               WHEN o.value IS NULL THEN NULL
               WHEN s.p5 IS NULL OR s.p95 IS NULL OR s.p95 <= s.p5 THEN 0.5::double precision
               ELSE greatest(0.0::double precision,
                             least(1.0::double precision, (o.value - s.p5) / (s.p95 - s.p5)))
           END AS norm,
           (oa.plant_id IS NOT NULL) AS alert,
           ST_AsMVTGeom(ST_Transform(p.geom, 3857),
                        ST_TileEnvelope($5, $6, $7), 4096, 64, true) AS geom
    FROM plants p
    CROSS JOIN scale s
    LEFT JOIN obs o ON o.plant_id = p.id
    LEFT JOIN open_alerts oa ON oa.plant_id = p.id
    WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status <> 'removed'
      AND p.geom && ST_Transform(ST_TileEnvelope($5, $6, $7, margin => 0.015625), 4326)
    ORDER BY p.id
    LIMIT $8
),
tile AS (
    SELECT ST_AsMVT(t, 'plants', 4096, 'geom') AS mvt, count(*) AS drawn
    FROM (SELECT * FROM feat WHERE geom IS NOT NULL) t
)
SELECT tile.mvt, tile.drawn, (SELECT count(*) FROM feat) AS candidates
FROM tile
"#
);

#[derive(sqlx::FromRow)]
struct TileRow {
    mvt: Option<Vec<u8>>,
    drawn: i64,
    candidates: i64,
}

/// `GET /tiles/plants/{parcel_id}/{z}/{x}/{y}.mvt` — the `{y}` param carries the extension.
async fn tile(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Path((parcel_id, z, x, y_ext)): Path<(Uuid, u32, u32, String)>,
    Query(q): Query<TileQuery>,
) -> ApiResult<Response> {
    // Bearer header OR a short-lived media token in `?token=`; a session JWT in the query string
    // is rejected (401) so long-lived credentials never ride in access logs or referrers.
    let user = security::authenticate_bearer_or_media(&state, &headers, q.token.as_deref()).await?;
    let diagnostic_id = normalize_diagnostic_id(q.diagnostic_id.as_deref())?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let capture = parse_capture(q.capture.as_deref())?;

    if !(Z_MIN..=Z_MAX).contains(&z) {
        return Err(ApiError::BadRequest(format!(
            "zoom out of range ({Z_MIN}..={Z_MAX})"
        )));
    }
    let y = strip_ext(&y_ext, ".mvt")
        .parse::<u32>()
        .map_err(|_| ApiError::BadRequest("invalid tile y".into()))?;

    // Org scoping goes through the parcel; cross-tenant is indistinguishable from missing.
    assert_owned(&state.pool, user.org_id, parcel_id).await?;

    // Coordinates outside the zoom's grid address no ground: an empty tile, never an error.
    let n = 1u32 << z;
    if x >= n || y >= n {
        log_tile_diagnostic(
            diagnostic_id,
            &user,
            parcel_id,
            metric,
            capture,
            z,
            x,
            y,
            0,
            0,
            0,
            "outside_grid",
        );
        return Ok(empty_tile());
    }

    let row = sqlx::query_as::<_, TileRow>(TILE_SQL)
        .bind(parcel_id)
        .bind(user.org_id)
        .bind(metric)
        .bind(capture)
        .bind(z as i32)
        .bind(x as i32)
        .bind(y as i32)
        .bind(MAX_FEATURES)
        .fetch_one(&state.pool)
        .await?;

    let bytes = row.mvt.as_ref().map_or(0, Vec::len);
    let outcome = if row.drawn > 0 { "tile" } else { "empty" };
    log_tile_diagnostic(
        diagnostic_id,
        &user,
        parcel_id,
        metric,
        capture,
        z,
        x,
        y,
        row.candidates,
        row.drawn,
        bytes,
        outcome,
    );

    let Some(mvt) = row.mvt.filter(|_| row.drawn > 0) else {
        return Ok(empty_tile());
    };

    let mut res = (
        [
            (header::CONTENT_TYPE, MVT_CONTENT_TYPE),
            (header::CACHE_CONTROL, CACHE_CONTROL),
        ],
        mvt,
    )
        .into_response();
    if row.candidates >= MAX_FEATURES {
        res.headers_mut().insert(
            HeaderName::from_static("x-arvo-truncated"),
            HeaderValue::from_static("1"),
        );
    }
    Ok(res)
}

#[allow(clippy::too_many_arguments)]
fn log_tile_diagnostic(
    diagnostic_id: Option<&str>,
    user: &AuthUser,
    parcel_id: Uuid,
    metric: &str,
    capture: Option<Uuid>,
    z: u32,
    x: u32,
    y: u32,
    candidates: i64,
    drawn: i64,
    bytes: usize,
    outcome: &str,
) {
    let Some(diagnostic_id) = diagnostic_id else {
        return;
    };
    tracing::info!(
        target: "plant_map_diagnostic",
        %diagnostic_id,
        org_id = %user.org_id,
        user_id = %user.user_id,
        %parcel_id,
        %metric,
        capture_id = ?capture,
        z,
        x,
        y,
        candidates,
        drawn,
        bytes,
        %outcome,
        "plant map tile"
    );
}

/// 204, not 404: MapLibre reads an empty tile as "nothing here", a 404 as a broken source.
fn empty_tile() -> Response {
    (
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, CACHE_CONTROL)],
    )
        .into_response()
}

// --- TestFlight diagnostics ------------------------------------------------

/// A deliberately narrow diagnostic schema. Arbitrary JSON and URLs are not accepted: this keeps
/// media tokens and user-authored content out of server logs while retaining everything needed to
/// separate a request, decode, source-layer, paint, camera, or WebView failure.
#[derive(Deserialize)]
struct PlantMapDiagnostic {
    diagnostic_id: String,
    parcel_id: Uuid,
    metric: String,
    platform: Option<String>,
    os_version: Option<String>,
    device_model: Option<String>,
    app_version: Option<String>,
    build_number: Option<String>,
    event: PlantMapDiagnosticEvent,
}

#[derive(Deserialize)]
struct PlantMapDiagnosticEvent {
    name: String,
    elapsed_ms: Option<u64>,
    state: Option<String>,
    zoom: Option<f64>,
    source_loaded: Option<bool>,
    source_features: Option<u32>,
    rendered_features: Option<u32>,
    heat_features: Option<u32>,
    tile_requests: Option<u32>,
    tile_events: Option<u32>,
    tile: Option<String>,
    source_data_type: Option<String>,
    source_id: Option<String>,
    circle_layer: Option<bool>,
    heat_layer: Option<bool>,
    canvas_width: Option<u32>,
    canvas_height: Option<u32>,
    origin: Option<String>,
    error_name: Option<String>,
    error_message: Option<String>,
    http_status: Option<u16>,
}

const DIAGNOSTIC_EVENTS: [&str; 13] = [
    "webview-load-start",
    "webview-load-end",
    "webview-error",
    "webview-http-error",
    "webview-process-terminated",
    "library-timeout",
    "init-received",
    "map-load",
    "source-added",
    "tile-request",
    "source-data",
    "source-error",
    "source-snapshot",
];

async fn plant_map_diagnostic(
    State(state): State<AppState>,
    user: AuthUser,
    Json(report): Json<PlantMapDiagnostic>,
) -> ApiResult<StatusCode> {
    assert_owned(&state.pool, user.org_id, report.parcel_id).await?;
    let diagnostic_id = normalize_diagnostic_id(Some(&report.diagnostic_id))?
        .ok_or_else(|| ApiError::BadRequest("diagnostic id is required".into()))?;
    let metric = normalize_metric(Some(&report.metric))?;
    if !DIAGNOSTIC_EVENTS.contains(&report.event.name.as_str()) {
        return Err(ApiError::BadRequest("unknown diagnostic event".into()));
    }
    if report.event.zoom.is_some_and(|zoom| !zoom.is_finite()) {
        return Err(ApiError::BadRequest("invalid diagnostic zoom".into()));
    }

    let platform = diagnostic_label(report.platform.as_deref(), 32);
    let os_version = diagnostic_label(report.os_version.as_deref(), 64);
    let device_model = diagnostic_label(report.device_model.as_deref(), 80);
    let app_version = diagnostic_label(report.app_version.as_deref(), 32);
    let build_number = diagnostic_label(report.build_number.as_deref(), 32);
    let event_state = diagnostic_label(report.event.state.as_deref(), 32);
    let tile = diagnostic_label(report.event.tile.as_deref(), 64);
    let source_data_type = diagnostic_label(report.event.source_data_type.as_deref(), 32);
    let source_id = diagnostic_label(report.event.source_id.as_deref(), 32);
    let origin = diagnostic_label(report.event.origin.as_deref(), 160);
    let error_name = diagnostic_label(report.event.error_name.as_deref(), 80);
    let error_message = redact_diagnostic_message(report.event.error_message.as_deref());

    tracing::info!(
        target: "plant_map_diagnostic",
        %diagnostic_id,
        org_id = %user.org_id,
        user_id = %user.user_id,
        parcel_id = %report.parcel_id,
        %metric,
        event = %report.event.name,
        state = ?event_state,
        elapsed_ms = ?report.event.elapsed_ms,
        zoom = ?report.event.zoom,
        source_loaded = ?report.event.source_loaded,
        source_features = ?report.event.source_features,
        rendered_features = ?report.event.rendered_features,
        heat_features = ?report.event.heat_features,
        tile_requests = ?report.event.tile_requests,
        tile_events = ?report.event.tile_events,
        tile = ?tile,
        source_data_type = ?source_data_type,
        source_id = ?source_id,
        circle_layer = ?report.event.circle_layer,
        heat_layer = ?report.event.heat_layer,
        canvas_width = ?report.event.canvas_width,
        canvas_height = ?report.event.canvas_height,
        origin = ?origin,
        error_name = ?error_name,
        error_message = ?error_message,
        http_status = ?report.event.http_status,
        platform = ?platform,
        os_version = ?os_version,
        device_model = ?device_model,
        app_version = ?app_version,
        build_number = ?build_number,
        "plant map client"
    );

    Ok(StatusCode::NO_CONTENT)
}

fn normalize_diagnostic_id(value: Option<&str>) -> ApiResult<Option<&str>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::BadRequest("invalid diagnostic id".into()));
    }
    Ok(Some(value))
}

fn diagnostic_label(value: Option<&str>, max_len: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.chars().take(max_len).collect())
}

fn redact_diagnostic_message(value: Option<&str>) -> Option<String> {
    let mut value = diagnostic_label(value, 512)?;
    // MapLibre fetch errors can contain the full tile URL. Preserve the useful status/message but
    // remove the short-lived media credential before it reaches tracing output.
    for marker in ["token=", "authorization="] {
        if let Some(start) = value.to_ascii_lowercase().find(marker) {
            let value_start = start + marker.len();
            let value_end = value[value_start..]
                .find(|c: char| c == '&' || c == '#' || c.is_whitespace())
                .map_or(value.len(), |offset| value_start + offset);
            value.replace_range(value_start..value_end, "[redacted]");
        }
    }
    Some(value)
}

// --- metric scale ----------------------------------------------------------

/// Same `cap`/`obs` resolution as the tile, so the legend and the tiles can never disagree.
/// Every statistic is over **alive** plants — `p5`/`p95` because the contract says so, the rest
/// so the legend describes the distribution it is colouring.
const SCALE_SQL: &str = concat!(
    "WITH ",
    cap_cte!(),
    r#",
obs AS (
    SELECT DISTINCT ON (po.plant_id) po.plant_id, po.value, po.observed_at
    FROM plant_observations po
    WHERE po.org_id = $2 AND po.parcel_id = $1 AND po.metric = $3
      AND po.capture_id = (SELECT id FROM cap)
    ORDER BY po.plant_id, po.observed_at DESC
)
SELECT (SELECT id FROM cap) AS capture_id,
       max(o.observed_at) AS observed_at,
       percentile_cont(0.05) WITHIN GROUP (ORDER BY o.value) AS p5,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY o.value) AS p95,
       min(o.value) AS v_min,
       max(o.value) AS v_max,
       avg(o.value) AS v_mean,
       count(*) AS plant_count
FROM obs o
JOIN plants p ON p.id = o.plant_id
WHERE p.parcel_id = $1 AND p.org_id = $2 AND p.status = 'alive'
"#
);

#[derive(sqlx::FromRow)]
struct ScaleRow {
    capture_id: Option<Uuid>,
    observed_at: Option<DateTime<Utc>>,
    p5: Option<f64>,
    p95: Option<f64>,
    v_min: Option<f64>,
    v_max: Option<f64>,
    v_mean: Option<f64>,
    plant_count: i64,
}

/// `GET /parcels/{id}/plants/metric-scale?metric=&capture=` → `MetricScale`.
/// No capture yet → 200 with nulls (a blank map still needs a legend), never a 404.
async fn metric_scale(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<ScaleQuery>,
) -> ApiResult<Json<Value>> {
    assert_owned(&state.pool, user.org_id, id).await?;
    let metric = normalize_metric(q.metric.as_deref())?;
    let capture = parse_capture(q.capture.as_deref())?;

    let row = sqlx::query_as::<_, ScaleRow>(SCALE_SQL)
        .bind(id)
        .bind(user.org_id)
        .bind(metric)
        .bind(capture)
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(json!({
        "parcel_id": id,
        "metric": metric,
        "capture_id": row.capture_id,
        "observed_at": row.observed_at,
        "p5": row.p5,
        "p95": row.p95,
        "min": row.v_min,
        "max": row.v_max,
        "mean": row.v_mean,
        "plant_count": row.plant_count,
    })))
}

// --- helpers ---------------------------------------------------------------

/// Validate/normalize the `metric` param; default `ndvi`. Returns a `'static` str so it can be
/// bound straight into SQL without allocating (and never as caller-controlled text).
fn normalize_metric(metric: Option<&str>) -> ApiResult<&'static str> {
    match metric.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok("ndvi"),
        Some(v) => PLANT_METRICS
            .into_iter()
            .find(|m| m.eq_ignore_ascii_case(v))
            .ok_or_else(|| ApiError::BadRequest(format!("unknown metric: {v}"))),
    }
}

/// `capture`: absent/empty/`latest` → None (resolve server-side), otherwise a UUID. Garbage is a
/// 400 — falling back to "latest" would silently colour the map from the wrong flight.
fn parse_capture(capture: Option<&str>) -> ApiResult<Option<Uuid>> {
    match capture.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(v) if v.eq_ignore_ascii_case("latest") => Ok(None),
        Some(v) => Uuid::parse_str(v)
            .map(Some)
            .map_err(|_| ApiError::BadRequest("invalid capture id".into())),
    }
}

/// Strip a known extension (case-insensitive) if present; the extension is optional. The
/// char-boundary check matters: the segment is caller-controlled and byte-slicing inside a
/// multibyte char would panic.
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
    fn strips_optional_mvt_extension() {
        assert_eq!(strip_ext("4821.mvt", ".mvt"), "4821");
        assert_eq!(strip_ext("4821.MVT", ".mvt"), "4821");
        assert_eq!(strip_ext("4821", ".mvt"), "4821");
        // Multibyte tail: must not panic on a non-char-boundary slice.
        assert_eq!(strip_ext("4€21", ".mvt"), "4€21");
        assert_eq!(strip_ext("€", ".mvt"), "€");
    }

    #[test]
    fn normalizes_metric_case_insensitively() {
        assert_eq!(normalize_metric(None).unwrap(), "ndvi");
        assert_eq!(normalize_metric(Some(" ")).unwrap(), "ndvi");
        assert_eq!(normalize_metric(Some("NDRE")).unwrap(), "ndre");
        assert_eq!(normalize_metric(Some(" canopy_m2 ")).unwrap(), "canopy_m2");
        assert_eq!(normalize_metric(Some("height_m")).unwrap(), "height_m");
        assert!(normalize_metric(Some("ndvi; DROP")).is_err());
        assert!(normalize_metric(Some("bogus")).is_err());
    }

    #[test]
    fn parses_capture_selector() {
        assert!(parse_capture(None).unwrap().is_none());
        assert!(parse_capture(Some("latest")).unwrap().is_none());
        assert!(parse_capture(Some("")).unwrap().is_none());
        let id = Uuid::new_v4();
        assert_eq!(parse_capture(Some(&id.to_string())).unwrap(), Some(id));
        assert!(parse_capture(Some("not-a-uuid")).is_err());
    }

    #[test]
    fn validates_diagnostic_ids() {
        assert_eq!(normalize_diagnostic_id(None).unwrap(), None);
        assert_eq!(
            normalize_diagnostic_id(Some("pm-abc_123")).unwrap(),
            Some("pm-abc_123")
        );
        assert!(normalize_diagnostic_id(Some("contains spaces")).is_err());
        assert!(normalize_diagnostic_id(Some("token=secret")).is_err());
        assert!(normalize_diagnostic_id(Some(&"x".repeat(65))).is_err());
    }

    #[test]
    fn redacts_credentials_from_diagnostic_messages() {
        assert_eq!(
            redact_diagnostic_message(Some(
                "fetch https://api.test/tile?metric=ndvi&token=secret-value&capture=latest"
            )),
            Some("fetch https://api.test/tile?metric=ndvi&token=[redacted]&capture=latest".into())
        );
    }

    /// The clip buffer in `ST_TileEnvelope(margin => …)` is a fraction of the tile width, and
    /// must equal the `ST_AsMVTGeom` buffer over the extent — otherwise features are fetched
    /// and then clipped away (or worse, popped in at tile edges).
    /// `latest` must resolve to the newest **extracted** capture in both statements, exactly as
    /// `plant_insights.rs`/`plants.rs` do: a re-processed capture keeps the previous run's
    /// observations while its status is rewound, and without the filter the map would paint a
    /// capture the ranking/outliers/replant/export lists ignore.
    #[test]
    fn both_statements_share_the_extracted_capture_cte() {
        assert!(cap_cte!().contains("c.status = 'extracted'"));
        assert!(TILE_SQL.contains(cap_cte!()));
        assert!(SCALE_SQL.contains(cap_cte!()));
    }

    #[test]
    fn tile_margin_matches_the_mvt_buffer() {
        assert!(TILE_SQL.contains("ST_TileEnvelope($5, $6, $7, margin => 0.015625)"));
        assert!(TILE_SQL.contains("ST_TileEnvelope($5, $6, $7), 4096, 64, true"));
        assert_eq!(64.0 / 4096.0, 0.015625);
    }
}
