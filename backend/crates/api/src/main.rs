// SPINE (read-only for feature agents). CLI + boot. Keep the called signatures stable.
mod audit;
mod config;
mod error;
mod imagery;
mod jobs;
mod modules;
mod ratelimit;
mod routes;
mod security;
mod seed;
mod state;
mod util;

use std::net::SocketAddr;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

#[derive(Parser)]
#[command(name = "arvo-api", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the HTTP API (default)
    Serve,
    /// Apply pending migrations and exit
    Migrate,
    /// Seed the database (--demo for the full demo tenant, --demo-plants for the Phase-P orchard)
    Seed {
        #[arg(long)]
        demo: bool,
        /// Seed only the Phase-P plant tier on top of an existing --demo tenant
        #[arg(long)]
        demo_plants: bool,
    },
    /// Refresh STAC scenes (and compute indices when built with --features imagery)
    IngestImagery {
        #[arg(long)]
        parcel: Option<uuid::Uuid>,
    },
    /// Run the anomaly detector over all parcels
    DetectAnomalies,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let _ = dotenvy::from_path("../.env"); // repo root when running from backend/
    let _ = dotenvy::from_path(".env");
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = config::Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(cfg.db_max_connections)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(&cfg.database_url)
        .await?;
    let state = state::AppState {
        pool: pool.clone(),
        cfg: Arc::new(cfg),
    };

    match Cli::parse().cmd.unwrap_or(Cmd::Serve) {
        Cmd::Migrate => {
            MIGRATOR.run(&pool).await?;
            println!("migrations applied");
        }
        Cmd::Seed { demo, demo_plants } => {
            MIGRATOR.run(&pool).await?;
            if demo_plants {
                seed::run_demo_plants(&state).await?;
            } else {
                seed::run(&state, demo).await?;
            }
        }
        Cmd::IngestImagery { parcel } => {
            imagery::ingest_all(&state, parcel).await?;
        }
        Cmd::DetectAnomalies => {
            let n = jobs::detect_all(&state).await?;
            println!("alerts created: {n}");
        }
        Cmd::Serve => {
            MIGRATOR.run(&pool).await?;
            std::fs::create_dir_all(&state.cfg.upload_dir)?;
            let addr = SocketAddr::from(([0, 0, 0, 0], state.cfg.port));
            let app = routes::app(state);
            tracing::info!("arvo-api listening on http://{addr}");
            let listener = tokio::net::TcpListener::bind(addr).await?;
            // ConnectInfo powers the per-IP auth rate limiter; graceful shutdown lets
            // in-flight requests (sync transactions especially) finish on SIGTERM/ctrl-c.
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(shutdown_signal())
            .await?;
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received — draining in-flight requests");
}
