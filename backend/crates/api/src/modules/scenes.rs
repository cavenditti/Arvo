//! Satellite scene catalog endpoints (docs/API.md §Imagery — scenes):
//! POST /parcels/{id}/imagery/refresh, GET /parcels/{id}/scenes.
use axum::extract::{Path, Query, State};
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
        .route("/parcels/{id}/imagery/refresh", post(refresh))
        .route("/parcels/{id}/scenes", get(list_scenes))
}

#[derive(Deserialize, Default)]
struct RefreshBody {
    days: Option<i64>,
}

/// POST /parcels/{id}/imagery/refresh — search STAC, upsert scenes, (feature) compute indices.
async fn refresh(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Option<Json<RefreshBody>>,
) -> ApiResult<Json<Value>> {
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
    let days = body
        .and_then(|b| b.0.days)
        .unwrap_or(imagery::DEFAULT_REFRESH_DAYS)
        .clamp(1, 366);
    let outcome = imagery::refresh_scenes(&state, id, &geometry, days)
        .await
        .map_err(|e| {
            // Upstream/STAC failure details stay in the logs; clients get a stable message.
            tracing::warn!(parcel = %id, error = ?e, "scene refresh failed");
            ApiError::Internal(anyhow::anyhow!(
                "scene refresh failed (upstream imagery service)"
            ))
        })?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "imagery.refresh",
        "parcel",
        id,
        json!({ "found": outcome.found, "new": outcome.new, "computed": outcome.computed }),
    )
    .await;

    Ok(Json(json!({
        "scenes_found": outcome.found,
        "scenes_new": outcome.new,
        "computed": outcome.computed,
    })))
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
