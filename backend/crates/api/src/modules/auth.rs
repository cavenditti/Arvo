//! OWNER: be-auth — authentication per docs/API.md §Auth.
//! register / login / switch-org / me / accept-invite / password-reset. Invites + members
//! live in orgs.rs.
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::OnceLock;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{issue_media_token, issue_token, sha256_hex, AuthUser, Role};
use crate::state::AppState;
use crate::util::require_len;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/switch-org", post(switch_org))
        .route("/auth/me", get(me))
        .route("/auth/accept-invite", post(accept_invite))
        .route("/auth/media-token", post(media_token))
        .route("/auth/password-reset/request", post(password_reset_request))
        .route("/auth/password-reset/confirm", post(password_reset_confirm))
}

// ---- shared shapes -------------------------------------------------------

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
struct AuthResponse {
    token: String,
    user: User,
    org: Org,
}

// ---- register ------------------------------------------------------------

#[derive(Deserialize)]
struct RegisterReq {
    email: String,
    password: String,
    #[serde(default)]
    full_name: String,
    org_name: String,
    #[serde(default)]
    locale: Option<String>,
}

async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterReq>,
) -> ApiResult<impl IntoResponse> {
    let email = normalize_email(&req.email)?;
    validate_password(&req.password)?;
    let full_name = req.full_name.trim().to_string();
    let org_name = req.org_name.trim().to_string();
    if org_name.is_empty() {
        return Err(ApiError::BadRequest("org_name required".into()));
    }
    require_len("full_name", &full_name, 200)?;
    require_len("org_name", &org_name, 200)?;
    let locale = req
        .locale
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "it".into());
    require_len("locale", &locale, 16)?;
    let hash = hash_password_blocking(req.password).await?;

    let mut tx = state.pool.begin().await?;
    let org = sqlx::query_as::<_, Org>("INSERT INTO orgs (name) VALUES ($1) RETURNING id, name")
        .bind(&org_name)
        .fetch_one(&mut *tx)
        .await?;
    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (email, password_hash, full_name, locale)
         VALUES ($1, $2, $3, $4) RETURNING id, email, full_name, locale",
    )
    .bind(&email)
    .bind(&hash)
    .bind(&full_name)
    .bind(&locale)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| conflict_on_unique(e, "email already registered"))?;
    sqlx::query("INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, 'owner')")
        .bind(user.id)
        .bind(org.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let token = issue_token(&state.cfg.jwt_secret, user.id, org.id, Role::Owner)?;
    audit::record(
        &state.pool,
        org.id,
        Some(user.id),
        "user.register",
        "user",
        user.id,
        json!({ "email": email, "org_name": org_name }),
    )
    .await;
    Ok((StatusCode::CREATED, Json(AuthResponse { token, user, org })))
}

// ---- login ---------------------------------------------------------------

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
    #[serde(default)]
    org_id: Option<Uuid>,
}

#[derive(Serialize, sqlx::FromRow)]
struct OrgMembership {
    id: Uuid,
    name: String,
    role: Role,
}

#[derive(Serialize)]
struct LoginResponse {
    token: String,
    user: User,
    orgs: Vec<OrgMembership>,
}

#[derive(sqlx::FromRow)]
struct AuthRow {
    id: Uuid,
    email: String,
    password_hash: String,
    full_name: String,
    locale: String,
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginReq>,
) -> ApiResult<Json<LoginResponse>> {
    let email = req.email.trim().to_lowercase();
    let row = sqlx::query_as::<_, AuthRow>(
        "SELECT id, email, password_hash, full_name, locale FROM users WHERE lower(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&state.pool)
    .await?;

    // Uniform 401: on an unknown email do the same argon2 work, then fail identically,
    // so the response neither reveals existence nor leaks timing.
    let Some(row) = row else {
        let _ = verify_password_blocking(req.password, dummy_hash().to_string()).await;
        return Err(ApiError::Unauthorized);
    };
    if !verify_password_blocking(req.password, row.password_hash.clone()).await {
        return Err(ApiError::Unauthorized);
    }

    let orgs = sqlx::query_as::<_, OrgMembership>(
        "SELECT o.id, o.name, m.role FROM memberships m
         JOIN orgs o ON o.id = m.org_id
         WHERE m.user_id = $1 ORDER BY m.created_at",
    )
    .bind(row.id)
    .fetch_all(&state.pool)
    .await?;

    // Scope the token to the requested org (must be a member) or the first membership.
    let (org_id, role) = match req.org_id {
        Some(oid) => {
            let m = orgs
                .iter()
                .find(|o| o.id == oid)
                .ok_or(ApiError::NotFound)?;
            (m.id, m.role)
        }
        None => {
            let m = orgs.first().ok_or(ApiError::Unauthorized)?;
            (m.id, m.role)
        }
    };
    let token = issue_token(&state.cfg.jwt_secret, row.id, org_id, role)?;
    let user = User {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        locale: row.locale,
    };
    Ok(Json(LoginResponse { token, user, orgs }))
}

// ---- switch-org ----------------------------------------------------------

#[derive(Deserialize)]
struct SwitchOrgReq {
    org_id: Uuid,
}

#[derive(Serialize)]
struct TokenResponse {
    token: String,
}

async fn switch_org(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SwitchOrgReq>,
) -> ApiResult<Json<TokenResponse>> {
    let role: Option<Role> =
        sqlx::query_scalar("SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2")
            .bind(user.user_id)
            .bind(req.org_id)
            .fetch_optional(&state.pool)
            .await?;
    let role = role.ok_or(ApiError::NotFound)?; // not a member → 404 (do not leak existence)
    let token = issue_token(&state.cfg.jwt_secret, user.user_id, req.org_id, role)?;
    Ok(Json(TokenResponse { token }))
}

// ---- me ------------------------------------------------------------------

#[derive(Serialize)]
struct MeResponse {
    user: User,
    org: Org,
    role: Role,
}

async fn me(State(state): State<AppState>, user: AuthUser) -> ApiResult<Json<MeResponse>> {
    let u =
        sqlx::query_as::<_, User>("SELECT id, email, full_name, locale FROM users WHERE id = $1")
            .bind(user.user_id)
            .fetch_one(&state.pool)
            .await?;
    let org = sqlx::query_as::<_, Org>("SELECT id, name FROM orgs WHERE id = $1")
        .bind(user.org_id)
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(MeResponse {
        user: u,
        org,
        role: user.role,
    }))
}

// ---- accept-invite -------------------------------------------------------

#[derive(Deserialize)]
struct AcceptInviteReq {
    token: String,
    email: String,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    full_name: Option<String>,
}

#[derive(sqlx::FromRow)]
struct InviteRow {
    id: Uuid,
    org_id: Uuid,
    email: String,
    role: Role,
    expires_at: DateTime<Utc>,
    accepted_at: Option<DateTime<Utc>>,
}

async fn accept_invite(
    State(state): State<AppState>,
    Json(req): Json<AcceptInviteReq>,
) -> ApiResult<Json<AuthResponse>> {
    let email = req.email.trim().to_lowercase();
    let token = req.token.trim();
    if token.is_empty() {
        return Err(ApiError::BadRequest("invite token required".into()));
    }

    // Invites are stored hashed (orgs.rs) so a DB leak doesn't yield join-as-any-role tokens.
    let invite = sqlx::query_as::<_, InviteRow>(
        "SELECT id, org_id, email, role, expires_at, accepted_at FROM invites WHERE token = $1",
    )
    .bind(sha256_hex(token))
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::BadRequest("invalid invite token".into()))?;

    if invite.accepted_at.is_some() {
        return Err(ApiError::BadRequest("invite already accepted".into()));
    }
    if invite.expires_at < Utc::now() {
        return Err(ApiError::BadRequest("invite expired".into()));
    }
    if invite.email.to_lowercase() != email {
        return Err(ApiError::BadRequest("email does not match invite".into()));
    }

    let mut tx = state.pool.begin().await?;
    // Link an existing account, or provision a new one (password required for new users).
    let user = match sqlx::query_as::<_, User>(
        "SELECT id, email, full_name, locale FROM users WHERE lower(email) = $1",
    )
    .bind(&email)
    .fetch_optional(&mut *tx)
    .await?
    {
        Some(u) => u,
        None => {
            let password = req.password.clone().unwrap_or_default();
            if password.len() < 8 {
                return Err(ApiError::BadRequest(
                    "password (min 8 characters) required for a new account".into(),
                ));
            }
            validate_password(&password)?;
            let hash = hash_password_blocking(password).await?;
            let full_name = req.full_name.as_deref().unwrap_or("").trim().to_string();
            require_len("full_name", &full_name, 200)?;
            sqlx::query_as::<_, User>(
                "INSERT INTO users (email, password_hash, full_name, locale)
                 VALUES ($1, $2, $3, 'it') RETURNING id, email, full_name, locale",
            )
            .bind(&email)
            .bind(&hash)
            .bind(&full_name)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| conflict_on_unique(e, "email already registered"))?
        }
    };

    // Add the membership; keep an existing member's current role rather than overriding it.
    sqlx::query(
        "INSERT INTO memberships (user_id, org_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, org_id) DO NOTHING",
    )
    .bind(user.id)
    .bind(invite.org_id)
    .bind(invite.role)
    .execute(&mut *tx)
    .await?;
    let role: Role =
        sqlx::query_scalar("SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2")
            .bind(user.id)
            .bind(invite.org_id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("UPDATE invites SET accepted_at = now() WHERE id = $1")
        .bind(invite.id)
        .execute(&mut *tx)
        .await?;
    let org = sqlx::query_as::<_, Org>("SELECT id, name FROM orgs WHERE id = $1")
        .bind(invite.org_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    audit::record(
        &state.pool,
        invite.org_id,
        Some(user.id),
        "invite.accept",
        "invite",
        invite.id,
        json!({ "email": email, "role": role }),
    )
    .await;
    let token = issue_token(&state.cfg.jwt_secret, user.id, invite.org_id, role)?;
    Ok(Json(AuthResponse { token, user, org }))
}

// ---- media token ---------------------------------------------------------

/// Short-lived read-only token for tile/photo URLs (docs/API.md §"Media tokens").
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

// ---- password reset ------------------------------------------------------

#[derive(Deserialize)]
struct ResetRequestReq {
    email: String,
}

/// POST /auth/password-reset/request — ALWAYS 204: the response must not reveal whether an
/// account exists (no user enumeration; unknown emails burn the same argon2 time). For a
/// real account a one-time token (32 random bytes, hex) is stored argon2-hashed with a
/// 30-minute expiry and the app deep link is logged at info level — there is no SMTP in the
/// stack, so the operator log IS the delivery channel for now.
/// TODO: deliver the link by email once a provider lands (docs/API.md §Auth).
/// Rate limiting: rides the per-IP auth limiter this router is mounted with (routes.rs).
async fn password_reset_request(
    State(state): State<AppState>,
    Json(req): Json<ResetRequestReq>,
) -> ApiResult<StatusCode> {
    // Malformed input answers 204 too — anything else would leak information.
    let Ok(email) = normalize_email(&req.email) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let user_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM users WHERE lower(email) = $1")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await?;
    let Some(user_id) = user_id else {
        // Keep timing roughly uniform with the known-email path (same argon2 work).
        let _ = hash_password_blocking("arvo-uniform-timing-guard".into()).await;
        return Ok(StatusCode::NO_CONTENT);
    };

    let mut token_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token: String = token_bytes.iter().map(|b| format!("{b:02x}")).collect();
    let token_hash = hash_password_blocking(token.clone()).await?;

    let mut tx = state.pool.begin().await?;
    // One outstanding link per user: a new request invalidates the previous one. This also
    // keeps the confirm-side candidate scan small.
    sqlx::query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')",
    )
    .bind(user_id)
    .bind(&token_hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    // The raw token exists only in this log line and in the user's hands.
    tracing::info!(
        email = %email,
        link = %format!("arvo:///forgot-password?token={token}"),
        "password reset link (no SMTP configured — deliver manually)"
    );
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ResetConfirmReq {
    token: String,
    new_password: String,
}

#[derive(sqlx::FromRow)]
struct ResetRow {
    id: Uuid,
    user_id: Uuid,
    token_hash: String,
}

/// How many outstanding reset rows the confirm endpoint is willing to argon2-verify per
/// call. Hashed random tokens cannot be looked up directly by design; recency covers the
/// real flow (the newest link is the one being clicked) while bounding CPU, and the per-IP
/// auth rate limiter caps how often anyone can make us do this.
const RESET_VERIFY_CANDIDATES: i64 = 20;

/// POST /auth/password-reset/confirm — one-shot: verifies the token against recent
/// unexpired unused rows, sets the new password, marks the row used. Every token problem is
/// the same opaque 400 `invalid_token` so the endpoint is not a guessing oracle; only a
/// too-short password gets its own message (client-side validation mirrors it).
async fn password_reset_confirm(
    State(state): State<AppState>,
    Json(req): Json<ResetConfirmReq>,
) -> ApiResult<StatusCode> {
    let invalid = || ApiError::BadRequest("invalid_token".into());
    let token = req.token.trim().to_string();
    if token.is_empty() || token.len() > 128 {
        return Err(invalid());
    }
    validate_password(&req.new_password)?;

    let rows: Vec<ResetRow> = sqlx::query_as(
        "SELECT id, user_id, token_hash FROM password_resets
         WHERE used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC LIMIT $1",
    )
    .bind(RESET_VERIFY_CANDIDATES)
    .fetch_all(&state.pool)
    .await?;
    let mut matched: Option<(Uuid, Uuid)> = None;
    for row in rows {
        if verify_password_blocking(token.clone(), row.token_hash.clone()).await {
            matched = Some((row.id, row.user_id));
            break;
        }
    }
    let Some((reset_id, user_id)) = matched else {
        return Err(invalid());
    };

    let hash = hash_password_blocking(req.new_password).await?;
    let mut tx = state.pool.begin().await?;
    // Claim the row first (only if still unused) so two concurrent confirms cannot both win.
    let claimed =
        sqlx::query("UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL")
            .bind(reset_id)
            .execute(&mut *tx)
            .await?;
    if claimed.rows_affected() == 0 {
        return Err(invalid());
    }
    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // Password reset is user-scoped; audit under the user's first org. Best-effort — the
    // reset already succeeded, so a lookup hiccup must not turn it into an error response.
    let org_id: Option<Uuid> = sqlx::query_scalar(
        "SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    if let Some(org_id) = org_id {
        audit::record(
            &state.pool,
            org_id,
            Some(user_id),
            "user.password_reset",
            "user",
            user_id,
            json!({}),
        )
        .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- helpers -------------------------------------------------------------

fn normalize_email(raw: &str) -> ApiResult<String> {
    let email = raw.trim().to_lowercase();
    if email.is_empty() || !email.contains('@') {
        return Err(ApiError::BadRequest("valid email required".into()));
    }
    require_len("email", &email, 254)?;
    Ok(email)
}

/// Upper bound only — the argon2 cost of pathological inputs, not password policy.
fn validate_password(password: &str) -> ApiResult<()> {
    if password.len() < 8 {
        return Err(ApiError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }
    if password.len() > 512 {
        return Err(ApiError::BadRequest("password too long (max 512)".into()));
    }
    Ok(())
}

/// argon2id is ~50-100ms of pure CPU; keep it off the async workers so a login burst
/// can't stall every other endpoint.
async fn hash_password_blocking(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || hash_password(&password))
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("hash task: {e}")))?
}

async fn verify_password_blocking(password: String, phc: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&password, &phc))
        .await
        .unwrap_or(false)
}

fn hash_password(password: &str) -> ApiResult<String> {
    let mut salt_bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt_bytes);
    let salt = SaltString::encode_b64(&salt_bytes)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("salt: {e}")))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("password hash: {e}")))
}

fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A valid hash to verify against when the email is unknown, keeping login timing uniform.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("arvo-uniform-timing-guard").unwrap_or_default())
}

fn conflict_on_unique(e: sqlx::Error, msg: &str) -> ApiError {
    if e.as_database_error()
        .is_some_and(|db| db.is_unique_violation())
    {
        ApiError::Conflict(msg.into())
    } else {
        e.into()
    }
}
