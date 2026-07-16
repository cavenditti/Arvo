//! OWNER: be-imagery — replace this file. Add stac.rs (Earth Search client), synth.rs (demo
//! series generator used by seed), worker.rs behind #[cfg(feature = "imagery")] (GDAL pixel
//! compute with SCL cloud mask). KEEP the `ingest_all` signature — main.rs calls it.
use crate::state::AppState;

pub async fn ingest_all(_state: &AppState, _parcel: Option<uuid::Uuid>) -> anyhow::Result<()> {
    tracing::warn!("imagery ingest not implemented yet");
    Ok(())
}
