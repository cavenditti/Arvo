//! Read-only organization membership projection. Better Auth owns organization mutations,
//! invitations, and role changes; migration triggers keep these domain tables queryable here.
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::security::{AuthUser, Role};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/orgs/members", get(list_members))
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
