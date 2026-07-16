// SPINE (read-only for feature agents). All feature routers are mounted here under /api/v1.
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use crate::modules;
use crate::state::AppState;

pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/meta", get(meta))
        .merge(modules::auth::router())
        .merge(modules::orgs::router())
        .merge(modules::farms::router())
        .merge(modules::parcels::router())
        .merge(modules::weather::router())
        .merge(modules::scenes::router())
        .merge(modules::indices::router())
        .merge(modules::alerts::router())
        .merge(modules::observations::router())
        .merge(modules::reports::router());

    // Raster tiles + GeoTIFF export (FR-0-027) — only in `imagery` builds (needs GDAL).
    #[cfg(feature = "imagery")]
    let api = api.merge(modules::tiles::router());

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api/v1", api)
        .nest_service("/uploads", ServeDir::new(state.cfg.upload_dir.clone()))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn meta() -> Json<Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "features": { "imagery": cfg!(feature = "imagery") }
    }))
}
