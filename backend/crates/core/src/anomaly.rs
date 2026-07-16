//! OWNER: be-alerts — index time-series anomaly detection (see docs/API.md §Alerts, spec FR-0-050).
//! Pure functions: series in → Vec<AnomalyEvent> out; include #[cfg(test)] tests.
//!
//! Detector: for a point, the baseline is the median of prior points within a trailing
//! 45-day window (needs ≥3 samples). A relative drop of ≥15% below that baseline is a
//! `warning`, ≥25% a `critical`. Anything smaller (or a rise) is not an event.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Trailing window used to establish the baseline.
pub const BASELINE_WINDOW_DAYS: i64 = 45;
/// Minimum prior samples inside the window before a baseline is trustworthy.
pub const MIN_BASELINE_POINTS: usize = 3;
/// Relative drop thresholds (fraction of baseline).
pub const WARNING_DROP: f64 = 0.15;
pub const CRITICAL_DROP: f64 = 0.25;

/// One sample of a per-parcel index series: observation time + parcel-mean value.
#[derive(Debug, Clone, Copy)]
pub struct SeriesPoint {
    pub observed_at: DateTime<Utc>,
    pub mean: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

/// A detected abrupt drop relative to the trailing baseline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnomalyEvent {
    pub observed_at: DateTime<Utc>,
    /// Observed value at the anomalous point.
    pub value: f64,
    /// Median baseline the drop is measured against.
    pub baseline: f64,
    /// Relative drop as a fraction of the baseline, e.g. 0.27 = 27% below baseline.
    pub drop_pct: f64,
    pub severity: Severity,
}

/// Evaluate the latest point of a time-ascending series. `None` if there is no anomaly
/// (or not enough baseline history). Input must be sorted ascending by `observed_at`.
pub fn detect_latest(series: &[SeriesPoint]) -> Option<AnomalyEvent> {
    if series.is_empty() {
        return None;
    }
    evaluate_point(series, series.len() - 1)
}

/// Scan every point of a time-ascending series and return an event for each anomalous one.
/// Used by tests to exercise the detector across a whole fixture series.
pub fn scan_series(series: &[SeriesPoint]) -> Vec<AnomalyEvent> {
    (0..series.len())
        .filter_map(|i| evaluate_point(series, i))
        .collect()
}

/// Evaluate the point at `idx` against the median of prior points within the trailing window.
fn evaluate_point(series: &[SeriesPoint], idx: usize) -> Option<AnomalyEvent> {
    let point = series[idx];
    let window_start = point.observed_at - Duration::days(BASELINE_WINDOW_DAYS);

    let mut baseline_values: Vec<f64> = series[..idx]
        .iter()
        .filter(|p| p.observed_at >= window_start && p.observed_at < point.observed_at)
        .map(|p| p.mean)
        .collect();

    if baseline_values.len() < MIN_BASELINE_POINTS {
        return None;
    }
    let baseline = median(&mut baseline_values);
    if baseline <= 0.0 {
        return None; // guard against divide-by-zero / degenerate series
    }

    let drop_pct = (baseline - point.mean) / baseline;
    let severity = if drop_pct >= CRITICAL_DROP {
        Severity::Critical
    } else if drop_pct >= WARNING_DROP {
        Severity::Warning
    } else {
        return None;
    };

    Some(AnomalyEvent {
        observed_at: point.observed_at,
        value: point.mean,
        baseline,
        drop_pct,
        severity,
    })
}

/// Median of a slice (sorts in place). Caller guarantees non-empty.
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
    use chrono::TimeZone;

    fn ts(day: i64) -> DateTime<Utc> {
        // Base date 2026-03-01, `day` days later.
        Utc.with_ymd_and_hms(2026, 3, 1, 0, 0, 0).unwrap() + Duration::days(day)
    }

    /// A series with a stable ~0.60 baseline, one point every 5 days.
    fn stable_series(n: i64) -> Vec<SeriesPoint> {
        (0..n)
            .map(|i| SeriesPoint {
                observed_at: ts(i * 5),
                // small deterministic wobble around 0.60
                mean: 0.60 + if i % 2 == 0 { 0.01 } else { -0.01 },
            })
            .collect()
    }

    #[test]
    fn critical_drop_on_latest() {
        let mut s = stable_series(6); // days 0..25, baseline ~0.60
        s.push(SeriesPoint { observed_at: ts(30), mean: 0.44 }); // ~27% drop
        let ev = detect_latest(&s).expect("event");
        assert_eq!(ev.severity, Severity::Critical);
        assert!((ev.baseline - 0.60).abs() < 0.02, "baseline {}", ev.baseline);
        assert!((ev.value - 0.44).abs() < 1e-9);
        assert!(ev.drop_pct >= CRITICAL_DROP);
        assert!((ev.drop_pct - 0.2667).abs() < 0.02, "drop {}", ev.drop_pct);
    }

    #[test]
    fn warning_drop_on_latest() {
        let mut s = stable_series(6);
        s.push(SeriesPoint { observed_at: ts(30), mean: 0.50 }); // ~17% drop
        let ev = detect_latest(&s).expect("event");
        assert_eq!(ev.severity, Severity::Warning);
        assert!(ev.drop_pct >= WARNING_DROP && ev.drop_pct < CRITICAL_DROP);
    }

    #[test]
    fn no_event_for_small_dip() {
        let mut s = stable_series(6);
        s.push(SeriesPoint { observed_at: ts(30), mean: 0.56 }); // ~7% dip
        assert!(detect_latest(&s).is_none());
    }

    #[test]
    fn no_event_when_value_rises() {
        let mut s = stable_series(6);
        s.push(SeriesPoint { observed_at: ts(30), mean: 0.72 });
        assert!(detect_latest(&s).is_none());
    }

    #[test]
    fn needs_three_baseline_points() {
        // Only two prior points → no baseline, no event even on a big drop.
        let s = vec![
            SeriesPoint { observed_at: ts(0), mean: 0.60 },
            SeriesPoint { observed_at: ts(5), mean: 0.60 },
            SeriesPoint { observed_at: ts(10), mean: 0.30 },
        ];
        assert!(detect_latest(&s).is_none());
    }

    #[test]
    fn prior_points_outside_window_are_ignored() {
        // Three old points (>45d before the last), then a lone recent baseline point and a drop.
        // Only one point falls inside the trailing window → below MIN_BASELINE_POINTS → no event.
        let s = vec![
            SeriesPoint { observed_at: ts(0), mean: 0.60 },
            SeriesPoint { observed_at: ts(5), mean: 0.60 },
            SeriesPoint { observed_at: ts(10), mean: 0.60 },
            SeriesPoint { observed_at: ts(70), mean: 0.60 }, // day 55..100 window: only this one
            SeriesPoint { observed_at: ts(100), mean: 0.30 }, // window start = day 55
        ];
        // Within [55,100): only day 70 → 1 point < 3 → None.
        assert!(detect_latest(&s).is_none());
    }

    #[test]
    fn scan_flags_every_anomalous_point() {
        // Stable baseline, then two consecutive drops (mirrors the seeded −25% dip).
        let mut s = stable_series(6);
        s.push(SeriesPoint { observed_at: ts(30), mean: 0.42 });
        s.push(SeriesPoint { observed_at: ts(35), mean: 0.41 });
        let events = scan_series(&s);
        assert_eq!(events.len(), 2, "both drops flagged");
        assert!(events.iter().all(|e| e.severity == Severity::Critical));
    }

    #[test]
    fn empty_series_is_none() {
        assert!(detect_latest(&[]).is_none());
    }
}
