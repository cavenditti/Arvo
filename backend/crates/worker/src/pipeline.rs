//! OWNER: be-sfm — job claiming, the stage state machine, shared worker plumbing.
//! Contract: docs/API-PLANT.md §"Pipeline stages" (claim SQL, backoff and status rewind are
//! frozen there — any future runner must use exactly the same claim statement).
//!
//! Stage bodies are owned elsewhere: `sfm.rs` (be-sfm), `detect.rs` (be-detect), `extract.rs`
//! (be-extract) + `rollup.rs`. This module is the only place that touches `pipeline_jobs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use sqlx::PgPool;
use tokio::sync::Notify;
use uuid::Uuid;

use crate::{detect, extract, sfm};

/// Default retry budget per job (`pipeline_jobs.max_attempts`).
pub const MAX_ATTEMPTS: i32 = 3;
/// A `running` job older than this was orphaned by a crashed worker.
pub const STALE_AFTER_HOURS: i64 = 2;
/// Retry backoff: `run_after = now() + 1 min * 2^attempts`, capped here.
pub const MAX_BACKOFF_MINUTES: i64 = 30;
/// Job error string a stage returns when it needs GDAL and the binary was built without
/// `--features imagery` (docs/API-PLANT.md §"Builds without GDAL (CI default)").
pub const STAGE_UNSUPPORTED: &str = "stage_unsupported";
/// `pipeline_jobs.error` / `captures.error` are surfaced verbatim by the API; a runaway
/// subprocess log must not become a megabyte column.
const MAX_ERROR_LEN: usize = 2000;

/// Everything a stage body needs: the pool, the object-store root, this process' id
/// (written to `pipeline_jobs.worker_id` on claim), and the cooperative shutdown flag.
pub struct Worker {
    pub pool: PgPool,
    pub store_dir: PathBuf,
    /// `PLANT_DETECT_URL`, when the `services/plant-detect` microservice is deployed. `None`
    /// keeps detection entirely in-process (docs/API-PLANT.md §Detection).
    pub detect_url: Option<String>,
    pub worker_id: String,
    pub shutdown: Shutdown,
}

/// The four stages. `rollup` is the tail of `extract`, not a job of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Sfm,
    Detect,
    Register,
    Extract,
}

impl Stage {
    pub const ALL: [Stage; 4] = [Stage::Sfm, Stage::Detect, Stage::Register, Stage::Extract];

    pub fn as_str(self) -> &'static str {
        match self {
            Stage::Sfm => "sfm",
            Stage::Detect => "detect",
            Stage::Register => "register",
            Stage::Extract => "extract",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|st| st.as_str() == s)
    }

    /// `captures.status` the stage consumes — what `POST /captures/{id}/retry` rewinds to.
    /// The API owns the rewind; the mapping lives here so the machine is described once.
    #[allow(dead_code)]
    pub fn input_status(self) -> &'static str {
        match self {
            Stage::Sfm => "uploaded",
            Stage::Detect => "ortho",
            Stage::Register => "detected",
            Stage::Extract => "registered",
        }
    }

    /// `captures.status` reached when the stage succeeds.
    pub fn success_status(self) -> &'static str {
        match self {
            Stage::Sfm => "ortho",
            Stage::Detect => "detected",
            Stage::Register => "registered",
            Stage::Extract => "extracted",
        }
    }

    /// Stage queued behind this one on success (`None` = pipeline complete).
    pub fn next(self) -> Option<Stage> {
        match self {
            Stage::Sfm => Some(Stage::Detect),
            Stage::Detect => Some(Stage::Register),
            Stage::Register => Some(Stage::Extract),
            Stage::Extract => None,
        }
    }
}

/// One claimed `pipeline_jobs` row. `stage` stays a `String` (runtime sqlx, no macros).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Job {
    pub id: Uuid,
    pub org_id: Uuid,
    pub capture_id: Uuid,
    pub stage: String,
    pub attempts: i32,
    pub max_attempts: i32,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Outcome {
    /// Jobs claimed and executed in this pass.
    pub ran: usize,
    /// Jobs that exhausted their attempts (capture ended `failed`).
    pub failed: usize,
}

/// Cooperative shutdown. SIGINT stops the worker **between** jobs: a stage in flight owns a
/// claimed row and half of a capture's state, so it is never cancelled mid-way — the job would
/// have to be reclaimed as stale anyway.
#[derive(Clone, Default)]
pub struct Shutdown(Arc<ShutdownInner>);

#[derive(Default)]
struct ShutdownInner {
    flag: AtomicBool,
    wake: Notify,
}

impl Shutdown {
    pub fn requested(&self) -> bool {
        self.0.flag.load(Ordering::Relaxed)
    }

    pub fn request(&self) {
        self.0.flag.store(true, Ordering::Relaxed);
        // `notify_one` leaves a permit behind, so a request racing with `sleep` still wakes it.
        self.0.wake.notify_one();
    }

    /// Idle for `d`, waking early when shutdown is requested.
    pub async fn sleep(&self, d: Duration) {
        if self.requested() {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep(d) => {}
            _ = self.0.wake.notified() => {}
        }
    }

    /// Spawn the SIGINT listener. A second Ctrl-C hits tokio's default handler and kills the
    /// process outright, which is the intended escape hatch during a long ODM run.
    pub fn listen_ctrl_c(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                tracing::info!("shutdown signal received — finishing the current stage");
                me.request();
            }
        });
    }
}

// --- run loops -------------------------------------------------------------

/// Drain every runnable job — including the ones a stage enqueues behind itself — then report.
/// This is what `--once` runs, so the smoke script gets a fully processed capture in one call.
/// A job re-queued with backoff has `run_after` in the future and is therefore not runnable:
/// the drain always terminates.
pub async fn run_once(w: &Worker, capture: Option<Uuid>) -> anyhow::Result<Outcome> {
    let mut outcome = Outcome::default();
    while !w.shutdown.requested() {
        let Some(job) = claim(w, capture).await? else {
            break;
        };
        outcome.ran += 1;
        match run_job(w, &job).await {
            Ok(()) => finish_ok(w, &job).await?,
            Err(e) => {
                tracing::warn!(job = %job.id, stage = %job.stage, error = %e, "stage failed");
                if fail_job(w, &job, &e.to_string()).await? {
                    outcome.failed += 1;
                }
            }
        }
    }
    Ok(outcome)
}

/// Long-running mode: drain, then idle for `interval` before polling again.
pub async fn run_loop(w: &Worker, interval: Duration, capture: Option<Uuid>) -> anyhow::Result<()> {
    loop {
        let outcome = run_once(w, capture).await?;
        if w.shutdown.requested() {
            tracing::info!("worker stopped");
            return Ok(());
        }
        if outcome.ran == 0 {
            w.shutdown.sleep(interval).await;
        }
    }
}

/// Dispatch one claimed job to its stage body.
pub async fn run_job(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let stage = Stage::parse(&job.stage).ok_or_else(|| anyhow!("unknown stage {}", job.stage))?;
    tracing::info!(job = %job.id, capture = %job.capture_id, stage = stage.as_str(), "running stage");
    match stage {
        Stage::Sfm => sfm::run(w, job).await,
        Stage::Detect => detect::run(w, job).await,
        Stage::Register => detect::register(w, job).await,
        Stage::Extract => extract::run(w, job).await,
    }
}

// --- job bookkeeping (the SQL is frozen in the contract) --------------------

/// Claim the next runnable job. **Frozen statement** (docs/API-PLANT.md §"Pipeline stages");
/// `--capture` narrows the inner select, and `FOR UPDATE SKIP LOCKED` is what keeps two
/// workers from running the same stage twice.
pub async fn claim(w: &Worker, capture: Option<Uuid>) -> anyhow::Result<Option<Job>> {
    let job = sqlx::query_as::<_, Job>(
        "UPDATE pipeline_jobs
            SET state = 'running', started_at = now(), attempts = attempts + 1,
                worker_id = $1, updated_at = now()
          WHERE id = (SELECT id FROM pipeline_jobs
                       WHERE state = 'queued' AND run_after <= now()
                         AND ($2::uuid IS NULL OR capture_id = $2)
                       ORDER BY run_after, created_at
                       FOR UPDATE SKIP LOCKED
                       LIMIT 1)
      RETURNING id, org_id, capture_id, stage, attempts, max_attempts",
    )
    .bind(&w.worker_id)
    .bind(capture)
    .fetch_optional(&w.pool)
    .await?;
    Ok(job)
}

/// Mark the job `succeeded`, advance `captures.status` to `stage.success_status()`, and
/// insert/queue `stage.next()` (`ON CONFLICT (capture_id, stage)` → re-queue). When there is
/// no next stage the capture is `extracted` and `processed_at` is stamped. One transaction:
/// a crash here must never leave a capture advanced with nothing queued behind it.
pub async fn finish_ok(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let stage = Stage::parse(&job.stage).ok_or_else(|| anyhow!("unknown stage {}", job.stage))?;
    let next = stage.next();

    let mut tx = w.pool.begin().await?;
    sqlx::query(
        "UPDATE pipeline_jobs
            SET state = 'succeeded', finished_at = now(), error = NULL, updated_at = now()
          WHERE id = $1",
    )
    .bind(job.id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE captures
            SET status = $2, failed_stage = NULL, error = NULL, updated_at = now(),
                processed_at = CASE WHEN $3 THEN now() ELSE processed_at END
          WHERE id = $1 AND org_id = $4",
    )
    .bind(job.capture_id)
    .bind(stage.success_status())
    .bind(next.is_none())
    .bind(job.org_id)
    .execute(&mut *tx)
    .await?;

    if let Some(next) = next {
        // Re-queueing an already-`succeeded` downstream job is deliberate: its inputs were
        // just rebuilt, so the rest of the chain has to run again.
        sqlx::query(
            "INSERT INTO pipeline_jobs
                 (id, org_id, capture_id, stage, state, attempts, max_attempts, run_after)
             VALUES ($1, $2, $3, $4, 'queued', 0, $5, now())
             ON CONFLICT (capture_id, stage) DO UPDATE SET
                 state = 'queued', attempts = 0, error = NULL, run_after = now(),
                 started_at = NULL, finished_at = NULL, worker_id = NULL, updated_at = now()",
        )
        .bind(Uuid::new_v4())
        .bind(job.org_id)
        .bind(job.capture_id)
        .bind(next.as_str())
        .bind(MAX_ATTEMPTS)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    tracing::info!(
        job = %job.id, capture = %job.capture_id, stage = stage.as_str(),
        status = stage.success_status(), next = next.map(Stage::as_str),
        "stage succeeded"
    );
    Ok(())
}

/// Record a stage failure. `attempts < max_attempts` → back to `queued` with
/// `run_after = now() + 1 min * 2^attempts` (cap [`MAX_BACKOFF_MINUTES`]) and the capture keeps
/// its last-good status. On the last attempt the job is `failed` **and** the capture becomes
/// `failed` with `failed_stage`/`error` set. Returns `true` in that terminal case.
pub async fn fail_job(w: &Worker, job: &Job, error: &str) -> anyhow::Result<bool> {
    let error = truncate_error(error);
    // `attempts` was incremented by the claim, so it counts attempts *used*.
    if job.attempts < job.max_attempts {
        let backoff = backoff_minutes(job.attempts);
        sqlx::query(
            "UPDATE pipeline_jobs
                SET state = 'queued', error = $2, started_at = NULL, updated_at = now(),
                    run_after = now() + make_interval(mins => $3)
              WHERE id = $1",
        )
        .bind(job.id)
        .bind(&error)
        .bind(backoff)
        .execute(&w.pool)
        .await?;
        tracing::info!(
            job = %job.id, attempts = job.attempts, max_attempts = job.max_attempts,
            retry_in_min = backoff, "stage re-queued"
        );
        return Ok(false);
    }

    let mut tx = w.pool.begin().await?;
    sqlx::query(
        "UPDATE pipeline_jobs
            SET state = 'failed', error = $2, finished_at = now(), updated_at = now()
          WHERE id = $1",
    )
    .bind(job.id)
    .bind(&error)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE captures
            SET status = 'failed', failed_stage = $2, error = $3, updated_at = now()
          WHERE id = $1 AND org_id = $4",
    )
    .bind(job.capture_id)
    .bind(&job.stage)
    .bind(&error)
    .bind(job.org_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    tracing::error!(
        job = %job.id, capture = %job.capture_id, stage = %job.stage,
        "stage exhausted its attempts — capture failed"
    );
    Ok(true)
}

/// Re-queue jobs orphaned by a crashed worker: `state='running' AND started_at < now() -
/// interval '2 hours'` (see [`STALE_AFTER_HOURS`]). Called once at startup; returns the count.
/// `attempts` is left alone — a crash loop still exhausts the retry budget.
pub async fn requeue_stale(pool: &PgPool) -> anyhow::Result<u64> {
    let res = sqlx::query(
        "UPDATE pipeline_jobs
            SET state = 'queued', started_at = NULL, run_after = now(), updated_at = now()
          WHERE state = 'running' AND started_at < now() - make_interval(hours => $1)",
    )
    .bind(STALE_AFTER_HOURS as i32)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Minutes to wait before the next attempt: `2^attempts`, capped at [`MAX_BACKOFF_MINUTES`].
pub fn backoff_minutes(attempts: i32) -> i32 {
    let exp = attempts.clamp(0, 16);
    (1i64 << exp).min(MAX_BACKOFF_MINUTES) as i32
}

fn truncate_error(e: &str) -> String {
    let e = e.trim();
    if e.chars().count() <= MAX_ERROR_LEN {
        return e.to_string();
    }
    e.chars().take(MAX_ERROR_LEN).collect::<String>() + "…"
}

// --- object store (worker side) --------------------------------------------

/// `STORE_DIR` (default `./var/store`). The worker resolves the store root and the keys
/// itself — same layout as `crates/api/src/storage/mod.rs`, deliberately no shared crate
/// (docs/API-PLANT.md §"Storage layout").
pub fn store_dir_from_env() -> PathBuf {
    PathBuf::from(std::env::var("STORE_DIR").unwrap_or_else(|_| "./var/store".into()))
}

/// `PLANT_DETECT_URL` (e.g. `http://127.0.0.1:8788`), trailing slash trimmed. Unset or blank
/// means "no service" — `detect` then runs the in-process CV path only.
pub fn detect_url_from_env() -> Option<String> {
    std::env::var("PLANT_DETECT_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// Local path of a store key. Keys are built here, never client-supplied.
pub fn key_path(store_dir: &Path, key: &str) -> PathBuf {
    store_dir.join(key)
}

pub fn raw_prefix(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/raw")
}

pub fn ortho_key(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/ortho.tif")
}

pub fn dsm_key(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/dsm.tif")
}

/// ODM scratch space — worker-only, never an asset row.
pub fn work_prefix(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/work")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_names_round_trip() {
        for st in Stage::ALL {
            assert_eq!(Stage::parse(st.as_str()), Some(st));
        }
        assert_eq!(Stage::parse("rollup"), None); // rollup is the tail of extract, not a job
    }

    #[test]
    fn the_chain_walks_uploaded_to_extracted() {
        let mut st = Stage::Sfm;
        let mut statuses = vec![st.input_status()];
        loop {
            statuses.push(st.success_status());
            match st.next() {
                Some(n) => {
                    assert_eq!(n.input_status(), st.success_status(), "gap before {n:?}");
                    st = n;
                }
                None => break,
            }
        }
        assert_eq!(
            statuses,
            ["uploaded", "ortho", "detected", "registered", "extracted"]
        );
    }

    #[test]
    fn backoff_doubles_then_caps() {
        assert_eq!(backoff_minutes(1), 2); // first retry
        assert_eq!(backoff_minutes(2), 4);
        assert_eq!(backoff_minutes(5), 30); // 32 → capped
        assert_eq!(backoff_minutes(1000), MAX_BACKOFF_MINUTES as i32);
        assert_eq!(backoff_minutes(0), 1);
    }

    #[test]
    fn store_keys_match_the_frozen_layout() {
        let c = Uuid::nil();
        assert_eq!(ortho_key(c), format!("captures/{c}/ortho.tif"));
        assert_eq!(dsm_key(c), format!("captures/{c}/dsm.tif"));
        assert_eq!(raw_prefix(c), format!("captures/{c}/raw"));
        assert_eq!(work_prefix(c), format!("captures/{c}/work"));
        assert_eq!(
            key_path(Path::new("/var/store"), &ortho_key(c)),
            PathBuf::from(format!("/var/store/captures/{c}/ortho.tif"))
        );
    }

    #[test]
    fn long_errors_are_truncated() {
        let long = "x".repeat(MAX_ERROR_LEN * 2);
        assert_eq!(truncate_error(&long).chars().count(), MAX_ERROR_LEN + 1);
        assert_eq!(truncate_error("  boom\n"), "boom");
    }
}
