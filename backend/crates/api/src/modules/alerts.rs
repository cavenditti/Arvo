//! OWNER: be-alerts — implement per docs/API.md §Alerts. Replace this stub;
//! keep `router()` as the only public entry (already mounted in routes.rs under /api/v1).
use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
