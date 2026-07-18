//! OWNER: be-alerts — alert lifecycle per docs/API.md §Alerts.
//! GET list (with elapsed-snooze auto-reopen), ack/dismiss/snooze/assign, and the
//! on-demand detector trigger. Every mutation is org-scoped and audited.
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
use crate::{audit, jobs};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/alerts", get(list_alerts))
        .route("/alerts/detect", post(detect))
        .route("/alerts/{id}/ack", post(ack))
        .route("/alerts/{id}/dismiss", post(dismiss))
        .route("/alerts/{id}/snooze", post(snooze))
        .route("/alerts/{id}/assign", post(assign))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct Alert {
    id: Uuid,
    parcel_id: Option<Uuid>,
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

/// Columns for every Alert response. `state` is cast to text so it maps to `String`.
const ALERT_COLS: &str = "id, parcel_id, kind, severity, title, message, data, \
    state::text AS state, snoozed_until, assigned_to, created_at, updated_at";

#[derive(Debug, Deserialize)]
struct ListQuery {
    state: Option<String>,
    parcel_id: Option<Uuid>,
    limit: Option<i64>,
}

/// GET /alerts — desc by created_at. Snoozed rows whose `snoozed_until` has elapsed are
/// flipped back to `open` before the read, so they resurface as open.
async fn list_alerts(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Alert>>> {
    // Auto-reopen elapsed snoozes (org-scoped, idempotent).
    sqlx::query(
        "UPDATE alerts SET state = 'open', snoozed_until = NULL, updated_at = now()
         WHERE org_id = $1 AND state = 'snoozed'
           AND snoozed_until IS NOT NULL AND snoozed_until <= now()",
    )
    .bind(user.org_id)
    .execute(&state.pool)
    .await?;

    // Bounded: alert history grows daily per parcel; dashboards poll this endpoint.
    let limit = q.limit.unwrap_or(200).clamp(1, 500);
    let sql = format!(
        "SELECT {ALERT_COLS} FROM alerts
         WHERE org_id = $1
           AND ($2::text IS NULL OR state::text = $2)
           AND ($3::uuid IS NULL OR parcel_id = $3)
         ORDER BY created_at DESC
         LIMIT $4"
    );
    let alerts: Vec<Alert> = sqlx::query_as(&sql)
        .bind(user.org_id)
        .bind(&q.state)
        .bind(q.parcel_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(alerts))
}

async fn ack(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Alert>> {
    transition(&state, &user, id, "acked", None, "alert.ack").await
}

async fn dismiss(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Alert>> {
    transition(&state, &user, id, "dismissed", None, "alert.dismiss").await
}

#[derive(Debug, Deserialize)]
struct SnoozeReq {
    until: DateTime<Utc>,
}

async fn snooze(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<SnoozeReq>,
) -> ApiResult<Json<Alert>> {
    if req.until <= Utc::now() {
        return Err(ApiError::BadRequest(
            "snooze `until` must be in the future".into(),
        ));
    }
    transition(
        &state,
        &user,
        id,
        "snoozed",
        Some(req.until),
        "alert.snooze",
    )
    .await
}

#[derive(Debug, Deserialize)]
struct AssignReq {
    user_id: Uuid,
}

async fn assign(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(req): Json<AssignReq>,
) -> ApiResult<Json<Alert>> {
    user.require(Role::Operator)?;

    // Assignee must be a member of the caller's org (tenancy guard).
    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2)",
    )
    .bind(user.org_id)
    .bind(req.user_id)
    .fetch_one(&state.pool)
    .await?;
    if !is_member {
        return Err(ApiError::BadRequest(
            "assignee is not a member of this org".into(),
        ));
    }

    let sql = format!(
        "UPDATE alerts SET assigned_to = $3, updated_at = now()
         WHERE id = $1 AND org_id = $2 RETURNING {ALERT_COLS}"
    );
    let alert: Alert = sqlx::query_as(&sql)
        .bind(id)
        .bind(user.org_id)
        .bind(req.user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::NotFound)?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "alert.assign",
        "alert",
        id,
        json!({ "assigned_to": req.user_id }),
    )
    .await;
    Ok(Json(alert))
}

/// Shared state transition for ack/dismiss/snooze. Sets `state` (and `snoozed_until`),
/// clearing the snooze on non-snooze transitions. 404 when the alert is not in the org.
async fn transition(
    state: &AppState,
    user: &AuthUser,
    id: Uuid,
    new_state: &str,
    snoozed_until: Option<DateTime<Utc>>,
    action: &str,
) -> ApiResult<Json<Alert>> {
    user.require(Role::Operator)?;

    let sql = format!(
        "UPDATE alerts SET state = $3::alert_state, snoozed_until = $4, updated_at = now()
         WHERE id = $1 AND org_id = $2 RETURNING {ALERT_COLS}"
    );
    let alert: Alert = sqlx::query_as(&sql)
        .bind(id)
        .bind(user.org_id)
        .bind(new_state)
        .bind(snoozed_until)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(ApiError::NotFound)?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        action,
        "alert",
        id,
        json!({ "state": new_state, "snoozed_until": snoozed_until }),
    )
    .await;
    Ok(Json(alert))
}

/// POST /alerts/detect [agronomist+] — run the detector across the org now.
async fn detect(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<Value>> {
    user.require(Role::Agronomist)?;
    let created = jobs::detect_for_org(&state, user.org_id).await?;
    Ok(Json(json!({ "created": created })))
}
