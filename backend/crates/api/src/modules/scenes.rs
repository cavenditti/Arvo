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

    let days = body.and_then(|b| b.0.days).unwrap_or(imagery::DEFAULT_REFRESH_DAYS);
    let outcome = imagery::refresh_scenes(&state, id, &geometry, days)
        .await
        .map_err(|e| ApiError::BadRequest(format!("scene refresh failed: {e}")))?;

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

/// GET /parcels/{id}/scenes — recent scenes from the shared catalog (scenes are public source
/// data; the parcel id is validated for org ownership before listing).
async fn list_scenes(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(q): Query<ScenesQuery>,
) -> ApiResult<Json<Vec<SceneOut>>> {
    let owned: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM parcels WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(user.org_id)
            .fetch_optional(&state.pool)
            .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound);
    }

    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let scenes = sqlx::query_as::<_, SceneOut>(
        "SELECT id, stac_id, acquired_at, cloud_cover
         FROM scenes ORDER BY acquired_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(scenes))
}
