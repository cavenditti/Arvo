//! OWNER: be-scouting — scouting sync + photo upload per docs/API.md §Observations.
//! Offline-first: client-generated UUIDs, last-write-wins on `updated_at`, pull-since.
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;

const MAX_UPSERTS: usize = 500;
const MAX_PHOTO_BYTES: usize = 10 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        // Sync payloads can be large (up to 500 rows); lift the 2 MB default.
        .route(
            "/observations/sync",
            post(sync).layer(DefaultBodyLimit::max(8 * 1024 * 1024)),
        )
        .route("/observations", get(list))
        // Photos up to 10 MB + multipart overhead.
        .route(
            "/observations/{id}/photos",
            post(upload_photo).layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
}

/// Observation as returned to clients (row + author name via join).
#[derive(Debug, Serialize, sqlx::FromRow)]
struct ObservationRow {
    id: Uuid,
    parcel_id: Option<Uuid>,
    note: String,
    tags: Vec<String>,
    photos: Value,
    lon: Option<f64>,
    lat: Option<f64>,
    taken_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted: bool,
    author_id: Uuid,
    author_name: Option<String>,
}

const OBS_SELECT: &str = "SELECT o.id, o.parcel_id, o.note, o.tags, o.photos, o.lon, o.lat,
        o.taken_at, o.updated_at, o.deleted, o.author_id, u.full_name AS author_name
 FROM observations o
 LEFT JOIN users u ON u.id = o.author_id";

/// Incoming upsert. `author_id`/`author_name` in the body are ignored — the server
/// always uses the token identity (§Security: identity never comes from the body).
#[derive(Debug, Deserialize)]
struct Upsert {
    id: Uuid,
    #[serde(default)]
    parcel_id: Option<Uuid>,
    #[serde(default)]
    note: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    photos: Value,
    #[serde(default)]
    lon: Option<f64>,
    #[serde(default)]
    lat: Option<f64>,
    taken_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Deserialize)]
struct SyncRequest {
    #[serde(default)]
    last_pulled_at: Option<DateTime<Utc>>,
    #[serde(default)]
    upserts: Vec<Upsert>,
}

#[derive(Debug, Serialize)]
struct SyncResponse {
    server_time: DateTime<Utc>,
    applied: Vec<Uuid>,
    changes: Vec<ObservationRow>,
}

/// POST /observations/sync — LWW upsert + pull-since. Idempotent.
async fn sync(
    State(state): State<AppState>,
    user: AuthUser,
    Json(req): Json<SyncRequest>,
) -> ApiResult<Json<SyncResponse>> {
    user.require(Role::Operator)?;
    if req.upserts.len() > MAX_UPSERTS {
        return Err(ApiError::BadRequest(format!(
            "too many upserts (max {MAX_UPSERTS} per call)"
        )));
    }
    let server_time = Utc::now();

    let mut applied: Vec<Uuid> = Vec::new();
    let mut tx = state.pool.begin().await?;
    for up in &req.upserts {
        let existing: Option<(Uuid, DateTime<Utc>)> =
            sqlx::query_as("SELECT org_id, updated_at FROM observations WHERE id = $1")
                .bind(up.id)
                .fetch_optional(&mut *tx)
                .await?;
        // Photos jsonb must be an array; coerce a missing/null value to [].
        let photos = if up.photos.is_array() { up.photos.clone() } else { json!([]) };
        match existing {
            // Unknown id → INSERT (org + author from the token).
            None => {
                sqlx::query(
                    "INSERT INTO observations
                       (id, org_id, parcel_id, author_id, lon, lat, note, tags, photos, taken_at, deleted, updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                     ON CONFLICT (id) DO NOTHING",
                )
                .bind(up.id)
                .bind(user.org_id)
                .bind(up.parcel_id)
                .bind(user.user_id)
                .bind(up.lon)
                .bind(up.lat)
                .bind(&up.note)
                .bind(&up.tags)
                .bind(&photos)
                .bind(up.taken_at)
                .bind(up.deleted)
                .bind(up.updated_at)
                .execute(&mut *tx)
                .await?;
                applied.push(up.id);
            }
            // Known id in the SAME org → LWW update (keep author_id).
            Some((org_id, stored_updated)) if org_id == user.org_id => {
                if up.updated_at > stored_updated {
                    sqlx::query(
                        "UPDATE observations SET
                           parcel_id = $2, lon = $3, lat = $4, note = $5, tags = $6,
                           photos = $7, taken_at = $8, deleted = $9, updated_at = $10
                         WHERE id = $1 AND org_id = $11",
                    )
                    .bind(up.id)
                    .bind(up.parcel_id)
                    .bind(up.lon)
                    .bind(up.lat)
                    .bind(&up.note)
                    .bind(&up.tags)
                    .bind(&photos)
                    .bind(up.taken_at)
                    .bind(up.deleted)
                    .bind(up.updated_at)
                    .bind(user.org_id)
                    .execute(&mut *tx)
                    .await?;
                }
                applied.push(up.id);
            }
            // Id belongs to another org → skip silently (do not leak existence).
            Some(_) => {}
        }
    }
    tx.commit().await?;

    // Pull: all org rows changed since last_pulled_at (all rows when null), tombstones included.
    let changes: Vec<ObservationRow> = sqlx::query_as(&format!(
        "{} WHERE o.org_id = $1 AND ($2::timestamptz IS NULL OR o.updated_at > $2)
         ORDER BY o.updated_at ASC",
        OBS_SELECT
    ))
    .bind(user.org_id)
    .bind(req.last_pulled_at)
    .fetch_all(&state.pool)
    .await?;

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "observation.sync",
        "observation",
        "",
        json!({ "applied": applied.len(), "upserts": req.upserts.len() }),
    )
    .await;

    Ok(Json(SyncResponse { server_time, applied, changes }))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    parcel_id: Option<Uuid>,
    limit: Option<i64>,
}

/// GET /observations?parcel_id=&limit=100 — non-deleted, newest first.
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<ObservationRow>>> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let rows: Vec<ObservationRow> = sqlx::query_as(&format!(
        "{} WHERE o.org_id = $1 AND o.deleted = false
           AND ($2::uuid IS NULL OR o.parcel_id = $2)
         ORDER BY o.taken_at DESC
         LIMIT $3",
        OBS_SELECT
    ))
    .bind(user.org_id)
    .bind(q.parcel_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize)]
struct PhotoResponse {
    path: String,
}

/// POST /observations/{id}/photos — multipart field `file` (jpeg/png ≤ 10 MB).
async fn upload_photo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<PhotoResponse>)> {
    user.require(Role::Operator)?;

    // 404 early if the observation isn't in the caller's org.
    let owned: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM observations WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(user.org_id)
            .fetch_optional(&state.pool)
            .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound);
    }

    // Pull the `file` field, validating type and size.
    let mut file: Option<(bytes::Bytes, &'static str)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("invalid multipart: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let content_type = field.content_type().map(|s| s.to_ascii_lowercase());
        let file_ext = field
            .file_name()
            .and_then(|n| n.rsplit('.').next())
            .map(|e| e.to_ascii_lowercase());
        let ext = match content_type.as_deref() {
            Some("image/jpeg") | Some("image/jpg") => "jpg",
            Some("image/png") => "png",
            // Fall back to the filename extension when the client omits a content type.
            _ => match file_ext.as_deref() {
                Some("jpg") | Some("jpeg") => "jpg",
                Some("png") => "png",
                _ => return Err(ApiError::BadRequest("only jpeg or png images are allowed".into())),
            },
        };
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(format!("could not read upload: {e}")))?;
        if data.len() > MAX_PHOTO_BYTES {
            return Err(ApiError::BadRequest("file exceeds the 10 MB limit".into()));
        }
        file = Some((data, ext));
        break;
    }
    let (data, ext) = file.ok_or_else(|| ApiError::BadRequest("missing `file` field".into()))?;

    // Save under <upload_dir>/observations/<obs_id>/<uuid>.<ext>.
    let dir = state.cfg.upload_dir.join("observations").join(id.to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let file_name = format!("{}.{ext}", Uuid::new_v4());
    tokio::fs::write(dir.join(&file_name), &data)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    let path = format!("/uploads/observations/{id}/{file_name}");
    let entry = json!([{ "path": path, "taken_at": Utc::now() }]);
    let res = sqlx::query(
        "UPDATE observations SET photos = photos || $1::jsonb, updated_at = now()
         WHERE id = $2 AND org_id = $3",
    )
    .bind(&entry)
    .bind(id)
    .bind(user.org_id)
    .execute(&state.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    audit::record(
        &state.pool,
        user.org_id,
        Some(user.user_id),
        "observation.photo",
        "observation",
        id,
        json!({ "path": path }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(PhotoResponse { path })))
}
