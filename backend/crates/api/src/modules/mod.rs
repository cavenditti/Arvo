// SPINE (read-only for feature agents). One module per feature; each exposes `router()`.
pub mod alerts;
pub mod auth;
pub mod captures;
pub mod farms;
pub mod indices;
pub mod observations;
pub mod orgs;
pub mod parcels;
pub mod plant_insights;
pub mod plant_tiles;
pub mod plants;
pub mod reports;
pub mod scenes;
#[cfg(feature = "imagery")]
pub mod tiles;
pub mod weather;

// Not a feature module: the object store (docs/API-PLANT.md §"Storage layout"). The file lives
// at the contract path `crates/api/src/storage/mod.rs`; it is declared from here because
// `main.rs` — the only place a crate-root `mod` can go — is frozen this phase. Callers use
// `crate::modules::storage::{Store, LocalStore}`.
#[path = "../storage/mod.rs"]
pub mod storage;
