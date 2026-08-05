//! Satellite imagery: STAC scene catalog + index computation.
//! - `stac`  — Earth Search client, scene upsert (always built).
//! - `synth` — deterministic demo series for `seed --demo` (always built).
//! - `worker` — GDAL pixel compute, only under the `imagery` feature.
//!
//! `ingest_all` keeps the signature `main.rs` calls: STAC refresh per active parcel, and
//! (under the feature) index computation for the returned scenes.
#[cfg(feature = "imagery")]
use chrono::Datelike;
use chrono::Utc;
#[cfg(feature = "imagery")]
use std::collections::HashMap;
use std::collections::HashSet;
use uuid::Uuid;

use crate::state::AppState;

pub mod crop;
pub mod stac;
pub mod synth;

#[cfg(feature = "imagery")]
pub(crate) mod raster;
#[cfg(feature = "imagery")]
mod worker;

/// A full phenological cycle is needed for crop classification; the search is split into the
/// bounded windows below so the longer default never relies on STAC pagination luck.
pub const DEFAULT_REFRESH_DAYS: i64 = 366;
/// Keep each STAC response comfortably below Earth Search's 100-item page cap, including parcels
/// that straddle two Sentinel-2 tiles. Crop detection still sees the combined full-year series.
const SEARCH_CHUNK_DAYS: i64 = 90;

/// Result of refreshing one parcel's scenes.
pub struct RefreshOutcome {
    pub found: usize,
    pub new: usize,
    pub computed: usize,
}

/// Record intent before spawning an in-memory refresh. If the process dies after this write, the
/// status endpoint converts the stale row to `failed` instead of telling the app it runs forever.
pub async fn queue_refresh(pool: &sqlx::PgPool, parcel_id: Uuid) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO parcel_imagery_refreshes (parcel_id, state, requested_at, updated_at)
         VALUES ($1, 'queued', now(), now())
         ON CONFLICT (parcel_id) DO UPDATE SET
             state = 'queued', requested_at = now(), started_at = NULL, finished_at = NULL,
             scenes_found = 0, scenes_new = 0, computed = 0, error_code = NULL,
             updated_at = now()",
    )
    .bind(parcel_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_refresh_running(pool: &sqlx::PgPool, parcel_id: Uuid) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE parcel_imagery_refreshes
            SET state = 'running', started_at = now(), updated_at = now()
          WHERE parcel_id = $1",
    )
    .bind(parcel_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Finish as `ready` whenever this or an earlier pass produced observations; a zero-result refresh
/// on a previously healthy parcel must not downgrade it to "no data".
pub async fn complete_refresh(
    pool: &sqlx::PgPool,
    parcel_id: Uuid,
    outcome: &RefreshOutcome,
) -> anyhow::Result<&'static str> {
    let has_data: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM index_observations WHERE parcel_id = $1)")
            .bind(parcel_id)
            .fetch_one(pool)
            .await?;
    let state = if has_data { "ready" } else { "empty" };
    sqlx::query(
        "UPDATE parcel_imagery_refreshes
            SET state = $2, finished_at = now(), scenes_found = $3, scenes_new = $4,
                computed = $5, error_code = NULL, updated_at = now()
          WHERE parcel_id = $1",
    )
    .bind(parcel_id)
    .bind(state)
    .bind(i32::try_from(outcome.found).unwrap_or(i32::MAX))
    .bind(i32::try_from(outcome.new).unwrap_or(i32::MAX))
    .bind(i32::try_from(outcome.computed).unwrap_or(i32::MAX))
    .execute(pool)
    .await?;
    Ok(state)
}

pub async fn fail_refresh(
    pool: &sqlx::PgPool,
    parcel_id: Uuid,
    error_code: &str,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE parcel_imagery_refreshes
            SET state = 'failed', finished_at = now(), error_code = $2, updated_at = now()
          WHERE parcel_id = $1",
    )
    .bind(parcel_id)
    .bind(error_code)
    .execute(pool)
    .await?;
    Ok(())
}

/// At most one low-cloud scene per half-month. A full-year search may catalog hundreds of scenes,
/// but crop phenology needs seasonal coverage, not every overlapping acquisition. This caps a
/// normal 366-day pass at 26 remote pixel computations while preserving every season.
#[cfg(feature = "imagery")]
fn seasonal_scenes(scenes: &[stac::SceneRow]) -> Vec<stac::SceneRow> {
    let mut selected: HashMap<(i32, u32, u8), &stac::SceneRow> = HashMap::new();
    let cloud_rank = |scene: &stac::SceneRow| {
        scene
            .cloud_cover
            .filter(|value| value.is_finite())
            .unwrap_or(100.0)
    };
    for scene in scenes {
        let bin = (
            scene.acquired_at.year(),
            scene.acquired_at.month(),
            if scene.acquired_at.day() <= 15 { 0 } else { 1 },
        );
        match selected.get(&bin) {
            Some(current) if cloud_rank(current) <= cloud_rank(scene) => {}
            _ => {
                selected.insert(bin, scene);
            }
        }
    }
    let mut result: Vec<_> = selected.into_values().cloned().collect();
    result.sort_by_key(|scene| scene.acquired_at);
    result
}

/// Search Earth Search STAC for scenes intersecting `geometry_geojson` over the last `days`,
/// upsert them, and (only under the `imagery` feature) compute indices for each scene.
pub async fn refresh_scenes(
    state: &AppState,
    parcel_id: Uuid,
    geometry_geojson: &str,
    days: i64,
) -> anyhow::Result<RefreshOutcome> {
    // Defensive clamp (the API layer clamps tighter): chrono::Duration::days panics on
    // extreme values, and no caller ever needs more than a decade.
    let to = Utc::now();
    let from = to - chrono::Duration::days(days.clamp(1, 3650));
    let client = stac::client()?;
    let mut cursor = from;
    let mut found = 0usize;
    let mut new = 0usize;
    let mut scenes = Vec::new();
    let mut seen = HashSet::new();
    loop {
        let chunk_to = (cursor + chrono::Duration::days(SEARCH_CHUNK_DAYS)).min(to);
        let result =
            stac::search_and_upsert(&state.pool, &client, geometry_geojson, cursor, chunk_to)
                .await?;
        found += result.found;
        new += result.new;
        for scene in result.scenes {
            if seen.insert(scene.stac_id.clone()) {
                scenes.push(scene);
            }
        }
        if chunk_to >= to {
            break;
        }
        // STAC datetime intervals are inclusive; step beyond the shared boundary and also keep
        // the HashSet guard above for providers that round timestamps differently.
        cursor = chunk_to + chrono::Duration::seconds(1);
    }

    #[allow(unused_mut)] // mutated only under the `imagery` feature
    let mut computed = 0usize;
    #[cfg(feature = "imagery")]
    {
        let selected = seasonal_scenes(&scenes);
        tracing::info!(
            parcel = %parcel_id,
            catalogued = scenes.len(),
            selected = selected.len(),
            "selected seasonally distributed Sentinel scenes"
        );
        for scene in &selected {
            match worker::compute_scene(
                &state.pool,
                parcel_id,
                geometry_geojson.to_string(),
                scene.clone(),
            )
            .await
            {
                Ok(n) if n > 0 => computed += 1,
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(error = ?e, stac_id = %scene.stac_id, "index compute failed")
                }
            }
        }
        if let Err(error) = crop::refresh_prediction(&state.pool, parcel_id).await {
            tracing::warn!(parcel = %parcel_id, error = ?error, "crop classification failed")
        }
    }
    #[cfg(not(feature = "imagery"))]
    {
        let _ = parcel_id; // only used by the worker path
    }

    Ok(RefreshOutcome {
        found,
        new,
        computed,
    })
}

#[cfg(all(test, feature = "imagery"))]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn scene(month: u32, day: u32, cloud_cover: f64) -> stac::SceneRow {
        stac::SceneRow {
            id: Uuid::new_v4(),
            stac_id: format!("scene-{month}-{day}-{cloud_cover}"),
            acquired_at: Utc.with_ymd_and_hms(2026, month, day, 10, 0, 0).unwrap(),
            cloud_cover: Some(cloud_cover),
            assets: json!({}),
            boa_offset_applied: Some(true),
        }
    }

    #[test]
    fn seasonal_sampling_caps_work_and_keeps_low_cloud_scenes() {
        let mut scenes = Vec::new();
        for month in 1..=12 {
            for day in [2, 7, 14, 18, 24, 28] {
                scenes.push(scene(month, day, day as f64));
            }
        }
        let selected = seasonal_scenes(&scenes);
        assert_eq!(selected.len(), 24);
        assert!(selected
            .iter()
            .all(|s| [2, 18].contains(&s.acquired_at.day())));
    }
}

/// Refresh scenes for every active parcel (or just `parcel` when given). Best-effort: a STAC
/// failure on one parcel is logged and skipped so seeding/ingest never aborts (AGENTS §Seed).
pub async fn ingest_all(state: &AppState, parcel: Option<Uuid>) -> anyhow::Result<()> {
    let parcels: Vec<(Uuid, String)> = match parcel {
        Some(id) => sqlx::query_as(
            "SELECT id, ST_AsGeoJSON(geom)::text FROM parcels WHERE id = $1 AND archived = false",
        )
        .bind(id)
        .fetch_all(&state.pool)
        .await?,
        None => {
            sqlx::query_as(
                "SELECT id, ST_AsGeoJSON(geom)::text FROM parcels WHERE archived = false",
            )
            .fetch_all(&state.pool)
            .await?
        }
    };

    for (id, geometry) in parcels {
        match refresh_scenes(state, id, &geometry, DEFAULT_REFRESH_DAYS).await {
            Ok(o) => tracing::info!(
                parcel = %id, found = o.found, new = o.new, computed = o.computed, "scene refresh"
            ),
            Err(e) => tracing::warn!(parcel = %id, error = ?e, "scene refresh failed (skipped)"),
        }
    }
    Ok(())
}
