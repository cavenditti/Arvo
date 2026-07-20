//! OWNER: be-sfm (pipeline spine) — parcel rollup, the tail of the `extract` stage (FR-P-032).
//!
//! For each index metric present in the capture's `plant_observations`, upsert **one**
//! `index_observations` row for the parcel: `observed_at = captured_at`,
//! `mean/median/p10/p90/stddev` over the per-plant values, `pixel_count` = contributing plant
//! count, `cloud_pct = 0`, `scene_id = NULL`, `source = 'drone'`,
//! `ON CONFLICT (parcel_id, index_name, observed_at) DO UPDATE`.
//!
//! This is the seam that keeps the Tier-0 dashboard, series API and anomaly loop working
//! unchanged — it is a plain upsert into the existing table, no schema change.
//!
//! Statistics match `arvo_core::indices::stats` (what `imagery/worker.rs` writes for
//! Sentinel-2) exactly, so a drone point and a satellite point on the same chart mean the same
//! thing: linear-interpolation percentiles (`percentile_cont`) and **population** stddev
//! (`stddev_pop`). Only the five index metrics roll up — `canopy_m2`/`height_m` have no
//! `index_observations` home (the table's `index_name` CHECK would reject them) and stay
//! per-plant, served by `GET /plants/{id}/series`.
// `extract.rs` (be-extract) calls this as its tail step; the stage is no longer a stub, so the
// module needs no dead-code allow.
use arvo_core::indices::INDEX_NAMES;
use uuid::Uuid;

use crate::pipeline::Worker;

#[derive(Debug, sqlx::FromRow)]
struct CaptureRef {
    org_id: Uuid,
    parcel_id: Uuid,
}

pub async fn run(w: &Worker, capture_id: Uuid) -> anyhow::Result<()> {
    let cap =
        sqlx::query_as::<_, CaptureRef>("SELECT org_id, parcel_id FROM captures WHERE id = $1")
            .bind(capture_id)
            .fetch_optional(&w.pool)
            .await?
            .ok_or_else(|| anyhow::anyhow!("capture {capture_id} not found"))?;

    let metrics: Vec<String> = INDEX_NAMES.iter().map(|m| m.to_string()).collect();

    // Grouping by `observed_at` (not `captured_at`) keeps the aggregate honest if a future
    // extractor ever writes more than one timestamp per capture; today they are the same value.
    let res = sqlx::query(
        "INSERT INTO index_observations
             (parcel_id, scene_id, index_name, observed_at, mean, median, p10, p90, stddev,
              pixel_count, cloud_pct, source)
         SELECT po.parcel_id,
                NULL::uuid,
                po.metric,
                po.observed_at,
                avg(po.value),
                percentile_cont(0.5) WITHIN GROUP (ORDER BY po.value),
                percentile_cont(0.1) WITHIN GROUP (ORDER BY po.value),
                percentile_cont(0.9) WITHIN GROUP (ORDER BY po.value),
                stddev_pop(po.value),
                count(*)::int,
                0,
                'drone'
           FROM plant_observations po
          WHERE po.capture_id = $1 AND po.org_id = $2 AND po.metric = ANY($3)
          GROUP BY po.parcel_id, po.metric, po.observed_at
         ON CONFLICT (parcel_id, index_name, observed_at) DO UPDATE SET
              scene_id = EXCLUDED.scene_id, mean = EXCLUDED.mean, median = EXCLUDED.median,
              p10 = EXCLUDED.p10, p90 = EXCLUDED.p90, stddev = EXCLUDED.stddev,
              pixel_count = EXCLUDED.pixel_count, cloud_pct = EXCLUDED.cloud_pct,
              source = EXCLUDED.source",
    )
    .bind(capture_id)
    .bind(cap.org_id)
    .bind(&metrics)
    .execute(&w.pool)
    .await?;

    let rows = res.rows_affected();
    if rows == 0 {
        // Not an error: an RGB-only ortho yields canopy/height only (docs/API-PLANT.md
        // §"Extraction"), and those metrics do not belong in `index_observations`.
        tracing::info!(capture = %capture_id, parcel = %cap.parcel_id, "rollup: no index metrics to roll up");
    } else {
        tracing::info!(capture = %capture_id, parcel = %cap.parcel_id, rows, "rollup: parcel index_observations upserted");
    }
    Ok(())
}
