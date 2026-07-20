//! OWNER: be-capture — captures (drone flights / pre-built ortho drops), their assets, and the
//! hand-off into the pipeline. Contract: docs/API-PLANT.md §Captures, §"Storage layout",
//! §"Pipeline stages". Migration `0080_captures.sql`.
//!
//! ```text
//! POST   /captures                          201, status="uploaded" (source="demo" → [agronomist+])
//! GET    /captures?parcel_id=&status=&limit= list, assets/jobs omitted
//! GET    /captures/{id}                      with `assets` + `jobs`
//! GET    /captures/{id}/status               CaptureStatusInfo — the app polls this every 5 s
//! POST   /captures/{id}/assets/{kind}        multipart, streamed to the store
//! GET    /captures/{id}/assets/{kind}        media token or Bearer, org-checked via the parcel
//! POST   /captures/{id}/process              202, enqueues the first pipeline stage (idempotent)
//! POST   /captures/{id}/retry                202, re-queues a stage and rewinds captures.status
//! ```
//!
//! This module only *enqueues* work; `arvo-worker` claims `pipeline_jobs` and advances
//! `captures.status`. Bytes never touch the DB (NFR-P-STORE) and raw imagery is never publicly
//! served (NFR-P-SEC) — every read goes through the media-token + org check below.
use axum::body::Body;
use axum::extract::multipart::Field;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower_http::services::fs::AsyncReadBody;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::modules::parcels::assert_owned;
use crate::modules::storage::{self, LocalStore, Store, StoreWriter};
use crate::security::{self, AuthUser, Role};
use crate::state::AppState;
use crate::util::require_len;

const MB: u64 = 1024 * 1024;
/// Per-file / per-request upload caps (docs/API-PLANT.md §Captures).
const MAX_RAW_FILE_BYTES: u64 = 200 * MB;
const MAX_RAW_REQUEST_BYTES: u64 = 500 * MB;
const MAX_COG_BYTES: u64 = 2048 * MB;
const MAX_RAW_FILES: i64 = 2_000;
/// Frame size of a download. Assets are streamed off `Store::path`, never buffered, so an
/// asset is readable up to the same cap the upload half accepts ([`MAX_COG_BYTES`]).
const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;
/// Bytes of a file we buffer before its magic number decides the content type.
const SNIFF_LEN: usize = 4;
const MAX_FILE_NAME: usize = 200;
const MAX_TEXT: usize = 200;
const MAX_NOTES: usize = 2_000;
/// A flight stamped further than this from now is a client clock bug, not a capture.
const CAPTURED_AT_WINDOW_DAYS: i64 = 3_653;

const KIND_RAW: &str = "raw";
const KIND_ORTHO: &str = "ortho";
const KIND_DSM: &str = "dsm";

const SOURCES: [&str; 3] = ["drone", "prebuilt", "demo"];
const STATUSES: [&str; 6] = [
    "uploaded",
    "ortho",
    "detected",
    "registered",
    "extracted",
    "failed",
];
const UNIT_TYPES: [&str; 4] = ["tree", "vine", "row_segment", "bush"];
const BAND_NAMES: [&str; 6] = ["red", "green", "blue", "rededge", "nir", "swir"];
/// The four pipeline stages, in execution order — the index is the ordering used by `retry`.
const STAGES: [&str; 4] = ["sfm", "detect", "register", "extract"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/captures", get(list).post(create))
        .route("/captures/{id}", get(get_one))
        .route("/captures/{id}/status", get(get_status))
        // Uploads stream straight to the store, so the global body limit is off and the caps
        // above are enforced by a manual byte counter. The GET on this path carries no body,
        // so sharing the layer with it is a no-op.
        .route(
            "/captures/{id}/assets/{kind}",
            post(upload_asset)
                .get(download_asset)
                .layer(DefaultBodyLimit::disable()),
        )
        .route("/captures/{id}/process", post(process))
        .route("/captures/{id}/retry", post(retry))
}

// --- rows ------------------------------------------------------------------

/// `bbox` is stored as a polygon and served as `[w,s,e,n]`; the four ordinates are read
/// separately and folded in [`CaptureRow::fill_bbox`].
const CAPTURE_COLS: &str = "c.id, c.parcel_id, c.captured_at, c.source, c.status,
        c.unit_type::text AS unit_type, c.sensor, c.gsd_cm, c.bands, c.pilot_name,
        c.operator_id, c.drone_model, c.flight_ref, c.notes, c.failed_stage, c.error,
        ST_XMin(c.bbox) AS bbox_w, ST_YMin(c.bbox) AS bbox_s,
        ST_XMax(c.bbox) AS bbox_e, ST_YMax(c.bbox) AS bbox_n,
        c.plant_count, c.observation_count, c.processed_at, c.created_at, c.updated_at";

#[derive(Debug, Serialize, sqlx::FromRow)]
struct CaptureRow {
    id: Uuid,
    parcel_id: Uuid,
    captured_at: DateTime<Utc>,
    source: String,
    status: String,
    unit_type: String,
    sensor: Option<String>,
    gsd_cm: Option<f64>,
    bands: Value,
    pilot_name: Option<String>,
    operator_id: Option<String>,
    drone_model: Option<String>,
    flight_ref: Option<String>,
    notes: Option<String>,
    failed_stage: Option<String>,
    error: Option<String>,
    #[serde(skip_serializing)]
    bbox_w: Option<f64>,
    #[serde(skip_serializing)]
    bbox_s: Option<f64>,
    #[serde(skip_serializing)]
    bbox_e: Option<f64>,
    #[serde(skip_serializing)]
    bbox_n: Option<f64>,
    #[sqlx(skip)]
    bbox: Option<[f64; 4]>,
    plant_count: i32,
    observation_count: i32,
    processed_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    /// Present only on `GET /captures/{id}` (the contract omits both in list responses).
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    assets: Option<Vec<AssetRow>>,
    #[sqlx(skip)]
    #[serde(skip_serializing_if = "Option::is_none")]
    jobs: Option<Vec<JobRow>>,
}

impl CaptureRow {
    fn fill_bbox(&mut self) {
        self.bbox = match (self.bbox_w, self.bbox_s, self.bbox_e, self.bbox_n) {
            (Some(w), Some(s), Some(e), Some(n)) => Some([w, s, e, n]),
            _ => None,
        };
    }
}

const ASSET_SELECT: &str = "SELECT id, capture_id, kind, file_name, path, bytes, content_type,
        checksum, created_at
 FROM capture_assets";

#[derive(Debug, Serialize, sqlx::FromRow)]
struct AssetRow {
    id: Uuid,
    capture_id: Uuid,
    kind: String,
    file_name: String,
    /// Store key (`captures/…/ortho.tif`), never an absolute path and never a URL.
    path: String,
    bytes: i64,
    content_type: Option<String>,
    checksum: Option<String>,
    created_at: DateTime<Utc>,
}

const JOB_SELECT: &str = "SELECT id, capture_id, stage, state, attempts, max_attempts, run_after,
        started_at, finished_at, error, created_at, updated_at
 FROM pipeline_jobs";

#[derive(Debug, Serialize, sqlx::FromRow)]
struct JobRow {
    id: Uuid,
    capture_id: Uuid,
    stage: String,
    state: String,
    attempts: i32,
    max_attempts: i32,
    run_after: DateTime<Utc>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

// --- validation ------------------------------------------------------------

/// Validate a client-supplied enum-ish value against the frozen vocabulary, returning the
/// interned variant so it can be bound to SQL without borrowing the request.
fn one_of(value: &str, allowed: &[&'static str], field: &str) -> ApiResult<&'static str> {
    allowed
        .iter()
        .find(|a| **a == value)
        .copied()
        .ok_or_else(|| ApiError::BadRequest(format!("invalid {field} `{value}`")))
}

fn normalize_kind(kind: &str) -> ApiResult<&'static str> {
    one_of(kind, &[KIND_RAW, KIND_ORTHO, KIND_DSM], "asset kind")
}

/// Optional descriptive field: trimmed, capped, empty → `None`.
fn opt_text(value: Option<String>, field: &str, max: usize) -> ApiResult<Option<String>> {
    let Some(v) = value else { return Ok(None) };
    let v = v.trim();
    require_len(field, v, max)?;
    Ok((!v.is_empty()).then(|| v.to_string()))
}

/// Band map: reflectance band name → 1-based band index in `ortho.tif`. Omitted on a
/// non-`demo` capture means a plain RGB ortho; `demo` captures are sampled synthetically and
/// carry no bands at all.
fn validate_bands(bands: Option<Value>, source: &str) -> ApiResult<Value> {
    let Some(v) = bands else {
        return Ok(if source == "demo" {
            json!({})
        } else {
            json!({ "red": 1, "green": 2, "blue": 3 })
        });
    };
    let map = v
        .as_object()
        .ok_or_else(|| ApiError::BadRequest("bands must be an object".into()))?;
    for (name, index) in map {
        if !BAND_NAMES.contains(&name.as_str()) {
            return Err(ApiError::BadRequest(format!("unknown band `{name}`")));
        }
        match index.as_i64() {
            Some(i) if (1..=16).contains(&i) => {}
            _ => {
                return Err(ApiError::BadRequest(format!(
                    "band `{name}` must be a band index 1..16"
                )))
            }
        }
    }
    Ok(v)
}

/// Position of a stage in the pipeline (`sfm` = 0 … `extract` = 3).
fn stage_index(stage: &str) -> ApiResult<usize> {
    STAGES
        .iter()
        .position(|s| *s == stage)
        .ok_or_else(|| ApiError::BadRequest(format!("invalid stage `{stage}`")))
}

/// `captures.status` the stage consumes — what a retry rewinds to.
fn stage_input_status(stage: &str) -> &'static str {
    match stage {
        "detect" => "ortho",
        "register" => "detected",
        "extract" => "registered",
        _ => "uploaded",
    }
}

/// How far the capture has come, expressed as the furthest stage that may legally run.
/// `failed` is handled by the caller (a failed capture may retry anything).
fn status_stage_index(status: &str) -> usize {
    match status {
        "ortho" => 1,
        "detected" => 2,
        "registered" | "extracted" => 3,
        _ => 0,
    }
}

// --- loaders ---------------------------------------------------------------

async fn load_capture(st: &AppState, org_id: Uuid, id: Uuid) -> ApiResult<CaptureRow> {
    let mut row: CaptureRow = sqlx::query_as(&format!(
        "SELECT {CAPTURE_COLS} FROM captures c WHERE c.id = $1 AND c.org_id = $2"
    ))
    .bind(id)
    .bind(org_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(ApiError::NotFound)?;
    row.fill_bbox();
    Ok(row)
}

async fn load_assets(st: &AppState, org_id: Uuid, id: Uuid) -> ApiResult<Vec<AssetRow>> {
    Ok(sqlx::query_as(&format!(
        "{ASSET_SELECT} WHERE capture_id = $1 AND org_id = $2 ORDER BY kind, created_at"
    ))
    .bind(id)
    .bind(org_id)
    .fetch_all(&st.pool)
    .await?)
}

async fn load_jobs(st: &AppState, org_id: Uuid, id: Uuid) -> ApiResult<Vec<JobRow>> {
    Ok(sqlx::query_as(&format!(
        "{JOB_SELECT} WHERE capture_id = $1 AND org_id = $2 ORDER BY created_at"
    ))
    .bind(id)
    .bind(org_id)
    .fetch_all(&st.pool)
    .await?)
}

// --- register / read -------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CreateBody {
    parcel_id: Uuid,
    captured_at: DateTime<Utc>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    unit_type: Option<String>,
    #[serde(default)]
    sensor: Option<String>,
    #[serde(default)]
    gsd_cm: Option<f64>,
    #[serde(default)]
    bands: Option<Value>,
    #[serde(default)]
    pilot_name: Option<String>,
    #[serde(default)]
    operator_id: Option<String>,
    #[serde(default)]
    drone_model: Option<String>,
    #[serde(default)]
    flight_ref: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

/// POST /captures — register a flight. Registering does not start work; `process` does.
async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<CaptureRow>)> {
    user.require(Role::Operator)?;
    let source = one_of(
        body.source.as_deref().unwrap_or("drone").trim(),
        &SOURCES,
        "source",
    )?;
    // `demo` synthesises detections and metrics — it is the seed/CI path, not a field action.
    if source == "demo" {
        user.require(Role::Agronomist)?;
    }
    let unit_type = one_of(
        body.unit_type.as_deref().unwrap_or("tree").trim(),
        &UNIT_TYPES,
        "unit_type",
    )?;

    let window = chrono::Duration::days(CAPTURED_AT_WINDOW_DAYS);
    let now = Utc::now();
    if body.captured_at < now - window || body.captured_at > now + window {
        return Err(ApiError::BadRequest(
            "captured_at must be within ±10 years of now".into(),
        ));
    }
    if let Some(gsd) = body.gsd_cm {
        if !(0.1..=100.0).contains(&gsd) {
            return Err(ApiError::BadRequest("gsd_cm must be 0.1..100".into()));
        }
    }
    let bands = validate_bands(body.bands, source)?;
    let sensor = opt_text(body.sensor, "sensor", MAX_TEXT)?;
    let pilot_name = opt_text(body.pilot_name, "pilot_name", MAX_TEXT)?;
    let operator_id = opt_text(body.operator_id, "operator_id", MAX_TEXT)?;
    let drone_model = opt_text(body.drone_model, "drone_model", MAX_TEXT)?;
    let flight_ref = opt_text(body.flight_ref, "flight_ref", MAX_TEXT)?;
    let notes = opt_text(body.notes, "notes", MAX_NOTES)?;

    // Org scope: the parcel must be the caller's, and `org_id` comes from the token only.
    assert_owned(&st.pool, user.org_id, body.parcel_id).await?;

    let mut row: CaptureRow = sqlx::query_as(&format!(
        "WITH ins AS (
             INSERT INTO captures (org_id, parcel_id, captured_at, source, unit_type, sensor,
                                   gsd_cm, bands, pilot_name, operator_id, drone_model,
                                   flight_ref, notes, created_by)
             VALUES ($1,$2,$3,$4,$5::plant_unit,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING *
         )
         SELECT {CAPTURE_COLS} FROM ins c"
    ))
    .bind(user.org_id)
    .bind(body.parcel_id)
    .bind(body.captured_at)
    .bind(source)
    .bind(unit_type)
    .bind(&sensor)
    .bind(body.gsd_cm)
    .bind(&bands)
    .bind(&pilot_name)
    .bind(&operator_id)
    .bind(&drone_model)
    .bind(&flight_ref)
    .bind(&notes)
    .bind(user.user_id)
    .fetch_one(&st.pool)
    .await?;
    row.fill_bbox();

    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "capture.create",
        "capture",
        row.id,
        json!({ "parcel_id": body.parcel_id, "source": source, "unit_type": unit_type }),
    )
    .await;
    Ok((StatusCode::CREATED, Json(row)))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    parcel_id: Option<Uuid>,
    #[serde(default)]
    status: Option<String>,
    limit: Option<i64>,
}

/// GET /captures — newest flight first. `assets`/`jobs` are omitted here by contract.
async fn list(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<CaptureRow>>> {
    let status = match q.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(one_of(s, &STATUSES, "status")?),
        None => None,
    };
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let mut rows: Vec<CaptureRow> = sqlx::query_as(&format!(
        "SELECT {CAPTURE_COLS} FROM captures c
         WHERE c.org_id = $1
           AND ($2::uuid IS NULL OR c.parcel_id = $2)
           AND ($3::text IS NULL OR c.status = $3)
         ORDER BY c.captured_at DESC, c.id
         LIMIT $4"
    ))
    .bind(user.org_id)
    .bind(q.parcel_id)
    .bind(status)
    .bind(limit)
    .fetch_all(&st.pool)
    .await?;
    for row in &mut rows {
        row.fill_bbox();
    }
    Ok(Json(rows))
}

/// GET /captures/{id} — the full record, with the asset manifest and the job table.
async fn get_one(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<CaptureRow>> {
    let mut row = load_capture(&st, user.org_id, id).await?;
    row.assets = Some(load_assets(&st, user.org_id, id).await?);
    row.jobs = Some(load_jobs(&st, user.org_id, id).await?);
    Ok(Json(row))
}

#[derive(Debug, Serialize)]
struct AssetCounts {
    raw: i64,
    ortho: i64,
    dsm: i64,
}

#[derive(Debug, Serialize)]
struct CaptureStatusInfo {
    capture_id: Uuid,
    status: String,
    stage: Option<String>,
    state: Option<String>,
    attempts: i32,
    failed_stage: Option<String>,
    error: Option<String>,
    plant_count: i32,
    observation_count: i32,
    asset_counts: AssetCounts,
    updated_at: DateTime<Utc>,
}

/// GET /captures/{id}/status — the cheap poll target (fe-capture hits it every 5 s).
/// `stage`/`state` describe the job that best explains the capture right now: whatever is
/// running, else what is queued, else the last failure, else the last success.
async fn get_status(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<CaptureStatusInfo>> {
    let cap = load_capture(&st, user.org_id, id).await?;
    let job: Option<(String, String, i32)> = sqlx::query_as(
        "SELECT stage, state, attempts FROM pipeline_jobs
         WHERE capture_id = $1 AND org_id = $2
         ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'failed' THEN 2
                             ELSE 3 END,
                  updated_at DESC
         LIMIT 1",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&st.pool)
    .await?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT kind, count(*) FROM capture_assets
         WHERE capture_id = $1 AND org_id = $2 GROUP BY kind",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_all(&st.pool)
    .await?;
    let count_of = |kind: &str| {
        counts
            .iter()
            .find(|(k, _)| k == kind)
            .map_or(0, |(_, n)| *n)
    };

    Ok(Json(CaptureStatusInfo {
        capture_id: cap.id,
        status: cap.status,
        stage: job.as_ref().map(|j| j.0.clone()),
        state: job.as_ref().map(|j| j.1.clone()),
        attempts: job.as_ref().map_or(0, |j| j.2),
        failed_stage: cap.failed_stage,
        error: cap.error,
        plant_count: cap.plant_count,
        observation_count: cap.observation_count,
        asset_counts: AssetCounts {
            raw: count_of(KIND_RAW),
            ortho: count_of(KIND_ORTHO),
            dsm: count_of(KIND_DSM),
        },
        updated_at: cap.updated_at,
    }))
}

// --- uploads ---------------------------------------------------------------

/// One file successfully written to the store, not yet recorded in the DB.
struct StoredFile {
    id: Uuid,
    key: String,
    file_name: String,
    content_type: &'static str,
    checksum: String,
    bytes: u64,
}

#[derive(Debug, Serialize)]
struct UploadResponse {
    assets: Vec<AssetRow>,
    total_bytes: i64,
}

/// The stored name is cosmetic (`?file=` lookups and `Content-Disposition`) — store **keys**
/// never contain a client-supplied component, so path traversal is not expressible.
fn sanitize_file_name(raw: Option<&str>, fallback: Uuid) -> String {
    let cleaned: String = raw
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(MAX_FILE_NAME)
        .collect();
    // `.` is in the contract's alphabet, so `..` survives the map; drop it anyway — the name
    // must stay inert even if some later caller does treat it as a path component.
    let cleaned = cleaned.replace("..", "_");
    let cleaned = cleaned.trim_matches('.');
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

/// Magic-number sniff: a lying `Content-Type` header never decides what we store.
fn sniff(head: &[u8], kind: &str) -> ApiResult<(&'static str, &'static str)> {
    let hit = if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if head.starts_with(b"II*\0") || head.starts_with(b"MM\0*") {
        Some(("image/tiff", "tif"))
    } else if head.starts_with(b"PK\x03\x04") {
        Some(("application/zip", "zip"))
    } else {
        None
    };
    match hit {
        Some(hit) if kind == KIND_RAW || hit.0 == "image/tiff" => Ok(hit),
        Some(_) => Err(ApiError::BadRequest(
            "ortho/dsm must be a GeoTIFF (image/tiff)".into(),
        )),
        None => Err(ApiError::BadRequest(
            "unrecognised file content (expected jpeg, tiff or zip)".into(),
        )),
    }
}

fn store_key(kind: &str, capture_id: Uuid, asset_id: Uuid, ext: &str) -> String {
    match kind {
        KIND_ORTHO => storage::ortho_key(capture_id),
        KIND_DSM => storage::dsm_key(capture_id),
        _ => storage::raw_key(capture_id, asset_id, ext),
    }
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Stream one multipart field into the store, hashing as it goes. Never buffers the file: only
/// the first [`SNIFF_LEN`] bytes are held back, long enough for the magic number to pick the
/// key's extension. The writer is handed back through `writer` so the caller can abort a
/// partial object — a truncated `ortho.tif` must never be published for the pipeline to read.
// Eight plain, unrelated scalars (two ids, two caps, the store, the field, the kind, the writer
// out-param): a params struct here would only rename the arguments, not reduce the coupling.
#[allow(clippy::too_many_arguments)]
async fn read_field(
    store: &LocalStore,
    field: &mut Field<'_>,
    capture_id: Uuid,
    asset_id: Uuid,
    kind: &str,
    max_file: u64,
    max_request_left: u64,
    writer: &mut Option<StoreWriter>,
) -> ApiResult<(String, &'static str, String)> {
    let mut head: Vec<u8> = Vec::with_capacity(SNIFF_LEN);
    let mut hasher = Sha256::new();
    let mut key = String::new();
    let mut content_type = "";
    let mut total: u64 = 0;

    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| ApiError::BadRequest(format!("could not read upload: {e}")))?
    {
        total += chunk.len() as u64;
        if total > max_file {
            return Err(ApiError::BadRequest(format!(
                "file exceeds the {} MB limit",
                max_file / MB
            )));
        }
        if total > max_request_left {
            return Err(ApiError::BadRequest(format!(
                "request exceeds the {} MB limit",
                MAX_RAW_REQUEST_BYTES / MB
            )));
        }
        hasher.update(&chunk);
        match writer.as_mut() {
            Some(w) => w.write(&chunk).await?,
            None => {
                head.extend_from_slice(&chunk);
                if head.len() >= SNIFF_LEN {
                    let (ct, ext) = sniff(&head, kind)?;
                    content_type = ct;
                    key = store_key(kind, capture_id, asset_id, ext);
                    let mut w = store.create(&key).await?;
                    w.write(&head).await?;
                    *writer = Some(w);
                }
            }
        }
    }
    // A file shorter than the sniff window (or empty) still has to prove what it is.
    if writer.is_none() {
        let (ct, ext) = sniff(&head, kind)?;
        content_type = ct;
        key = store_key(kind, capture_id, asset_id, ext);
        let mut w = store.create(&key).await?;
        w.write(&head).await?;
        *writer = Some(w);
    }
    Ok((key, content_type, hex(hasher.finalize())))
}

async fn store_field(
    store: &LocalStore,
    field: &mut Field<'_>,
    capture_id: Uuid,
    kind: &str,
    max_file: u64,
    max_request_left: u64,
) -> ApiResult<StoredFile> {
    let asset_id = Uuid::new_v4();
    let file_name = sanitize_file_name(field.file_name(), asset_id);
    let mut writer: Option<StoreWriter> = None;
    match read_field(
        store,
        field,
        capture_id,
        asset_id,
        kind,
        max_file,
        max_request_left,
        &mut writer,
    )
    .await
    {
        Ok((key, content_type, checksum)) => {
            let w = writer
                .take()
                .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("upload writer missing")))?;
            let bytes = w.finish().await?;
            Ok(StoredFile {
                id: asset_id,
                key,
                file_name,
                content_type,
                checksum,
                bytes,
            })
        }
        Err(e) => {
            if let Some(w) = writer.take() {
                w.abort().await;
            }
            Err(e)
        }
    }
}

/// A rejected request leaves nothing behind: drop everything it had already written.
async fn cleanup_and_err<T>(
    store: &LocalStore,
    files: &[StoredFile],
    err: ApiError,
) -> ApiResult<T> {
    for f in files {
        let _ = store.delete(&f.key).await;
    }
    Err(err)
}

async fn insert_assets(
    st: &AppState,
    org_id: Uuid,
    capture_id: Uuid,
    kind: &str,
    files: &[StoredFile],
) -> ApiResult<Vec<AssetRow>> {
    let mut tx = st.pool.begin().await?;
    // `raw` appends; ortho/dsm are one per capture and replace the previous drop (the bytes
    // already landed on the same key).
    if kind != KIND_RAW {
        sqlx::query(
            "DELETE FROM capture_assets WHERE capture_id = $1 AND org_id = $2 AND kind = $3",
        )
        .bind(capture_id)
        .bind(org_id)
        .bind(kind)
        .execute(&mut *tx)
        .await?;
    }
    let mut rows = Vec::with_capacity(files.len());
    for f in files {
        let row: AssetRow = sqlx::query_as(
            "INSERT INTO capture_assets
                 (id, org_id, capture_id, kind, path, file_name, bytes, content_type, checksum)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id, capture_id, kind, file_name, path, bytes, content_type, checksum,
                       created_at",
        )
        .bind(f.id)
        .bind(org_id)
        .bind(capture_id)
        .bind(kind)
        .bind(&f.key)
        .bind(&f.file_name)
        .bind(f.bytes as i64)
        .bind(f.content_type)
        .bind(&f.checksum)
        .fetch_one(&mut *tx)
        .await?;
        rows.push(row);
    }
    sqlx::query("UPDATE captures SET updated_at = now() WHERE id = $1 AND org_id = $2")
        .bind(capture_id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(rows)
}

/// POST /captures/{id}/assets/{kind} — multipart field `file`, repeatable for `raw`.
async fn upload_asset(
    State(st): State<AppState>,
    user: AuthUser,
    Path((id, kind)): Path<(Uuid, String)>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<UploadResponse>)> {
    user.require(Role::Operator)?;
    let kind = normalize_kind(&kind)?;

    let status: String =
        sqlx::query_scalar("SELECT status FROM captures WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(user.org_id)
            .fetch_optional(&st.pool)
            .await?
            .ok_or(ApiError::NotFound)?;
    // Raw photos only belong to a capture that has not started processing. A pre-built
    // ortho/DSM may also be re-dropped on a failed capture, right before retrying its stage.
    let allowed = if kind == KIND_RAW {
        status == "uploaded"
    } else {
        status == "uploaded" || status == "failed"
    };
    if !allowed {
        return Err(ApiError::Conflict(format!(
            "capture is `{status}` — retry the stage instead"
        )));
    }

    let existing_raw: i64 = if kind == KIND_RAW {
        sqlx::query_scalar(
            "SELECT count(*) FROM capture_assets
             WHERE capture_id = $1 AND org_id = $2 AND kind = 'raw'",
        )
        .bind(id)
        .bind(user.org_id)
        .fetch_one(&st.pool)
        .await?
    } else {
        0
    };

    let max_file = if kind == KIND_RAW {
        MAX_RAW_FILE_BYTES
    } else {
        MAX_COG_BYTES
    };
    let store = LocalStore::new(st.cfg.store_dir.clone());
    let mut files: Vec<StoredFile> = Vec::new();
    let mut request_bytes: u64 = 0;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("invalid multipart: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        if kind != KIND_RAW && !files.is_empty() {
            return cleanup_and_err(
                &store,
                &files,
                ApiError::BadRequest("exactly one ortho/dsm file per request".into()),
            )
            .await;
        }
        if kind == KIND_RAW && existing_raw + files.len() as i64 >= MAX_RAW_FILES {
            return cleanup_and_err(
                &store,
                &files,
                ApiError::BadRequest(format!("capture already holds {MAX_RAW_FILES} raw files")),
            )
            .await;
        }
        let left = if kind == KIND_RAW {
            MAX_RAW_REQUEST_BYTES.saturating_sub(request_bytes)
        } else {
            u64::MAX
        };
        match store_field(&store, &mut field, id, kind, max_file, left).await {
            Ok(f) => {
                request_bytes += f.bytes;
                files.push(f);
            }
            Err(e) => return cleanup_and_err(&store, &files, e).await,
        }
    }
    if files.is_empty() {
        return Err(ApiError::BadRequest("missing `file` field".into()));
    }

    let assets = match insert_assets(&st, user.org_id, id, kind, &files).await {
        Ok(rows) => rows,
        // The manifest is the source of truth: bytes with no row are garbage, so drop them.
        Err(e) => return cleanup_and_err(&store, &files, e).await,
    };

    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "capture.upload",
        "capture",
        id,
        json!({ "kind": kind, "files": assets.len(), "bytes": request_bytes }),
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            assets,
            total_bytes: request_bytes as i64,
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct AssetQuery {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    file: Option<String>,
}

/// GET /captures/{id}/assets/{kind}?file=&token= — the asset bytes.
/// Bearer header **or** a short-lived media token in `?token=` (a session JWT in the query
/// string is rejected): browsers open these URLs directly, docs/API.md §"Media tokens".
async fn download_asset(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((id, kind)): Path<(Uuid, String)>,
    Query(q): Query<AssetQuery>,
) -> ApiResult<Response> {
    let user =
        security::authenticate_bearer_or_media(&st.cfg.jwt_secret, &headers, q.token.as_deref())?;
    let kind = normalize_kind(&kind)?;

    // Org scope goes through the parcel (contract); cross-tenant is a 404, never a 403.
    let owned: Option<Uuid> = sqlx::query_scalar(
        "SELECT c.id FROM captures c JOIN parcels p ON p.id = c.parcel_id
         WHERE c.id = $1 AND p.org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&st.pool)
    .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound);
    }

    let asset: Option<AssetRow> = if kind == KIND_RAW {
        let file = q
            .file
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ApiError::BadRequest("`file` is required for raw assets".into()))?;
        require_len("file", file, MAX_FILE_NAME)?;
        sqlx::query_as(&format!(
            "{ASSET_SELECT} WHERE capture_id = $1 AND org_id = $2 AND kind = 'raw'
               AND file_name = $3
             ORDER BY created_at LIMIT 1"
        ))
        .bind(id)
        .bind(user.org_id)
        .bind(file)
        .fetch_optional(&st.pool)
        .await?
    } else {
        sqlx::query_as(&format!(
            "{ASSET_SELECT} WHERE capture_id = $1 AND org_id = $2 AND kind = $3 LIMIT 1"
        ))
        .bind(id)
        .bind(user.org_id)
        .bind(kind)
        .fetch_optional(&st.pool)
        .await?
    };
    let asset = asset.ok_or(ApiError::NotFound)?;

    // The key comes from the manifest, never from the request. The bytes are streamed straight
    // off the store path — the upload half accepts a 2 GB ortho (`MAX_COG_BYTES`), so this, the
    // only documented read path (docs/API-PLANT.md §"Storage layout"), must never hold a whole
    // asset in memory. `Content-Length` comes from the open handle, so a concurrent re-drop of
    // `ortho.tif` (a rename onto the key) cannot desync it from what we send.
    let path = LocalStore::new(st.cfg.store_dir.clone()).path(&asset.path)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let bytes = file
        .metadata()
        .await
        .map_err(|e| ApiError::Internal(e.into()))?
        .len();
    let file_name = sanitize_file_name(Some(&asset.file_name), asset.id);
    let content_type = asset
        .content_type
        .unwrap_or_else(|| "application/octet-stream".into());
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CONTENT_LENGTH, bytes.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
            (header::CACHE_CONTROL, "private, max-age=60".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        Body::new(AsyncReadBody::with_capacity(file, DOWNLOAD_CHUNK_BYTES)),
    )
        .into_response())
}

// --- pipeline hand-off -----------------------------------------------------

/// Queue a stage and rewind the capture to that stage's input status. One row per
/// `(capture_id, stage)` for the lifetime of the capture — retries re-use it.
async fn enqueue(st: &AppState, org_id: Uuid, capture_id: Uuid, stage: &str) -> ApiResult<()> {
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO pipeline_jobs (org_id, capture_id, stage, state, attempts, run_after)
         VALUES ($1, $2, $3, 'queued', 0, now())
         ON CONFLICT (capture_id, stage) DO UPDATE
             SET state = 'queued', attempts = 0, run_after = now(), error = NULL,
                 started_at = NULL, finished_at = NULL, worker_id = NULL, updated_at = now()",
    )
    .bind(org_id)
    .bind(capture_id)
    .bind(stage)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE captures
         SET status = $3, failed_stage = NULL, error = NULL, processed_at = NULL,
             updated_at = now()
         WHERE id = $1 AND org_id = $2",
    )
    .bind(capture_id)
    .bind(org_id)
    .bind(stage_input_status(stage))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn count_assets(st: &AppState, org_id: Uuid, capture_id: Uuid, kind: &str) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT count(*) FROM capture_assets
         WHERE capture_id = $1 AND org_id = $2 AND kind = $3",
    )
    .bind(capture_id)
    .bind(org_id)
    .bind(kind)
    .fetch_one(&st.pool)
    .await?)
}

/// POST /captures/{id}/process — enqueue the first stage. Idempotent: a capture that already
/// has work in flight comes back unchanged instead of growing a duplicate job.
async fn process(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<(StatusCode, Json<CaptureRow>)> {
    user.require(Role::Operator)?;
    let cap = load_capture(&st, user.org_id, id).await?;

    let in_flight: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM pipeline_jobs
         WHERE capture_id = $1 AND org_id = $2 AND state IN ('queued', 'running')
         LIMIT 1",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&st.pool)
    .await?;
    if in_flight.is_some() {
        return Ok((StatusCode::ACCEPTED, Json(cap)));
    }

    // `prebuilt`/`demo` skip SfM: the ortho already exists (or is synthesised), so the capture
    // goes straight to `ortho` and the pipeline starts at `detect`.
    let stage = match cap.source.as_str() {
        "drone" => {
            if count_assets(&st, user.org_id, id, KIND_RAW).await? == 0 {
                return Err(ApiError::BadRequest(
                    "no raw imagery uploaded for this capture".into(),
                ));
            }
            "sfm"
        }
        "prebuilt" => {
            if count_assets(&st, user.org_id, id, KIND_ORTHO).await? == 0 {
                return Err(ApiError::BadRequest(
                    "no ortho uploaded for this capture".into(),
                ));
            }
            // Crown delineation is a canopy-height problem: no DSM, no tree/bush detection.
            if matches!(cap.unit_type.as_str(), "tree" | "bush")
                && count_assets(&st, user.org_id, id, KIND_DSM).await? == 0
            {
                return Err(ApiError::BadRequest(
                    "a dsm is required for tree/bush captures".into(),
                ));
            }
            "detect"
        }
        _ => "detect",
    };

    enqueue(&st, user.org_id, id, stage).await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "capture.process",
        "capture",
        id,
        json!({ "stage": stage, "source": cap.source }),
    )
    .await;
    Ok((
        StatusCode::ACCEPTED,
        Json(load_capture(&st, user.org_id, id).await?),
    ))
}

#[derive(Debug, Default, Deserialize)]
struct RetryBody {
    #[serde(default)]
    stage: Option<String>,
}

/// POST /captures/{id}/retry — re-queue a stage. Defaults to whatever failed; an explicit
/// stage may only rewind (never skip ahead of) the capture's current position.
async fn retry(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    body: Option<Json<RetryBody>>,
) -> ApiResult<(StatusCode, Json<CaptureRow>)> {
    user.require(Role::Operator)?;
    let cap = load_capture(&st, user.org_id, id).await?;
    let Json(body) = body.unwrap_or_default();

    let requested = body
        .stage
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| cap.failed_stage.clone())
        .ok_or_else(|| ApiError::BadRequest("no failed stage to retry — pass `stage`".into()))?;
    let index = stage_index(&requested)?;
    let stage = STAGES[index];

    if cap.status != "failed" && index > status_stage_index(&cap.status) {
        return Err(ApiError::Conflict(format!(
            "stage `{stage}` has not run yet on a `{}` capture",
            cap.status
        )));
    }

    enqueue(&st, user.org_id, id, stage).await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "capture.retry",
        "capture",
        id,
        json!({ "stage": stage, "from_status": cap.status }),
    )
    .await;
    Ok((
        StatusCode::ACCEPTED,
        Json(load_capture(&st, user.org_id, id).await?),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_numbers_decide_the_content_type() {
        assert_eq!(sniff(b"\xFF\xD8\xFFxx", KIND_RAW).unwrap().1, "jpg");
        assert_eq!(sniff(b"II*\0", KIND_RAW).unwrap().1, "tif");
        assert_eq!(sniff(b"MM\0*", KIND_ORTHO).unwrap().0, "image/tiff");
        assert_eq!(sniff(b"PK\x03\x04", KIND_RAW).unwrap().1, "zip");
        // A jpeg/zip is a valid raw photo but never an ortho, and junk is never anything.
        assert!(sniff(b"\xFF\xD8\xFFxx", KIND_ORTHO).is_err());
        assert!(sniff(b"PK\x03\x04", KIND_DSM).is_err());
        assert!(sniff(b"<htm", KIND_RAW).is_err());
        assert!(sniff(b"", KIND_RAW).is_err());
    }

    #[test]
    fn file_names_are_stripped_to_the_safe_alphabet() {
        let fallback = Uuid::nil();
        assert_eq!(
            sanitize_file_name(Some("DJI_0042.JPG"), fallback),
            "DJI_0042.JPG"
        );
        let traversal = sanitize_file_name(Some("../../etc/passwd"), fallback);
        assert!(
            !traversal.contains("..") && !traversal.contains('/'),
            "{traversal}"
        );
        assert!(traversal
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')));
        assert_eq!(sanitize_file_name(Some(".."), fallback), "_");
        // Nothing usable left → the asset id stands in.
        assert_eq!(
            sanitize_file_name(Some("."), fallback),
            fallback.to_string()
        );
        assert_eq!(sanitize_file_name(None, fallback), fallback.to_string());
        assert_eq!(
            sanitize_file_name(Some(&"a".repeat(400)), fallback).len(),
            MAX_FILE_NAME
        );
    }

    #[test]
    fn stage_order_drives_the_retry_gate() {
        assert_eq!(stage_index("sfm").unwrap(), 0);
        assert_eq!(stage_index("extract").unwrap(), 3);
        assert!(stage_index("rollup").is_err());
        assert_eq!(stage_input_status("detect"), "ortho");
        assert_eq!(stage_input_status("sfm"), "uploaded");
        // An `ortho` capture may redo sfm/detect but not register/extract.
        assert_eq!(status_stage_index("ortho"), 1);
        assert_eq!(status_stage_index("extracted"), 3);
    }

    #[test]
    fn bands_default_per_source_and_reject_junk() {
        assert_eq!(validate_bands(None, "demo").unwrap(), json!({}));
        assert_eq!(
            validate_bands(None, "drone").unwrap(),
            json!({ "red": 1, "green": 2, "blue": 3 })
        );
        assert!(validate_bands(Some(json!({ "nir": 4 })), "drone").is_ok());
        assert!(validate_bands(Some(json!({ "thermal": 4 })), "drone").is_err());
        assert!(validate_bands(Some(json!({ "nir": 0 })), "drone").is_err());
        assert!(validate_bands(Some(json!({ "nir": 17 })), "drone").is_err());
        assert!(validate_bands(Some(json!([1, 2])), "drone").is_err());
    }
}
