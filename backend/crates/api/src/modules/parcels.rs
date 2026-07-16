//! OWNER: be-parcels — parcels CRUD + GeoJSON import/export per docs/API.md §Parcels.
//! `router()` is the only public entry (mounted in routes.rs under /api/v1).
//! Geometry math lives in PostGIS (AGENTS.md §Backend patterns); no Rust geo crates.
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::audit;
use crate::error::{ApiError, ApiResult};
use crate::security::{AuthUser, Role};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/parcels", get(list).post(create))
        .route("/parcels/import", post(import))
        .route("/parcels/export.geojson", get(export))
        .route("/parcels/{id}", get(get_one).patch(update).delete(archive))
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
    crop, variety, planting_date, season_year, archived, created_at";

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
    archived: bool,
    created_at: DateTime<Utc>,
}

impl ParcelRow {
    /// The exact Parcel JSON shape from docs/API.md §Parcels.
    fn to_json(&self) -> ApiResult<Value> {
        let geometry: Value = serde_json::from_str(&self.geometry_json)
            .map_err(|e| ApiError::Internal(e.into()))?;
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
            "archived": self.archived,
            "created_at": self.created_at,
        }))
    }
}

/// Validate that the farm exists in the caller's org (task: farm-belongs-to-org → 400).
async fn ensure_farm(pool: &PgPool, org_id: Uuid, farm_id: Uuid) -> ApiResult<()> {
    let found: Option<Uuid> = sqlx::query_scalar("SELECT id FROM farms WHERE id = $1 AND org_id = $2")
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
        return Err(ApiError::BadRequest("geometry is not topologically valid".into()));
    }
    if area_ha > 10_000.0 {
        return Err(ApiError::BadRequest(format!(
            "parcel area {area_ha:.1} ha exceeds the 10000 ha limit"
        )));
    }
    Ok(())
}

/// Insert one parcel and return the full read shape. Caller validates geometry/farm first.
#[allow(clippy::too_many_arguments)]
async fn insert_parcel(
    pool: &PgPool,
    org_id: Uuid,
    farm_id: Uuid,
    name: &str,
    geometry: &Value,
    crop: Option<&str>,
    variety: Option<&str>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
) -> ApiResult<ParcelRow> {
    let sql = format!(
        "INSERT INTO parcels (org_id, farm_id, name, geom, crop, variety, planting_date, season_year)
         VALUES ($1, $2, $3, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), $5, $6, $7, $8)
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
        .fetch_one(pool)
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
    let out = rows.iter().map(ParcelRow::to_json).collect::<ApiResult<Vec<_>>>()?;
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
    Ok((StatusCode::CREATED, Json(row.to_json()?)))
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

#[derive(Deserialize)]
struct PatchParcel {
    name: Option<String>,
    crop: Option<String>,
    variety: Option<String>,
    planting_date: Option<NaiveDate>,
    season_year: Option<i32>,
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
    if let Some(g) = &body.geometry {
        validate_geometry(&st.pool, g).await?;
    }
    let geometry_str = body.geometry.as_ref().map(Value::to_string);
    // COALESCE keeps existing values for omitted fields; geometry replaced only when present.
    let sql = format!(
        "UPDATE parcels SET
            name = COALESCE($3, name),
            crop = COALESCE($4, crop),
            variety = COALESCE($5, variety),
            planting_date = COALESCE($6, planting_date),
            season_year = COALESCE($7, season_year),
            archived = COALESCE($8, archived),
            geom = CASE WHEN $9::text IS NOT NULL
                        THEN ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
                        ELSE geom END,
            updated_at = now()
         WHERE id = $1 AND org_id = $2
         RETURNING {PARCEL_COLS}"
    );
    let row = sqlx::query_as::<_, ParcelRow>(&sql)
        .bind(id)
        .bind(user.org_id)
        .bind(name)
        .bind(body.crop.as_deref())
        .bind(body.variety.as_deref())
        .bind(body.planting_date)
        .bind(body.season_year)
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
        .ok_or_else(|| ApiError::BadRequest("feature_collection.features must be an array".into()))?;

    let mut created: Vec<Value> = Vec::new();
    let mut skipped: usize = 0;
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
        let crop = props.and_then(|p| p.get("crop")).and_then(Value::as_str);

        let row =
            insert_parcel(&st.pool, user.org_id, body.farm_id, &name, geometry, crop, None, None, None)
                .await?;
        audit::record(
            &st.pool,
            user.org_id,
            Some(user.user_id),
            "parcel.create",
            "parcel",
            row.id,
            json!({ "name": row.name, "farm_id": row.farm_id, "source": "import" }),
        )
        .await;
        created.push(row.to_json()?);
    }
    Ok((StatusCode::CREATED, Json(json!({ "created": created, "skipped": skipped }))))
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
    Ok(Json(json!({ "type": "FeatureCollection", "features": features })))
}
