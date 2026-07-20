//! OWNER: be-capture — the object store behind a small trait (docs/API-PLANT.md §"Storage layout").
//!
//! P-MVP is **local disk** rooted at `STORE_DIR` (default `./var/store`, sibling of
//! `var/uploads` and `var/tiles`). S3/MinIO later is a second `Store` impl plus a config
//! switch — no endpoint and no DB change. **Keys are the contract** (they are the future S3
//! keys) and are built by the helpers below, never assembled from client input:
//!
//! ```text
//! captures/{capture_id}/raw/{asset_id}.{ext}   # one per uploaded photo
//! captures/{capture_id}/ortho.tif              # orthomosaic (COG when ODM produced it)
//! captures/{capture_id}/dsm.tif                # surface model / canopy height source
//! captures/{capture_id}/work/…                 # ODM scratch, worker-only, never an asset row
//! ```
//!
//! `capture_assets.path` stores the key, never an absolute path; `arvo-worker` resolves the
//! same `STORE_DIR` + keys independently (deliberately no shared crate).
//!
//! **Module path:** reachable as `crate::modules::storage` — `main.rs` is frozen this phase,
//! so the module is declared from `modules/mod.rs` with `#[path]` while the file stays at the
//! contract location `crates/api/src/storage/mod.rs`.
// The `Store` surface is deliberately complete (it is the S3 seam, docs/API-PLANT.md
// §"Storage layout") even though P-MVP's captures module exercises only part of it.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::error::{ApiError, ApiResult};

/// Cap on a key's length — keys are internal, this only catches a bug before it hits the FS.
const MAX_KEY_LEN: usize = 512;

// --- keys ------------------------------------------------------------------

pub fn raw_key(capture_id: Uuid, asset_id: Uuid, ext: &str) -> String {
    format!("captures/{capture_id}/raw/{asset_id}.{ext}")
}

pub fn ortho_key(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/ortho.tif")
}

pub fn dsm_key(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/dsm.tif")
}

/// Worker scratch prefix. Never served, never an asset row.
pub fn work_prefix(capture_id: Uuid) -> String {
    format!("captures/{capture_id}/work")
}

/// Segments are `[A-Za-z0-9._-]` only, so `..`, absolute paths and separators are structurally
/// impossible — path traversal cannot be expressed as a key.
fn validate_key(key: &str) -> ApiResult<()> {
    let ok = !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key.split('/').all(|seg| {
            !seg.is_empty()
                && seg != "."
                && seg != ".."
                && seg
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        });
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest("invalid store key".into()))
    }
}

// --- trait -----------------------------------------------------------------

/// Minimal object store. Concrete `LocalStore` only in P-MVP; an S3 impl slots in behind the
/// same six methods.
#[allow(async_fn_in_trait)] // one concrete impl, always used directly — no `dyn Store`.
pub trait Store {
    /// Local filesystem path of a key. The worker and the asset-download handler need the
    /// path itself (streamed responses, ODM I/O) rather than the bytes.
    fn path(&self, key: &str) -> ApiResult<PathBuf>;
    /// Write a small object in one shot. Returns the byte count.
    async fn put(&self, key: &str, bytes: &[u8]) -> ApiResult<u64>;
    /// Open a streaming writer — multipart uploads are never buffered in memory (a raw photo
    /// runs to 200 MB, an ortho to 2 GB).
    async fn create(&self, key: &str) -> ApiResult<StoreWriter>;
    /// Read a **small** object whole; asset downloads stream from [`Store::path`] instead.
    async fn get(&self, key: &str) -> ApiResult<Vec<u8>>;
    async fn exists(&self, key: &str) -> ApiResult<bool>;
    async fn delete(&self, key: &str) -> ApiResult<()>;
}

/// Streaming writer. Writes to `<key>.part` and renames on [`StoreWriter::finish`], so an
/// aborted upload can never leave a truncated `ortho.tif` behind for the pipeline to read.
pub struct StoreWriter {
    file: tokio::fs::File,
    part: PathBuf,
    final_path: PathBuf,
    written: u64,
}

impl StoreWriter {
    pub async fn write(&mut self, chunk: &[u8]) -> ApiResult<()> {
        self.file
            .write_all(chunk)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        self.written += chunk.len() as u64;
        Ok(())
    }

    /// Bytes written so far — the caller's running total for the per-file/per-request caps.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Flush and publish the object. Returns the byte count.
    pub async fn finish(mut self) -> ApiResult<u64> {
        self.file
            .flush()
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        drop(self.file);
        tokio::fs::rename(&self.part, &self.final_path)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        Ok(self.written)
    }

    /// Drop the partial object (upload rejected mid-stream).
    pub async fn abort(self) {
        drop(self.file);
        let _ = tokio::fs::remove_file(&self.part).await;
    }
}

// --- local disk ------------------------------------------------------------

pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    /// Root is `Config::store_dir` (`STORE_DIR`). Directories are created lazily on write.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Store for LocalStore {
    fn path(&self, key: &str) -> ApiResult<PathBuf> {
        validate_key(key)?;
        Ok(self.root.join(key))
    }

    async fn put(&self, key: &str, bytes: &[u8]) -> ApiResult<u64> {
        let mut w = self.create(key).await?;
        w.write(bytes).await?;
        w.finish().await
    }

    async fn create(&self, key: &str) -> ApiResult<StoreWriter> {
        let final_path = self.path(key)?;
        if let Some(parent) = final_path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ApiError::Internal(e.into()))?;
        }
        // Append (never replace) the suffix: `ortho.tif` → `ortho.tif.part`.
        let mut part = final_path.clone().into_os_string();
        part.push(".part");
        let part = PathBuf::from(part);
        let file = tokio::fs::File::create(&part)
            .await
            .map_err(|e| ApiError::Internal(e.into()))?;
        Ok(StoreWriter {
            file,
            part,
            final_path,
            written: 0,
        })
    }

    async fn get(&self, key: &str) -> ApiResult<Vec<u8>> {
        let path = self.path(key)?;
        tokio::fs::read(&path).await.map_err(|_| ApiError::NotFound)
    }

    async fn exists(&self, key: &str) -> ApiResult<bool> {
        let path = self.path(key)?;
        Ok(tokio::fs::metadata(&path).await.is_ok())
    }

    async fn delete(&self, key: &str) -> ApiResult<()> {
        let path = self.path(key)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ApiError::Internal(e.into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_the_frozen_layout() {
        let c = Uuid::nil();
        let a = Uuid::nil();
        assert_eq!(raw_key(c, a, "jpg"), format!("captures/{c}/raw/{a}.jpg"));
        assert_eq!(ortho_key(c), format!("captures/{c}/ortho.tif"));
        assert_eq!(dsm_key(c), format!("captures/{c}/dsm.tif"));
    }

    #[test]
    fn traversal_and_absolute_keys_are_rejected() {
        let store = LocalStore::new("/var/store");
        assert!(store.path("captures/a/ortho.tif").is_ok());
        for bad in [
            "",
            "/etc/passwd",
            "../etc/passwd",
            "captures/../../etc/passwd",
            "captures//ortho.tif",
            "captures/a/o rtho.tif",
            "captures/a/\\ortho.tif",
        ] {
            assert!(store.path(bad).is_err(), "accepted bad key {bad:?}");
        }
    }
}
