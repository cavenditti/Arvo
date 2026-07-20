//! OWNER: be-sfm — `arvo-worker`, the durable capture-pipeline runner
//! (docs/API-PLANT.md §"Pipeline stages", docs/PHASE-PLANT.md §6).
//!
//! The API only *enqueues* the first stage; this binary claims `pipeline_jobs` rows, runs the
//! stage body, and queues the next stage on success. Stage bodies live in `sfm.rs` (be-sfm),
//! `detect.rs` (be-detect: `detect` + `register`), `extract.rs` + `rollup.rs` (be-extract).
//!
//! CLI is **frozen** (integrate-backend's smoke run depends on it):
//!
//! ```text
//! arvo-worker run [--once] [--interval-secs 5] [--capture <uuid>]
//! ```
//!
//! `--once` drains every runnable job — including the ones it enqueues itself — then exits `0`;
//! exit `1` if any job ended `failed`.
mod detect;
mod extract;
mod pipeline;
mod rollup;
mod sfm;

use std::time::Duration;

use clap::{Parser, Subcommand};
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::pipeline::{Shutdown, Worker};

#[derive(Parser)]
#[command(name = "arvo-worker", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Claim and run pipeline jobs.
    Run {
        /// Drain every runnable job, then exit (CI / smoke).
        #[arg(long)]
        once: bool,
        /// Seconds to wait after an empty claim (long-running mode).
        #[arg(long, default_value_t = 5)]
        interval_secs: u64,
        /// Restrict the run to one capture.
        #[arg(long)]
        capture: Option<Uuid>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Parse before touching the DB so `--help`/`--version` work without Postgres.
    let Cmd::Run {
        once,
        interval_secs,
        capture,
    } = Cli::parse().cmd;

    dotenvy::dotenv().ok();
    let _ = dotenvy::from_path("../.env"); // repo root when running from backend/
    let _ = dotenvy::from_path(".env");
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://arvo:arvo@localhost:5439/arvo".into());
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&database_url)
        .await?;

    // SIGINT stops the worker between jobs — a claimed stage always runs to completion.
    let shutdown = Shutdown::default();
    shutdown.listen_ctrl_c();

    let worker = Worker {
        pool,
        store_dir: pipeline::store_dir_from_env(),
        detect_url: pipeline::detect_url_from_env(),
        worker_id: format!(
            "{}-{}",
            std::env::var("HOSTNAME").unwrap_or_else(|_| "worker".into()),
            std::process::id()
        ),
        shutdown,
    };
    tracing::info!(
        worker_id = %worker.worker_id,
        store_dir = %worker.store_dir.display(),
        mode = if once { "once" } else { "loop" },
        "arvo-worker started"
    );

    // A crashed run leaves jobs stuck in `running`; reclaim those before claiming anything new.
    let stale = pipeline::requeue_stale(&worker.pool).await?;
    if stale > 0 {
        tracing::warn!(stale, "re-queued stale running jobs");
    }

    if once {
        let outcome = pipeline::run_once(&worker, capture).await?;
        tracing::info!(ran = outcome.ran, failed = outcome.failed, "drained");
        if outcome.failed > 0 {
            std::process::exit(1);
        }
    } else {
        pipeline::run_loop(&worker, Duration::from_secs(interval_secs.max(1)), capture).await?;
    }
    Ok(())
}
