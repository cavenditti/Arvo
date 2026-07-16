//! OWNER: be-auth — org membership per docs/API.md §Auth.
//! POST /orgs/invites [admin+] · GET /orgs/members. Accepting an invite lives in auth.rs.
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/orgs/invites", post(create_invite))
        .route("/orgs/members", get(list_members))
}

#[derive(Deserialize)]
struct CreateInviteReq {
    email: String,
    role: Role,
}

#[derive(Serialize, sqlx::FromRow)]
struct Invite {
    id: Uuid,
    token: String,
    email: String,
    role: Role,
    expires_at: DateTime<Utc>,
}

async fn create_invite(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<CreateInviteReq>,
) -> ApiResult<impl IntoResponse> {
    user.require(Role::Admin)?;
    // Can't grant a role above your own.
    if req.role > user.role {
        return Err(ApiError::Forbidden);
    }
    let email = req.email.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::BadRequest("valid email required".into()));
    }

    let token = invite_token();
    let expires_at = Utc::now() + Duration::days(7);
    let invite = sqlx::query_as::<_, Invite>(
        "INSERT INTO invites (org_id, email, role, token, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, token, email, role, expires_at",
    )
    .bind(user.org_id)
    .bind(&email)
    .bind(req.role)
    .bind(&token)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "org.invite",
        "invite",
        invite.id,
        json!({ "email": email, "role": req.role }),
    )
    .await;
    Ok((StatusCode::CREATED, Json(invite)))
}

#[derive(Serialize, sqlx::FromRow)]
struct Member {
    user_id: Uuid,
    email: String,
    full_name: String,
    role: Role,
}

async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<Member>>> {
    let members = sqlx::query_as::<_, Member>(
        "SELECT u.id AS user_id, u.email, u.full_name, m.role
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 ORDER BY m.created_at",
    )
    .bind(user.org_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(members))
}

fn invite_token() -> String {
    use rand::Rng;
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}
