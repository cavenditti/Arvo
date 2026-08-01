//! OWNER: backend-core — Expo push device registry (UX revamp: push notifications).
//! One row per device token. Registration is an upsert by token, so a device that logs
//! into another user or org is re-bound, never duplicated. Self-service for every role
//! (viewers want pushes too). Delivery lives in `crate::modules::push`.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::AuthUser;
use crate::state::AppState;
use crate::util::require_len;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/devices", post(register))
        .route("/devices/{token}", delete(unregister))
}

#[derive(Deserialize)]
struct RegisterReq {
    platform: String,
    token: String,
}

/// POST /devices — register (or re-bind) the caller's device push token.
async fn register(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<RegisterReq>,
) -> ApiResult<StatusCode> {
    let platform = req.platform.trim().to_lowercase();
    if !matches!(platform.as_str(), "ios" | "android" | "web") {
        return Err(ApiError::BadRequest(
            "platform must be ios, android or web".into(),
        ));
    }
    let token = req.token.trim().to_string();
    if token.is_empty() {
        return Err(ApiError::BadRequest("token required".into()));
    }
    require_len("token", &token, 512)?;

    let device_id: Uuid = sqlx::query_scalar(
        "INSERT INTO devices (org_id, user_id, platform, token)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE
           SET org_id = EXCLUDED.org_id, user_id = EXCLUDED.user_id,
               platform = EXCLUDED.platform, last_seen_at = now()
         RETURNING id",
    )
    .bind(user.org_id)
    .bind(user.user_id)
    .bind(&platform)
    .bind(&token)
    .fetch_one(&state.pool)
    .await?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "device.register",
        "device",
        device_id,
        json!({ "platform": platform }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// DELETE /devices/{token} — drop a token (logout / notifications off). Idempotent and
/// org-scoped: a token held by another org is a silent no-op, not an existence oracle.
async fn unregister(
    State(state): State<AppState>,
    user: AuthUser,
    Path(token): Path<String>,
) -> ApiResult<StatusCode> {
    let deleted: Option<Uuid> =
        sqlx::query_scalar("DELETE FROM devices WHERE token = $1 AND org_id = $2 RETURNING id")
            .bind(&token)
            .bind(user.org_id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some(device_id) = deleted {
        audit::record(
            &state.pool,
            user.org_id,
            Some(user.user_id),
            "device.unregister",
            "device",
            device_id,
            json!({}),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}
