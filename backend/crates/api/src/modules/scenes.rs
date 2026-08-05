//! Satellite scene catalog endpoints (docs/API.md §Imagery — scenes):
//! POST /parcels/{id}/imagery/refresh, GET /parcels/{id}/scenes.
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;
use crate::{audit, imagery};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/imagery/status", get(imagery_status))
        .route("/parcels/{id}/imagery/refresh", post(refresh))
        .route("/parcels/{id}/satellite-analysis", get(satellite_analysis))
        .route("/parcels/{id}/scenes", get(list_scenes))
}

#[derive(Deserialize, Default)]
struct RefreshBody {
    days: Option<i64>,
    #[serde(default)]
    background: bool,
}

/// POST /parcels/{id}/imagery/refresh — search STAC, upsert scenes, (feature) compute indices.
async fn refresh(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Option<Json<RefreshBody>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    // Parcel must belong to the caller's org (cross-tenant → 404). Also yields the geometry.
    let geometry: String = sqlx::query_scalar(
        "SELECT ST_AsGeoJSON(geom)::text FROM parcels
         WHERE id = $1 AND org_id = $2 AND archived = false",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(ApiError::NotFound)?;

    // Clamp: chrono::Duration::days panics far out of range, huge windows are pointless
    // (STAC pagination caps out anyway), and negative values are meaningless.
    let body = body.map(|body| body.0).unwrap_or_default();
    let days = body
        .days
        .unwrap_or(imagery::DEFAULT_REFRESH_DAYS)
        .clamp(1, 366);
    imagery::queue_refresh(&state.pool, id).await?;
    if body.background {
        let org_id = user.org_id;
        let user_id = user.user_id;
        tokio::spawn(async move {
            if let Err(error) = imagery::mark_refresh_running(&state.pool, id).await {
                tracing::warn!(parcel = %id, error = ?error, "could not mark imagery refresh running");
                return;
            }
            match imagery::refresh_scenes(&state, id, &geometry, days).await {
                Ok(outcome) => {
                    let refresh_state = match imagery::complete_refresh(&state.pool, id, &outcome)
                        .await
                    {
                        Ok(refresh_state) => refresh_state,
                        Err(error) => {
                            tracing::warn!(parcel = %id, error = ?error, "could not persist imagery refresh completion");
                            "ready"
                        }
                    };
                    audit::record(
                        &state.pool,
                        org_id,
                        Some(user_id),
                        "imagery.refresh",
                        "parcel",
                        id,
                        json!({
                            "found": outcome.found,
                            "new": outcome.new,
                            "computed": outcome.computed,
                            "background": true,
                            "state": refresh_state,
                        }),
                    )
                    .await;
                    tracing::info!(
                        parcel = %id,
                        found = outcome.found,
                        new = outcome.new,
                        computed = outcome.computed,
                        "background imagery refresh complete"
                    );
                }
                Err(error) => {
                    if let Err(status_error) =
                        imagery::fail_refresh(&state.pool, id, "provider_or_compute_failed").await
                    {
                        tracing::warn!(parcel = %id, error = ?status_error, "could not persist imagery refresh failure");
                    }
                    tracing::warn!(
                        parcel = %id,
                        error = ?error,
                        "background imagery refresh failed"
                    );
                }
            }
        });
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({
                "started": true,
                "scenes_found": 0,
                "scenes_new": 0,
                "computed": 0,
            })),
        ));
    }
    imagery::mark_refresh_running(&state.pool, id).await?;
    let outcome = match imagery::refresh_scenes(&state, id, &geometry, days).await {
        Ok(outcome) => outcome,
        Err(e) => {
            let _ = imagery::fail_refresh(&state.pool, id, "provider_or_compute_failed").await;
            // Upstream/STAC failure details stay in the logs; clients get a stable message.
            tracing::warn!(parcel = %id, error = ?e, "scene refresh failed");
            return Err(ApiError::Internal(anyhow::anyhow!(
                "scene refresh failed (upstream imagery service)"
            )));
        }
    };
    let refresh_state = imagery::complete_refresh(&state.pool, id, &outcome).await?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "imagery.refresh",
        "parcel",
        id,
        json!({
            "found": outcome.found,
            "new": outcome.new,
            "computed": outcome.computed,
            "state": refresh_state,
        }),
    )
    .await;

    Ok((
        StatusCode::OK,
        Json(json!({
            "scenes_found": outcome.found,
            "scenes_new": outcome.new,
            "computed": outcome.computed,
        })),
    ))
}

#[derive(Deserialize, Default)]
struct ImageryStatusQuery {
    parcel_ids: Option<String>,
}

#[derive(sqlx::FromRow)]
struct ImageryStatusRow {
    parcel_id: Uuid,
    state: String,
    requested_at: Option<DateTime<Utc>>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    scenes_found: i32,
    scenes_new: i32,
    computed: i32,
    error_code: Option<String>,
    updated_at: Option<DateTime<Utc>>,
}

/// GET /imagery/status?parcel_ids=... — explicit, persisted lifecycle for dashboard/detail UI.
/// Queued/running rows with no heartbeat for 45 minutes are process-loss failures, never an
/// excuse for an endless spinner.
async fn imagery_status(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ImageryStatusQuery>,
) -> ApiResult<Json<Value>> {
    let ids: Vec<Uuid> = q
        .parcel_ids
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .filter_map(|value| Uuid::parse_str(value.trim()).ok())
        .take(500)
        .collect();
    if ids.is_empty() {
        return Ok(Json(json!({})));
    }

    sqlx::query(
        "UPDATE parcel_imagery_refreshes r
            SET state = 'failed', finished_at = now(), error_code = 'refresh_timeout',
                updated_at = now()
          WHERE r.state IN ('queued', 'running')
            AND r.updated_at < now() - interval '45 minutes'
            AND r.parcel_id IN (
                SELECT p.id FROM parcels p
                 WHERE p.id = ANY($1) AND p.org_id = $2 AND NOT p.archived
            )",
    )
    .bind(&ids)
    .bind(user.org_id)
    .execute(&state.pool)
    .await?;

    let rows: Vec<ImageryStatusRow> = sqlx::query_as(
        "SELECT p.id AS parcel_id,
                COALESCE(r.state,
                    CASE WHEN EXISTS (
                        SELECT 1 FROM index_observations i WHERE i.parcel_id = p.id
                    ) THEN 'ready' ELSE 'failed' END) AS state,
                r.requested_at, r.started_at, r.finished_at,
                COALESCE(r.scenes_found, 0) AS scenes_found,
                COALESCE(r.scenes_new, 0) AS scenes_new,
                COALESCE(r.computed, 0) AS computed,
                COALESCE(r.error_code,
                    CASE WHEN r.parcel_id IS NULL THEN 'not_started' END) AS error_code,
                r.updated_at
           FROM parcels p
           LEFT JOIN parcel_imagery_refreshes r ON r.parcel_id = p.id
          WHERE p.id = ANY($1) AND p.org_id = $2 AND NOT p.archived",
    )
    .bind(&ids)
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;

    let mut out = serde_json::Map::new();
    for row in rows {
        out.insert(
            row.parcel_id.to_string(),
            json!({
                "state": row.state,
                "requested_at": row.requested_at,
                "started_at": row.started_at,
                "finished_at": row.finished_at,
                "scenes_found": row.scenes_found,
                "scenes_new": row.scenes_new,
                "computed": row.computed,
                "error_code": row.error_code,
                "updated_at": row.updated_at,
            }),
        );
    }
    Ok(Json(Value::Object(out)))
}

#[derive(Deserialize)]
struct ScenesQuery {
    limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
struct SceneOut {
    id: Uuid,
    stac_id: String,
    acquired_at: DateTime<Utc>,
    cloud_cover: Option<f64>,
}

/// GET /parcels/{id}/scenes — scenes whose footprint covers the parcel (scenes are shared
/// public source data; the parcel id is validated for org ownership before listing).
/// Rows ingested before footprints were stored (bbox NULL) are included until the next
/// refresh backfills them — better a briefly-wide list than a silently-empty one.
async fn list_scenes(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<ScenesQuery>,
) -> ApiResult<Json<Vec<SceneOut>>> {
    crate::modules::parcels::assert_owned(&state.pool, user.org_id, id).await?;

    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let scenes = sqlx::query_as::<_, SceneOut>(
        "SELECT s.id, s.stac_id, s.acquired_at, s.cloud_cover
         FROM scenes s
         WHERE s.bbox IS NULL
            OR ST_Intersects(s.bbox, (SELECT geom FROM parcels WHERE id = $1))
         ORDER BY s.acquired_at DESC LIMIT $2",
    )
    .bind(id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(scenes))
}

#[derive(Serialize, sqlx::FromRow)]
struct SatelliteAnalysisRow {
    crop_type: Option<String>,
    crop_confidence: Option<f64>,
    crop_scene_count: i32,
    crop_month_count: i32,
    vegetation_detected: Option<bool>,
    vegetation_cover_pct: Option<f64>,
    clear_pixel_count: Option<i32>,
    observed_at: Option<DateTime<Utc>>,
    model_version: String,
    applied_to_parcel: bool,
}

/// GET /parcels/{id}/satellite-analysis — the latest automatic Sentinel-2 interpretation.
/// A pending result is a normal 200: a new parcel may not have enough clear acquisitions yet.
async fn satellite_analysis(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    crate::modules::parcels::assert_owned(&state.pool, user.org_id, id).await?;
    let row: Option<SatelliteAnalysisRow> = sqlx::query_as(
        "SELECT a.crop_type, a.crop_confidence, a.crop_scene_count, a.crop_month_count,
                a.vegetation_detected, a.vegetation_cover_pct, a.clear_pixel_count,
                a.observed_at, a.model_version,
                COALESCE(p.crop_source = 'sentinel-2' AND p.crop = a.crop_type, false)
                    AS applied_to_parcel
           FROM parcel_satellite_analysis a
           JOIN parcels p ON p.id = a.parcel_id
          WHERE a.parcel_id = $1 AND p.org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Ok(Json(json!({
            "status": "pending",
            "resolution_m": 10,
            "individual_plants_supported": false,
        })));
    };
    Ok(Json(json!({
        "status": "ready",
        "crop": row.crop_type,
        "confidence": row.crop_confidence,
        "scene_count": row.crop_scene_count,
        "month_count": row.crop_month_count,
        "applied_to_parcel": row.applied_to_parcel,
        "vegetation": {
            "detected": row.vegetation_detected,
            "cover_pct": row.vegetation_cover_pct,
            "clear_pixels": row.clear_pixel_count,
            "observed_at": row.observed_at,
        },
        "model_version": row.model_version,
        "resolution_m": 10,
        "individual_plants_supported": false,
    })))
}
