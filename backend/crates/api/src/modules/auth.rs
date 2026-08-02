//! Arvo resource-server auth helpers.
//!
//! Better Auth owns registration, login, logout, organization switching, invitations and
//! password reset under `/api/auth` on the app host. The Rust API exposes only the domain profile
//! and a short-lived media token because those require direct access to agronomic identities.

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::security::{issue_media_token, AuthUser, Role};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/me", get(me))
        .route("/auth/media-token", post(media_token))
}

#[derive(Serialize, sqlx::FromRow)]
struct User {
    id: Uuid,
    email: String,
    full_name: String,
    locale: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct Org {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
struct MeResponse {
    user: User,
    org: Org,
    role: Role,
}

async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<MeResponse>> {
    let domain_user =
        sqlx::query_as::<_, User>("SELECT id, email, full_name, locale FROM users WHERE id = $1")
            .bind(user.user_id)
            .fetch_one(&state.pool)
            .await?;
    let org = sqlx::query_as::<_, Org>("SELECT id, name FROM orgs WHERE id = $1")
        .bind(user.org_id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(MeResponse {
        user: domain_user,
        org,
        role: user.role,
    }))
}

/// Short-lived read-only token for tile/photo/download URLs that cannot set Bearer headers.
async fn media_token(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    let (token, exp) = issue_media_token(&state.cfg.jwt_secret, &user)?;
    Ok(Json(json!({
        "token": token,
        "expires_at": DateTime::from_timestamp(exp, 0).unwrap_or_else(Utc::now),
    })))
}
