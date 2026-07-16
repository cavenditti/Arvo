//! OWNER: integrate-backend — replace this file per docs/AGENTS.md §Seed spec.
//! Idempotent demo tenant: users, farm, 3 parcels, weather backfill, synthetic index series
//! with an injected NDVI anomaly, detector run, sample observations. KEEP the signature.
use crate::state::AppState;

pub async fn run(_state: &AppState, demo: bool) -> anyhow::Result<()> {
    tracing::warn!(demo, "seed not implemented yet");
    Ok(())
}
