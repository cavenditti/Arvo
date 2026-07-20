//! OWNER: be-plant-insights — neighbour-relative vigor outliers (FR-P-040): a plant judged
//! against the plants standing around it. That is a different question from the one
//! `core::anomaly` answers (a parcel judged against its own past): a whole block can decline
//! together after a heat wave without a single plant being an outlier, and a plant can be
//! dying while the block trend is flat. Both detectors run; neither replaces the other.
//!
//! Frozen definition: docs/API-PLANT.md §"Plant insights" (outliers). Pure — the caller
//! selects the neighbours in PostGIS (`ST_DWithin` + the `<->` KNN order) and passes their
//! values in; nothing here knows about ids, geometry or the database.
//!
//! **Why median + MAD and not mean + stddev.** A neighbourhood is 3–32 plants, so one dead
//! tree is 3–30% of the sample. It pulls the mean down *and* inflates the stddev, and the
//! inflated stddev is what hides the very plant we are hunting — the detector would go quiet
//! exactly when a cluster starts failing. The median ignores the dead neighbour and the MAD
//! barely moves. `one_dead_neighbour_does_not_hide_the_outlier` pins that difference down.

use serde::{Deserialize, Serialize};

/// Neighbourhood size and search radius (endpoint defaults; ranges 3–32 and 5–100 m).
pub const DEFAULT_K: usize = 8;
pub const DEFAULT_RADIUS_M: f64 = 25.0;
/// Reporting threshold and the critical cut on the robust z.
pub const DEFAULT_THRESHOLD_Z: f64 = -2.5;
pub const CRITICAL_Z: f64 = -3.5;
/// Below this many neighbours (or with a zero MAD) the plant is skipped — no z at all.
pub const MIN_NEIGHBOURS: usize = 3;
/// 0.6745 = Φ⁻¹(0.75): scales the MAD onto a standard-deviation-equivalent.
pub const MAD_SCALE: f64 = 0.6745;

/// Accepted parameter ranges (docs/API-PLANT.md §"Plant insights"), kept next to the maths so
/// the handler clamps to the same numbers the detector was reasoned about.
pub const K_MIN: usize = 3;
pub const K_MAX: usize = 32;
pub const RADIUS_MIN_M: f64 = 5.0;
pub const RADIUS_MAX_M: f64 = 100.0;
pub const THRESHOLD_Z_MIN: f64 = -6.0;
pub const THRESHOLD_Z_MAX: f64 = -1.0;

/// Noise floor on the spread — the neighbour-relative counterpart of `anomaly::MIN_BASELINE`.
/// The z divides by the MAD, so a nearly constant neighbourhood turns sensor noise into an
/// arbitrarily large z: eight plants reported as 0.6001/0.6002/0.6003 make a plant at 0.59
/// look 70 sigma out. That happens with quantized or synthetic values, never with a real
/// canopy. The floor is **relative** (a fraction of the median) because this detector runs
/// over metrics with wildly different units — NDVI in 0..1, `canopy_m2` in m², `height_m` in
/// m — and one fixed absolute floor would be wrong in at least one of them.
///
/// Set at 0.2%, deliberately far below real measurement noise: this guards *degenerate* data
/// (a neighbourhood whose values agree to two parts per thousand, which no instrument
/// produces), not noise in general — genuine noise belongs in the MAD, where the z already
/// accounts for it. A tighter floor starts skipping plants on a mildly varying synthetic
/// field, and a detector that goes quiet on the demo data is worse than useless.
pub const MIN_MAD_FRACTION: f64 = 0.002;
/// Absolute backstop for medians at or near zero (NDMI legitimately sits around 0), where the
/// relative floor collapses. Also the float-safe spelling of "the MAD is zero".
pub const MAD_EPSILON: f64 = 1e-9;

/// Noise floor on the **gap** — the neighbour-relative counterpart of `anomaly::MIN_ABS_DROP`,
/// and the reason the MAD floor above is not sufficient on its own. The z knows *how many MADs*
/// a plant sits below its neighbours, never *how much NDVI*: on a genuinely uniform block the
/// MAD clears its floor while still being tiny, so a difference no instrument can resolve comes
/// out past the critical cut. Eight plants spread over 0.696..0.704 have a MAD of 0.0020 against
/// a 0.0014 floor (cleared), and a plant at 0.690 — 1.5% below its neighbours, inside drone
/// radiometric and co-registration error — scores z = −3.5, which raises a `critical`
/// plant_vigor_outlier and puts a healthy tree on the replant list as `vigor_collapse`.
///
/// So a *reported* plant must also be materially below its neighbourhood: at least
/// `MIN_GAP_FRACTION` of the neighbour median, and never less than [`MIN_ABS_GAP`].
///
/// **Relative, like the MAD floor, and for the same reason.** The detector is metric-blind —
/// [`assess`] and [`evaluate`] see bare numbers, and the caller pushes NDVI (~0..1), `canopy_m2`
/// (~15 m²) and `height_m` (~3 m) through the same code path with no metric in the signature.
/// One fixed absolute floor cannot serve all three (0.05 is a large slice of the useful NDVI
/// range and 0.3% of a canopy), so the floor is a fraction of the median and rescales itself
/// with whatever metric it is handed.
///
/// **5%, not more.** The gaps this exists to silence are ~1.5% of the median; the smallest gap
/// still worth an agronomist's walk is ~0.065 NDVI on a 0.70 block (9%), and the loosest
/// threshold a caller may pass reports 0.04 on 0.70 (5.7%) — both pinned by tests below. 5%
/// sits between them with room on either side: on a 0.70 block it means 0.035 NDVI, above
/// per-plant extraction error and below any deficit an agronomist would act on.
pub const MIN_GAP_FRACTION: f64 = 0.05;
/// Absolute backstop for medians at or near zero, where the relative gap floor collapses to
/// nothing (NDMI sits around 0 and legitimately goes negative — there a 0.0105 gap is "2100% of
/// the median" and the fraction above waves it through). Expressed in **reflectance-index
/// units**, because those are the only metrics whose median can approach zero: `canopy_m2` and
/// `height_m` are never near zero for a living plant, so there the relative term always binds
/// first and this constant never applies. 0.02 is the drone radiometric + co-registration error
/// on a per-plant index sample; deliberately below `anomaly::MIN_ABS_DROP` (0.05), which has to
/// carry a whole parcel-mean series on its own, whereas here the fraction above does the work on
/// every non-degenerate median.
pub const MIN_ABS_GAP: f64 = 0.02;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

/// The robust baseline a plant is judged against: what its neighbours look like.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Neighbourhood {
    pub median: f64,
    pub mad: f64,
    /// Usable neighbours — non-finite values are dropped before anything is computed.
    pub count: usize,
}

/// A plant scored against its neighbourhood. Mirrors the `PlantOutlier` API type.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Outlier {
    pub z: f64,
    pub neighbour_median: f64,
    pub neighbour_mad: f64,
    pub neighbour_count: usize,
    /// Severity of the raw z ([`severity_for`]). Only [`evaluate`] applies the materiality gate,
    /// so a `critical` read off [`assess`] is not by itself a reportable event.
    pub severity: Severity,
}

pub fn severity_for(z: f64) -> Severity {
    if z <= CRITICAL_Z {
        Severity::Critical
    } else if z <= DEFAULT_THRESHOLD_Z {
        Severity::Warning
    } else {
        Severity::Info
    }
}

/// Smallest MAD that still carries information for a neighbourhood centred on `median`.
pub fn mad_floor(median: f64) -> f64 {
    (MIN_MAD_FRACTION * median.abs()).max(MAD_EPSILON)
}

/// Smallest shortfall below `median` that is a real difference rather than sensor noise — the
/// materiality gate [`evaluate`] applies on top of the z (see [`MIN_GAP_FRACTION`]).
pub fn gap_floor(median: f64) -> f64 {
    (MIN_GAP_FRACTION * median.abs()).max(MIN_ABS_GAP)
}

/// Median + MAD of a plant's neighbours. `None` when the neighbourhood cannot support a z:
/// fewer than [`MIN_NEIGHBOURS`] usable values, or a spread at/below the noise floor.
pub fn neighbourhood(neighbour_values: &[f64]) -> Option<Neighbourhood> {
    let mut sample: Vec<f64> = neighbour_values
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .collect();
    if sample.len() < MIN_NEIGHBOURS {
        return None;
    }
    let mid = median(&mut sample);
    let mut deviations: Vec<f64> = sample.iter().map(|v| (v - mid).abs()).collect();
    let mad = median(&mut deviations);
    if mad < mad_floor(mid) {
        return None; // constant/quantized neighbourhood — the z would be pure noise gain
    }
    Some(Neighbourhood {
        median: mid,
        mad,
        count: sample.len(),
    })
}

/// Score a plant against its neighbours: `z = 0.6745 · (value − median) / mad`, negative when
/// the plant is weaker than its neighbourhood. `None` when no z can be computed (see
/// [`neighbourhood`]). Neither the threshold nor the [`MIN_GAP_FRACTION`] gate is applied —
/// this is the raw score the ranking's `neighbour_z` reports; acting on it goes through
/// [`evaluate`], which is also how the replant list re-uses the `critical` cut.
pub fn assess(value: f64, neighbour_values: &[f64]) -> Option<Outlier> {
    if !value.is_finite() {
        return None;
    }
    let n = neighbourhood(neighbour_values)?;
    let z = MAD_SCALE * (value - n.median) / n.mad;
    Some(Outlier {
        z,
        neighbour_median: n.median,
        neighbour_mad: n.mad,
        neighbour_count: n.count,
        severity: severity_for(z),
    })
}

/// [`assess`] restricted to reportable outliers. `Some` only when the plant is both
/// **statistically** out (`z ≤ threshold`, default [`DEFAULT_THRESHOLD_Z`]) and **materially**
/// below its neighbourhood (`median − value ≥ gap_floor(median)`, see [`MIN_GAP_FRACTION`]).
/// A plant *above* its neighbourhood is never an event — vigor above the neighbours is not
/// something to act on.
///
/// Every caller that *acts* comes through here — the outliers endpoint, the plant-alert
/// detector, and the replant list re-evaluating at [`CRITICAL_Z`] — so this one gate is also
/// what keeps a `critical` off a plant whose deficit is not real: a gap under the floor yields
/// no event at all, and therefore no `critical` either. [`assess`] stays ungated on purpose —
/// the ranking's `neighbour_z` is informative even where it is not actionable.
pub fn evaluate(value: f64, neighbour_values: &[f64], threshold: f64) -> Option<Outlier> {
    assess(value, neighbour_values)
        .filter(|o| o.z <= threshold)
        .filter(|o| o.neighbour_median - value >= gap_floor(o.neighbour_median))
}

/// Median of a slice (sorts in place). Caller guarantees non-empty and finite.
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = values.len();
    if n % 2 == 1 {
        values[n / 2]
    } else {
        (values[n / 2 - 1] + values[n / 2]) / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A healthy orchard neighbourhood: eight plants wobbling around 0.70 NDVI.
    fn healthy_neighbours() -> Vec<f64> {
        vec![0.68, 0.70, 0.72, 0.69, 0.71, 0.70, 0.73, 0.67]
    }

    /// Textbook mean + stddev z, used only to show what the robust z buys us.
    fn naive_z(value: f64, values: &[f64]) -> f64 {
        let n = values.len() as f64;
        let mean = values.iter().sum::<f64>() / n;
        let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0);
        (value - mean) / var.sqrt()
    }

    #[test]
    fn severity_follows_the_frozen_cuts() {
        assert_eq!(severity_for(-4.0), Severity::Critical);
        assert_eq!(severity_for(CRITICAL_Z), Severity::Critical);
        assert_eq!(severity_for(-2.8), Severity::Warning);
        assert_eq!(severity_for(DEFAULT_THRESHOLD_Z), Severity::Warning);
        assert_eq!(severity_for(-1.0), Severity::Info);
        assert_eq!(severity_for(0.5), Severity::Info);
    }

    #[test]
    fn z_matches_the_frozen_formula() {
        // Neighbours 1,2,3,4 → median 2.5; |deviations| 1.5,0.5,0.5,1.5 → MAD 1.0.
        let o = assess(0.0, &[1.0, 2.0, 3.0, 4.0]).expect("computable");
        assert!((o.neighbour_median - 2.5).abs() < 1e-12);
        assert!((o.neighbour_mad - 1.0).abs() < 1e-12);
        assert_eq!(o.neighbour_count, 4);
        // 0.6745 · (0 − 2.5) / 1.0
        assert!((o.z - (-1.686_25)).abs() < 1e-9, "z {}", o.z);
        assert_eq!(o.severity, Severity::Info);
    }

    #[test]
    fn a_failing_plant_is_flagged_critical() {
        let o = evaluate(0.42, &healthy_neighbours(), DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.severity, Severity::Critical);
        assert!(o.z <= CRITICAL_Z, "z {}", o.z);
        assert!((o.neighbour_median - 0.70).abs() < 0.02);
    }

    #[test]
    fn a_mildly_weak_plant_is_a_warning() {
        // 0.065 below a neighbourhood whose median is 0.70 and MAD 0.015 → the warning band.
        let o = evaluate(0.635, &healthy_neighbours(), DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.severity, Severity::Warning);
        assert!(o.z <= DEFAULT_THRESHOLD_Z && o.z > CRITICAL_Z, "z {}", o.z);
    }

    #[test]
    fn a_normal_plant_is_not_an_event() {
        assert!(evaluate(0.70, &healthy_neighbours(), DEFAULT_THRESHOLD_Z).is_none());
        assert!(evaluate(0.68, &healthy_neighbours(), DEFAULT_THRESHOLD_Z).is_none());
    }

    #[test]
    fn a_vigorous_plant_is_never_reported() {
        // Above the neighbourhood: scored with a positive z, but never an event.
        assert!(evaluate(0.95, &healthy_neighbours(), DEFAULT_THRESHOLD_Z).is_none());
        let o = assess(0.95, &healthy_neighbours()).expect("computable");
        assert!(o.z > 0.0, "z {}", o.z);
        assert_eq!(o.severity, Severity::Info);
    }

    #[test]
    fn one_dead_neighbour_does_not_hide_the_outlier() {
        // THE reason this detector is median+MAD. One collapsed neighbour (0.05) among seven
        // healthy ones: mean+stddev inflates the spread until a genuinely failing plant looks
        // ordinary; the robust z still calls it critical.
        let mut neighbours = healthy_neighbours();
        neighbours[7] = 0.05;
        let o = evaluate(0.55, &neighbours, DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.severity, Severity::Critical);
        assert!((o.neighbour_median - 0.70).abs() < 0.02, "the median holds");
        assert!(
            naive_z(0.55, &neighbours) > DEFAULT_THRESHOLD_Z,
            "mean+stddev would have missed it (z {})",
            naive_z(0.55, &neighbours)
        );
    }

    #[test]
    fn two_neighbours_are_not_a_neighbourhood() {
        // A plant at the edge of a block: too few neighbours → skipped, never guessed at.
        assert!(evaluate(0.10, &[0.70, 0.71], DEFAULT_THRESHOLD_Z).is_none());
        assert!(neighbourhood(&[0.70, 0.71]).is_none());
        assert!(neighbourhood(&[]).is_none());
    }

    #[test]
    fn identical_neighbours_are_skipped() {
        // MAD = 0 → the z is a division by zero; the frozen rule is to skip the plant.
        assert!(evaluate(0.10, &[0.70; 8], DEFAULT_THRESHOLD_Z).is_none());
    }

    #[test]
    fn a_nearly_constant_neighbourhood_is_skipped() {
        // Quantized/synthetic values: MAD ~1e-4 on a 0.60 median. Without the floor a 0.59
        // plant scores z ≈ −70 and every wobble becomes a critical alert.
        let quantized = [
            0.6000, 0.6001, 0.6002, 0.6001, 0.6003, 0.6002, 0.6000, 0.6001,
        ];
        assert!(
            naive_z(0.59, &quantized) < CRITICAL_Z,
            "the naive z would fire"
        );
        assert!(evaluate(0.59, &quantized, DEFAULT_THRESHOLD_Z).is_none());
        assert!(neighbourhood(&quantized).is_none());
    }

    #[test]
    fn the_mad_floor_scales_with_the_metric() {
        // The same relative picture in NDVI units and in canopy m² → the same verdict,
        // because the floor is a fraction of the median, not a fixed absolute number.
        let ndvi: Vec<f64> = healthy_neighbours();
        let canopy: Vec<f64> = ndvi.iter().map(|v| v * 10.0).collect();
        let a = evaluate(0.42, &ndvi, DEFAULT_THRESHOLD_Z).expect("event");
        let b = evaluate(4.2, &canopy, DEFAULT_THRESHOLD_Z).expect("event");
        assert!((a.z - b.z).abs() < 1e-9, "{} vs {}", a.z, b.z);
        assert!((mad_floor(0.70) - 0.0014).abs() < 1e-9);
        assert!((mad_floor(7.0) - 0.014).abs() < 1e-9);
        assert_eq!(mad_floor(0.0), MAD_EPSILON, "near-zero medians (NDMI)");
        // A mildly varying synthetic field (MAD 0.008 on a 0.716 median, which is what the
        // demo seed produces) must stay well clear of the floor — a detector that goes quiet
        // on the demo data would pass every unit test and fail the only run that matters.
        assert!(0.008 > mad_floor(0.716) * 5.0);
    }

    /// A uniform block: NDVI 0.696..0.704, MAD 0.0020 against a 0.0014 floor, so the MAD floor
    /// waves it through. A plant 0.0105 below the median (1.5%, inside drone radiometric +
    /// co-registration error) then scores z = −3.54 — a `critical` alert and a replant entry on
    /// a healthy tree. The gap floor is what stops it; the raw z is still reported.
    #[test]
    fn a_trivial_gap_on_a_uniform_block_is_not_an_event() {
        let uniform = [0.700, 0.702, 0.704, 0.698, 0.696, 0.701, 0.703, 0.699];
        let n = neighbourhood(&uniform).expect("the MAD clears its floor");
        assert!((n.median - 0.7005).abs() < 1e-12);
        assert!((n.mad - 0.0020).abs() < 1e-12);
        assert!(
            n.mad > mad_floor(n.median),
            "the MAD floor does not catch this"
        );

        // The raw z is unchanged — PlantRanking.neighbour_z stays informative.
        let raw = assess(0.690, &uniform).expect("computable");
        assert!((raw.z - (-3.541)).abs() < 0.001, "z {}", raw.z);
        assert_eq!(raw.severity, Severity::Critical, "raw severity is ungated");

        // …but nothing acts on it: no alert, and no replant entry at the critical cut.
        assert!(
            n.median - 0.690 < gap_floor(n.median),
            "gap under the floor"
        );
        assert!(evaluate(0.690, &uniform, DEFAULT_THRESHOLD_Z).is_none());
        assert!(evaluate(0.690, &uniform, CRITICAL_Z).is_none());
    }

    /// The same shape on a metric with a completely different scale: canopy m² around 15.01,
    /// a plant 0.21 m² (1.4%) below → z = −2.83, a `warning` on nothing at all.
    #[test]
    fn a_trivial_gap_on_a_uniform_canopy_is_not_an_event() {
        let canopy = [15.0, 15.05, 15.1, 14.95, 14.9, 15.02, 15.08, 14.98];
        let raw = assess(14.8, &canopy).expect("computable");
        assert!((raw.z - (-2.833)).abs() < 0.001, "z {}", raw.z);
        assert_eq!(raw.severity, Severity::Warning);
        assert!(evaluate(14.8, &canopy, DEFAULT_THRESHOLD_Z).is_none());
    }

    /// The guard must not blind the detector on a uniform block — that is where a collapsed
    /// plant is most obvious. Same neighbourhoods as the two tests above, a genuinely failed
    /// plant: still critical, on both scales.
    #[test]
    fn a_collapsed_plant_is_still_critical_on_a_uniform_block() {
        let uniform = [0.700, 0.702, 0.704, 0.698, 0.696, 0.701, 0.703, 0.699];
        let o = evaluate(0.25, &uniform, DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.severity, Severity::Critical);
        assert!(o.z <= CRITICAL_Z, "z {}", o.z);
        // …and it is still picked up by the replant list, which re-evaluates at the critical cut.
        assert!(evaluate(0.25, &uniform, CRITICAL_Z).is_some());

        let canopy = [15.0, 15.05, 15.1, 14.95, 14.9, 15.02, 15.08, 14.98];
        let c = evaluate(5.0, &canopy, DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(c.severity, Severity::Critical);
    }

    /// The gap floor rescales with the metric, exactly like the MAD floor, and hands over to the
    /// absolute backstop where the median approaches zero.
    #[test]
    fn the_gap_floor_scales_with_the_metric() {
        assert!((gap_floor(0.7005) - 0.035_025).abs() < 1e-12, "NDVI");
        assert!((gap_floor(15.01) - 0.750_5).abs() < 1e-12, "canopy m²");
        assert_eq!(gap_floor(0.0), MIN_ABS_GAP, "near-zero medians (NDMI)");
        assert_eq!(gap_floor(-0.10), MIN_ABS_GAP, "negative medians (NDMI)");
        // The two deficits the module must keep reporting sit above the floor (the same numbers
        // `a_mildly_weak_plant_is_a_warning` and `the_threshold_is_the_callers_to_move` pin), so
        // the guard is calibrated between sensor noise and a real agronomic difference.
        assert!(
            0.065 > gap_floor(0.70),
            "a 9% NDVI deficit stays reportable"
        );
        assert!(0.04 > gap_floor(0.70), "5.7% at a loosened threshold too");
    }

    /// Near a zero median the *relative* floor collapses (a 0.0105 gap is "2100% of the median")
    /// and only [`MIN_ABS_GAP`] stands between NDMI noise and a critical alert.
    #[test]
    fn near_zero_medians_fall_back_to_the_absolute_gap() {
        let ndmi = [0.000, 0.002, 0.004, -0.002, -0.004, 0.001, 0.003, -0.001];
        assert!((neighbourhood(&ndmi).expect("computable").median - 0.0005).abs() < 1e-12);
        assert!(assess(-0.010, &ndmi).expect("computable").z <= CRITICAL_Z);
        assert!(
            evaluate(-0.010, &ndmi, DEFAULT_THRESHOLD_Z).is_none(),
            "noise"
        );
        // A real NDMI collapse still gets through.
        let o = evaluate(-0.20, &ndmi, DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.severity, Severity::Critical);
    }

    #[test]
    fn negative_metrics_are_scored_normally() {
        // NDMI legitimately sits below zero; the sign must not change the verdict.
        let neighbours = [-0.10, -0.12, -0.08, -0.11, -0.09, -0.10, -0.13, -0.07];
        let o = evaluate(-0.40, &neighbours, DEFAULT_THRESHOLD_Z).expect("event");
        assert!(o.z <= CRITICAL_Z, "z {}", o.z);
        assert!(o.neighbour_median < 0.0);
    }

    #[test]
    fn the_threshold_is_the_callers_to_move() {
        let neighbours = healthy_neighbours();
        // A mild gap: reported at a loose threshold, silent at the frozen default.
        assert!(evaluate(0.66, &neighbours, DEFAULT_THRESHOLD_Z).is_none());
        assert!(evaluate(0.66, &neighbours, -1.5).is_some());
        // The replant list re-uses the critical cut.
        assert!(evaluate(0.66, &neighbours, CRITICAL_Z).is_none());
        assert!(evaluate(0.42, &neighbours, CRITICAL_Z).is_some());
    }

    #[test]
    fn non_finite_values_never_panic() {
        let mut neighbours = healthy_neighbours();
        neighbours.push(f64::NAN);
        let o = evaluate(0.42, &neighbours, DEFAULT_THRESHOLD_Z).expect("event");
        assert_eq!(o.neighbour_count, 8, "the NaN neighbour is dropped");
        assert!(assess(f64::NAN, &healthy_neighbours()).is_none());
        assert!(assess(f64::INFINITY, &healthy_neighbours()).is_none());
    }

    #[test]
    fn an_even_neighbour_count_interpolates_both_medians() {
        // 6 neighbours → median = mean of the 3rd and 4th; the deviations likewise.
        let o = assess(1.0, &[10.0, 12.0, 14.0, 16.0, 18.0, 20.0]).expect("computable");
        assert!((o.neighbour_median - 15.0).abs() < 1e-12);
        // |deviations| = 5,3,1,1,3,5 → sorted 1,1,3,3,5,5 → MAD 3.
        assert!((o.neighbour_mad - 3.0).abs() < 1e-12);
        assert!((o.z - (0.6745 * (1.0 - 15.0) / 3.0)).abs() < 1e-12);
    }
}
