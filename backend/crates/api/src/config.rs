// SPINE (read-only for feature agents).
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub jwt_secret: String,
    pub port: u16,
    pub upload_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "postgres://arvo:arvo@localhost:5439/arvo".into());
        let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| {
            tracing::warn!("JWT_SECRET not set — using insecure dev default");
            "dev-secret-change-me".into()
        });
        let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
        let upload_dir =
            PathBuf::from(std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "./var/uploads".into()));
        Ok(Self { database_url, jwt_secret, port, upload_dir })
    }
}
