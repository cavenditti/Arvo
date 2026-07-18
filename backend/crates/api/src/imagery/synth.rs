//! Deterministic synthetic index series for `seed --demo`. No GDAL, no network:
//! generates a crop-plausible seasonal curve per index so the whole agronomy loop
//! (series → anomaly → alert → report) runs end-to-end without the `imagery` feature.
//!
//! Determinism: the RNG is seeded from the parcel UUID and sample dates sit on an
//! absolute 5-day grid anchored at Mar 1 (not rescaled to the wall clock), so the same
//! calendar date always produces the same rows. The seeder additionally deletes its own
//! `source = 'demo'` rows before inserting, making `seed --demo` idempotent across days.
use std::f64::consts::PI;

use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use uuid::Uuid;

/// One synthetic observation row (maps 1:1 onto `index_observations`).
#[derive(Debug, Clone)]
pub struct SynthObs {
    pub index_name: &'static str,
    pub observed_at: DateTime<Utc>,
    pub mean: f64,
    pub median: f64,
    pub p10: f64,
    pub p90: f64,
    pub stddev: f64,
    pub pixel_count: i32,
    pub cloud_pct: f64,
    pub source: &'static str,
}

pub use arvo_core::indices::INDEX_NAMES;

/// Max acquisitions kept (the newest ones); the sample grid is a fixed 5-day revisit.
const N_POINTS: usize = 18;
/// Sentinel-2-like revisit cadence anchoring the absolute sample grid.
const REVISIT_DAYS: i64 = 5;
/// Gaussian temporal noise on the mean (task spec: σ = 0.03).
const NOISE_SD: f64 = 0.03;
/// Within-parcel spatial spread used to derive p10/p90/stddev around the mean.
const SPATIAL_SD: f64 = 0.045;

/// Generate the full demo series (all 5 indices) for a parcel, from Mar 1 to today.
/// `anomaly` injects a −25% dip in the last two NDVI and SAVI points (drives the detector).
pub fn series(parcel_id: Uuid, anomaly: bool) -> Vec<SynthObs> {
    let end = Utc::now().date_naive();
    series_until(parcel_id, anomaly, end)
}

/// Testable core: caller supplies the end date so results don't depend on wall clock.
pub fn series_until(parcel_id: Uuid, anomaly: bool, end: NaiveDate) -> Vec<SynthObs> {
    let mut rng = seeded_rng(parcel_id);
    let start = NaiveDate::from_ymd_opt(end.year_from_march(), 3, 1).unwrap();

    // Absolute grid: Mar 1 + k*5 days, keeping the newest ≤ N_POINTS dates ≤ end. Interior
    // dates never move as `end` advances, so re-seeding on a later day produces a superset
    // series instead of interleaved duplicates. Early in the season the series is simply
    // shorter (the demo anomaly needs ~4 points before the detector can fire).
    let season_days = (end - start).num_days().max(0);
    let k_max = season_days / REVISIT_DAYS;
    let k_min = (k_max - (N_POINTS as i64 - 1)).max(0);
    let dates: Vec<NaiveDate> = (k_min..=k_max)
        .map(|k| start + Duration::days(k * REVISIT_DAYS))
        .collect();
    let n_dates = dates.len();

    let mut out = Vec::with_capacity(n_dates * INDEX_NAMES.len());
    for (i, date) in dates.iter().enumerate() {
        // Season fraction still spans the whole Mar→Oct arc for the curve shape.
        let t = ((*date - start).num_days() as f64 / 214.0).clamp(0.0, 1.0);
        // Sentinel-2 overpass is ~10:00 UTC; keep a stable time-of-day.
        let observed_at = Utc.from_utc_datetime(&date.and_hms_opt(10, 0, 0).unwrap());
        let last_two = i + 2 >= n_dates;

        let base = ndvi_curve(t);
        let cloud_pct = rng.gen_range(0.0..40.0);
        let pixel_count = rng.gen_range(400..1400);

        for &index_name in &INDEX_NAMES {
            let target = match index_name {
                "ndvi" => base,
                "ndre" => 0.68 * base,
                "gndvi" => 0.72 * base,
                // NDMI (canopy moisture) tracks green-up but stays in ~0.1..0.4.
                "ndmi" => 0.10 + 0.30 * green_fraction(t),
                "savi" => 0.90 * base,
                _ => base,
            };
            let mut mean = target + gauss(&mut rng, NOISE_SD);
            if anomaly && last_two && matches!(index_name, "ndvi" | "savi") {
                mean *= 0.75; // −25% dip
            }
            mean = mean.clamp(-1.0, 1.0);

            // Plausible spatial spread around the mean.
            let sd = SPATIAL_SD * (0.85 + rng.gen::<f64>() * 0.3);
            let median = (mean + gauss(&mut rng, 0.005)).clamp(-1.0, 1.0);
            let p10 = (mean - 1.2816 * sd).clamp(-1.0, 1.0);
            let p90 = (mean + 1.2816 * sd).clamp(-1.0, 1.0);

            out.push(SynthObs {
                index_name,
                observed_at,
                mean,
                median,
                p10,
                p90,
                stddev: sd,
                pixel_count,
                cloud_pct,
                source: "demo",
            });
        }
    }
    out
}

/// Crop-plausible NDVI: bare-ish floor → sigmoid green-up to a ~0.85 peak → gentle decline.
fn ndvi_curve(t: f64) -> f64 {
    let floor = 0.18;
    let peak = 0.85;
    let mut v = floor + (peak - floor) * green_fraction(t);
    if t > 0.75 {
        v -= 0.12 * (t - 0.75) / 0.25; // senescence tail
    }
    v
}

/// Sigmoid green-up fraction in [0, 1], inflection ~mid-April (t ≈ 0.32).
fn green_fraction(t: f64) -> f64 {
    1.0 / (1.0 + (-12.0 * (t - 0.32)).exp())
}

/// Deterministic RNG seeded from the 16 UUID bytes (expanded to 32).
fn seeded_rng(parcel_id: Uuid) -> StdRng {
    let mut seed = [0u8; 32];
    let b = parcel_id.as_bytes();
    seed[..16].copy_from_slice(b);
    seed[16..].copy_from_slice(b);
    StdRng::from_seed(seed)
}

/// Zero-mean gaussian via Box-Muller (avoids pulling in rand_distr).
fn gauss(rng: &mut StdRng, sd: f64) -> f64 {
    let u1: f64 = rng.gen_range(f64::MIN_POSITIVE..1.0);
    let u2: f64 = rng.gen::<f64>();
    (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos() * sd
}

/// Helper: the season year for a given end date (the Mar-1 start of the current season).
trait SeasonYear {
    fn year_from_march(&self) -> i32;
}
impl SeasonYear for NaiveDate {
    fn year_from_march(&self) -> i32 {
        use chrono::Datelike;
        // Before March we'd belong to the previous year's season; MVP demo runs Mar→now.
        if self.month() >= 3 {
            self.year()
        } else {
            self.year() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 7, 16).unwrap()
    }

    #[test]
    fn shape_is_5_indices_x_18_points() {
        let s = series_until(Uuid::nil(), false, end());
        assert_eq!(s.len(), N_POINTS * 5);
        for name in INDEX_NAMES {
            assert_eq!(s.iter().filter(|o| o.index_name == name).count(), N_POINTS);
        }
    }

    #[test]
    fn deterministic_for_same_parcel() {
        let id = Uuid::from_u128(0x1234_5678_9abc_def0_1234_5678_9abc_def0);
        let a = series_until(id, true, end());
        let b = series_until(id, true, end());
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.observed_at, y.observed_at);
            assert!((x.mean - y.mean).abs() < 1e-12);
            assert!((x.p10 - y.p10).abs() < 1e-12);
        }
    }

    #[test]
    fn different_parcels_differ() {
        let a = series_until(Uuid::from_u128(1), false, end());
        let b = series_until(Uuid::from_u128(2), false, end());
        let same = a
            .iter()
            .zip(&b)
            .all(|(x, y)| (x.mean - y.mean).abs() < 1e-12);
        assert!(!same, "distinct parcels should produce distinct noise");
    }

    #[test]
    fn ndvi_greens_up_over_season() {
        let s = series_until(Uuid::from_u128(7), false, end());
        let ndvi: Vec<f64> = s
            .iter()
            .filter(|o| o.index_name == "ndvi")
            .map(|o| o.mean)
            .collect();
        // early season is bare-ish, peak season is high
        assert!(ndvi[0] < 0.4, "early ndvi {} too high", ndvi[0]);
        let peak = ndvi.iter().cloned().fold(f64::MIN, f64::max);
        assert!(peak > 0.7, "peak ndvi {peak} too low");
    }

    #[test]
    fn anomaly_dips_last_two_ndvi_and_savi() {
        let id = Uuid::from_u128(42);
        let clean = series_until(id, false, end());
        let dipped = series_until(id, true, end());
        for name in ["ndvi", "savi"] {
            let c: Vec<f64> = clean
                .iter()
                .filter(|o| o.index_name == name)
                .map(|o| o.mean)
                .collect();
            let d: Vec<f64> = dipped
                .iter()
                .filter(|o| o.index_name == name)
                .map(|o| o.mean)
                .collect();
            let n = c.len();
            // last two points drop ~25%, earlier points unchanged
            assert!((c[n - 3] - d[n - 3]).abs() < 1e-12);
            assert!(d[n - 1] < c[n - 1] * 0.8, "{name} last point not dipped");
            assert!(d[n - 2] < c[n - 2] * 0.8, "{name} penultimate not dipped");
        }
        // ndre must be untouched by the anomaly
        let cn: Vec<f64> = clean
            .iter()
            .filter(|o| o.index_name == "ndre")
            .map(|o| o.mean)
            .collect();
        let dn: Vec<f64> = dipped
            .iter()
            .filter(|o| o.index_name == "ndre")
            .map(|o| o.mean)
            .collect();
        assert!(cn.iter().zip(&dn).all(|(a, b)| (a - b).abs() < 1e-12));
    }

    #[test]
    fn ndmi_stays_in_band() {
        let s = series_until(Uuid::from_u128(3), false, end());
        for o in s.iter().filter(|o| o.index_name == "ndmi") {
            assert!(o.mean > 0.0 && o.mean < 0.5, "ndmi {} out of band", o.mean);
        }
    }

    #[test]
    fn stats_are_ordered_and_ranged() {
        let s = series_until(Uuid::from_u128(9), true, end());
        for o in &s {
            assert!(o.p10 <= o.p90, "p10 {} > p90 {}", o.p10, o.p90);
            assert!(o.mean >= -1.0 && o.mean <= 1.0);
            assert!(o.cloud_pct >= 0.0 && o.cloud_pct < 40.0);
            assert!(o.pixel_count >= 400);
            assert_eq!(o.source, "demo");
        }
    }
}
