//! OWNER: be-alerts — anomaly detection job. Loads each non-archived parcel's NDVI series
//! (quality-filtered), scans it with `arvo_core::anomaly`, and upserts an `index_drop`
//! alert per recent event with a per-day dedupe key so re-running is idempotent.
use arvo_core::anomaly::{self, SeriesPoint, BASELINE_WINDOW_DAYS};
use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use crate::state::AppState;

/// The index the detector watches. NDVI is the canonical vigor proxy for Tier 0.
const INDEX: &str = "ndvi";
/// Observations above this per-parcel cloud fraction are too contaminated to trust —
/// residual cloud/shadow depresses NDVI and fires false "drops".
const MAX_CLOUD_PCT: f64 = 40.0;
/// Observations computed from fewer clear pixels than this are statistically meaningless.
const MIN_PIXELS: i64 = 50;
/// Drone rollups reuse `pixel_count` for the contributing PLANT count (worker/src/rollup.rs),
/// a number orders of magnitude smaller than a Sentinel-2 pixel count — a whole block can
/// legitimately be 30 trees. Applying the satellite floor to those rows would drop small
/// blocks out of the detector silently, so drone rows get their own floor: below this a
/// parcel mean is one tree's story, not the block's.
const MIN_PLANTS: i64 = 5;
/// Only events this recent become alerts (older ones are history, not something to act on).
const RECENT_DAYS: i64 = 14;

#[derive(sqlx::FromRow)]
struct ParcelRow {
    id: Uuid,
    name: String,
}

#[derive(sqlx::FromRow)]
struct SeriesRow {
    observed_at: DateTime<Utc>,
    mean: f64,
}

/// The quality-gated series of ONE parcel from ONE source. Held as a const so the
/// source-precedence chain — the whole reason this query exists — is unit-testable.
/// `$1` parcel, `$2` index, `$3` max cloud %, `$4` min clear pixels, `$5` min plants.
const SERIES_SQL: &str = "SELECT observed_at, mean FROM index_observations
     WHERE parcel_id = $1 AND index_name = $2
       AND (cloud_pct IS NULL OR cloud_pct < $3)
       AND (pixel_count IS NULL
            OR pixel_count >= CASE WHEN source = 'drone' THEN $5 ELSE $4 END)
       AND source = (SELECT CASE
             WHEN EXISTS (SELECT 1 FROM index_observations
                          WHERE parcel_id = $1 AND index_name = $2 AND source = 'sentinel-2')
               THEN 'sentinel-2'
             WHEN EXISTS (SELECT 1 FROM index_observations
                          WHERE parcel_id = $1 AND index_name = $2 AND source = 'drone')
               THEN 'drone'
             ELSE 'demo' END)
     ORDER BY observed_at ASC";

/// Run the detector for every non-archived parcel in one org. Returns the number of
/// alerts actually created (dedupe conflicts are not counted).
pub async fn detect_for_org(state: &AppState, org_id: Uuid) -> anyhow::Result<u32> {
    let parcels: Vec<ParcelRow> = sqlx::query_as(
        "SELECT id, name FROM parcels WHERE org_id = $1 AND archived = false ORDER BY created_at",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await?;

    let mut created = 0u32;
    for parcel in parcels {
        // Quality gate: scene-wide cloud filters happen at STAC search time, but per-parcel
        // cloud can still be ~100% — those observations must not feed the detector.
        // Source precedence sentinel-2 → drone → demo: the scan sees exactly ONE source,
        // never a mix, because the level jump between two sources looks like an anomaly.
        // A parcel no Sentinel-2 scene covers (or an operator with no satellite ingest) is
        // therefore scanned on its drone rollups instead of on an empty series.
        let series: Vec<SeriesRow> = sqlx::query_as(SERIES_SQL)
            .bind(parcel.id)
            .bind(INDEX)
            .bind(MAX_CLOUD_PCT)
            .bind(MIN_PIXELS)
            .bind(MIN_PLANTS)
            .fetch_all(&state.pool)
            .await?;

        if series.is_empty() {
            // Never fail silently again: a parcel that has observations but no usable series
            // is the signature of a quality gate or a source filter that excluded them all.
            tracing::debug!(parcel = %parcel.id, "detect: no usable observations, skipping");
            continue;
        }

        let points: Vec<SeriesPoint> = series
            .iter()
            .map(|r| SeriesPoint {
                observed_at: r.observed_at,
                mean: r.mean,
            })
            .collect();

        // Scan the whole series, then alert on recent events only: a batch ingest can land
        // several points at once, and a recovery point after a dip must not hide it.
        let cutoff = Utc::now() - Duration::days(RECENT_DAYS);
        for event in anomaly::scan_series(&points) {
            if event.observed_at < cutoff {
                continue;
            }
            if upsert_alert(state, org_id, &parcel, &event).await? {
                created += 1;
            }
        }
    }
    Ok(created)
}

/// Loop over every org and run detection. KEEP this signature — main.rs CLI
/// (`arvo-api detect-anomalies`) and the seed pipeline call it.
pub async fn detect_all(state: &AppState) -> anyhow::Result<u32> {
    let orgs: Vec<(Uuid,)> = sqlx::query_as("SELECT id FROM orgs")
        .fetch_all(&state.pool)
        .await?;

    let mut total = 0u32;
    for (org_id,) in orgs {
        total += detect_for_org(state, org_id).await?;
    }
    Ok(total)
}

/// Insert an `index_drop` alert deduped per parcel+day. A same-day second scene that is
/// WORSE escalates the existing row to critical (state untouched); anything else is a no-op.
/// Returns true when a row was inserted or escalated.
async fn upsert_alert(
    state: &AppState,
    org_id: Uuid,
    parcel: &ParcelRow,
    event: &anomaly::AnomalyEvent,
) -> anyhow::Result<bool> {
    let date = event.observed_at.date_naive();
    let dedupe_key = format!("index_drop:{}:{}", parcel.id, date);
    let pct = (event.drop_pct * 100.0).round() as i64;
    let title = format!("NDVI drop on {}", parcel.name);
    let message = format!(
        "NDVI dropped {pct}% below the {BASELINE_WINDOW_DAYS}-day baseline ({:.2} → {:.2})",
        event.baseline, event.value
    );
    let data = serde_json::json!({
        "index": INDEX,
        "value": event.value,
        "baseline": event.baseline,
        "drop_pct": event.drop_pct,
    });

    let result = sqlx::query(
        "INSERT INTO alerts (org_id, parcel_id, kind, severity, title, message, data, dedupe_key)
         VALUES ($1, $2, 'index_drop', $3, $4, $5, $6, $7)
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE
           SET severity = EXCLUDED.severity, message = EXCLUDED.message,
               data = EXCLUDED.data, updated_at = now()
           WHERE alerts.severity = 'warning' AND EXCLUDED.severity = 'critical'",
    )
    .bind(org_id)
    .bind(parcel.id)
    .bind(event.severity.as_str())
    .bind(&title)
    .bind(&message)
    .bind(&data)
    .bind(&dedupe_key)
    .execute(&state.pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `worker/src/rollup.rs` writes `source = 'drone'`. A two-level chain matched neither
    /// branch for a drone-only parcel, which scanned it on an EMPTY series and raised nothing.
    /// Order matters: real satellite beats drone beats the synthetic demo series.
    #[test]
    fn source_precedence_is_three_level_and_ordered() {
        let s2 = SERIES_SQL
            .find("THEN 'sentinel-2'")
            .expect("sentinel-2 branch");
        let drone = SERIES_SQL.find("THEN 'drone'").expect("drone branch");
        let demo = SERIES_SQL.find("ELSE 'demo'").expect("demo fallback");
        assert!(s2 < drone, "sentinel-2 must be tried before drone");
        assert!(drone < demo, "drone must be tried before the demo series");
    }

    /// The precedence exists to keep sources UNMIXED: exactly one source filter, and it
    /// resolves to a single value, never a set.
    #[test]
    fn the_scan_reads_exactly_one_source() {
        assert_eq!(SERIES_SQL.matches("AND source = (SELECT CASE").count(), 1);
        assert!(!SERIES_SQL.contains("source IN ("));
    }

    /// Drone rows carry a plant count in `pixel_count`, so the satellite clear-pixel floor
    /// must not be applied to them — that would silently exclude legitimate small blocks.
    #[test]
    fn pixel_gate_is_source_aware() {
        assert!(SERIES_SQL.contains("CASE WHEN source = 'drone' THEN $5 ELSE $4 END"));
        const { assert!(MIN_PLANTS < MIN_PIXELS, "the drone floor is the looser one") };
    }
}
