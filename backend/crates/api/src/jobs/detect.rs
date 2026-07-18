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
        // Source precedence: when real sentinel-2 observations exist for the parcel, the
        // synthetic demo series is ignored entirely — mixing the two makes the level jump
        // between them look like an anomaly.
        let series: Vec<SeriesRow> = sqlx::query_as(
            "SELECT observed_at, mean FROM index_observations
             WHERE parcel_id = $1 AND index_name = $2
               AND (cloud_pct IS NULL OR cloud_pct < $3)
               AND (pixel_count IS NULL OR pixel_count >= $4)
               AND source = (SELECT CASE WHEN EXISTS (
                     SELECT 1 FROM index_observations
                     WHERE parcel_id = $1 AND index_name = $2 AND source = 'sentinel-2'
                   ) THEN 'sentinel-2' ELSE 'demo' END)
             ORDER BY observed_at ASC",
        )
        .bind(parcel.id)
        .bind(INDEX)
        .bind(MAX_CLOUD_PCT)
        .bind(MIN_PIXELS)
        .fetch_all(&state.pool)
        .await?;

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
