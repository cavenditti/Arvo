//! OWNER: be-extract — per-plant statistics over a sampled pixel buffer (FR-P-030).
//! Frozen definition: docs/API-PLANT.md §"Pipeline stages" → Extraction.
//! Pure (no I/O, no GDAL — the caller does the sampling). MUST ship `#[cfg(test)]` tests.

use crate::indices;

/// Canopy mask: only pixels with NDVI ≥ this contribute to the index metrics.
pub const CANOPY_NDVI_MIN: f64 = 0.25;
/// Fewer masked pixels than this → index metrics are skipped for the plant.
pub const MIN_CANOPY_PIXELS: usize = 5;
/// `height_m` is this percentile of the CHM inside the sampling geometry.
pub const HEIGHT_PERCENTILE: f64 = 0.95;
/// Sampling buffer around the plant point when it has no crown polygon (metres).
pub const BUFFER_TREE_M: f64 = 1.5;
pub const BUFFER_VINE_M: f64 = 0.75;

/// The seven `PlantMetric` names in contract order (docs/API-PLANT.md §Types). Single source of
/// truth for the extractor, the API validation and the `plant_observations.metric` CHECK (0090).
pub const PLANT_METRICS: [&str; 7] = [
    "ndvi",
    "ndre",
    "gndvi",
    "ndmi",
    "savi",
    "canopy_m2",
    "height_m",
];

/// Reflectance buffers sampled inside one plant's sampling geometry.
///
/// Every present band holds **one entry per pixel of the geometry, in the same pixel order**, so
/// a single canopy mask indexes all of them. A band the ortho does not carry is `None` and its
/// metrics are simply absent (an RGB-only ortho ⇒ only `canopy_m2` + `height_m`). Nodata is a
/// non-finite value — never a zero, which would read as a real dark pixel and drag the mean
/// down. `blue` is not modelled: no index in `indices` uses it.
#[derive(Debug, Default, Clone)]
pub struct Bands {
    pub red: Option<Vec<f32>>,
    pub green: Option<Vec<f32>>,
    pub rededge: Option<Vec<f32>>,
    pub nir: Option<Vec<f32>>,
    pub swir: Option<Vec<f32>>,
}

/// Everything sampled for one plant: the pixels plus the geometry facts the DB already knows.
#[derive(Debug, Default, Clone)]
pub struct Sample {
    pub bands: Bands,
    /// Canopy-height model in metres (DSM − terrain baseline), same pixel order as the bands.
    /// Empty when the capture has no DSM; non-finite entries are nodata.
    pub chm_m: Vec<f32>,
    /// Ground area of the sampling geometry in m² (PostGIS `ST_Area(geom::geography)`).
    pub area_m2: f64,
    /// Pixel count inside the sampling geometry — the `quality` denominator.
    pub pixels: usize,
}

/// What one plant contributes to `plant_observations` for one capture.
#[derive(Debug, Clone, PartialEq)]
pub struct Extracted {
    /// `(metric, value)` in [`PLANT_METRICS`] order; a metric that could not be computed is
    /// absent rather than zero.
    pub metrics: Vec<(&'static str, f64)>,
    /// `plant_observations.quality`, shared by every row of this plant.
    pub quality: i16,
    /// Pixels that passed the canopy mask (below [`MIN_CANOPY_PIXELS`] ⇒ no index metrics).
    pub canopy_pixels: usize,
}

/// `plant_observations.quality` — the share of usable pixels, 0..100.
pub fn quality(used_pixels: usize, pixels_in_geometry: usize) -> i16 {
    if pixels_in_geometry == 0 {
        return 0;
    }
    let pct = 100.0 * used_pixels as f64 / pixels_in_geometry as f64;
    pct.round().clamp(0.0, 100.0) as i16
}

/// Percentile (`p` in 0..=1) of a sample; `None` when empty. Carries `height_m` (p95).
/// Non-finite entries are dropped first — nodata is not a value.
pub fn percentile(values: &[f64], p: f64) -> Option<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    let rank = p.clamp(0.0, 1.0) * (v.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    Some(if lo == hi {
        v[lo]
    } else {
        let frac = rank - lo as f64;
        v[lo] * (1.0 - frac) + v[hi] * frac
    })
}

/// Canopy mask: `true` where NDVI ≥ [`CANOPY_NDVI_MIN`]. A pixel whose NIR or red sample is
/// nodata yields a non-finite NDVI and is masked **out**, so missing data can never be mistaken
/// for bare soil (or for canopy). Length = the shorter of the two buffers.
pub fn canopy_mask(nir: &[f32], red: &[f32]) -> Vec<bool> {
    nir.iter()
        .zip(red)
        .map(|(&n, &r)| {
            let v = indices::ndvi(n, r);
            v.is_finite() && v as f64 >= CANOPY_NDVI_MIN
        })
        .collect()
}

/// Mean of index `f(a, b)` over the masked pixels, skipping any pixel whose result is not
/// finite. `None` when no pixel contributes — the metric is then absent, not zero.
pub fn index_mean(a: &[f32], b: &[f32], mask: &[bool], f: fn(f32, f32) -> f32) -> Option<f64> {
    let mut sum = 0.0f64;
    let mut n = 0usize;
    for (i, &keep) in mask.iter().enumerate() {
        if !keep {
            continue;
        }
        let (Some(&x), Some(&y)) = (a.get(i), b.get(i)) else {
            continue;
        };
        let v = f(x, y);
        if v.is_finite() {
            sum += v as f64;
            n += 1;
        }
    }
    (n > 0).then(|| sum / n as f64)
}

/// `height_m` — the [`HEIGHT_PERCENTILE`] of the canopy-height model inside the sampling
/// geometry. Ground pixels around the crown are included on purpose: p95 reaches the canopy
/// while staying robust to a single spiky DSM cell.
pub fn height_m(chm_m: &[f32]) -> Option<f64> {
    let v: Vec<f64> = chm_m.iter().map(|x| *x as f64).collect();
    percentile(&v, HEIGHT_PERCENTILE)
}

/// The frozen extraction rule set (docs/API-PLANT.md §Extraction) applied to one plant.
///
/// Index metrics = the mean over canopy-masked pixels, and are skipped entirely when the plant
/// has fewer than [`MIN_CANOPY_PIXELS`] of them (a collapsed or missing plant reports no vigor
/// rather than a bare-soil one). `canopy_m2` and `height_m` do **not** depend on the mask — a
/// plant with no canopy left still has a footprint and a height, which is exactly the signal the
/// replant list reads.
pub fn extract(sample: &Sample) -> Extracted {
    let b = &sample.bands;
    let mut metrics: Vec<(&'static str, f64)> = Vec::with_capacity(PLANT_METRICS.len());

    // The canopy mask itself needs NIR + red; without them there are no index metrics at all.
    let mask = match (&b.nir, &b.red) {
        (Some(nir), Some(red)) => canopy_mask(nir, red),
        _ => Vec::new(),
    };
    let canopy_pixels = mask.iter().filter(|m| **m).count();

    if canopy_pixels >= MIN_CANOPY_PIXELS {
        // Both are Some: `mask` is only non-empty when they are.
        let nir = b.nir.as_deref().unwrap_or_default();
        let red = b.red.as_deref().unwrap_or_default();
        let mut push = |metric: &'static str, v: Option<f64>| {
            if let Some(v) = v.filter(|x| x.is_finite()) {
                metrics.push((metric, v));
            }
        };
        push("ndvi", index_mean(nir, red, &mask, indices::ndvi));
        if let Some(rededge) = &b.rededge {
            push("ndre", index_mean(nir, rededge, &mask, indices::ndre));
        }
        if let Some(green) = &b.green {
            push("gndvi", index_mean(nir, green, &mask, indices::gndvi));
        }
        if let Some(swir) = &b.swir {
            push("ndmi", index_mean(nir, swir, &mask, indices::ndmi));
        }
        push("savi", index_mean(nir, red, &mask, indices::savi));
    }

    if sample.area_m2.is_finite() && sample.area_m2 > 0.0 {
        metrics.push(("canopy_m2", sample.area_m2));
    }
    if let Some(h) = height_m(&sample.chm_m) {
        metrics.push(("height_m", h));
    }

    Extracted {
        metrics,
        quality: quality(canopy_pixels, sample.pixels),
        canopy_pixels,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reflectance pair with the requested NDVI (red fixed, NIR solved from it).
    fn px(ndvi_target: f32) -> (f32, f32) {
        let red = 0.06f32;
        (red * (1.0 + ndvi_target) / (1.0 - ndvi_target), red)
    }

    /// `n` canopy pixels at `ndvi` followed by `ground` bare-soil pixels at NDVI 0.10.
    fn buffers(n: usize, ndvi: f32, ground: usize) -> (Vec<f32>, Vec<f32>) {
        let (nir_c, red_c) = px(ndvi);
        let (nir_g, red_g) = px(0.10);
        let mut nir = vec![nir_c; n];
        let mut red = vec![red_c; n];
        nir.extend(std::iter::repeat_n(nir_g, ground));
        red.extend(std::iter::repeat_n(red_g, ground));
        (nir, red)
    }

    fn value(e: &Extracted, metric: &str) -> Option<f64> {
        e.metrics
            .iter()
            .find(|(m, _)| *m == metric)
            .map(|(_, v)| *v)
    }

    #[test]
    fn quality_is_the_usable_pixel_share() {
        assert_eq!(quality(0, 0), 0); // empty geometry, never a divide-by-zero
        assert_eq!(quality(5, 10), 50);
        assert_eq!(quality(10, 10), 100);
        assert_eq!(quality(1, 3), 33);
    }

    #[test]
    fn percentile_interpolates_and_ignores_nodata() {
        let v: Vec<f64> = (0..=10).map(|i| i as f64).collect();
        assert_eq!(percentile(&v, 0.0), Some(0.0));
        assert_eq!(percentile(&v, 1.0), Some(10.0));
        assert_eq!(percentile(&v, 0.5), Some(5.0));
        assert_eq!(percentile(&v, 0.95), Some(9.5)); // between neighbours
        assert_eq!(percentile(&[2.0, f64::NAN, 4.0], 1.0), Some(4.0));
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(percentile(&[f64::NAN], 0.5), None);
        // p outside 0..=1 is clamped rather than panicking on a bad caller
        assert_eq!(percentile(&v, 2.0), Some(10.0));
    }

    #[test]
    fn canopy_mask_uses_the_frozen_ndvi_cut() {
        let (nir, red) = buffers(3, 0.60, 2);
        let mask = canopy_mask(&nir, &red);
        assert_eq!(mask, vec![true, true, true, false, false]);
        // exactly on the cut is canopy (≥): (1.25 − 0.75) / 2.0 = 0.25, exact in binary
        assert_eq!(canopy_mask(&[1.25], &[0.75]), vec![true]);
    }

    #[test]
    fn nodata_is_never_read_as_bare_soil_or_canopy() {
        // NaN in either band → masked out; a 0/0 pixel gives a NaN NDVI and is masked too.
        let mask = canopy_mask(&[f32::NAN, 0.5, 0.0], &[0.06, f32::NAN, 0.0]);
        assert_eq!(mask, vec![false, false, false]);
    }

    #[test]
    fn index_mean_averages_only_masked_finite_pixels() {
        let (nir, red) = buffers(2, 0.80, 2);
        let mask = canopy_mask(&nir, &red);
        let m = index_mean(&nir, &red, &mask, indices::ndvi).unwrap();
        assert!((m - 0.80).abs() < 1e-5, "{m}");
        // nothing masked in → None, not 0.0
        assert_eq!(index_mean(&nir, &red, &[false, false], indices::ndvi), None);
        // a nodata pixel that slipped through the mask is skipped by the mean
        let m2 = index_mean(
            &[f32::NAN, nir[0]],
            &[0.06, red[0]],
            &[true, true],
            indices::ndvi,
        );
        assert!((m2.unwrap() - 0.80).abs() < 1e-5);
    }

    #[test]
    fn height_is_the_chm_p95_over_finite_pixels() {
        let mut chm: Vec<f32> = vec![0.1; 5];
        chm.extend(vec![3.5f32; 95]);
        let h = height_m(&chm).unwrap();
        assert!((h - 3.5).abs() < 1e-9, "{h}");
        assert_eq!(height_m(&[]), None);
        assert_eq!(height_m(&[f32::NAN]), None);
    }

    #[test]
    fn extract_multispectral_plant() {
        let (nir, red) = buffers(30, 0.70, 10);
        let sample = Sample {
            bands: Bands {
                red: Some(red),
                green: Some(vec![0.09; 40]),
                rededge: Some(vec![0.20; 40]),
                nir: Some(nir),
                swir: Some(vec![0.18; 40]),
            },
            chm_m: {
                let mut c = vec![0.2f32; 10];
                c.extend(vec![4.0f32; 30]);
                c
            },
            area_m2: 7.25,
            pixels: 40,
        };
        let e = extract(&sample);
        assert_eq!(e.canopy_pixels, 30);
        assert_eq!(e.quality, 75); // 30 usable of 40 in the geometry
        assert!((value(&e, "ndvi").unwrap() - 0.70).abs() < 1e-5);
        assert_eq!(value(&e, "canopy_m2"), Some(7.25));
        assert!((value(&e, "height_m").unwrap() - 4.0).abs() < 1e-9);
        // every index whose band is present, and nothing else
        let names: Vec<&str> = e.metrics.iter().map(|(m, _)| *m).collect();
        assert_eq!(
            names,
            vec![
                "ndvi",
                "ndre",
                "gndvi",
                "ndmi",
                "savi",
                "canopy_m2",
                "height_m"
            ]
        );
        // SAVI is dampened relative to NDVI on the same pixels
        assert!(value(&e, "savi").unwrap() < value(&e, "ndvi").unwrap());
    }

    #[test]
    fn rgb_only_ortho_yields_geometry_metrics_only() {
        // No NIR ⇒ no canopy mask ⇒ no index metrics at all (docs/API-PLANT.md §Extraction).
        let sample = Sample {
            bands: Bands {
                red: Some(vec![0.06; 20]),
                green: Some(vec![0.09; 20]),
                ..Bands::default()
            },
            chm_m: vec![2.0; 20],
            area_m2: 7.07,
            pixels: 20,
        };
        let e = extract(&sample);
        let names: Vec<&str> = e.metrics.iter().map(|(m, _)| *m).collect();
        assert_eq!(names, vec!["canopy_m2", "height_m"]);
        assert_eq!(e.quality, 0);
    }

    #[test]
    fn collapsed_canopy_skips_index_metrics_but_keeps_footprint() {
        // 4 canopy pixels < MIN_CANOPY_PIXELS = 5.
        let (nir, red) = buffers(MIN_CANOPY_PIXELS - 1, 0.65, 30);
        let n = nir.len();
        let sample = Sample {
            bands: Bands {
                red: Some(red),
                nir: Some(nir),
                ..Bands::default()
            },
            chm_m: vec![0.3; n],
            area_m2: 7.07,
            pixels: n,
        };
        let e = extract(&sample);
        assert_eq!(e.canopy_pixels, MIN_CANOPY_PIXELS - 1);
        assert_eq!(value(&e, "ndvi"), None);
        assert_eq!(value(&e, "canopy_m2"), Some(7.07));
        assert!(value(&e, "height_m").is_some());
    }

    #[test]
    fn fully_nodata_geometry_reports_nothing_measurable() {
        let sample = Sample {
            bands: Bands {
                red: Some(vec![f32::NAN; 12]),
                nir: Some(vec![f32::NAN; 12]),
                ..Bands::default()
            },
            chm_m: vec![f32::NAN; 12],
            area_m2: 0.0,
            pixels: 12,
        };
        let e = extract(&sample);
        assert!(e.metrics.is_empty(), "{:?}", e.metrics);
        assert_eq!(e.quality, 0);
    }

    #[test]
    fn every_emitted_metric_is_a_contract_metric() {
        let (nir, red) = buffers(20, 0.55, 5);
        let sample = Sample {
            bands: Bands {
                red: Some(red),
                green: Some(vec![0.09; 25]),
                rededge: Some(vec![0.20; 25]),
                nir: Some(nir),
                swir: Some(vec![0.18; 25]),
            },
            chm_m: vec![3.0; 25],
            area_m2: 5.0,
            pixels: 25,
        };
        for (metric, _) in extract(&sample).metrics {
            assert!(PLANT_METRICS.contains(&metric), "{metric} not in the CHECK");
        }
    }
}
