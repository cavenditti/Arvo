// SPINE (read-only for feature agents). All feature routers are mounted here under /api/v1.
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};
use crate::security::authenticate_bearer_or_media;
use crate::state::AppState;
use crate::{modules, ratelimit};

/// Global request deadline. Generous on purpose: report rendering and cold tile renders do
/// real work; anything slower than this is a bug or an abuse vector.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn app(state: AppState) -> Router {
    let api = Router::new()
        .route("/meta", get(meta))
        .merge(modules::auth::router().layer(axum::middleware::from_fn(ratelimit::auth_rate_limit)))
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
        // Scouting photos: authenticated (media token or Bearer) + org-checked, never a
        // public static mount — leaked URLs must not expose GPS-bearing field photos.
        .route(
            "/uploads/observations/{obs_id}/{file_name}",
            get(serve_photo),
        )
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(cors_layer(&state))
        .with_state(state)
}

/// Permissive in dev; explicit allowlist via ALLOWED_ORIGINS in production deployments.
fn cors_layer(state: &AppState) -> CorsLayer {
    let origins: Vec<HeaderValue> = state
        .cfg
        .allowed_origins
        .iter()
        .filter_map(|o| match o.parse::<HeaderValue>() {
            Ok(v) => Some(v),
            Err(_) => {
                tracing::warn!(origin = %o, "ignoring unparsable ALLOWED_ORIGINS entry");
                None
            }
        })
        .collect();
    if origins.is_empty() {
        if !cfg!(debug_assertions) {
            tracing::warn!("ALLOWED_ORIGINS not set — running with permissive CORS");
        }
        CorsLayer::permissive()
    } else {
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods(Any)
            .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
    }
}

async fn meta() -> Json<Value> {
    Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "features": { "imagery": cfg!(feature = "imagery") }
    }))
}

#[derive(serde::Deserialize)]
struct MediaTokenQuery {
    #[serde(default)]
    token: Option<String>,
}

/// GET /uploads/observations/{obs_id}/{file} — serve a scouting photo.
/// Auth: `?token=` media token (what <img> clients use) or a Bearer session token.
async fn serve_photo(
    State(state): State<AppState>,
    Path((obs_id, file_name)): Path<(Uuid, String)>,
    Query(q): Query<MediaTokenQuery>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Response> {
    let user = authenticate_bearer_or_media(&state.cfg.jwt_secret, &headers, q.token.as_deref())?;

    // Flat UUID-derived names only; anything with separators or dots-paths is not ours.
    if !file_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        || file_name.contains("..")
    {
        return Err(ApiError::NotFound);
    }
    let ext = file_name.rsplit('.').next().unwrap_or_default();
    let content_type = match ext {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => return Err(ApiError::NotFound),
    };

    // Org check: the photo is only served to members of the observation's org.
    let owned: Option<(Uuid,)> =
        sqlx::query_as("SELECT id FROM observations WHERE id = $1 AND org_id = $2")
            .bind(obs_id)
            .bind(user.org_id)
            .fetch_optional(&state.pool)
            .await?;
    if owned.is_none() {
        return Err(ApiError::NotFound);
    }

    let path = state
        .cfg
        .upload_dir
        .join("observations")
        .join(obs_id.to_string())
        .join(&file_name);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::NotFound)?;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "private, max-age=3600"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
