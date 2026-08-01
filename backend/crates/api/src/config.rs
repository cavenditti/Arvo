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
    /// Object store root: capture raw photos, orthomosaics and DSMs (docs/API-PLANT.md
    /// §"Storage layout"). Local disk in P-MVP; `arvo-worker` reads the same `STORE_DIR`.
    pub store_dir: PathBuf,
    /// CORS allowlist. Empty = permissive (dev default; release logs a warning).
    pub allowed_origins: Vec<String>,
    pub db_max_connections: u32,
    /// INSPIRE WFS endpoint for cadastral parcels (FR-0-010b). Defaults to the Agenzia
    /// delle Entrate open-data service; overridable for tests and other countries.
    pub cadastre_wfs_url: String,
    /// Expo push API endpoint (`push.rs`). Overridable for tests; delivery is best-effort.
    pub push_endpoint: String,
    /// Kill switch for all outbound push (`ARVO_PUSH_DISABLED=1`): dev environments and
    /// CI must never notify real phones.
    pub push_disabled: bool,
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
        let store_dir =
            PathBuf::from(std::env::var("STORE_DIR").unwrap_or_else(|_| "./var/store".into()));
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
        let cadastre_wfs_url = std::env::var("CADASTRE_WFS_URL").unwrap_or_else(|_| {
            "https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php".into()
        });
        let push_endpoint = std::env::var("PUSH_ENDPOINT")
            .unwrap_or_else(|_| "https://exp.host/--/api/v2/push/send".into());
        let push_disabled = std::env::var("ARVO_PUSH_DISABLED")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Ok(Self {
            database_url,
            jwt_secret,
            port,
            upload_dir,
            tile_cache_dir,
            store_dir,
            allowed_origins,
            db_max_connections,
            cadastre_wfs_url,
            push_endpoint,
            push_disabled,
        })
    }
}
