//! OWNER: be-sfm — stage `sfm`: raw photos → `ortho.tif` + `dsm.tif` via self-hosted ODM.
//!
//! Input: every `raw` asset of the capture (`captures/{id}/raw/…`), scratch in
//! `captures/{id}/work/…`. Output: the two COGs written at the frozen keys, one
//! `capture_assets` row per kind (replacing any previous one), capture → `ortho`.
//!
//! ODM is a **subprocess**, never a library: [`Odm`] builds the argv and nothing else, so the
//! invocation is unit-testable on a machine without ODM (and injectable — `ODM_COMMAND` points
//! at a local install or a CI stub, `ODM_DOCKER`/`ODM_IMAGE` at the container image).
//!
//! Two ODM-free paths keep the pipeline runnable today:
//!   * products already at the frozen keys (a **pre-built** ortho/DSM drop, FR-P-014, or a
//!     re-run after the products were written) → the stage adopts them and succeeds;
//!   * otherwise, without `--features imagery`, it fails with [`STAGE_UNSUPPORTED`]
//!     (docs/API-PLANT.md §"Builds without GDAL"). `source="demo"` captures never reach here —
//!     `POST /process` sends them straight to `detect`.
//!
//! Raw `application/zip` bundles are not expanded in P-MVP: ODM reads loose photos.
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use uuid::Uuid;

use crate::pipeline::{self, Job, Worker, STAGE_UNSUPPORTED};

/// Container image used when ODM runs under docker (the default runner).
const DEFAULT_IMAGE: &str = "opendronemap/odm:latest";
const DEFAULT_DOCKER: &str = "docker";
/// Wall-clock budget for one ODM run (NFR-P-PERF: "a few hours per flight").
const DEFAULT_TIMEOUT_SECS: u64 = 4 * 60 * 60;
/// Where ODM leaves its products inside the project directory.
const ODM_ORTHO_REL: &str = "odm_orthophoto/odm_orthophoto.tif";
const ODM_DSM_REL: &str = "odm_dem/dsm.tif";
/// Mount points inside the container: `<project-path>/<name>` is ODM's project convention.
const CONTAINER_PROJECT_PATH: &str = "/datasets";
const CONTAINER_PROJECT_NAME: &str = "code";
/// Lines of ODM output kept in the job's `error` column.
const LOG_TAIL_LINES: usize = 20;

#[derive(Debug, sqlx::FromRow)]
struct CaptureRow {
    org_id: Uuid,
    source: String,
    gsd_cm: Option<f64>,
}

pub async fn run(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let capture_id = job.capture_id;
    let cap = sqlx::query_as::<_, CaptureRow>(
        "SELECT org_id, source, gsd_cm::double precision AS gsd_cm
           FROM captures WHERE id = $1 AND org_id = $2",
    )
    .bind(capture_id)
    .bind(job.org_id)
    .fetch_optional(&w.pool)
    .await?
    .ok_or_else(|| anyhow!("capture {capture_id} not found"))?;

    let ortho = pipeline::key_path(&w.store_dir, &pipeline::ortho_key(capture_id));
    let dsm = pipeline::key_path(&w.store_dir, &pipeline::dsm_key(capture_id));

    // Already built (pre-built drop, or a re-run after ODM succeeded): adopt the products and
    // keep the stage idempotent instead of burning hours re-running photogrammetry.
    if is_file(&ortho).await && is_file(&dsm).await {
        tracing::info!(capture = %capture_id, "sfm: reusing existing ortho/dsm");
        record_asset(w, cap.org_id, capture_id, "ortho", &ortho).await?;
        record_asset(w, cap.org_id, capture_id, "dsm", &dsm).await?;
        return Ok(());
    }

    let images = pipeline::key_path(&w.store_dir, &pipeline::raw_prefix(capture_id));
    let (raw_count, zip_count) = raw_asset_counts(w, capture_id).await?;
    if raw_count == 0 {
        bail!("capture has no raw imagery (source={})", cap.source);
    }
    if zip_count > 0 {
        tracing::warn!(
            capture = %capture_id, zip_count,
            "sfm: zipped raw bundles are not expanded in P-MVP — ODM will ignore them"
        );
    }

    // Real photogrammetry needs the imagery build (docs/API-PLANT.md §"Builds without GDAL").
    if !cfg!(feature = "imagery") {
        bail!(STAGE_UNSUPPORTED);
    }

    let project = pipeline::key_path(&w.store_dir, &pipeline::work_prefix(capture_id));
    tokio::fs::create_dir_all(&project)
        .await
        .with_context(|| format!("create work dir {}", project.display()))?;
    let odm = Odm::from_env();
    let run = OdmRun {
        project_dir: project.clone(),
        images_dir: images,
        gsd_cm: cap.gsd_cm,
        extra_args: extra_args_from_env(),
    };
    odm.prepare(&run).await?;

    let argv = odm.argv(&run);
    tracing::info!(capture = %capture_id, cmd = %argv.join(" "), "sfm: running ODM");
    spawn(&argv, timeout_from_env()).await?;

    publish(&project.join(ODM_ORTHO_REL), &ortho)
        .await
        .context("odm produced no orthomosaic")?;
    publish(&project.join(ODM_DSM_REL), &dsm)
        .await
        .context("odm produced no dsm (was --dsm dropped from ODM_EXTRA_ARGS?)")?;
    record_asset(w, cap.org_id, capture_id, "ortho", &ortho).await?;
    record_asset(w, cap.org_id, capture_id, "dsm", &dsm).await?;
    Ok(())
}

// --- ODM invocation --------------------------------------------------------

/// How ODM is reached. Chosen from the environment once per run; both variants build an argv
/// and nothing else, which is the whole point — the stage is testable without ODM installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Odm {
    /// `docker run --rm -v … <image> …` (default; `ODM_DOCKER`, `ODM_IMAGE`).
    Docker { docker: String, image: String },
    /// A host executable speaking ODM's CLI — a local install or a CI stub (`ODM_COMMAND`).
    Local { program: String },
}

/// One photogrammetry job in host paths.
#[derive(Debug, Clone)]
pub struct OdmRun {
    /// ODM project directory (scratch + products): `<store>/captures/{id}/work`.
    pub project_dir: PathBuf,
    /// Directory holding the raw photos: `<store>/captures/{id}/raw`.
    pub images_dir: PathBuf,
    /// Ground sampling distance in cm/px, when the flight recorded one.
    pub gsd_cm: Option<f64>,
    /// `ODM_EXTRA_ARGS`, split on whitespace.
    pub extra_args: Vec<String>,
}

impl Odm {
    pub fn from_env() -> Self {
        match std::env::var("ODM_COMMAND") {
            Ok(p) if !p.trim().is_empty() => Odm::Local {
                program: p.trim().to_string(),
            },
            _ => Odm::Docker {
                docker: env_or("ODM_DOCKER", DEFAULT_DOCKER),
                image: env_or("ODM_IMAGE", DEFAULT_IMAGE),
            },
        }
    }

    /// The full command line, `argv[0]` = program. Pure: nothing is spawned, nothing is read
    /// from the environment.
    pub fn argv(&self, run: &OdmRun) -> Vec<String> {
        let mut argv: Vec<String> = Vec::new();
        match self {
            Odm::Docker { docker, image } => {
                let container_project =
                    format!("{CONTAINER_PROJECT_PATH}/{CONTAINER_PROJECT_NAME}");
                argv.push(docker.clone());
                argv.extend(["run", "--rm", "-v"].map(String::from));
                argv.push(format!("{}:{container_project}", show(&run.project_dir)));
                argv.push("-v".into());
                // Read-only: ODM must never touch the uploaded originals.
                argv.push(format!(
                    "{}:{container_project}/images:ro",
                    show(&run.images_dir)
                ));
                argv.push(image.clone());
                argv.push("--project-path".into());
                argv.push(CONTAINER_PROJECT_PATH.into());
                argv.push(CONTAINER_PROJECT_NAME.into());
            }
            Odm::Local { program } => {
                let parent = run.project_dir.parent().unwrap_or(Path::new("."));
                let name = run
                    .project_dir
                    .file_name()
                    .and_then(OsStr::to_str)
                    .unwrap_or(CONTAINER_PROJECT_NAME);
                argv.push(program.clone());
                argv.push("--project-path".into());
                argv.push(show(parent));
                argv.push(name.to_string());
            }
        }
        argv.push("--dsm".into()); // the CHM the detector needs
        argv.push("--cog".into()); // NFR-P-STORE: products are COGs
        if let Some(gsd) = run.gsd_cm.filter(|g| g.is_finite() && *g > 0.0) {
            argv.push("--orthophoto-resolution".into());
            argv.push(format!("{gsd}"));
        }
        argv.extend(run.extra_args.iter().cloned());
        argv
    }

    /// Make the photos visible where the runner expects them. Docker bind-mounts them; a local
    /// ODM reads `<project>/images`, so link the raw directory in.
    async fn prepare(&self, run: &OdmRun) -> anyhow::Result<()> {
        let Odm::Local { .. } = self else {
            return Ok(());
        };
        let link = run.project_dir.join("images");
        if tokio::fs::symlink_metadata(&link).await.is_ok() {
            return Ok(());
        }
        link_images(&run.images_dir, &link)
    }
}

#[cfg(unix)]
fn link_images(images: &Path, link: &Path) -> anyhow::Result<()> {
    std::os::unix::fs::symlink(images, link)
        .with_context(|| format!("link {} -> {}", images.display(), link.display()))
}

#[cfg(not(unix))]
fn link_images(_images: &Path, _link: &Path) -> anyhow::Result<()> {
    bail!("ODM_COMMAND expects the photos at <project>/images; unsupported on this platform")
}

/// Run the command, capturing output. A timeout kills the child (`kill_on_drop`), so a wedged
/// ODM cannot hold the job in `running` until the stale sweep.
async fn spawn(argv: &[String], timeout: Duration) -> anyhow::Result<()> {
    let (program, args) = argv.split_first().ok_or_else(|| anyhow!("empty command"))?;
    let child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawn {program}"))?;

    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| anyhow!("odm timed out after {}s", timeout.as_secs()))?
        .context("odm wait")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let tail = if stderr.trim().is_empty() {
            tail_lines(&stdout, LOG_TAIL_LINES)
        } else {
            tail_lines(&stderr, LOG_TAIL_LINES)
        };
        bail!("odm exited with {}: {tail}", out.status);
    }
    Ok(())
}

// --- products --------------------------------------------------------------

/// Move an ODM product onto its frozen store key. Cross-device moves fall back to a copy into
/// `<key>.part` + rename, so a reader never sees a half-written `ortho.tif`.
async fn publish(src: &Path, dst: &Path) -> anyhow::Result<()> {
    if !is_file(src).await {
        bail!("missing {}", src.display());
    }
    if let Some(parent) = dst.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if tokio::fs::rename(src, dst).await.is_ok() {
        return Ok(());
    }
    let mut part = dst.as_os_str().to_os_string();
    part.push(".part");
    let part = PathBuf::from(part);
    tokio::fs::copy(src, &part)
        .await
        .with_context(|| format!("copy {} -> {}", src.display(), part.display()))?;
    tokio::fs::rename(&part, dst).await?;
    let _ = tokio::fs::remove_file(src).await;
    Ok(())
}

/// Replace the capture's single `ortho`/`dsm` asset row (docs/API-PLANT.md §Captures: exactly
/// one per capture). `path` is stored as the **store key**, never an absolute path.
async fn record_asset(
    w: &Worker,
    org_id: Uuid,
    capture_id: Uuid,
    kind: &str,
    path: &Path,
) -> anyhow::Result<()> {
    let key = match kind {
        "ortho" => pipeline::ortho_key(capture_id),
        "dsm" => pipeline::dsm_key(capture_id),
        other => bail!("sfm does not produce {other} assets"),
    };
    let bytes = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("stat {}", path.display()))?
        .len() as i64;
    let file_name = key.rsplit('/').next().unwrap_or(kind).to_string();

    let mut tx = w.pool.begin().await?;
    sqlx::query("DELETE FROM capture_assets WHERE capture_id = $1 AND org_id = $2 AND kind = $3")
        .bind(capture_id)
        .bind(org_id)
        .bind(kind)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO capture_assets
             (id, org_id, capture_id, kind, path, file_name, bytes, content_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'image/tiff')",
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(capture_id)
    .bind(kind)
    .bind(&key)
    .bind(&file_name)
    .bind(bytes)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(capture = %capture_id, kind, bytes, "sfm: recorded asset");
    Ok(())
}

/// `(raw assets, of which zip bundles)`.
async fn raw_asset_counts(w: &Worker, capture_id: Uuid) -> anyhow::Result<(i64, i64)> {
    let row: (i64, i64) = sqlx::query_as(
        "SELECT count(*),
                count(*) FILTER (WHERE content_type = 'application/zip')
           FROM capture_assets WHERE capture_id = $1 AND kind = 'raw'",
    )
    .bind(capture_id)
    .fetch_one(&w.pool)
    .await?;
    Ok(row)
}

// --- small helpers ---------------------------------------------------------

async fn is_file(p: &Path) -> bool {
    tokio::fs::metadata(p).await.is_ok_and(|m| m.is_file())
}

fn show(p: &Path) -> String {
    p.display().to_string()
}

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn extra_args_from_env() -> Vec<String> {
    std::env::var("ODM_EXTRA_ARGS")
        .unwrap_or_default()
        .split_whitespace()
        .map(String::from)
        .collect()
}

fn timeout_from_env() -> Duration {
    let secs = std::env::var("ODM_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|s| *s > 0)
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

fn tail_lines(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_of(gsd: Option<f64>, extra: &[&str]) -> OdmRun {
        OdmRun {
            project_dir: PathBuf::from("/var/store/captures/c1/work"),
            images_dir: PathBuf::from("/var/store/captures/c1/raw"),
            gsd_cm: gsd,
            extra_args: extra.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn docker_argv_mounts_project_and_photos() {
        let odm = Odm::Docker {
            docker: "docker".into(),
            image: "opendronemap/odm:3.5".into(),
        };
        assert_eq!(
            odm.argv(&run_of(Some(2.5), &[])),
            [
                "docker",
                "run",
                "--rm",
                "-v",
                "/var/store/captures/c1/work:/datasets/code",
                "-v",
                "/var/store/captures/c1/raw:/datasets/code/images:ro",
                "opendronemap/odm:3.5",
                "--project-path",
                "/datasets",
                "code",
                "--dsm",
                "--cog",
                "--orthophoto-resolution",
                "2.5",
            ]
        );
    }

    #[test]
    fn local_argv_uses_host_paths_and_the_project_name() {
        let odm = Odm::Local {
            program: "/usr/bin/odm".into(),
        };
        assert_eq!(
            odm.argv(&run_of(None, &["--fast-orthophoto"])),
            [
                "/usr/bin/odm",
                "--project-path",
                "/var/store/captures/c1",
                "work",
                "--dsm",
                "--cog",
                "--fast-orthophoto",
            ]
        );
    }

    #[test]
    fn a_missing_or_absurd_gsd_leaves_odm_to_its_default() {
        let odm = Odm::Local {
            program: "odm".into(),
        };
        for gsd in [None, Some(0.0), Some(f64::NAN)] {
            assert!(
                !odm.argv(&run_of(gsd, &[]))
                    .contains(&"--orthophoto-resolution".to_string()),
                "gsd {gsd:?} should not reach ODM"
            );
        }
    }

    #[test]
    fn the_dsm_is_never_optional() {
        // The detector's CHM comes from the DSM: every runner must ask ODM for one.
        for odm in [
            Odm::Docker {
                docker: "docker".into(),
                image: DEFAULT_IMAGE.into(),
            },
            Odm::Local {
                program: "odm".into(),
            },
        ] {
            assert!(odm.argv(&run_of(None, &[])).contains(&"--dsm".to_string()));
        }
    }

    #[test]
    fn log_tail_keeps_the_last_lines() {
        let log = (1..=50).map(|i| format!("line {i}\n")).collect::<String>();
        let tail = tail_lines(&log, 3);
        assert_eq!(tail, "line 48 | line 49 | line 50");
        assert_eq!(tail_lines("", 3), "");
    }
}
