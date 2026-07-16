// SPINE (read-only for feature agents).
use std::sync::Arc;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub cfg: Arc<Config>,
}
