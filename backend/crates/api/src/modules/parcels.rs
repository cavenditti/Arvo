//! OWNER: be-parcels — parcels CRUD + GeoJSON import/export per docs/API.md §Parcels.
//! `router()` is the only public entry (mounted in routes.rs under /api/v1).
//! Geometry math lives in PostGIS (AGENTS.md §Backend patterns); no Rust geo crates.
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;
use crate::util::{read_image_field, require_len};

const MAX_IMPORT_FEATURES: usize = 1000;
const OPENROUTER_CHAT_COMPLETIONS_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_DEFAULT_MODEL: &str = "openai/gpt-5.6-sol";
const OPENROUTER_TIMEOUT_SECS: u64 = 25;
const CROP_KEYS: [&str; 6] = ["vine", "olive", "tomato", "wheat", "maize", "other"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parcels", get(list).post(create))
        .route(
            "/parcels/crop-detect",
            post(detect_crop)
                .layer(DefaultBodyLimit::max(12 * 1024 * 1024))
                .layer(axum::middleware::from_fn(crate::ratelimit::auth_rate_limit)),
        )
        .route("/parcels/import", post(import))
        .route("/parcels/export.geojson", get(export))
        .route("/parcels/{id}", get(get_one).patch(update).delete(archive))
        // Cover photo (FR-0-010b onboarding): up to 10 MB + multipart overhead.
        .route(
            "/parcels/{id}/photo",
            post(set_photo)
                .delete(delete_photo)
                .layer(DefaultBodyLimit::max(12 * 1024 * 1024)),
        )
}

/// Assert the parcel exists in the caller's org (cross-tenant → 404). The single shared
/// ownership guard used by every per-parcel module (weather, indices, scenes, reports, tiles)
/// so the check can never drift between them.
pub async fn assert_owned(pool: &PgPool, org_id: Uuid, parcel_id: Uuid) -> ApiResult<()> {
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM parcels WHERE id = $1 AND org_id = $2")
            .bind(parcel_id)
            .bind(org_id)
            .fetch_optional(pool)
            .await?;
    found.map(|_| ()).ok_or(ApiError::NotFound)
}

/// Validate optional descriptive fields shared by create/update/import.
fn validate_fields(
    name: Option<&str>,
    crop: Option<&str>,
    variety: Option<&str>,
    season_year: Option<i32>,
) -> ApiResult<()> {
    if let Some(n) = name {
        require_len("name", n, 200)?;
    }
    if let Some(c) = crop {
        require_len("crop", c, 100)?;
    }
    if let Some(v) = variety {
        require_len("variety", v, 100)?;
    }
    if let Some(y) = season_year {
        if !(1900..=2100).contains(&y) {
            return Err(ApiError::BadRequest(
                "season_year out of range (1900-2100)".into(),
            ));
        }
    }
    Ok(())
}

/// Column list shared by every read (SELECT and INSERT/UPDATE ... RETURNING).
/// Constant text only — safe to interpolate with `format!`.
const PARCEL_COLS: &str = "
    id, farm_id, name,
    ST_AsGeoJSON(geom)::text AS geometry_json,
    ST_Area(geom::geography) / 10000.0 AS area_ha,
    ST_X(ST_Centroid(geom)) AS centroid_lon,
    ST_Y(ST_Centroid(geom)) AS centroid_lat,
    ST_XMin(ST_Envelope(geom)) AS bbox_w,
    ST_YMin(ST_Envelope(geom)) AS bbox_s,
    ST_XMax(ST_Envelope(geom)) AS bbox_e,
    ST_YMax(ST_Envelope(geom)) AS bbox_n,
    crop, variety, planting_date, season_year, cadastral_ref, photo_path, archived, created_at";

#[derive(sqlx::FromRow)]
struct ParcelRow {
    id: Uuid,
    farm_id: Uuid,
    name: String,
    geometry_json: String,
    area_ha: f64,
    centroid_lon: f64,
    centroid_lat: f64,
    bbox_w: f64,
    bbox_s: f64,
    bbox_e: f64,
    bbox_n: f64,
    crop: Option<String>,
    variety: Option<String>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
    cadastral_ref: Option<String>,
    photo_path: Option<String>,
    archived: bool,
    created_at: DateTime<Utc>,
}

impl ParcelRow {
    /// The exact Parcel JSON shape from docs/API.md §Parcels.
    fn to_json(&self) -> ApiResult<Value> {
        let geometry: Value =
            serde_json::from_str(&self.geometry_json).map_err(|e| ApiError::Internal(e.into()))?;
        Ok(json!({
            "id": self.id,
            "farm_id": self.farm_id,
            "name": self.name,
            "geometry": geometry,
            "area_ha": self.area_ha,
            "centroid": { "lon": self.centroid_lon, "lat": self.centroid_lat },
            "bbox": [self.bbox_w, self.bbox_s, self.bbox_e, self.bbox_n],
            "crop": self.crop,
            "variety": self.variety,
            "planting_date": self.planting_date,
            "season_year": self.season_year,
            "cadastral_ref": self.cadastral_ref,
            "photo_path": self.photo_path,
            "archived": self.archived,
            "created_at": self.created_at,
        }))
    }
}

/// Validate that the farm exists in the caller's org (task: farm-belongs-to-org → 400).
async fn ensure_farm(pool: &PgPool, org_id: Uuid, farm_id: Uuid) -> ApiResult<()> {
    let found: Option<Uuid> =
        sqlx::query_scalar("SELECT id FROM farms WHERE id = $1 AND org_id = $2")
            .bind(farm_id)
            .bind(org_id)
            .fetch_optional(pool)
            .await?;
    if found.is_none() {
        return Err(ApiError::BadRequest("farm not found in this org".into()));
    }
    Ok(())
}

/// Validate GeoJSON geometry: Polygon/MultiPolygon, ST_IsValid, area ≤ 10000 ha.
/// Any failure (incl. PostGIS parse errors) surfaces as `BadRequest`, never Internal.
async fn validate_geometry(pool: &PgPool, geometry: &Value) -> ApiResult<()> {
    let gtype = geometry.get("type").and_then(Value::as_str);
    if !matches!(gtype, Some("Polygon") | Some("MultiPolygon")) {
        return Err(ApiError::BadRequest(
            "geometry must be a GeoJSON Polygon or MultiPolygon".into(),
        ));
    }
    let (valid, area_ha): (bool, f64) = sqlx::query_as(
        "SELECT ST_IsValid(g), ST_Area(g::geography) / 10000.0
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) s",
    )
    .bind(geometry.to_string())
    .fetch_one(pool)
    .await
    // A malformed geometry makes PostGIS raise a DB error — that's a client error.
    .map_err(|e| match e {
        sqlx::Error::Database(_) => ApiError::BadRequest("invalid geometry".into()),
        other => ApiError::from(other),
    })?;
    if !valid {
        return Err(ApiError::BadRequest(
            "geometry is not topologically valid".into(),
        ));
    }
    if area_ha > 10_000.0 {
        return Err(ApiError::BadRequest(format!(
            "parcel area {area_ha:.1} ha exceeds the 10000 ha limit"
        )));
    }
    Ok(())
}

/// Insert one parcel and return the full read shape. Caller validates geometry/farm first.
/// Generic over the executor so import can run every insert inside one transaction.
#[allow(clippy::too_many_arguments)]
async fn insert_parcel<'e, E: sqlx::PgExecutor<'e>>(
    exec: E,
    org_id: Uuid,
    farm_id: Uuid,
    name: &str,
    geometry: &Value,
    crop: Option<&str>,
    variety: Option<&str>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
    cadastral_ref: Option<&str>,
) -> ApiResult<ParcelRow> {
    let sql = format!(
        "INSERT INTO parcels (org_id, farm_id, name, geom, crop, variety, planting_date, season_year, cadastral_ref)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), $5, $6, $7, $8, $9)
         RETURNING {PARCEL_COLS}"
    );
    let row = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(org_id)
        .bind(farm_id)
        .bind(name)
        .bind(geometry.to_string())
        .bind(crop)
        .bind(variety)
        .bind(planting_date)
        .bind(season_year)
        .bind(cadastral_ref)
        .fetch_one(exec)
        .await?;
    Ok(row)
}

#[derive(Deserialize)]
struct ListQuery {
    farm_id: Option<Uuid>,
    #[serde(default)]
    include_archived: bool,
}

async fn list(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    let sql = format!(
        "SELECT {PARCEL_COLS} FROM parcels
         WHERE org_id = $1
           AND ($2::uuid IS NULL OR farm_id = $2)
           AND ($3 OR archived = false)
         ORDER BY created_at DESC"
    );
    let rows = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(user.org_id)
        .bind(q.farm_id)
        .bind(q.include_archived)
        .fetch_all(&st.pool)
        .await?;
    let out = rows
        .iter()
        .map(ParcelRow::to_json)
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CreateParcel {
    farm_id: Uuid,
    name: String,
    geometry: Value,
    crop: Option<String>,
    variety: Option<String>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
    /// Provenance when the boundary came from the cadastre (FR-0-010b).
    cadastral_ref: Option<String>,
}

async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateParcel>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    validate_fields(
        Some(name),
        body.crop.as_deref(),
        body.variety.as_deref(),
        body.season_year,
    )?;
    let cadastral_ref = body
        .cadastral_ref
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(r) = cadastral_ref {
        require_len("cadastral_ref", r, 100)?;
    }
    ensure_farm(&st.pool, user.org_id, body.farm_id).await?;
    validate_geometry(&st.pool, &body.geometry).await?;
    let row = insert_parcel(
        &st.pool,
        user.org_id,
        body.farm_id,
        name,
        &body.geometry,
        body.crop.as_deref(),
        body.variety.as_deref(),
        body.planting_date,
        body.season_year,
        cadastral_ref,
    )
    .await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "parcel.create",
        "parcel",
        row.id,
        json!({ "name": row.name, "farm_id": row.farm_id, "area_ha": row.area_ha }),
    )
    .await;
    start_first_imagery_refresh(st.clone(), row.id, row.geometry_json.clone());
    Ok((StatusCode::CREATED, Json(row.to_json()?)))
}

/// Start the first satellite pass as soon as a field exists. On a lightweight build this still
/// catalogs scenes; the normal local server is an imagery build and also computes the indices.
/// Onboarding must never fail because an external imagery provider is slow or unavailable.
fn start_first_imagery_refresh(st: AppState, parcel_id: Uuid, geometry_json: String) {
    tokio::spawn(async move {
        match crate::imagery::refresh_scenes(
            &st,
            parcel_id,
            &geometry_json,
            crate::imagery::DEFAULT_REFRESH_DAYS,
        )
        .await
        {
            Ok(outcome) => tracing::info!(
                parcel = %parcel_id,
                found = outcome.found,
                new = outcome.new,
                computed = outcome.computed,
                "initial parcel imagery refresh complete"
            ),
            Err(error) => tracing::warn!(
                parcel = %parcel_id,
                error = ?error,
                "initial parcel imagery refresh failed; manual retry remains available"
            ),
        }
    });
}

#[derive(Deserialize, Default)]
struct DetectCropQuery {
    lang: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CropDetection {
    crop: String,
    confidence: f64,
    reason: String,
}

/// POST /parcels/crop-detect?lang=it|en — analyze one field photo without persisting it.
/// The API key remains server-side. The caller treats the answer as a suggestion and the farmer
/// always confirms or overrides it before the parcel is created.
async fn detect_crop(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<DetectCropQuery>,
    mut multipart: Multipart,
) -> ApiResult<Json<CropDetection>> {
    user.require(Role::Operator)?;
    let api_key = std::env::var("OPENROUTER_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            ApiError::Upstream("crop recognition is not configured on this server".into())
        })?;
    let model = std::env::var("OPENROUTER_MODEL")
        .ok()
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| OPENROUTER_DEFAULT_MODEL.into());
    let lang = crate::util::resolve_lang(&st, user.user_id, q.lang).await;
    let answer_language = match lang {
        crate::util::Lang::It => "Italian",
        crate::util::Lang::En => "English",
    };
    let (bytes, ext) = read_image_field(&mut multipart).await?;
    let mime = if ext == "png" {
        "image/png"
    } else {
        "image/jpeg"
    };
    let image_url = format!("data:{mime};base64,{}", encode_base64(&bytes));

    let prompt = format!(
        "Identify the main cultivated crop visible in this agricultural field photo. \
         Choose exactly one crop key from vine, olive, tomato, wheat, maize, other. \
         Use other when the photo is unclear, contains no crop, or shows a crop outside the list. \
         Confidence must reflect visual certainty, not plausibility. Give one short reason in \
         {answer_language}. This is only a suggestion for the farmer to confirm."
    );
    let payload = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image_url } }
            ]
        }],
        // Do not silently route to a provider that ignores the schema: a failed suggestion is
        // safer than presenting an unconstrained crop classification to the farmer.
        "provider": { "require_parameters": true },
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "crop_detection",
                "strict": true,
                "schema": {
                    "type": "object",
                    "properties": {
                        "crop": { "type": "string", "enum": CROP_KEYS },
                        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                        "reason": { "type": "string" }
                    },
                    "required": ["crop", "confidence", "reason"],
                    "additionalProperties": false
                }
            }
        }
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(OPENROUTER_TIMEOUT_SECS))
        .build()
        .map_err(|e| ApiError::Internal(e.into()))?;
    let response = client
        .post(OPENROUTER_CHAT_COMPLETIONS_URL)
        .bearer_auth(api_key)
        .header("HTTP-Referer", "https://arvo.local")
        .header("X-OpenRouter-Title", "Arvo")
        .json(&payload)
        .send()
        .await
        .map_err(|error| {
            tracing::warn!(error = ?error, "crop recognition request failed");
            ApiError::Upstream("crop recognition is temporarily unavailable".into())
        })?;
    let status = response.status();
    if !status.is_success() {
        tracing::warn!(%status, "crop recognition provider rejected the request");
        return Err(ApiError::Upstream(
            "crop recognition is temporarily unavailable".into(),
        ));
    }
    let response_json: Value = response.json().await.map_err(|error| {
        tracing::warn!(error = ?error, "crop recognition response was not JSON");
        ApiError::Upstream("crop recognition returned an invalid response".into())
    })?;
    let output_text = response_output_text(&response_json)
        .ok_or_else(|| ApiError::Upstream("crop recognition returned no classification".into()))?;
    let mut detection: CropDetection = serde_json::from_str(output_text).map_err(|error| {
        tracing::warn!(error = ?error, "crop recognition output did not match its schema");
        ApiError::Upstream("crop recognition returned an invalid classification".into())
    })?;
    if !CROP_KEYS.contains(&detection.crop.as_str()) {
        detection.crop = "other".into();
        detection.confidence = 0.0;
    }
    detection.confidence = detection.confidence.clamp(0.0, 1.0);
    Ok(Json(detection))
}

fn response_output_text(response: &Value) -> Option<&str> {
    response
        .get("choices")?
        .as_array()?
        .first()?
        .get("message")?
        .get("content")?
        .as_str()
}

/// Small local encoder avoids introducing a crate solely for one authenticated upstream call.
fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let a = chunk[0];
        let b = *chunk.get(1).unwrap_or(&0);
        let c = *chunk.get(2).unwrap_or(&0);
        out.push(TABLE[(a >> 2) as usize] as char);
        out.push(TABLE[(((a & 0x03) << 4) | (b >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(((b & 0x0f) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(c & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

async fn get_one(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let sql = format!("SELECT {PARCEL_COLS} FROM parcels WHERE id = $1 AND org_id = $2");
    let row = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(id)
        .bind(user.org_id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(row.to_json()?))
}

/// Distinguishes "field omitted" (None) from "field set to null" (Some(None)) so PATCH can
/// actually clear nullable columns — plain Option can't represent both.
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

#[derive(Deserialize)]
struct PatchParcel {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    crop: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    variety: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    planting_date: Option<Option<NaiveDate>>,
    #[serde(default, deserialize_with = "double_option")]
    season_year: Option<Option<i32>>,
    geometry: Option<Value>,
    archived: Option<bool>,
}

async fn update(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchParcel>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let name = match &body.name {
        Some(n) if n.trim().is_empty() => {
            return Err(ApiError::BadRequest("name cannot be empty".into()))
        }
        Some(n) => Some(n.trim()),
        None => None,
    };
    validate_fields(
        name,
        body.crop.as_ref().and_then(|o| o.as_deref()),
        body.variety.as_ref().and_then(|o| o.as_deref()),
        body.season_year.flatten(),
    )?;
    if let Some(g) = &body.geometry {
        validate_geometry(&st.pool, g).await?;
    }
    let geometry_str = body.geometry.as_ref().map(Value::to_string);
    // Omitted fields keep their value; nullable fields sent as explicit null are cleared
    // (set-flag + value pairs); geometry replaced only when present.
    let sql = format!(
        "UPDATE parcels SET
            name = COALESCE($3, name),
            crop = CASE WHEN $4 THEN $5 ELSE crop END,
            variety = CASE WHEN $6 THEN $7 ELSE variety END,
            planting_date = CASE WHEN $8 THEN $9 ELSE planting_date END,
            season_year = CASE WHEN $10 THEN $11 ELSE season_year END,
            archived = COALESCE($12, archived),
            geom = CASE WHEN $13::text IS NOT NULL
                        THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($13), 4326))
                        ELSE geom END,
            updated_at = now()
         WHERE id = $1 AND org_id = $2
         RETURNING {PARCEL_COLS}"
    );
    let row = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(id)
        .bind(user.org_id)
        .bind(name)
        .bind(body.crop.is_some())
        .bind(body.crop.clone().flatten())
        .bind(body.variety.is_some())
        .bind(body.variety.clone().flatten())
        .bind(body.planting_date.is_some())
        .bind(body.planting_date.flatten())
        .bind(body.season_year.is_some())
        .bind(body.season_year.flatten())
        .bind(body.archived)
        .bind(geometry_str)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(ApiError::NotFound)?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "parcel.update",
        "parcel",
        id,
        json!({ "name": row.name }),
    )
    .await;
    Ok(Json(row.to_json()?))
}

async fn archive(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Operator)?;
    // Soft delete.
    let res = sqlx::query(
        "UPDATE parcels SET archived = true, updated_at = now() WHERE id = $1 AND org_id = $2",
    )
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
        "parcel.archive",
        "parcel",
        id,
        json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ImportBody {
    farm_id: Uuid,
    feature_collection: Value,
}

async fn import(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<ImportBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    ensure_farm(&st.pool, user.org_id, body.farm_id).await?;
    let features = body
        .feature_collection
        .get("features")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::BadRequest("feature_collection.features must be an array".into())
        })?;
    if features.len() > MAX_IMPORT_FEATURES {
        return Err(ApiError::BadRequest(format!(
            "too many features (max {MAX_IMPORT_FEATURES} per import)"
        )));
    }

    // All-or-nothing: a DB failure mid-import must not leave a partial batch behind
    // (a client retry would then duplicate the committed half).
    let mut created: Vec<Value> = Vec::new();
    let mut created_meta: Vec<(Uuid, String, String)> = Vec::new();
    let mut skipped: usize = 0;
    let mut tx = st.pool.begin().await?;
    for (i, feature) in features.iter().enumerate() {
        let geometry = match feature.get("geometry") {
            Some(g) if !g.is_null() => g,
            _ => {
                skipped += 1;
                continue;
            }
        };
        // Skip invalid features instead of failing the whole import.
        match validate_geometry(&st.pool, geometry).await {
            Ok(()) => {}
            Err(ApiError::BadRequest(_)) => {
                skipped += 1;
                continue;
            }
            Err(e) => return Err(e),
        }
        let props = feature.get("properties");
        let name = props
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Parcella {}", i + 1));
        require_len("name", &name, 200)?;
        let crop = props.and_then(|p| p.get("crop")).and_then(Value::as_str);
        if let Some(c) = crop {
            require_len("crop", c, 100)?;
        }
        // Cadastre-detected features arrive through this same bulk path with their
        // reference in properties, so provenance survives multi-select onboarding.
        let cadastral_ref = props
            .and_then(|p| p.get("cadastral_ref"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if let Some(r) = cadastral_ref {
            require_len("cadastral_ref", r, 100)?;
        }

        let row = insert_parcel(
            &mut *tx,
            user.org_id,
            body.farm_id,
            &name,
            geometry,
            crop,
            None,
            None,
            None,
            cadastral_ref,
        )
        .await?;
        created_meta.push((row.id, row.name.clone(), row.geometry_json.clone()));
        created.push(row.to_json()?);
    }
    tx.commit().await?;
    for (id, name, geometry_json) in created_meta {
        audit::record(
            &st.pool,
            user.org_id,
            Some(user.user_id),
            "parcel.create",
            "parcel",
            id,
            json!({ "name": name, "farm_id": body.farm_id, "source": "import" }),
        )
        .await;
        start_first_imagery_refresh(st.clone(), id, geometry_json);
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({ "created": created, "skipped": skipped })),
    ))
}

/// POST /parcels/{id}/photo — multipart field `file` (jpeg/png ≤ 10 MB). One cover photo
/// per parcel: a new upload replaces (and removes) the previous file.
async fn set_photo(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    let old_path: Option<String> = sqlx::query_scalar(
        "SELECT photo_path FROM parcels WHERE id = $1 AND org_id = $2 AND archived = false",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(ApiError::NotFound)?;

    let (data, ext) = read_image_field(&mut multipart).await?;

    let dir = st.cfg.upload_dir.join("parcels").join(id.to_string());
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let file_name = format!("{}.{ext}", Uuid::new_v4());
    tokio::fs::write(dir.join(&file_name), &data)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;

    let path = format!("/uploads/parcels/{id}/{file_name}");
    let res = sqlx::query(
        "UPDATE parcels SET photo_path = $1, updated_at = now() WHERE id = $2 AND org_id = $3",
    )
    .bind(&path)
    .bind(id)
    .bind(user.org_id)
    .execute(&st.pool)
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {}
        other => {
            // Don't leave an orphan file when the DB update failed.
            let _ = tokio::fs::remove_file(dir.join(&file_name)).await;
            other?;
            return Err(ApiError::NotFound);
        }
    }
    remove_photo_file(&st, id, old_path.as_deref()).await;

    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "parcel.photo",
        "parcel",
        id,
        json!({ "path": path }),
    )
    .await;
    Ok((StatusCode::CREATED, Json(json!({ "path": path }))))
}

/// DELETE /parcels/{id}/photo — clear the cover photo and remove its file.
async fn delete_photo(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Operator)?;
    // Lock + read the old path in the same statement that clears it, so a concurrent
    // upload can't slip a fresh file in between and have it deleted from under the row.
    let old_path: Option<Option<String>> = sqlx::query_scalar(
        "WITH old AS (
            SELECT id, photo_path FROM parcels WHERE id = $1 AND org_id = $2 FOR UPDATE
         )
         UPDATE parcels p SET photo_path = NULL, updated_at = now()
         FROM old WHERE p.id = old.id
         RETURNING old.photo_path",
    )
    .bind(id)
    .bind(user.org_id)
    .fetch_optional(&st.pool)
    .await?;
    let Some(old_path) = old_path else {
        return Err(ApiError::NotFound);
    };
    remove_photo_file(&st, id, old_path.as_deref()).await;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "parcel.photo_delete",
        "parcel",
        id,
        json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Best-effort removal of a replaced/cleared cover photo file. Only touches files inside
/// this parcel's own upload directory — the stored path is server-issued, but re-checking
/// here keeps a corrupted row from ever deleting outside it.
async fn remove_photo_file(st: &AppState, id: Uuid, path: Option<&str>) {
    let Some(p) = path else { return };
    let prefix = format!("/uploads/parcels/{id}/");
    let Some(file_name) = p.strip_prefix(&prefix) else {
        return;
    };
    if file_name.contains('/') || file_name.contains("..") {
        return;
    }
    let full = st
        .cfg
        .upload_dir
        .join("parcels")
        .join(id.to_string())
        .join(file_name);
    let _ = tokio::fs::remove_file(full).await;
}

#[derive(Deserialize)]
struct ExportQuery {
    farm_id: Option<Uuid>,
}

async fn export(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Json<Value>> {
    let sql = format!(
        "SELECT {PARCEL_COLS} FROM parcels
         WHERE org_id = $1 AND ($2::uuid IS NULL OR farm_id = $2) AND archived = false
         ORDER BY created_at DESC"
    );
    let rows = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(user.org_id)
        .bind(q.farm_id)
        .fetch_all(&st.pool)
        .await?;
    let mut features = Vec::with_capacity(rows.len());
    for row in &rows {
        // Feature.geometry holds the GeoJSON; every other parcel field becomes a property.
        let mut props = row.to_json()?;
        let geometry = props
            .as_object_mut()
            .and_then(|o| o.remove("geometry"))
            .unwrap_or(Value::Null);
        features.push(json!({
            "type": "Feature",
            "geometry": geometry,
            "properties": props,
        }));
    }
    Ok(Json(
        json!({ "type": "FeatureCollection", "features": features }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encoder_handles_padding() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn extracts_structured_response_text() {
        let response = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "{\"crop\":\"olive\",\"confidence\":0.91,\"reason\":\"Rows of olive trees\"}"
                }
            }]
        });
        assert_eq!(
            response_output_text(&response),
            Some("{\"crop\":\"olive\",\"confidence\":0.91,\"reason\":\"Rows of olive trees\"}")
        );
    }
}
