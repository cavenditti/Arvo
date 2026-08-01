//! OWNER: backend-core — best-effort Expo push delivery (UX revamp: push notifications).
//! Fire-and-forget by contract: every failure is logged and swallowed, because a push must
//! never fail the job (or request) that triggered it. Device rows are managed by
//! `modules/devices.rs`; this module only fans out.
use std::sync::OnceLock;
use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::state::AppState;

/// Expo caps a push-send request at 100 messages.
const CHUNK_SIZE: usize = 100;
/// Outbound timeout — pushes ride background jobs, so fail fast and move on.
const TIMEOUT_SECS: u64 = 10;

/// Shared client (connection reuse across job runs). `AppState` carries no HTTP client —
/// cadastre builds one per request — so a process-wide static is the sanctioned spot.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .build()
            .unwrap_or_else(|e| {
                // Only reachable when the TLS backend is broken; the default client uses
                // the same stack, but degrading beats panicking a background job.
                tracing::warn!(error = %e, "push: client builder failed, using defaults");
                reqwest::Client::new()
            })
    })
}

/// Send one notification to EVERY device registered for the org, in Expo-sized chunks.
/// Skips entirely (debug log) when the org has no devices or push is disabled
/// (`ARVO_PUSH_DISABLED=1`). Never returns an error: log-and-continue is the contract.
pub async fn send_to_org(state: &AppState, org_id: Uuid, title: &str, body: &str, data: Value) {
    if state.cfg.push_disabled {
        tracing::debug!(%org_id, "push: disabled via ARVO_PUSH_DISABLED, skipping");
        return;
    }
    let tokens: Vec<String> =
        match sqlx::query_scalar("SELECT token FROM devices WHERE org_id = $1")
            .bind(org_id)
            .fetch_all(&state.pool)
            .await
        {
            Ok(tokens) => tokens,
            Err(e) => {
                tracing::warn!(%org_id, error = ?e, "push: loading device tokens failed");
                return;
            }
        };
    if tokens.is_empty() {
        tracing::debug!(%org_id, "push: no registered devices, skipping");
        return;
    }

    for chunk in tokens.chunks(CHUNK_SIZE) {
        let messages: Vec<Value> = chunk
            .iter()
            .map(|to| {
                json!({
                    "to": to,
                    "title": title,
                    "body": body,
                    "data": data.clone(),
                    "sound": "default",
                })
            })
            .collect();
        match client()
            .post(&state.cfg.push_endpoint)
            .json(&messages)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!(%org_id, sent = chunk.len(), "push: chunk accepted by Expo");
            }
            Ok(resp) => {
                tracing::warn!(%org_id, status = %resp.status(), "push: Expo answered non-success");
            }
            Err(e) => {
                tracing::warn!(%org_id, error = %e, "push: request to Expo failed");
            }
        }
    }
}
