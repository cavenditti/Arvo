//! OWNER: be-alerts — anomaly detection job. Loads each non-archived parcel's NDVI series,
//! runs `arvo_core::anomaly` on the latest point, and upserts an `index_drop` alert with a
//! per-day dedupe key so re-running is idempotent.
use arvo_core::anomaly::{self, SeriesPoint};
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::state::AppState;

/// The index the detector watches. NDVI is the canonical vigor proxy for Tier 0.
const INDEX: &str = "ndvi";

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
        let series: Vec<SeriesRow> = sqlx::query_as(
            "SELECT observed_at, mean FROM index_observations
             WHERE parcel_id = $1 AND index_name = $2
             ORDER BY observed_at ASC",
        )
        .bind(parcel.id)
        .bind(INDEX)
        .fetch_all(&state.pool)
        .await?;

        let points: Vec<SeriesPoint> = series
            .iter()
            .map(|r| SeriesPoint { observed_at: r.observed_at, mean: r.mean })
            .collect();

        let Some(event) = anomaly::detect_latest(&points) else {
            continue;
        };

        if upsert_alert(state, org_id, &parcel, &event).await? {
            created += 1;
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

/// Insert an `index_drop` alert; `ON CONFLICT DO NOTHING` on the per-day dedupe key.
/// Returns true when a new row was inserted.
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
        "NDVI dropped {}% below the 45-day baseline ({:.2} → {:.2})",
        pct, event.baseline, event.value
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
         ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING",
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
