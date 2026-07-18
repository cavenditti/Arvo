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
use crate::util::require_len;

const MAX_UPSERTS: usize = 500;
const MAX_PHOTO_BYTES: usize = 10 * 1024 * 1024;
const MAX_NOTE_BYTES: usize = 10_000;
const MAX_TAGS: usize = 50;
/// Pull cursors overlap by this much so rows committed by a transaction that was still
/// in flight when we computed `server_time` are re-delivered next sync instead of lost.
/// Re-delivery is harmless (LWW merge is idempotent); a skipped row would be silent data loss.
const PULL_OVERLAP_SECONDS: i64 = 10;

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
    // Viewers may pull (read-only offline app); pushing rows needs Operator.
    if !req.upserts.is_empty() {
        user.require(Role::Operator)?;
    }
    if req.upserts.len() > MAX_UPSERTS {
        return Err(ApiError::BadRequest(format!(
            "too many upserts (max {MAX_UPSERTS} per call)"
        )));
    }

    let mut applied: Vec<Uuid> = Vec::new();
    let mut tx = state.pool.begin().await?;
    for up in &req.upserts {
        require_len("note", &up.note, MAX_NOTE_BYTES)?;
        if up.tags.len() > MAX_TAGS {
            return Err(ApiError::BadRequest(format!(
                "too many tags (max {MAX_TAGS})"
            )));
        }
        for tag in &up.tags {
            require_len("tag", tag, 100)?;
        }
        // A parcel reference is honored only when the parcel belongs to the caller's org.
        // Anything else (foreign org, hard-deleted parcel from a cascaded farm delete) is
        // stored as NULL instead of failing the whole batch with an FK error — otherwise a
        // legitimate offline outbox replay would wedge on a 500 forever.
        let parcel_id: Option<Uuid> = match up.parcel_id {
            Some(pid) => {
                sqlx::query_scalar("SELECT id FROM parcels WHERE id = $1 AND org_id = $2")
                    .bind(pid)
                    .bind(user.org_id)
                    .fetch_optional(&mut *tx)
                    .await?
            }
            None => None,
        };
        let photos = sanitize_photos(&up.photos);
        let existing: Option<(Uuid, DateTime<Utc>)> =
            sqlx::query_as("SELECT org_id, updated_at FROM observations WHERE id = $1")
                .bind(up.id)
                .fetch_optional(&mut *tx)
                .await?;
        match existing {
            // Unknown id → INSERT (org + author from the token).
            None => {
                sqlx::query(
                    "INSERT INTO observations
                       (id, org_id, parcel_id, author_id, lon, lat, note, tags, photos, taken_at, deleted, updated_at, server_updated_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
                     ON CONFLICT (id) DO NOTHING",
                )
                .bind(up.id)
                .bind(user.org_id)
                .bind(parcel_id)
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
            // Known id in the SAME org → LWW update (keep author_id). The `updated_at <`
            // guard is repeated in the WHERE so two concurrent syncs can't apply out of order.
            Some((org_id, stored_updated)) if org_id == user.org_id => {
                if up.updated_at > stored_updated {
                    sqlx::query(
                        "UPDATE observations SET
                           parcel_id = $2, lon = $3, lat = $4, note = $5, tags = $6,
                           photos = $7, taken_at = $8, deleted = $9, updated_at = $10,
                           server_updated_at = now()
                         WHERE id = $1 AND org_id = $11 AND updated_at < $10",
                    )
                    .bind(up.id)
                    .bind(parcel_id)
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
            // Id belongs to another org: never applied, but still echoed in `applied` so the
            // client drains it from its outbox instead of retrying forever. No data is
            // revealed, and the response is identical to the freshly-inserted case.
            Some(_) => applied.push(up.id),
        }
    }

    // Pull inside the same transaction, cursored on the server clock (`server_updated_at`),
    // not client wall clocks — a device with a skewed clock must not make rows invisible
    // to its teammates. Tombstones included.
    let server_time: DateTime<Utc> = sqlx::query_scalar(&format!(
        "SELECT now() - interval '{PULL_OVERLAP_SECONDS} seconds'"
    ))
    .fetch_one(&mut *tx)
    .await?;
    let changes: Vec<ObservationRow> = sqlx::query_as(&format!(
        "{} WHERE o.org_id = $1 AND ($2::timestamptz IS NULL OR o.server_updated_at > $2)
         ORDER BY o.server_updated_at ASC",
        OBS_SELECT
    ))
    .bind(user.org_id)
    .bind(req.last_pulled_at)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;

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

    Ok(Json(SyncResponse {
        server_time,
        applied,
        changes,
    }))
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

/// Photos in sync bodies are client-supplied JSON. Keep only array entries whose `path` is a
/// server-issued upload path — anything else (external URLs, javascript:, junk shapes) is
/// dropped so it can never surface in reports or the app as an <img src>.
fn sanitize_photos(raw: &Value) -> Value {
    let Some(items) = raw.as_array() else {
        return json!([]);
    };
    let kept: Vec<Value> = items
        .iter()
        .filter(|p| {
            p.get("path")
                .and_then(Value::as_str)
                .is_some_and(|s| s.starts_with("/uploads/") && !s.contains(".."))
        })
        .cloned()
        .collect();
    json!(kept)
}

/// POST /observations/{id}/photos — multipart field `file` (jpeg/png ≤ 10 MB).
async fn upload_photo(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<PhotoResponse>)> {
    user.require(Role::Operator)?;

    // 404 early if the observation isn't in the caller's org; no photos on tombstones.
    let deleted: Option<bool> =
        sqlx::query_scalar("SELECT deleted FROM observations WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(user.org_id)
            .fetch_optional(&state.pool)
            .await?;
    match deleted {
        None => return Err(ApiError::NotFound),
        Some(true) => {
            return Err(ApiError::Conflict("observation was deleted".into()));
        }
        Some(false) => {}
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
                _ => {
                    return Err(ApiError::BadRequest(
                        "only jpeg or png images are allowed".into(),
                    ))
                }
            },
        };
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(format!("could not read upload: {e}")))?;
        if data.len() > MAX_PHOTO_BYTES {
            return Err(ApiError::BadRequest("file exceeds the 10 MB limit".into()));
        }
        // Content sniffing: extension/content-type alone must not decide what we store.
        let magic_ok = match ext {
            "jpg" => data.starts_with(&[0xFF, 0xD8, 0xFF]),
            "png" => data.starts_with(&[0x89, 0x50, 0x4E, 0x47]),
            _ => false,
        };
        if !magic_ok {
            return Err(ApiError::BadRequest(
                "file content is not a jpeg or png image".into(),
            ));
        }
        file = Some((data, ext));
        break;
    }
    let (data, ext) = file.ok_or_else(|| ApiError::BadRequest("missing `file` field".into()))?;

    // Save under <upload_dir>/observations/<obs_id>/<uuid>.<ext>.
    let dir = state
        .cfg
        .upload_dir
        .join("observations")
        .join(id.to_string());
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
        "UPDATE observations
         SET photos = photos || $1::jsonb, updated_at = now(), server_updated_at = now()
         WHERE id = $2 AND org_id = $3",
    )
    .bind(&entry)
    .bind(id)
    .bind(user.org_id)
    .execute(&state.pool)
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {}
        other => {
            // Don't leave an orphan file when the DB append failed.
            let _ = tokio::fs::remove_file(dir.join(&file_name)).await;
            other?;
            return Err(ApiError::NotFound);
        }
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
