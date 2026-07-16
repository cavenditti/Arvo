//! OWNER: be-parcels — farms CRUD per docs/API.md §Farms.
//! `router()` is the only public entry (mounted in routes.rs under /api/v1).
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/farms", get(list).post(create))
        .route("/farms/{id}", patch(update).delete(remove))
}

#[derive(sqlx::FromRow, Serialize)]
struct Farm {
    id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
    // Present only on list (LEFT JOIN count of active parcels); omitted elsewhere.
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    parcel_count: Option<i64>,
}

#[derive(Deserialize)]
struct FarmBody {
    name: String,
}

async fn list(State(st): State<AppState>, user: AuthUser) -> ApiResult<Json<Vec<Farm>>> {
    let farms = sqlx::query_as::<_, Farm>(
        "SELECT f.id, f.name, f.created_at, COUNT(p.id) AS parcel_count
         FROM farms f
         LEFT JOIN parcels p ON p.farm_id = f.id AND p.archived = false
         WHERE f.org_id = $1
         GROUP BY f.id
         ORDER BY f.created_at DESC",
    )
    .bind(user.org_id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(farms))
}

async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<FarmBody>,
) -> ApiResult<(StatusCode, Json<Farm>)> {
    user.require(Role::Operator)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let farm = sqlx::query_as::<_, Farm>(
        "INSERT INTO farms (org_id, name) VALUES ($1, $2)
         RETURNING id, name, created_at",
    )
    .bind(user.org_id)
    .bind(name)
    .fetch_one(&st.pool)
    .await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "farm.create",
        "farm",
        farm.id,
        json!({ "name": farm.name }),
    )
    .await;
    Ok((StatusCode::CREATED, Json(farm)))
}

async fn update(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<FarmBody>,
) -> ApiResult<Json<Farm>> {
    user.require(Role::Operator)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    let farm = sqlx::query_as::<_, Farm>(
        "UPDATE farms SET name = $3 WHERE id = $1 AND org_id = $2
         RETURNING id, name, created_at",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(name)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "farm.update",
        "farm",
        id,
        json!({ "name": farm.name }),
    )
    .await;
    Ok(Json(farm))
}

async fn remove(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Admin)?;
    // Hard delete (farms have no archive column); parcels cascade per schema.
    let res = sqlx::query("DELETE FROM farms WHERE id = $1 AND org_id = $2")
        .bind(id)
        .bind(user.org_id)
        .execute(&st.pool)
        .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "farm.delete",
        "farm",
        id,
        json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}
