//! OWNER: be-alerts — background/on-demand jobs. `detect` holds the anomaly detector.
//! `detect_all` keeps its signature: main.rs CLI (`detect-anomalies`) and seed call it.
mod detect;

pub use detect::{detect_all, detect_for_org};
