//! OWNER: be-weather — GDD accumulation, water balance, advisory rules (see docs/API.md §Weather).
//! Pure functions over simple structs; no I/O. Unit-tested below.
use chrono::NaiveDate;

/// GDD base temperature (°C) per crop: wheat 0, everything else 10.
/// Known crops: vine, olive, tomato, maize, wheat, other.
pub fn base_temp(crop: Option<&str>) -> f64 {
    match crop.map(str::to_ascii_lowercase).as_deref() {
        Some("wheat") => 0.0,
        _ => 10.0,
    }
}

/// Growing-degree-day accumulation over `(t_min, t_max)` day pairs:
/// Σ max(0, (t_min + t_max) / 2 − base).
pub fn gdd_sum(days: &[(f64, f64)], base: f64) -> f64 {
    days.iter().map(|&(lo, hi)| (((lo + hi) / 2.0) - base).max(0.0)).sum()
}

/// Water balance (mm) = Σ(precip − ET0) over the last `window` aligned days.
/// `precip[i]` and `et0[i]` must describe the same day (ascending by date).
pub fn water_balance(precip: &[f64], et0: &[f64], window: usize) -> f64 {
    let n = precip.len().min(et0.len());
    let start = n.saturating_sub(window);
    (start..n).map(|i| precip[i] - et0[i]).sum()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvisoryKind {
    FrostRisk,
    HeatStress,
    SprayWindow,
}

impl AdvisoryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FrostRisk => "frost_risk",
            Self::HeatStress => "heat_stress",
            Self::SprayWindow => "spray_window",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Critical => "critical",
        }
    }
}

/// One forecast day fed to the advisory engine (nulls tolerated).
#[derive(Debug, Clone, Copy)]
pub struct ForecastDay {
    pub date: NaiveDate,
    pub t_min: Option<f64>,
    pub t_max: Option<f64>,
    pub precip_mm: Option<f64>,
    pub wind_max_kmh: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Advisory {
    pub kind: AdvisoryKind,
    pub severity: Severity,
    pub date: NaiveDate,
    /// Salient value for message rendering: t_min (frost), t_max (heat), wind (spray).
    pub value: Option<f64>,
}

/// Decision-support advisories derived from the forecast window.
/// - frost_risk: t_min < 2 (critical < 0, else warning), any forecast day.
/// - heat_stress: t_max > 35 on ≥2 consecutive days (critical when that day ≥ 38).
/// - spray_window: wind < 15 km/h and precip < 1 mm on a day within the next 3 (info).
pub fn advisories(days: &[ForecastDay]) -> Vec<Advisory> {
    let mut days = days.to_vec();
    days.sort_by_key(|d| d.date);
    let mut out = Vec::new();

    for d in &days {
        if let Some(t) = d.t_min {
            if t < 2.0 {
                let severity = if t < 0.0 { Severity::Critical } else { Severity::Warning };
                out.push(Advisory { kind: AdvisoryKind::FrostRisk, severity, date: d.date, value: Some(t) });
            }
        }
    }

    let hot = |d: &ForecastDay| d.t_max.is_some_and(|t| t > 35.0);
    for i in 0..days.len() {
        if !hot(&days[i]) {
            continue;
        }
        let prev_run =
            i > 0 && hot(&days[i - 1]) && days[i - 1].date.succ_opt() == Some(days[i].date);
        let next_run =
            i + 1 < days.len() && hot(&days[i + 1]) && days[i].date.succ_opt() == Some(days[i + 1].date);
        if prev_run || next_run {
            let t = days[i].t_max.unwrap();
            let severity = if t >= 38.0 { Severity::Critical } else { Severity::Warning };
            out.push(Advisory { kind: AdvisoryKind::HeatStress, severity, date: days[i].date, value: Some(t) });
        }
    }

    for d in days.iter().take(3) {
        let calm = d.wind_max_kmh.is_some_and(|w| w < 15.0);
        let dry = d.precip_mm.is_some_and(|p| p < 1.0);
        if calm && dry {
            out.push(Advisory {
                kind: AdvisoryKind::SprayWindow,
                severity: Severity::Info,
                date: d.date,
                value: d.wind_max_kmh,
            });
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn base_temp_by_crop() {
        assert_eq!(base_temp(Some("wheat")), 0.0);
        assert_eq!(base_temp(Some("WHEAT")), 0.0);
        for c in ["vine", "olive", "tomato", "maize", "other", "kiwi"] {
            assert_eq!(base_temp(Some(c)), 10.0, "crop {c}");
        }
        assert_eq!(base_temp(None), 10.0);
    }

    #[test]
    fn gdd_accumulates_and_clamps() {
        assert_eq!(gdd_sum(&[], 10.0), 0.0);
        // mean 15, base 10 → 5 per day
        assert_eq!(gdd_sum(&[(10.0, 20.0), (10.0, 20.0)], 10.0), 10.0);
        // mean 8 < base 10 → clamped to 0, not negative
        assert_eq!(gdd_sum(&[(4.0, 12.0)], 10.0), 0.0);
        // wheat base 0: mean 10 → 10
        assert_eq!(gdd_sum(&[(5.0, 15.0)], 0.0), 10.0);
    }

    #[test]
    fn water_balance_windows() {
        let precip = [1.0, 2.0, 3.0];
        let et0 = [0.5, 0.5, 0.5];
        assert_eq!(water_balance(&precip, &et0, 3), 4.5);
        assert_eq!(water_balance(&precip, &et0, 2), 4.0); // last two: 1.5 + 2.5
        assert_eq!(water_balance(&precip, &et0, 10), 4.5); // window > len
        assert_eq!(water_balance(&[], &[], 7), 0.0);
        // deficit: no rain, ET0 evaporates
        assert_eq!(water_balance(&[0.0, 0.0], &[3.0, 4.0], 2), -7.0);
    }

    fn fd(date: &str, t_min: Option<f64>, t_max: Option<f64>, precip: Option<f64>, wind: Option<f64>) -> ForecastDay {
        ForecastDay { date: d(date), t_min, t_max, precip_mm: precip, wind_max_kmh: wind }
    }

    #[test]
    fn frost_risk_thresholds() {
        let days = [
            fd("2026-01-01", Some(1.5), Some(8.0), Some(0.0), Some(20.0)), // warning
            fd("2026-01-02", Some(-1.0), Some(6.0), Some(0.0), Some(20.0)), // critical
            fd("2026-01-03", Some(5.0), Some(10.0), Some(0.0), Some(20.0)), // none
        ];
        let a = advisories(&days);
        let frost: Vec<_> = a.iter().filter(|x| x.kind == AdvisoryKind::FrostRisk).collect();
        assert_eq!(frost.len(), 2);
        assert_eq!(frost[0].severity, Severity::Warning);
        assert_eq!(frost[1].severity, Severity::Critical);
    }

    #[test]
    fn heat_stress_needs_two_consecutive_days() {
        // single hot day surrounded by cool → no advisory
        let single = [
            fd("2026-07-01", Some(20.0), Some(30.0), Some(0.0), Some(10.0)),
            fd("2026-07-02", Some(22.0), Some(36.0), Some(0.0), Some(10.0)),
            fd("2026-07-03", Some(20.0), Some(30.0), Some(0.0), Some(10.0)),
        ];
        assert!(advisories(&single).iter().all(|x| x.kind != AdvisoryKind::HeatStress));

        // two consecutive hot days, second one extreme
        let run = [
            fd("2026-07-01", Some(24.0), Some(36.0), Some(0.0), Some(10.0)), // warning
            fd("2026-07-02", Some(25.0), Some(39.0), Some(0.0), Some(10.0)), // critical
        ];
        let heat: Vec<_> = advisories(&run)
            .into_iter()
            .filter(|x| x.kind == AdvisoryKind::HeatStress)
            .collect();
        assert_eq!(heat.len(), 2);
        assert_eq!(heat[0].severity, Severity::Warning);
        assert_eq!(heat[1].severity, Severity::Critical);
    }

    #[test]
    fn heat_stress_ignores_calendar_gaps() {
        // both hot but not adjacent dates → not a run
        let gap = [
            fd("2026-07-01", Some(24.0), Some(37.0), Some(0.0), Some(10.0)),
            fd("2026-07-05", Some(24.0), Some(37.0), Some(0.0), Some(10.0)),
        ];
        assert!(advisories(&gap).iter().all(|x| x.kind != AdvisoryKind::HeatStress));
    }

    #[test]
    fn spray_window_only_within_next_three_and_dry_calm() {
        let days = [
            fd("2026-05-01", Some(10.0), Some(20.0), Some(0.0), Some(8.0)),  // good, day 1
            fd("2026-05-02", Some(10.0), Some(20.0), Some(5.0), Some(8.0)),  // rain → no
            fd("2026-05-03", Some(10.0), Some(20.0), Some(0.0), Some(20.0)), // windy → no
            fd("2026-05-04", Some(10.0), Some(20.0), Some(0.0), Some(5.0)),  // good but beyond next 3
        ];
        let spray: Vec<_> = advisories(&days)
            .into_iter()
            .filter(|x| x.kind == AdvisoryKind::SprayWindow)
            .collect();
        assert_eq!(spray.len(), 1);
        assert_eq!(spray[0].date, d("2026-05-01"));
        assert_eq!(spray[0].severity, Severity::Info);
    }

    #[test]
    fn missing_values_do_not_trigger() {
        let days = [
            fd("2026-05-01", None, None, None, None),
            fd("2026-05-02", None, None, None, None),
        ];
        assert!(advisories(&days).is_empty());
    }
}
