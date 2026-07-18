// SPINE (read-only for feature agents).
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub upload_dir: PathBuf,
    /// Raster tile cache (imagery builds). Kept here so all env reads live in one place.
    #[cfg_attr(not(feature = "imagery"), allow(dead_code))]
    pub tile_cache_dir: PathBuf,
    /// CORS allowlist. Empty = permissive (dev default; release logs a warning).
    pub allowed_origins: Vec<String>,
    pub db_max_connections: u32,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://arvo:arvo@localhost:5439/arvo".into());
        // A forgeable signing key defeats all tenancy guarantees, so release builds refuse to
        // boot without a real one (NFR-SEC). Debug builds keep the frictionless dev default.
        let jwt_secret = match std::env::var("JWT_SECRET").ok() {
            Some(s) if s.len() >= 32 => s,
            Some(s) if cfg!(debug_assertions) => {
                tracing::warn!("JWT_SECRET is shorter than 32 chars — fine for dev only");
                s
            }
            None if cfg!(debug_assertions) => {
                tracing::warn!("JWT_SECRET not set — using insecure dev default");
                "dev-secret-change-me".into()
            }
            _ => anyhow::bail!(
                "JWT_SECRET must be set to at least 32 chars in release builds (openssl rand -hex 32)"
            ),
        };
        let port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8787);
        let upload_dir =
            PathBuf::from(std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "./var/uploads".into()));
        let tile_cache_dir =
            PathBuf::from(std::env::var("TILE_CACHE_DIR").unwrap_or_else(|_| "./var/tiles".into()));
        let allowed_origins = std::env::var("ALLOWED_ORIGINS")
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let db_max_connections = std::env::var("DATABASE_MAX_CONNECTIONS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10);
        Ok(Self {
            database_url,
            jwt_secret,
            port,
            upload_dir,
            tile_cache_dir,
            allowed_origins,
            db_max_connections,
        })
    }
}
