//! Vegetation index formulas (NDVI, NDRE, GNDVI, NDMI, SAVI) and per-parcel pixel
//! statistics (mean / median / p10 / p90 / stddev). Pure — no I/O, no DB.

/// Normalized difference of two reflectance bands: (a - b) / (a + b).
/// Returns NaN when the denominator is ~0 so callers/stats can mask it out.
#[inline]
fn norm_diff(a: f32, b: f32) -> f32 {
    let denom = a + b;
    if denom.abs() < f32::EPSILON {
        f32::NAN
    } else {
        (a - b) / denom
    }
}

/// NDVI = (NIR - Red) / (NIR + Red).
#[inline]
pub fn ndvi(nir: f32, red: f32) -> f32 {
    norm_diff(nir, red)
}

/// NDRE = (NIR - RedEdge) / (NIR + RedEdge).
#[inline]
pub fn ndre(nir: f32, rededge: f32) -> f32 {
    norm_diff(nir, rededge)
}

/// GNDVI = (NIR - Green) / (NIR + Green).
#[inline]
pub fn gndvi(nir: f32, green: f32) -> f32 {
    norm_diff(nir, green)
}

/// NDMI = (NIR08 - SWIR16) / (NIR08 + SWIR16).
#[inline]
pub fn ndmi(nir08: f32, swir16: f32) -> f32 {
    norm_diff(nir08, swir16)
}

/// SAVI = 1.5 * (NIR - Red) / (NIR + Red + 0.5) (soil-adjusted, L = 0.5).
#[inline]
pub fn savi(nir: f32, red: f32) -> f32 {
    let denom = nir + red + 0.5;
    if denom.abs() < f32::EPSILON {
        f32::NAN
    } else {
        1.5 * (nir - red) / denom
    }
}

/// Summary statistics over a set of index pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Stats {
    pub mean: f64,
    pub median: f64,
    pub p10: f64,
    pub p90: f64,
    pub stddev: f64,
    pub count: usize,
}

/// Compute mean/median/p10/p90/stddev over `values`, skipping any non-finite
/// (NaN/inf) entries — i.e. the mask is applied here. Returns `None` when no
/// finite value remains.
pub fn stats(values: &[f32]) -> Option<Stats> {
    let mut v: Vec<f64> = values
        .iter()
        .filter(|x| x.is_finite())
        .map(|x| *x as f64)
        .collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let count = v.len();
    let mean = v.iter().sum::<f64>() / count as f64;
    let variance = v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / count as f64;
    Some(Stats {
        mean,
        median: percentile(&v, 0.5),
        p10: percentile(&v, 0.10),
        p90: percentile(&v, 0.90),
        stddev: variance.sqrt(),
        count,
    })
}

/// Linear-interpolation percentile over an already-sorted slice. `p` in [0, 1].
fn percentile(sorted: &[f64], p: f64) -> f64 {
    match sorted.len() {
        0 => f64::NAN,
        1 => sorted[0],
        n => {
            let rank = p.clamp(0.0, 1.0) * (n - 1) as f64;
            let lo = rank.floor() as usize;
            let hi = rank.ceil() as usize;
            if lo == hi {
                sorted[lo]
            } else {
                let frac = rank - lo as f64;
                sorted[lo] * (1.0 - frac) + sorted[hi] * frac
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "{a} != {b}");
    }
    fn approx64(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "{a} != {b}");
    }

    #[test]
    fn ndvi_formula() {
        approx(ndvi(0.5, 0.1), 0.4 / 0.6);
        approx(ndvi(0.8, 0.2), 0.6);
        // healthy vegetation is positive, bare soil near zero
        assert!(ndvi(0.6, 0.1) > ndvi(0.2, 0.18));
    }

    #[test]
    fn other_normalized_indices() {
        approx(ndre(0.5, 0.2), 0.3 / 0.7);
        approx(gndvi(0.5, 0.3), 0.2 / 0.8);
        approx(ndmi(0.4, 0.2), 0.2 / 0.6);
    }

    #[test]
    fn savi_formula() {
        // 1.5 * (nir - red) / (nir + red + 0.5)
        approx(savi(0.5, 0.1), 1.5 * 0.4 / 1.1);
        // SAVI dampens vs NDVI on the same inputs (soil adjustment)
        assert!(savi(0.5, 0.1).abs() < ndvi(0.5, 0.1).abs());
    }

    #[test]
    fn zero_denominator_is_nan() {
        assert!(ndvi(0.0, 0.0).is_nan());
        assert!(ndre(0.0, 0.0).is_nan());
        // SAVI denom has +0.5 so it is only NaN at nir+red = -0.5 (never for reflectance)
        assert!(savi(0.0, 0.0).is_finite());
    }

    #[test]
    fn stats_basic() {
        let s = stats(&[1.0, 2.0, 3.0, 4.0, 5.0]).unwrap();
        approx64(s.mean, 3.0);
        approx64(s.median, 3.0);
        assert_eq!(s.count, 5);
        // stddev of 1..5 (population) = sqrt(2)
        approx64(s.stddev, 2f64.sqrt());
    }

    #[test]
    fn stats_percentiles_interpolate() {
        let data: Vec<f32> = (0..=10).map(|i| i as f32).collect(); // 0..10
        let s = stats(&data).unwrap();
        approx64(s.p10, 1.0);
        approx64(s.p90, 9.0);
        approx64(s.median, 5.0);
    }

    #[test]
    fn stats_masks_non_finite() {
        let s = stats(&[1.0, f32::NAN, 3.0, f32::INFINITY]).unwrap();
        assert_eq!(s.count, 2);
        approx64(s.mean, 2.0);
    }

    #[test]
    fn stats_empty_is_none() {
        assert!(stats(&[]).is_none());
        assert!(stats(&[f32::NAN, f32::NAN]).is_none());
    }
}
