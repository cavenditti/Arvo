//! Pure domain logic — no I/O, no DB. Everything here must be unit-tested.

pub mod agro;
pub mod anomaly;
pub mod indices;
// Phase P — per-plant tier (docs/API-PLANT.md).
pub mod plant_anomaly;
pub mod plant_metrics;
pub mod registration;
