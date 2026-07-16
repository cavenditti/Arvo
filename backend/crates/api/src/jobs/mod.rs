//! OWNER: be-alerts — replace this file. Add detect.rs (loads index series per parcel, runs
//! arvo_core::anomaly, upserts alerts with dedupe keys). KEEP the `detect_all` signature —
//! main.rs CLI and the /alerts/detect endpoint call it.
use crate::state::AppState;

pub async fn detect_all(_state: &AppState) -> anyhow::Result<u32> {
    tracing::warn!("anomaly detection not implemented yet");
    Ok(0)
}
