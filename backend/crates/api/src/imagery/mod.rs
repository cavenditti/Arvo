//! Satellite imagery: STAC scene catalog + index computation.
//! - `stac`  — Earth Search client, scene upsert (always built).
//! - `synth` — deterministic demo series for `seed --demo` (always built).
//! - `worker` — GDAL pixel compute, only under the `imagery` feature.
//!
//! `ingest_all` keeps the signature `main.rs` calls: STAC refresh per active parcel, and
//! (under the feature) index computation for the returned scenes.
use chrono::Utc;
use uuid::Uuid;

use crate::state::AppState;

pub mod stac;
pub mod synth;

#[cfg(feature = "imagery")]
pub(crate) mod raster;
#[cfg(feature = "imagery")]
mod worker;

pub const DEFAULT_REFRESH_DAYS: i64 = 90;

/// Result of refreshing one parcel's scenes.
pub struct RefreshOutcome {
    pub found: usize,
    pub new: usize,
    pub computed: usize,
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
    let result = stac::search_and_upsert(&state.pool, &client, geometry_geojson, from, to).await?;

    #[allow(unused_mut)] // mutated only under the `imagery` feature
    let mut computed = 0usize;
    #[cfg(feature = "imagery")]
    {
        for scene in &result.scenes {
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
    }
    #[cfg(not(feature = "imagery"))]
    {
        let _ = parcel_id; // only used by the worker path
    }

    Ok(RefreshOutcome {
        found: result.found,
        new: result.new,
        computed,
    })
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
