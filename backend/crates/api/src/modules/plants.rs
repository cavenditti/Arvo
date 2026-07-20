//! OWNER: be-plants — plants, blocks & rows, import/export.
//! Contract: docs/API-PLANT.md §Plants, §"Blocks & rows", §"Import & export".
//! Migration band 0070–0079 (`0070_plants.sql`).
//!
//! Crop-agnostic by construction (PHASE-PLANT §3): `unit_type` is the only thing that differs
//! between orchard, vineyard and horticulture — one schema, one API, one UI. Plant identity is
//! stable (FR-P-003): `DELETE` is a soft delete to `status = 'removed'` and nothing here ever
//! moves a plant's point except an explicit edit or an as-planted re-import.
//!
//! Geometry math lives in PostGIS (AGENTS.md §Backend patterns); no Rust geo crates.
use std::collections::HashMap;
use std::fmt::Write as _;

use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::modules::parcels::assert_owned;
use crate::security::{authenticate_bearer_or_media, AuthUser, Role};
use crate::state::AppState;
use crate::util::require_len;

/// Import bodies are as-planted maps — tens of thousands of points of JSON/CSV.
const IMPORT_BODY_LIMIT: usize = 32 * 1024 * 1024;
const MAX_IMPORT_FEATURES: usize = 50_000;
/// Only the first N per-feature reasons are echoed back; `skipped` still counts them all.
const MAX_IMPORT_ERRORS: usize = 20;
const MAX_EXPORT_FEATURES: i64 = 100_000;
const MAX_PLANTS_PER_PARCEL: i64 = 200_000;
const DEFAULT_LIST_LIMIT: i64 = 200;
const MAX_LIST_LIMIT: i64 = 1000;
/// A manually placed plant may sit slightly outside the surveyed boundary (headland trees,
/// GPS drift on the parcel polygon itself), so the in-parcel test is a 25 m buffer.
const PARCEL_BUFFER_M: f64 = 25.0;
/// Import does not pay for a per-point `ST_DWithin` (50k round trips); it rejects points outside
/// the parcel envelope grown by this margin instead. Generous enough for a sloppy as-planted map,
/// tight enough to catch the classic swapped lon/lat or wrong-CRS file.
const IMPORT_MARGIN_DEG: f64 = 0.05;

const UNIT_TYPES: [&str; 4] = ["tree", "vine", "row_segment", "bush"];
const STATUSES: [&str; 5] = ["alive", "dead", "missing", "replanted", "removed"];
/// Default list/export filter: everything except the soft-deleted rows.
const ACTIVE_STATUSES: [&str; 4] = ["alive", "dead", "missing", "replanted"];
const PLANT_METRICS: [&str; 7] = [
    "ndvi",
    "ndre",
    "gndvi",
    "ndmi",
    "savi",
    "canopy_m2",
    "height_m",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/plants", get(list).post(create))
        // Static siblings of `/plants/{id}` — matchit 0.8 backtracks, this is not a conflict.
        .route(
            "/plants/import",
            post(import_geojson).layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT)),
        )
        .route(
            "/plants/import.csv",
            post(import_csv).layer(DefaultBodyLimit::max(IMPORT_BODY_LIMIT)),
        )
        .route("/plants/export.geojson", get(export_geojson))
        .route("/plants/export.csv", get(export_csv))
        .route("/plants/{id}", get(get_one).patch(update).delete(remove))
        .route("/plants/{id}/status", post(set_status))
        .route(
            "/parcels/{id}/plant-blocks",
            get(list_blocks).post(create_block),
        )
        .route(
            "/plant-blocks/{id}",
            patch(update_block).delete(delete_block),
        )
        .route("/parcels/{id}/plant-rows", get(list_rows).post(create_row))
        .route("/plant-rows/{id}", patch(update_row).delete(delete_row))
}

// --- shared shapes ---------------------------------------------------------

/// Column list shared by every plant read. Constant text only — safe to `format!`.
/// Enums come back as `text` so no custom sqlx type registration is needed anywhere.
const PLANT_COLS: &str = "
    p.id, p.parcel_id, p.block_id, b.name AS block_name, p.row_id, r.name AS row_name,
    p.unit_type::text AS unit_type,
    ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat,
    ST_AsGeoJSON(p.crown_geom)::text AS crown_json,
    p.label, p.row_index, p.col_index, p.variety, p.rootstock, p.planted_on,
    p.status::text AS status, p.external_ref, p.source, p.created_at, p.updated_at";

const PLANT_FROM: &str = "
    plants p
    LEFT JOIN plant_blocks b ON b.id = p.block_id
    LEFT JOIN plant_rows r ON r.id = p.row_id";

#[derive(sqlx::FromRow)]
struct PlantRow {
    id: Uuid,
    parcel_id: Uuid,
    block_id: Option<Uuid>,
    block_name: Option<String>,
    row_id: Option<Uuid>,
    row_name: Option<String>,
    unit_type: String,
    lon: f64,
    lat: f64,
    crown_json: Option<String>,
    label: Option<String>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    variety: Option<String>,
    rootstock: Option<String>,
    planted_on: Option<NaiveDate>,
    status: String,
    external_ref: Option<String>,
    source: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl PlantRow {
    /// The exact Plant JSON shape from docs/API-PLANT.md §Types.
    fn to_json(&self) -> ApiResult<Value> {
        let crown = match &self.crown_json {
            Some(s) => serde_json::from_str(s).map_err(|e| ApiError::Internal(e.into()))?,
            None => Value::Null,
        };
        Ok(json!({
            "id": self.id,
            "parcel_id": self.parcel_id,
            "block_id": self.block_id,
            "block_name": self.block_name,
            "row_id": self.row_id,
            "row_name": self.row_name,
            "unit_type": self.unit_type,
            "lon": self.lon,
            "lat": self.lat,
            "crown": crown,
            "label": self.label,
            "row_index": self.row_index,
            "col_index": self.col_index,
            "variety": self.variety,
            "rootstock": self.rootstock,
            "planted_on": self.planted_on,
            "status": self.status,
            "external_ref": self.external_ref,
            "source": self.source,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }))
    }
}

/// `Page<T>` per docs/API-PLANT.md §Types — `total` is the exact filtered count.
fn page(items: Vec<Value>, total: i64, limit: i64, offset: i64) -> Value {
    let has_more = offset + (items.len() as i64) < total;
    json!({
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
    })
}

async fn fetch_plant(pool: &PgPool, org_id: Uuid, id: Uuid) -> ApiResult<PlantRow> {
    let sql = format!("SELECT {PLANT_COLS} FROM {PLANT_FROM} WHERE p.id = $1 AND p.org_id = $2");
    sqlx::query_as::<_, PlantRow>(&sql)
        .bind(id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ApiError::NotFound)
}

// --- validation helpers ----------------------------------------------------

/// Distinguishes "field omitted" (None) from "field set to null" (Some(None)) so PATCH can
/// actually clear nullable columns — plain Option can't represent both (same rule as parcels).
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

fn normalize_unit(raw: Option<&str>) -> ApiResult<&'static str> {
    let want = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("tree");
    UNIT_TYPES
        .into_iter()
        .find(|u| u.eq_ignore_ascii_case(want))
        .ok_or_else(|| ApiError::BadRequest(format!("unknown unit_type '{want}'")))
}

fn normalize_status(raw: &str) -> ApiResult<&'static str> {
    let want = raw.trim();
    STATUSES
        .into_iter()
        .find(|s| s.eq_ignore_ascii_case(want))
        .ok_or_else(|| ApiError::BadRequest(format!("unknown status '{want}'")))
}

fn normalize_metric(raw: &str) -> ApiResult<&'static str> {
    let want = raw.trim();
    PLANT_METRICS
        .into_iter()
        .find(|m| m.eq_ignore_ascii_case(want))
        .ok_or_else(|| ApiError::BadRequest(format!("unknown metric '{want}'")))
}

/// The frozen status lifecycle (FR-P-003). `removed` is terminal — a soft-deleted plant stays
/// deleted. Re-asserting the current status is allowed so a retried request is idempotent.
fn transition_allowed(from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }
    match from {
        "alive" => matches!(to, "dead" | "missing" | "removed"),
        "dead" | "missing" => matches!(to, "replanted" | "removed" | "alive"),
        "replanted" => matches!(to, "alive" | "dead" | "missing" | "removed"),
        _ => false,
    }
}

fn check_lonlat(lon: f64, lat: f64) -> ApiResult<()> {
    if !lon.is_finite()
        || !lat.is_finite()
        || !(-180.0..=180.0).contains(&lon)
        || !(-90.0..=90.0).contains(&lat)
    {
        return Err(ApiError::BadRequest("lon/lat out of range".into()));
    }
    Ok(())
}

/// Validate the optional descriptive fields shared by create/update/import.
fn validate_fields(
    label: Option<&str>,
    variety: Option<&str>,
    rootstock: Option<&str>,
    external_ref: Option<&str>,
) -> ApiResult<()> {
    if let Some(v) = label {
        require_len("label", v, 64)?;
    }
    if let Some(v) = variety {
        require_len("variety", v, 100)?;
    }
    if let Some(v) = rootstock {
        require_len("rootstock", v, 100)?;
    }
    if let Some(v) = external_ref {
        require_len("external_ref", v, 128)?;
    }
    Ok(())
}

/// Validate a GeoJSON geometry: allowed type + PostGIS-parsable + topologically valid.
/// Returns the string to bind. A malformed geometry is a client error, never a 500.
async fn validate_geometry(pool: &PgPool, geometry: &Value, allowed: &[&str]) -> ApiResult<String> {
    let gtype = geometry.get("type").and_then(Value::as_str).unwrap_or("");
    if !allowed.contains(&gtype) {
        return Err(ApiError::BadRequest(format!(
            "geometry must be a GeoJSON {}",
            allowed.join(" or ")
        )));
    }
    let raw = geometry.to_string();
    let valid: bool =
        sqlx::query_scalar("SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))")
            .bind(&raw)
            .fetch_one(pool)
            .await
            .map_err(|e| match e {
                sqlx::Error::Database(_) => ApiError::BadRequest("invalid geometry".into()),
                other => ApiError::from(other),
            })?;
    if !valid {
        return Err(ApiError::BadRequest(
            "geometry is not topologically valid".into(),
        ));
    }
    Ok(raw)
}

/// The parcel exists in the caller's org AND the point falls inside it (25 m buffer).
/// A parcel that is not the caller's is a 404 — cross-tenant probes never leak existence.
async fn assert_point_in_parcel(
    pool: &PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    lon: f64,
    lat: f64,
) -> ApiResult<()> {
    check_lonlat(lon, lat)?;
    let inside: Option<bool> = sqlx::query_scalar(
        "SELECT ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5)
         FROM parcels WHERE id = $1 AND org_id = $2",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(lon)
    .bind(lat)
    .bind(PARCEL_BUFFER_M)
    .fetch_optional(pool)
    .await?;
    match inside {
        None => Err(ApiError::NotFound),
        Some(false) => Err(ApiError::BadRequest("plant outside parcel".into())),
        Some(true) => Ok(()),
    }
}

/// A block/row referenced by a plant must live in the same parcel (contract: else 400).
async fn assert_group_in_parcel(
    pool: &PgPool,
    table: &str,
    org_id: Uuid,
    parcel_id: Uuid,
    id: Uuid,
) -> ApiResult<()> {
    let sql = format!("SELECT id FROM {table} WHERE id = $1 AND org_id = $2 AND parcel_id = $3");
    let found: Option<Uuid> = sqlx::query_scalar(&sql)
        .bind(id)
        .bind(org_id)
        .bind(parcel_id)
        .fetch_optional(pool)
        .await?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::BadRequest(format!("{table} not found in this parcel")))
}

/// Turn the two constraint violations a plant write can legitimately hit into client errors:
/// the per-parcel `external_ref` uniqueness (409) and the `source` CHECK / FKs (400).
fn map_write_err(e: sqlx::Error) -> ApiError {
    match &e {
        sqlx::Error::Database(db) => match db.code().as_deref() {
            Some("23505") => ApiError::Conflict("external_ref already used in this parcel".into()),
            Some("23503") | Some("23514") => {
                ApiError::BadRequest("invalid reference or value".into())
            }
            _ => ApiError::from(e),
        },
        _ => ApiError::from(e),
    }
}

/// Reject a write that would push the parcel past the contract's per-parcel ceiling.
/// Soft-deleted plants don't count, otherwise a heavily-churned parcel would lock itself out.
async fn assert_capacity(pool: &PgPool, parcel_id: Uuid, adding: i64) -> ApiResult<()> {
    let existing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM plants WHERE parcel_id = $1 AND status <> 'removed'",
    )
    .bind(parcel_id)
    .fetch_one(pool)
    .await?;
    if existing + adding > MAX_PLANTS_PER_PARCEL {
        return Err(ApiError::BadRequest(format!(
            "parcel plant limit reached (max {MAX_PLANTS_PER_PARCEL})"
        )));
    }
    Ok(())
}

// --- plants: list / get ----------------------------------------------------

#[derive(Deserialize)]
struct ListQuery {
    parcel_id: Option<Uuid>,
    block_id: Option<Uuid>,
    row_id: Option<Uuid>,
    status: Option<String>,
    unit_type: Option<String>,
    bbox: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// `status` is a comma list; absent → everything except the soft-deleted `removed`.
fn parse_status_filter(raw: Option<&str>) -> ApiResult<Vec<String>> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(ACTIVE_STATUSES.iter().map(|s| s.to_string()).collect());
    };
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let s = normalize_status(part)?;
        if !out.iter().any(|x| x == s) {
            out.push(s.to_string());
        }
    }
    if out.is_empty() {
        return Err(ApiError::BadRequest("status filter is empty".into()));
    }
    Ok(out)
}

/// `bbox=w,s,e,n` → the four `ST_MakeEnvelope` corners.
fn parse_bbox(raw: Option<&str>) -> ApiResult<[Option<f64>; 4]> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok([None; 4]);
    };
    let nums: Vec<f64> = raw
        .split(',')
        .map(|s| s.trim().parse::<f64>().ok())
        .collect::<Option<Vec<f64>>>()
        .ok_or_else(|| ApiError::BadRequest("bbox must be w,s,e,n".into()))?;
    if nums.len() != 4
        || !nums.iter().all(|v| v.is_finite())
        || nums[0] > nums[2]
        || nums[1] > nums[3]
    {
        return Err(ApiError::BadRequest("bbox must be w,s,e,n".into()));
    }
    Ok([Some(nums[0]), Some(nums[1]), Some(nums[2]), Some(nums[3])])
}

/// `%`/`_`/`\` are LIKE metacharacters; escape them so a search for "R_1" is literal.
fn like_pattern(q: &str) -> String {
    let escaped = q
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

#[derive(sqlx::FromRow)]
struct PlantListRow {
    #[sqlx(flatten)]
    plant: PlantRow,
    total: i64,
}

/// GET /plants — paginated, org-scoped, stably ordered. One of `parcel_id`/`block_id`/`row_id`
/// is required: an unbounded org-wide scan over a tens-of-thousands-per-parcel table is never
/// something a client should be able to ask for by accident.
async fn list(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    if q.parcel_id.is_none() && q.block_id.is_none() && q.row_id.is_none() {
        return Err(ApiError::BadRequest(
            "one of parcel_id, block_id or row_id is required".into(),
        ));
    }
    let statuses = parse_status_filter(q.status.as_deref())?;
    let unit = match q
        .unit_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(u) => Some(normalize_unit(Some(u))?),
        None => None,
    };
    let bbox = parse_bbox(q.bbox.as_deref())?;
    let search = match q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            require_len("q", s, 64)?;
            Some(like_pattern(s))
        }
        None => None,
    };
    let limit = q
        .limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, MAX_LIST_LIMIT);
    let offset = q.offset.unwrap_or(0).max(0);

    let sql = format!(
        "SELECT {PLANT_COLS}, COUNT(*) OVER () AS total
         FROM {PLANT_FROM}
         WHERE p.org_id = $1
           AND ($2::uuid IS NULL OR p.parcel_id = $2)
           AND ($3::uuid IS NULL OR p.block_id = $3)
           AND ($4::uuid IS NULL OR p.row_id = $4)
           AND p.status::text = ANY($5::text[])
           AND ($6::text IS NULL OR p.unit_type::text = $6)
           AND ($7::float8 IS NULL OR p.geom && ST_MakeEnvelope($7, $8, $9, $10, 4326))
           AND ($11::text IS NULL OR p.label ILIKE $11 OR p.external_ref ILIKE $11)
         ORDER BY p.row_index NULLS LAST, p.col_index NULLS LAST, p.id
         LIMIT $12 OFFSET $13"
    );
    let rows = sqlx::query_as::<_, PlantListRow>(&sql)
        .bind(user.org_id)
        .bind(q.parcel_id)
        .bind(q.block_id)
        .bind(q.row_id)
        .bind(&statuses)
        .bind(unit)
        .bind(bbox[0])
        .bind(bbox[1])
        .bind(bbox[2])
        .bind(bbox[3])
        .bind(search)
        .bind(limit)
        .bind(offset)
        .fetch_all(&st.pool)
        .await?;

    let total = rows.first().map(|r| r.total).unwrap_or(0);
    let items = rows
        .iter()
        .map(|r| r.plant.to_json())
        .collect::<ApiResult<Vec<_>>>()?;
    Ok(Json(page(items, total, limit, offset)))
}

async fn get_one(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<Value>> {
    let row = fetch_plant(&st.pool, user.org_id, id).await?;
    Ok(Json(row.to_json()?))
}

// --- plants: create / update / delete / status -----------------------------

#[derive(Deserialize)]
struct CreatePlant {
    parcel_id: Uuid,
    lon: f64,
    lat: f64,
    unit_type: Option<String>,
    label: Option<String>,
    block_id: Option<Uuid>,
    row_id: Option<Uuid>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    variety: Option<String>,
    rootstock: Option<String>,
    planted_on: Option<NaiveDate>,
    status: Option<String>,
    external_ref: Option<String>,
    crown: Option<Value>,
}

async fn create(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreatePlant>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    let unit = normalize_unit(body.unit_type.as_deref())?;
    let status = match body.status.as_deref() {
        Some(s) => normalize_status(s)?,
        None => "alive",
    };
    validate_fields(
        body.label.as_deref(),
        body.variety.as_deref(),
        body.rootstock.as_deref(),
        body.external_ref.as_deref(),
    )?;
    assert_point_in_parcel(&st.pool, user.org_id, body.parcel_id, body.lon, body.lat).await?;
    assert_capacity(&st.pool, body.parcel_id, 1).await?;
    if let Some(bid) = body.block_id {
        assert_group_in_parcel(&st.pool, "plant_blocks", user.org_id, body.parcel_id, bid).await?;
    }
    if let Some(rid) = body.row_id {
        assert_group_in_parcel(&st.pool, "plant_rows", user.org_id, body.parcel_id, rid).await?;
    }
    let crown = match &body.crown {
        Some(g) if !g.is_null() => Some(validate_geometry(&st.pool, g, &["Polygon"]).await?),
        _ => None,
    };

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO plants (org_id, parcel_id, block_id, row_id, unit_type, geom, crown_geom,
                             label, row_index, col_index, variety, rootstock, planted_on,
                             status, external_ref, source)
         VALUES ($1, $2, $3, $4, $5::text::plant_unit,
                 ST_SetSRID(ST_MakePoint($6, $7), 4326),
                 CASE WHEN $8::text IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_GeomFromGeoJSON($8), 4326) END,
                 $9, $10, $11, $12, $13, $14, $15::text::plant_status, $16, 'manual')
         RETURNING id",
    )
    .bind(user.org_id)
    .bind(body.parcel_id)
    .bind(body.block_id)
    .bind(body.row_id)
    .bind(unit)
    .bind(body.lon)
    .bind(body.lat)
    .bind(crown)
    .bind(body.label.as_deref())
    .bind(body.row_index)
    .bind(body.col_index)
    .bind(body.variety.as_deref())
    .bind(body.rootstock.as_deref())
    .bind(body.planted_on)
    .bind(status)
    .bind(body.external_ref.as_deref())
    .fetch_one(&st.pool)
    .await
    .map_err(map_write_err)?;

    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant.create",
        "plant",
        id,
        json!({ "parcel_id": body.parcel_id, "unit_type": unit, "label": body.label }),
    )
    .await;
    let row = fetch_plant(&st.pool, user.org_id, id).await?;
    Ok((StatusCode::CREATED, Json(row.to_json()?)))
}

#[derive(Deserialize)]
struct PatchPlant {
    #[serde(default, deserialize_with = "double_option")]
    block_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    row_id: Option<Option<Uuid>>,
    unit_type: Option<String>,
    lon: Option<f64>,
    lat: Option<f64>,
    #[serde(default, deserialize_with = "double_option")]
    crown: Option<Option<Value>>,
    #[serde(default, deserialize_with = "double_option")]
    label: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    row_index: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    col_index: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    variety: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    rootstock: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    planted_on: Option<Option<NaiveDate>>,
    status: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    external_ref: Option<Option<String>>,
}

/// PATCH /plants/{id} — omitted fields keep their value, explicit `null` clears a nullable one.
/// `id`, `parcel_id` and `source` are not patchable (identity + provenance are stable).
async fn update(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchPlant>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let current = fetch_plant(&st.pool, user.org_id, id).await?;

    let unit = match body.unit_type.as_deref() {
        Some(u) => Some(normalize_unit(Some(u))?),
        None => None,
    };
    // The dedicated /status endpoint is the intended path, but the app writes whole rows back;
    // re-sending the current status must not 400, and an illegal jump must not sneak through.
    let status = match body.status.as_deref() {
        Some(s) => {
            let to = normalize_status(s)?;
            if !transition_allowed(&current.status, to) {
                return Err(ApiError::BadRequest(format!(
                    "illegal status transition {} → {to}",
                    current.status
                )));
            }
            Some(to)
        }
        None => None,
    };
    validate_fields(
        body.label.as_ref().and_then(|o| o.as_deref()),
        body.variety.as_ref().and_then(|o| o.as_deref()),
        body.rootstock.as_ref().and_then(|o| o.as_deref()),
        body.external_ref.as_ref().and_then(|o| o.as_deref()),
    )?;
    // Moving the plant re-runs the in-parcel check; both coordinates are needed for a point.
    let (lon, lat) = match (body.lon, body.lat) {
        (Some(lon), Some(lat)) => {
            assert_point_in_parcel(&st.pool, user.org_id, current.parcel_id, lon, lat).await?;
            (Some(lon), Some(lat))
        }
        (None, None) => (None, None),
        _ => {
            return Err(ApiError::BadRequest(
                "lon and lat must be sent together".into(),
            ))
        }
    };
    if let Some(Some(bid)) = body.block_id {
        assert_group_in_parcel(
            &st.pool,
            "plant_blocks",
            user.org_id,
            current.parcel_id,
            bid,
        )
        .await?;
    }
    if let Some(Some(rid)) = body.row_id {
        assert_group_in_parcel(&st.pool, "plant_rows", user.org_id, current.parcel_id, rid).await?;
    }
    let crown = match &body.crown {
        Some(Some(g)) if !g.is_null() => Some(validate_geometry(&st.pool, g, &["Polygon"]).await?),
        _ => None,
    };

    let affected = sqlx::query(
        "UPDATE plants SET
            block_id     = CASE WHEN $3  THEN $4  ELSE block_id END,
            row_id       = CASE WHEN $5  THEN $6  ELSE row_id END,
            unit_type    = COALESCE($7::text::plant_unit, unit_type),
            geom         = CASE WHEN $8::float8 IS NOT NULL
                                THEN ST_SetSRID(ST_MakePoint($8, $9), 4326) ELSE geom END,
            crown_geom   = CASE WHEN $10 THEN
                                CASE WHEN $11::text IS NULL THEN NULL
                                     ELSE ST_SetSRID(ST_GeomFromGeoJSON($11), 4326) END
                                ELSE crown_geom END,
            label        = CASE WHEN $12 THEN $13 ELSE label END,
            row_index    = CASE WHEN $14 THEN $15 ELSE row_index END,
            col_index    = CASE WHEN $16 THEN $17 ELSE col_index END,
            variety      = CASE WHEN $18 THEN $19 ELSE variety END,
            rootstock    = CASE WHEN $20 THEN $21 ELSE rootstock END,
            planted_on   = CASE WHEN $22 THEN $23 ELSE planted_on END,
            status       = COALESCE($24::text::plant_status, status),
            external_ref = CASE WHEN $25 THEN $26 ELSE external_ref END,
            updated_at   = now()
         WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(body.block_id.is_some())
    .bind(body.block_id.flatten())
    .bind(body.row_id.is_some())
    .bind(body.row_id.flatten())
    .bind(unit)
    .bind(lon)
    .bind(lat)
    .bind(body.crown.is_some())
    .bind(crown)
    .bind(body.label.is_some())
    .bind(body.label.clone().flatten())
    .bind(body.row_index.is_some())
    .bind(body.row_index.flatten())
    .bind(body.col_index.is_some())
    .bind(body.col_index.flatten())
    .bind(body.variety.is_some())
    .bind(body.variety.clone().flatten())
    .bind(body.rootstock.is_some())
    .bind(body.rootstock.clone().flatten())
    .bind(body.planted_on.is_some())
    .bind(body.planted_on.flatten())
    .bind(status)
    .bind(body.external_ref.is_some())
    .bind(body.external_ref.clone().flatten())
    .execute(&st.pool)
    .await
    .map_err(map_write_err)?;
    if affected.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant.update",
        "plant",
        id,
        json!({ "parcel_id": current.parcel_id, "moved": lon.is_some(), "status": status }),
    )
    .await;
    let row = fetch_plant(&st.pool, user.org_id, id).await?;
    Ok(Json(row.to_json()?))
}

/// DELETE /plants/{id} — soft: `status = 'removed'`, history preserved. No hard delete in P-MVP.
async fn remove(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Operator)?;
    let res = sqlx::query(
        "UPDATE plants SET status = 'removed', updated_at = now()
         WHERE id = $1 AND org_id = $2",
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
        "plant.delete",
        "plant",
        id,
        json!({ "soft": true }),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct StatusBody {
    status: String,
    note: Option<String>,
}

/// POST /plants/{id}/status — the app's "mark dead / replanted" action.
async fn set_status(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<StatusBody>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let to = normalize_status(&body.status)?;
    if let Some(note) = body.note.as_deref() {
        require_len("note", note, 2000)?;
    }
    let current = fetch_plant(&st.pool, user.org_id, id).await?;
    if !transition_allowed(&current.status, to) {
        return Err(ApiError::BadRequest(format!(
            "illegal status transition {} → {to}",
            current.status
        )));
    }
    sqlx::query(
        "UPDATE plants SET status = $3::text::plant_status, updated_at = now()
         WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(to)
    .execute(&st.pool)
    .await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant.status",
        "plant",
        id,
        json!({ "from": current.status, "to": to, "note": body.note }),
    )
    .await;
    let row = fetch_plant(&st.pool, user.org_id, id).await?;
    Ok(Json(row.to_json()?))
}

// --- blocks ----------------------------------------------------------------

const BLOCK_COLS: &str = "
    b.id, b.parcel_id, b.name,
    ST_AsGeoJSON(b.geom)::text AS geometry_json,
    b.notes,
    (SELECT COUNT(*) FROM plants p WHERE p.block_id = b.id AND p.status <> 'removed')
        AS plant_count,
    b.created_at, b.updated_at";

#[derive(sqlx::FromRow)]
struct BlockRow {
    id: Uuid,
    parcel_id: Uuid,
    name: String,
    geometry_json: Option<String>,
    notes: Option<String>,
    plant_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl BlockRow {
    fn to_json(&self) -> ApiResult<Value> {
        Ok(json!({
            "id": self.id,
            "parcel_id": self.parcel_id,
            "name": self.name,
            "geometry": parse_geometry_json(self.geometry_json.as_deref())?,
            "notes": self.notes,
            "plant_count": self.plant_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }))
    }
}

fn parse_geometry_json(raw: Option<&str>) -> ApiResult<Value> {
    match raw {
        Some(s) => serde_json::from_str(s).map_err(|e| ApiError::Internal(e.into())),
        None => Ok(Value::Null),
    }
}

async fn fetch_block(pool: &PgPool, org_id: Uuid, id: Uuid) -> ApiResult<BlockRow> {
    let sql = format!("SELECT {BLOCK_COLS} FROM plant_blocks b WHERE b.id = $1 AND b.org_id = $2");
    sqlx::query_as::<_, BlockRow>(&sql)
        .bind(id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ApiError::NotFound)
}

async fn list_blocks(
    State(st): State<AppState>,
    user: AuthUser,
    Path(parcel_id): Path<Uuid>,
) -> ApiResult<Json<Vec<Value>>> {
    assert_owned(&st.pool, user.org_id, parcel_id).await?;
    let sql = format!(
        "SELECT {BLOCK_COLS} FROM plant_blocks b
         WHERE b.parcel_id = $1 AND b.org_id = $2
         ORDER BY b.name ASC"
    );
    let rows = sqlx::query_as::<_, BlockRow>(&sql)
        .bind(parcel_id)
        .bind(user.org_id)
        .fetch_all(&st.pool)
        .await?;
    Ok(Json(
        rows.iter()
            .map(BlockRow::to_json)
            .collect::<ApiResult<_>>()?,
    ))
}

#[derive(Deserialize)]
struct CreateBlock {
    name: String,
    geometry: Option<Value>,
    notes: Option<String>,
}

async fn create_block(
    State(st): State<AppState>,
    user: AuthUser,
    Path(parcel_id): Path<Uuid>,
    Json(body): Json<CreateBlock>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    assert_owned(&st.pool, user.org_id, parcel_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    require_len("name", name, 200)?;
    if let Some(n) = body.notes.as_deref() {
        require_len("notes", n, 2000)?;
    }
    let geometry = match &body.geometry {
        Some(g) if !g.is_null() => {
            Some(validate_geometry(&st.pool, g, &["Polygon", "MultiPolygon"]).await?)
        }
        _ => None,
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO plant_blocks (org_id, parcel_id, name, geom, notes)
         VALUES ($1, $2, $3,
                 CASE WHEN $4::text IS NULL THEN NULL
                      ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)) END,
                 $5)
         RETURNING id",
    )
    .bind(user.org_id)
    .bind(parcel_id)
    .bind(name)
    .bind(geometry)
    .bind(body.notes.as_deref())
    .fetch_one(&st.pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            ApiError::Conflict("a block with this name already exists in the parcel".into())
        }
        _ => ApiError::from(e),
    })?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant_block.create",
        "plant_block",
        id,
        json!({ "parcel_id": parcel_id, "name": name }),
    )
    .await;
    let row = fetch_block(&st.pool, user.org_id, id).await?;
    Ok((StatusCode::CREATED, Json(row.to_json()?)))
}

#[derive(Deserialize)]
struct PatchBlock {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    geometry: Option<Option<Value>>,
    #[serde(default, deserialize_with = "double_option")]
    notes: Option<Option<String>>,
}

async fn update_block(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchBlock>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let name = match body.name.as_deref().map(str::trim) {
        Some("") => return Err(ApiError::BadRequest("name cannot be empty".into())),
        Some(n) => {
            require_len("name", n, 200)?;
            Some(n)
        }
        None => None,
    };
    if let Some(Some(n)) = body.notes.as_ref() {
        require_len("notes", n, 2000)?;
    }
    let geometry = match &body.geometry {
        Some(Some(g)) if !g.is_null() => {
            Some(validate_geometry(&st.pool, g, &["Polygon", "MultiPolygon"]).await?)
        }
        _ => None,
    };
    let res = sqlx::query(
        "UPDATE plant_blocks SET
            name  = COALESCE($3, name),
            geom  = CASE WHEN $4 THEN
                        CASE WHEN $5::text IS NULL THEN NULL
                             ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326)) END
                        ELSE geom END,
            notes = CASE WHEN $6 THEN $7 ELSE notes END,
            updated_at = now()
         WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(name)
    .bind(body.geometry.is_some())
    .bind(geometry)
    .bind(body.notes.is_some())
    .bind(body.notes.clone().flatten())
    .execute(&st.pool)
    .await
    .map_err(|e| match &e {
        sqlx::Error::Database(db) if db.code().as_deref() == Some("23505") => {
            ApiError::Conflict("a block with this name already exists in the parcel".into())
        }
        _ => ApiError::from(e),
    })?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant_block.update",
        "plant_block",
        id,
        json!({ "name": name }),
    )
    .await;
    let row = fetch_block(&st.pool, user.org_id, id).await?;
    Ok(Json(row.to_json()?))
}

/// DELETE /plant-blocks/{id} — the FK is ON DELETE SET NULL, so the plants survive ungrouped.
async fn delete_block(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Operator)?;
    let res = sqlx::query("DELETE FROM plant_blocks WHERE id = $1 AND org_id = $2")
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
        "plant_block.delete",
        "plant_block",
        id,
        json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- rows ------------------------------------------------------------------

const ROW_COLS: &str = "
    r.id, r.parcel_id, r.block_id, r.name, r.row_index,
    ST_AsGeoJSON(r.geom)::text AS geometry_json,
    (SELECT COUNT(*) FROM plants p WHERE p.row_id = r.id AND p.status <> 'removed')
        AS plant_count,
    r.created_at, r.updated_at";

#[derive(sqlx::FromRow)]
struct RowRow {
    id: Uuid,
    parcel_id: Uuid,
    block_id: Option<Uuid>,
    name: String,
    row_index: Option<i32>,
    geometry_json: Option<String>,
    plant_count: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl RowRow {
    fn to_json(&self) -> ApiResult<Value> {
        Ok(json!({
            "id": self.id,
            "parcel_id": self.parcel_id,
            "block_id": self.block_id,
            "name": self.name,
            "row_index": self.row_index,
            "geometry": parse_geometry_json(self.geometry_json.as_deref())?,
            "plant_count": self.plant_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }))
    }
}

async fn fetch_row(pool: &PgPool, org_id: Uuid, id: Uuid) -> ApiResult<RowRow> {
    let sql = format!("SELECT {ROW_COLS} FROM plant_rows r WHERE r.id = $1 AND r.org_id = $2");
    sqlx::query_as::<_, RowRow>(&sql)
        .bind(id)
        .bind(org_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ApiError::NotFound)
}

#[derive(Deserialize)]
struct RowListQuery {
    block_id: Option<Uuid>,
}

async fn list_rows(
    State(st): State<AppState>,
    user: AuthUser,
    Path(parcel_id): Path<Uuid>,
    Query(q): Query<RowListQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    assert_owned(&st.pool, user.org_id, parcel_id).await?;
    let sql = format!(
        "SELECT {ROW_COLS} FROM plant_rows r
         WHERE r.parcel_id = $1 AND r.org_id = $2 AND ($3::uuid IS NULL OR r.block_id = $3)
         ORDER BY r.row_index NULLS LAST, r.name ASC"
    );
    let rows = sqlx::query_as::<_, RowRow>(&sql)
        .bind(parcel_id)
        .bind(user.org_id)
        .bind(q.block_id)
        .fetch_all(&st.pool)
        .await?;
    Ok(Json(
        rows.iter().map(RowRow::to_json).collect::<ApiResult<_>>()?,
    ))
}

#[derive(Deserialize)]
struct CreateRow {
    name: String,
    block_id: Option<Uuid>,
    row_index: Option<i32>,
    geometry: Option<Value>,
}

async fn create_row(
    State(st): State<AppState>,
    user: AuthUser,
    Path(parcel_id): Path<Uuid>,
    Json(body): Json<CreateRow>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    assert_owned(&st.pool, user.org_id, parcel_id).await?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("name is required".into()));
    }
    require_len("name", name, 200)?;
    if let Some(bid) = body.block_id {
        assert_group_in_parcel(&st.pool, "plant_blocks", user.org_id, parcel_id, bid).await?;
    }
    let geometry = match &body.geometry {
        Some(g) if !g.is_null() => Some(validate_geometry(&st.pool, g, &["LineString"]).await?),
        _ => None,
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO plant_rows (org_id, parcel_id, block_id, name, row_index, geom)
         VALUES ($1, $2, $3, $4, $5,
                 CASE WHEN $6::text IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_GeomFromGeoJSON($6), 4326) END)
         RETURNING id",
    )
    .bind(user.org_id)
    .bind(parcel_id)
    .bind(body.block_id)
    .bind(name)
    .bind(body.row_index)
    .bind(geometry)
    .fetch_one(&st.pool)
    .await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant_row.create",
        "plant_row",
        id,
        json!({ "parcel_id": parcel_id, "name": name, "block_id": body.block_id }),
    )
    .await;
    let row = fetch_row(&st.pool, user.org_id, id).await?;
    Ok((StatusCode::CREATED, Json(row.to_json()?)))
}

#[derive(Deserialize)]
struct PatchRow {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    block_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    row_index: Option<Option<i32>>,
    #[serde(default, deserialize_with = "double_option")]
    geometry: Option<Option<Value>>,
}

async fn update_row(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(body): Json<PatchRow>,
) -> ApiResult<Json<Value>> {
    user.require(Role::Operator)?;
    let current = fetch_row(&st.pool, user.org_id, id).await?;
    let name = match body.name.as_deref().map(str::trim) {
        Some("") => return Err(ApiError::BadRequest("name cannot be empty".into())),
        Some(n) => {
            require_len("name", n, 200)?;
            Some(n)
        }
        None => None,
    };
    if let Some(Some(bid)) = body.block_id {
        assert_group_in_parcel(
            &st.pool,
            "plant_blocks",
            user.org_id,
            current.parcel_id,
            bid,
        )
        .await?;
    }
    let geometry = match &body.geometry {
        Some(Some(g)) if !g.is_null() => {
            Some(validate_geometry(&st.pool, g, &["LineString"]).await?)
        }
        _ => None,
    };
    let res = sqlx::query(
        "UPDATE plant_rows SET
            name      = COALESCE($3, name),
            block_id  = CASE WHEN $4 THEN $5 ELSE block_id END,
            row_index = CASE WHEN $6 THEN $7 ELSE row_index END,
            geom      = CASE WHEN $8 THEN
                            CASE WHEN $9::text IS NULL THEN NULL
                                 ELSE ST_SetSRID(ST_GeomFromGeoJSON($9), 4326) END
                            ELSE geom END,
            updated_at = now()
         WHERE id = $1 AND org_id = $2",
    )
    .bind(id)
    .bind(user.org_id)
    .bind(name)
    .bind(body.block_id.is_some())
    .bind(body.block_id.flatten())
    .bind(body.row_index.is_some())
    .bind(body.row_index.flatten())
    .bind(body.geometry.is_some())
    .bind(geometry)
    .execute(&st.pool)
    .await?;
    if res.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant_row.update",
        "plant_row",
        id,
        json!({ "name": name }),
    )
    .await;
    let row = fetch_row(&st.pool, user.org_id, id).await?;
    Ok(Json(row.to_json()?))
}

async fn delete_row(
    State(st): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> ApiResult<StatusCode> {
    user.require(Role::Operator)?;
    let res = sqlx::query("DELETE FROM plant_rows WHERE id = $1 AND org_id = $2")
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
        "plant_row.delete",
        "plant_row",
        id,
        json!({}),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

// --- import ----------------------------------------------------------------

/// One validated plant to upsert. Building this from a feature/CSV line is where every
/// per-record rejection happens, so the DB phase can be a straight all-or-nothing loop.
struct ImportRecord {
    lon: f64,
    lat: f64,
    label: Option<String>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    variety: Option<String>,
    rootstock: Option<String>,
    planted_on: Option<NaiveDate>,
    external_ref: Option<String>,
    status: Option<&'static str>,
    block: Option<String>,
    row: Option<String>,
}

/// Parcel envelope, the cheap sanity fence for bulk points (see `IMPORT_MARGIN_DEG`).
#[derive(sqlx::FromRow)]
struct ParcelBounds {
    w: f64,
    s: f64,
    e: f64,
    n: f64,
}

impl ParcelBounds {
    fn contains(&self, lon: f64, lat: f64) -> bool {
        lon >= self.w - IMPORT_MARGIN_DEG
            && lon <= self.e + IMPORT_MARGIN_DEG
            && lat >= self.s - IMPORT_MARGIN_DEG
            && lat <= self.n + IMPORT_MARGIN_DEG
    }
}

/// Doubles as the ownership guard: a parcel outside the caller's org is a 404.
async fn parcel_bounds(pool: &PgPool, org_id: Uuid, parcel_id: Uuid) -> ApiResult<ParcelBounds> {
    sqlx::query_as::<_, ParcelBounds>(
        "SELECT ST_XMin(e) AS w, ST_YMin(e) AS s, ST_XMax(e) AS e, ST_YMax(e) AS n
         FROM (SELECT ST_Envelope(geom) e FROM parcels WHERE id = $1 AND org_id = $2) g",
    )
    .bind(parcel_id)
    .bind(org_id)
    .fetch_optional(pool)
    .await?
    .ok_or(ApiError::NotFound)
}

/// Common field validation for one incoming record; `Err` is the human reason we skip it.
#[allow(clippy::too_many_arguments)]
fn build_record(
    bounds: &ParcelBounds,
    lon: f64,
    lat: f64,
    label: Option<String>,
    row_index: Option<i32>,
    col_index: Option<i32>,
    variety: Option<String>,
    rootstock: Option<String>,
    planted_on: Option<NaiveDate>,
    external_ref: Option<String>,
    status: Option<&str>,
    block: Option<String>,
    row: Option<String>,
) -> Result<ImportRecord, String> {
    check_lonlat(lon, lat).map_err(|_| "lon/lat out of range".to_string())?;
    if !bounds.contains(lon, lat) {
        return Err("point outside parcel".into());
    }
    validate_fields(
        label.as_deref(),
        variety.as_deref(),
        rootstock.as_deref(),
        external_ref.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    for (field, value) in [("block", &block), ("row", &row)] {
        if let Some(v) = value {
            require_len(field, v, 200).map_err(|e| e.to_string())?;
        }
    }
    let status = match status {
        Some(s) => Some(normalize_status(s).map_err(|e| e.to_string())?),
        None => None,
    };
    Ok(ImportRecord {
        lon,
        lat,
        label,
        row_index,
        col_index,
        variety,
        rootstock,
        planted_on,
        external_ref,
        status,
        block,
        row,
    })
}

/// Resolve a block *name* (case-insensitive, parcel-scoped) to an id, creating it when absent.
/// The unique index on `(parcel_id, lower(name))` makes the create race-safe.
async fn resolve_block(
    conn: &mut sqlx::PgConnection,
    org_id: Uuid,
    parcel_id: Uuid,
    name: &str,
    cache: &mut HashMap<String, Uuid>,
) -> ApiResult<Uuid> {
    let key = name.to_lowercase();
    if let Some(id) = cache.get(&key) {
        return Ok(*id);
    }
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM plant_blocks
         WHERE parcel_id = $1 AND org_id = $2 AND lower(name) = lower($3)",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                "INSERT INTO plant_blocks (org_id, parcel_id, name) VALUES ($1, $2, $3)
                 ON CONFLICT (parcel_id, lower(name)) DO UPDATE SET updated_at = now()
                 RETURNING id",
            )
            .bind(org_id)
            .bind(parcel_id)
            .bind(name)
            .fetch_one(&mut *conn)
            .await?
        }
    };
    cache.insert(key, id);
    Ok(id)
}

/// Same for rows. Row names are not unique per parcel (two blocks may both hold a row "1"), so
/// the lookup takes the lowest id on a tie — repeated imports then stay deterministic.
async fn resolve_row(
    conn: &mut sqlx::PgConnection,
    org_id: Uuid,
    parcel_id: Uuid,
    name: &str,
    block_id: Option<Uuid>,
    cache: &mut HashMap<String, Uuid>,
) -> ApiResult<Uuid> {
    let key = name.to_lowercase();
    if let Some(id) = cache.get(&key) {
        return Ok(*id);
    }
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM plant_rows
         WHERE parcel_id = $1 AND org_id = $2 AND lower(name) = lower($3)
         ORDER BY id LIMIT 1",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(name)
    .fetch_optional(&mut *conn)
    .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                "INSERT INTO plant_rows (org_id, parcel_id, block_id, name)
                 VALUES ($1, $2, $3, $4) RETURNING id",
            )
            .bind(org_id)
            .bind(parcel_id)
            .bind(block_id)
            .bind(name)
            .fetch_one(&mut *conn)
            .await?
        }
    };
    cache.insert(key, id);
    Ok(id)
}

/// Upsert on `(parcel_id, external_ref)` so an as-planted map can be re-imported: a matching tag
/// updates the plant in place (identity preserved, FR-P-003), everything else inserts.
/// `xmax = 0` only for a freshly inserted tuple — that is how we tell created from updated.
/// Explicitly-absent properties never clobber existing values (COALESCE), so a partial
/// re-import can enrich a plant without erasing what the detector or a human already set.
const UPSERT_SQL: &str = "
    INSERT INTO plants (org_id, parcel_id, block_id, row_id, unit_type, geom, label, row_index,
                        col_index, variety, rootstock, planted_on, status, external_ref, source)
    VALUES ($1, $2, $3, $4, $5::text::plant_unit, ST_SetSRID(ST_MakePoint($6, $7), 4326),
            $8, $9, $10, $11, $12, $13, COALESCE($14::text, 'alive')::plant_status, $15, 'import')
    ON CONFLICT (parcel_id, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
        block_id   = COALESCE(EXCLUDED.block_id, plants.block_id),
        row_id     = COALESCE(EXCLUDED.row_id, plants.row_id),
        unit_type  = EXCLUDED.unit_type,
        geom       = EXCLUDED.geom,
        label      = COALESCE(EXCLUDED.label, plants.label),
        row_index  = COALESCE(EXCLUDED.row_index, plants.row_index),
        col_index  = COALESCE(EXCLUDED.col_index, plants.col_index),
        variety    = COALESCE(EXCLUDED.variety, plants.variety),
        rootstock  = COALESCE(EXCLUDED.rootstock, plants.rootstock),
        planted_on = COALESCE(EXCLUDED.planted_on, plants.planted_on),
        status     = COALESCE($14::text::plant_status, plants.status),
        updated_at = now()
    RETURNING (plants.xmax::text::bigint = 0) AS inserted";

/// All-or-nothing: one transaction for the whole batch, because a half-committed import that a
/// client retries would double every plant that lacks an `external_ref`.
async fn insert_import_batch(
    pool: &PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    unit: &str,
    records: &[ImportRecord],
) -> ApiResult<(usize, usize)> {
    let mut tx = pool.begin().await?;
    let mut blocks: HashMap<String, Uuid> = HashMap::new();
    let mut rows: HashMap<String, Uuid> = HashMap::new();
    let (mut created, mut updated) = (0usize, 0usize);

    for rec in records {
        let block_id = match &rec.block {
            Some(name) => Some(resolve_block(&mut tx, org_id, parcel_id, name, &mut blocks).await?),
            None => None,
        };
        let row_id = match &rec.row {
            Some(name) => {
                Some(resolve_row(&mut tx, org_id, parcel_id, name, block_id, &mut rows).await?)
            }
            None => None,
        };
        let inserted: bool = sqlx::query_scalar(UPSERT_SQL)
            .bind(org_id)
            .bind(parcel_id)
            .bind(block_id)
            .bind(row_id)
            .bind(unit)
            .bind(rec.lon)
            .bind(rec.lat)
            .bind(rec.label.as_deref())
            .bind(rec.row_index)
            .bind(rec.col_index)
            .bind(rec.variety.as_deref())
            .bind(rec.rootstock.as_deref())
            .bind(rec.planted_on)
            .bind(rec.status)
            .bind(rec.external_ref.as_deref())
            .fetch_one(&mut *tx)
            .await
            .map_err(map_write_err)?;
        if inserted {
            created += 1;
        } else {
            updated += 1;
        }
    }
    tx.commit().await?;
    Ok((created, updated))
}

fn import_response(
    created: usize,
    updated: usize,
    skipped: usize,
    errors: Vec<Value>,
) -> (StatusCode, Json<Value>) {
    (
        StatusCode::CREATED,
        Json(json!({
            "created": created,
            "updated": updated,
            "skipped": skipped,
            "errors": errors,
        })),
    )
}

fn prop<'a>(props: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    props.and_then(|p| p.get(key)).filter(|v| !v.is_null())
}

fn prop_string(props: Option<&Value>, key: &str) -> Option<String> {
    prop(props, key)
        .and_then(|v| match v {
            Value::String(s) => Some(s.trim().to_string()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
}

fn prop_i32(props: Option<&Value>, key: &str) -> Option<i32> {
    prop(props, key)
        .and_then(|v| match v {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.trim().parse::<i64>().ok(),
            _ => None,
        })
        .and_then(|n| i32::try_from(n).ok())
}

fn parse_date(raw: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d").ok()
}

#[derive(Deserialize)]
struct ImportBody {
    parcel_id: Uuid,
    unit_type: Option<String>,
    feature_collection: Value,
}

/// POST /plants/import — GeoJSON Point FeatureCollection (an as-planted map).
async fn import_geojson(
    State(st): State<AppState>,
    user: AuthUser,
    Json(body): Json<ImportBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    let unit = normalize_unit(body.unit_type.as_deref())?;
    let bounds = parcel_bounds(&st.pool, user.org_id, body.parcel_id).await?;

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
    assert_capacity(&st.pool, body.parcel_id, features.len() as i64).await?;

    let mut records = Vec::with_capacity(features.len());
    let mut skipped = 0usize;
    let mut errors: Vec<Value> = Vec::new();
    for (i, feature) in features.iter().enumerate() {
        match feature_to_record(&bounds, feature) {
            Ok(rec) => records.push(rec),
            Err(reason) => {
                skipped += 1;
                if errors.len() < MAX_IMPORT_ERRORS {
                    errors.push(json!({ "index": i, "reason": reason }));
                }
            }
        }
    }

    let (created, updated) =
        insert_import_batch(&st.pool, user.org_id, body.parcel_id, unit, &records).await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant.import",
        "parcel",
        body.parcel_id,
        json!({ "format": "geojson", "unit_type": unit,
                "created": created, "updated": updated, "skipped": skipped }),
    )
    .await;
    Ok(import_response(created, updated, skipped, errors))
}

/// Only `Point` features are accepted; everything else is skipped with a reason, never fatal.
fn feature_to_record(bounds: &ParcelBounds, feature: &Value) -> Result<ImportRecord, String> {
    let geometry = feature
        .get("geometry")
        .filter(|g| !g.is_null())
        .ok_or("missing geometry")?;
    if geometry.get("type").and_then(Value::as_str) != Some("Point") {
        return Err("geometry must be a Point".into());
    }
    let coords = geometry
        .get("coordinates")
        .and_then(Value::as_array)
        .ok_or("missing coordinates")?;
    if coords.len() < 2 {
        return Err("coordinates must be [lon, lat]".into());
    }
    let lon = coords[0].as_f64().ok_or("coordinates must be numbers")?;
    let lat = coords[1].as_f64().ok_or("coordinates must be numbers")?;

    let props = feature.get("properties");
    let planted_on = match prop_string(props, "planted_on") {
        Some(s) => Some(parse_date(&s).ok_or("planted_on must be YYYY-MM-DD")?),
        None => None,
    };
    build_record(
        bounds,
        lon,
        lat,
        prop_string(props, "label"),
        prop_i32(props, "row_index"),
        prop_i32(props, "col_index"),
        prop_string(props, "variety"),
        prop_string(props, "rootstock"),
        planted_on,
        prop_string(props, "external_ref"),
        prop_string(props, "status").as_deref(),
        prop_string(props, "block"),
        prop_string(props, "row"),
    )
}

#[derive(Deserialize)]
struct CsvImportQuery {
    parcel_id: Uuid,
    unit_type: Option<String>,
}

/// POST /plants/import.csv — raw `text/csv` body, header row required, columns in any order.
async fn import_csv(
    State(st): State<AppState>,
    user: AuthUser,
    Query(q): Query<CsvImportQuery>,
    body: String,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require(Role::Operator)?;
    let unit = normalize_unit(q.unit_type.as_deref())?;
    let bounds = parcel_bounds(&st.pool, user.org_id, q.parcel_id).await?;

    let mut lines = parse_csv(&body).into_iter();
    let header = lines
        .next()
        .ok_or_else(|| ApiError::BadRequest("csv is empty (a header row is required)".into()))?;
    let cols: HashMap<String, usize> = header
        .iter()
        .enumerate()
        .map(|(i, h)| (h.trim().to_lowercase(), i))
        .collect();
    for required in ["lon", "lat"] {
        if !cols.contains_key(required) {
            return Err(ApiError::BadRequest(format!(
                "csv header is missing the '{required}' column"
            )));
        }
    }
    let data: Vec<Vec<String>> = lines.collect();
    if data.len() > MAX_IMPORT_FEATURES {
        return Err(ApiError::BadRequest(format!(
            "too many rows (max {MAX_IMPORT_FEATURES} per import)"
        )));
    }
    assert_capacity(&st.pool, q.parcel_id, data.len() as i64).await?;

    let mut records = Vec::with_capacity(data.len());
    let mut skipped = 0usize;
    let mut errors: Vec<Value> = Vec::new();
    for (i, line) in data.iter().enumerate() {
        match csv_to_record(&bounds, &cols, line) {
            Ok(rec) => records.push(rec),
            Err(reason) => {
                skipped += 1;
                if errors.len() < MAX_IMPORT_ERRORS {
                    errors.push(json!({ "index": i, "reason": reason }));
                }
            }
        }
    }

    let (created, updated) =
        insert_import_batch(&st.pool, user.org_id, q.parcel_id, unit, &records).await?;
    audit::record(
        &st.pool,
        user.org_id,
        Some(user.user_id),
        "plant.import",
        "parcel",
        q.parcel_id,
        json!({ "format": "csv", "unit_type": unit,
                "created": created, "updated": updated, "skipped": skipped }),
    )
    .await;
    Ok(import_response(created, updated, skipped, errors))
}

fn csv_cell<'a>(cols: &HashMap<String, usize>, line: &'a [String], key: &str) -> Option<&'a str> {
    cols.get(key)
        .and_then(|i| line.get(*i))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
}

fn csv_to_record(
    bounds: &ParcelBounds,
    cols: &HashMap<String, usize>,
    line: &[String],
) -> Result<ImportRecord, String> {
    let lon = csv_cell(cols, line, "lon")
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or("lon is missing or not a number")?;
    let lat = csv_cell(cols, line, "lat")
        .and_then(|s| s.parse::<f64>().ok())
        .ok_or("lat is missing or not a number")?;
    let int = |key: &str| -> Result<Option<i32>, String> {
        match csv_cell(cols, line, key) {
            Some(s) => s
                .parse::<i32>()
                .map(Some)
                .map_err(|_| format!("{key} must be an integer")),
            None => Ok(None),
        }
    };
    let planted_on = match csv_cell(cols, line, "planted_on") {
        Some(s) => Some(parse_date(s).ok_or("planted_on must be YYYY-MM-DD")?),
        None => None,
    };
    let owned = |key: &str| csv_cell(cols, line, key).map(str::to_string);
    build_record(
        bounds,
        lon,
        lat,
        owned("label"),
        int("row_index")?,
        int("col_index")?,
        owned("variety"),
        owned("rootstock"),
        planted_on,
        owned("external_ref"),
        csv_cell(cols, line, "status"),
        owned("block"),
        owned("row"),
    )
}

/// Minimal RFC-4180 reader: quoted fields, `""` escapes, embedded newlines, CRLF, BOM.
/// There is no csv crate in the workspace and Cargo.toml is frozen this phase.
fn parse_csv(input: &str) -> Vec<Vec<String>> {
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut started = false;
    let mut chars = input.trim_start_matches('\u{feff}').chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => {
                in_quotes = true;
                started = true;
            }
            ',' => {
                record.push(std::mem::take(&mut field));
                started = true;
            }
            '\r' => {}
            '\n' => {
                if started || !field.is_empty() {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                started = false;
            }
            _ => {
                field.push(c);
                started = true;
            }
        }
    }
    if started || !field.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

// --- export ----------------------------------------------------------------

#[derive(Deserialize)]
struct ExportQuery {
    parcel_id: Option<Uuid>,
    block_id: Option<Uuid>,
    status: Option<String>,
    metric: Option<String>,
    capture: Option<String>,
    token: Option<String>,
}

#[derive(sqlx::FromRow)]
struct PlantExportRow {
    #[sqlx(flatten)]
    plant: PlantRow,
    metric_value: Option<f64>,
    metric_observed_at: Option<DateTime<Utc>>,
    metric_capture_id: Option<Uuid>,
}

/// `capture=latest` (default) → the parcel's newest `extracted` capture that actually has
/// observations for this metric; an explicit UUID must belong to the caller's org.
/// Only ever called when a `metric` was requested.
async fn resolve_capture(
    pool: &PgPool,
    org_id: Uuid,
    parcel_id: Uuid,
    metric: &str,
    raw: Option<&str>,
) -> ApiResult<Option<Uuid>> {
    let raw = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("latest");
    if !raw.eq_ignore_ascii_case("latest") {
        let id = Uuid::parse_str(raw)
            .map_err(|_| ApiError::BadRequest("capture must be 'latest' or a uuid".into()))?;
        let found: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM captures WHERE id = $1 AND org_id = $2")
                .bind(id)
                .bind(org_id)
                .fetch_optional(pool)
                .await?;
        return found.map(Some).ok_or(ApiError::NotFound);
    }
    let latest: Option<Uuid> = sqlx::query_scalar(
        "SELECT o.capture_id FROM plant_observations o
         JOIN captures c ON c.id = o.capture_id
         WHERE o.parcel_id = $1 AND o.org_id = $2 AND o.metric = $3 AND c.status = 'extracted'
         ORDER BY c.captured_at DESC
         LIMIT 1",
    )
    .bind(parcel_id)
    .bind(org_id)
    .bind(metric)
    .fetch_optional(pool)
    .await?;
    Ok(latest)
}

/// Shared body of both export routes: auth (media token or Bearer), scoping, and the rows.
async fn export_rows(
    st: &AppState,
    headers: &HeaderMap,
    q: &ExportQuery,
) -> ApiResult<(Uuid, Vec<PlantExportRow>)> {
    let user = authenticate_bearer_or_media(&st.cfg.jwt_secret, headers, q.token.as_deref())?;
    // Same no-unbounded-scan rule as the list endpoint.
    let parcel_id = match (q.parcel_id, q.block_id) {
        (Some(p), _) => {
            assert_owned(&st.pool, user.org_id, p).await?;
            p
        }
        (None, Some(b)) => {
            sqlx::query_scalar("SELECT parcel_id FROM plant_blocks WHERE id = $1 AND org_id = $2")
                .bind(b)
                .bind(user.org_id)
                .fetch_optional(&st.pool)
                .await?
                .ok_or(ApiError::NotFound)?
        }
        (None, None) => {
            return Err(ApiError::BadRequest(
                "parcel_id or block_id is required".into(),
            ))
        }
    };
    let statuses = parse_status_filter(q.status.as_deref())?;
    let metric = match q.metric.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(m) => Some(normalize_metric(m)?),
        None => None,
    };
    let capture_id = match metric {
        Some(m) => {
            resolve_capture(&st.pool, user.org_id, parcel_id, m, q.capture.as_deref()).await?
        }
        None => None,
    };

    // The observation join is only assembled when a metric was asked for, so the plain export
    // never touches the extraction tier's tables.
    let (join, value_cols) = if metric.is_some() {
        (
            "LEFT JOIN plant_observations po
                    ON po.plant_id = p.id AND po.metric = $5::text AND po.capture_id = $6::uuid",
            "po.value AS metric_value, po.observed_at AS metric_observed_at,
             po.capture_id AS metric_capture_id",
        )
    } else {
        (
            "",
            "NULL::float8 AS metric_value, NULL::timestamptz AS metric_observed_at,
             NULL::uuid AS metric_capture_id",
        )
    };
    let sql = format!(
        "SELECT {PLANT_COLS}, {value_cols}
         FROM {PLANT_FROM} {join}
         WHERE p.org_id = $1
           AND p.parcel_id = $2
           AND ($3::uuid IS NULL OR p.block_id = $3)
           AND p.status::text = ANY($4::text[])
         ORDER BY p.row_index NULLS LAST, p.col_index NULLS LAST, p.id
         LIMIT {MAX_EXPORT_FEATURES}"
    );
    let mut query = sqlx::query_as::<_, PlantExportRow>(&sql)
        .bind(user.org_id)
        .bind(parcel_id)
        .bind(q.block_id)
        .bind(&statuses);
    if metric.is_some() {
        query = query.bind(metric).bind(capture_id);
    }
    let rows = query.fetch_all(&st.pool).await?;
    Ok((parcel_id, rows))
}

/// GET /plants/export.geojson — Point FeatureCollection, every Plant field a property.
async fn export_geojson(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ExportQuery>,
) -> ApiResult<impl IntoResponse> {
    let (parcel_id, rows) = export_rows(&st, &headers, &q).await?;
    let mut features = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut props = row.plant.to_json()?;
        if let Some(obj) = props.as_object_mut() {
            if q.metric.is_some() {
                obj.insert("value".into(), json!(row.metric_value));
                obj.insert("observed_at".into(), json!(row.metric_observed_at));
                obj.insert("capture_id".into(), json!(row.metric_capture_id));
            }
        }
        features.push(json!({
            "type": "Feature",
            "geometry": { "type": "Point", "coordinates": [row.plant.lon, row.plant.lat] },
            "properties": props,
        }));
    }
    let body = json!({ "type": "FeatureCollection", "features": features }).to_string();
    Ok((
        [
            (header::CONTENT_TYPE, "application/geo+json".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"plants_{parcel_id}.geojson\""),
            ),
        ],
        body,
    ))
}

/// Quote a CSV cell only when it needs it (comma, quote or newline).
fn csv_field(raw: &str) -> String {
    if raw.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

fn csv_opt(raw: Option<&str>) -> String {
    raw.map(csv_field).unwrap_or_default()
}

async fn export_csv(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ExportQuery>,
) -> ApiResult<impl IntoResponse> {
    let (parcel_id, rows) = export_rows(&st, &headers, &q).await?;
    let mut csv = String::from(
        "id,label,lon,lat,block,row,row_index,col_index,unit_type,status,variety,rootstock,\
         planted_on,external_ref,source,value,observed_at\n",
    );
    for row in &rows {
        let p = &row.plant;
        let _ = writeln!(
            csv,
            "{},{},{:.7},{:.7},{},{},{},{},{},{},{},{},{},{},{},{},{}",
            p.id,
            csv_opt(p.label.as_deref()),
            p.lon,
            p.lat,
            csv_opt(p.block_name.as_deref()),
            csv_opt(p.row_name.as_deref()),
            p.row_index.map(|v| v.to_string()).unwrap_or_default(),
            p.col_index.map(|v| v.to_string()).unwrap_or_default(),
            p.unit_type,
            p.status,
            csv_opt(p.variety.as_deref()),
            csv_opt(p.rootstock.as_deref()),
            p.planted_on.map(|d| d.to_string()).unwrap_or_default(),
            csv_opt(p.external_ref.as_deref()),
            p.source,
            row.metric_value.map(|v| v.to_string()).unwrap_or_default(),
            row.metric_observed_at
                .map(|t| t.to_rfc3339())
                .unwrap_or_default(),
        );
    }
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"plants_{parcel_id}.csv\""),
            ),
        ],
        csv,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_lifecycle_matches_the_contract() {
        assert!(transition_allowed("alive", "dead"));
        assert!(transition_allowed("alive", "missing"));
        assert!(transition_allowed("alive", "removed"));
        assert!(!transition_allowed("alive", "replanted"));
        assert!(transition_allowed("missing", "replanted"));
        assert!(transition_allowed("dead", "alive"));
        assert!(transition_allowed("replanted", "dead"));
        // 'removed' is terminal; re-asserting the current status is an idempotent no-op.
        assert!(!transition_allowed("removed", "alive"));
        assert!(transition_allowed("removed", "removed"));
    }

    #[test]
    fn csv_reader_handles_quotes_and_blank_lines() {
        let rows = parse_csv("lon,lat,label\r\n1.5,2.5,\"R1, P2\"\n\n3,4,\"say \"\"hi\"\"\"\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], vec!["lon", "lat", "label"]);
        assert_eq!(rows[1], vec!["1.5", "2.5", "R1, P2"]);
        assert_eq!(rows[2], vec!["3", "4", "say \"hi\""]);
        // Trailing empty cells survive; a file without a trailing newline still yields its row.
        assert_eq!(parse_csv("a,,c"), vec![vec!["a", "", "c"]]);
    }

    #[test]
    fn like_metacharacters_are_escaped() {
        assert_eq!(like_pattern("R_1"), "%R\\_1%");
        assert_eq!(like_pattern("50%"), "%50\\%%");
    }

    #[test]
    fn bbox_and_status_filters_reject_junk() {
        assert!(parse_bbox(Some("1,2,3")).is_err());
        assert!(parse_bbox(Some("3,2,1,4")).is_err());
        assert_eq!(parse_bbox(Some("1,2,3,4")).unwrap()[2], Some(3.0));
        assert_eq!(parse_status_filter(None).unwrap().len(), 4);
        assert_eq!(
            parse_status_filter(Some("alive, removed")).unwrap(),
            vec!["alive".to_string(), "removed".to_string()]
        );
        assert!(parse_status_filter(Some("zombie")).is_err());
    }
}
