//! Parcel-scale Sentinel-2 interpretation.
//!
//! The classifier is intentionally small and reproducible: it compares monthly clear-sky NDVI
//! means with Mediterranean phenology profiles for Arvo's known crops. It is a suggestion, not a
//! claim of botanical certainty. The farmer's crop wins permanently once it has been entered
//! manually. Vegetation presence is measured independently from Sentinel-2's SCL vegetation class.
#![cfg_attr(not(feature = "imagery"), allow(dead_code))]

use chrono::{DateTime, Datelike, Utc};
use sqlx::PgPool;
use uuid::Uuid;

pub const MODEL_VERSION: &str = "s2-phenology-scl-1.0.0";
const MIN_SCENES: usize = 6;
const MIN_MONTHS: usize = 3;
const AUTO_APPLY_SCENES: usize = 10;
const AUTO_APPLY_MONTHS: usize = 5;
const AUTO_APPLY_CONFIDENCE: f64 = 0.72;
const MAX_PROFILE_RMSE: f64 = 0.22;

#[derive(Debug, Clone, Copy)]
pub struct SpectralSample {
    pub observed_at: DateTime<Utc>,
    pub ndvi: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CropPrediction {
    pub crop: &'static str,
    pub confidence: f64,
    pub scene_count: usize,
    pub month_count: usize,
}

#[derive(Clone, Copy)]
struct Profile {
    crop: &'static str,
    /// January through December NDVI. These are broad Mediterranean/Northern-Hemisphere shapes;
    /// fitting uses only observed months and confidence stays low when coverage is sparse.
    ndvi: [f64; 12],
}

const PROFILES: [Profile; 5] = [
    Profile {
        crop: "vine",
        ndvi: [
            0.23, 0.22, 0.24, 0.35, 0.52, 0.65, 0.68, 0.61, 0.52, 0.38, 0.27, 0.23,
        ],
    },
    Profile {
        crop: "olive",
        ndvi: [
            0.46, 0.47, 0.48, 0.49, 0.50, 0.51, 0.50, 0.48, 0.48, 0.49, 0.48, 0.46,
        ],
    },
    Profile {
        crop: "tomato",
        ndvi: [
            0.12, 0.12, 0.14, 0.18, 0.32, 0.58, 0.70, 0.65, 0.40, 0.18, 0.13, 0.12,
        ],
    },
    Profile {
        crop: "wheat",
        ndvi: [
            0.38, 0.48, 0.62, 0.72, 0.70, 0.40, 0.18, 0.12, 0.15, 0.22, 0.29, 0.34,
        ],
    },
    Profile {
        crop: "maize",
        ndvi: [
            0.12, 0.13, 0.15, 0.18, 0.24, 0.45, 0.68, 0.78, 0.70, 0.42, 0.18, 0.13,
        ],
    },
];

/// Classify a clear-sky NDVI series by its seasonal shape. Scene-dense months are averaged first
/// so a cloudy month with one usable acquisition weighs the same as a clear month with five.
pub fn classify(samples: &[SpectralSample]) -> Option<CropPrediction> {
    let mut sums = [0.0f64; 12];
    let mut counts = [0usize; 12];
    let mut scene_count = 0usize;
    for sample in samples {
        if !sample.ndvi.is_finite() || !(-0.2..=1.0).contains(&sample.ndvi) {
            continue;
        }
        let month = sample.observed_at.month0() as usize;
        sums[month] += sample.ndvi;
        counts[month] += 1;
        scene_count += 1;
    }
    let month_count = counts.iter().filter(|n| **n > 0).count();
    if scene_count < MIN_SCENES || month_count < MIN_MONTHS {
        return None;
    }

    let monthly = std::array::from_fn::<_, 12, _>(|month| {
        (counts[month] > 0).then(|| sums[month] / counts[month] as f64)
    });
    let mut ranked: Vec<(&Profile, f64)> = PROFILES
        .iter()
        .map(|profile| {
            let mse = monthly
                .iter()
                .enumerate()
                .filter_map(|(month, value)| {
                    value.map(|value| (value - profile.ndvi[month]).powi(2))
                })
                .sum::<f64>()
                / month_count as f64;
            (profile, mse.sqrt())
        })
        .collect();
    ranked.sort_by(|a, b| a.1.total_cmp(&b.1));
    let (best, best_rmse) = ranked[0];
    let second_rmse = ranked[1].1;
    if best_rmse > MAX_PROFILE_RMSE {
        return None;
    }

    // Fit answers "does it resemble the profile?"; margin answers "is it distinguishable from
    // the runner-up?"; coverage prevents a perfect but three-month fragment looking definitive.
    let fit = (1.0 - best_rmse / MAX_PROFILE_RMSE).clamp(0.0, 1.0);
    let margin = ((second_rmse - best_rmse) / 0.12).clamp(0.0, 1.0);
    let coverage = (month_count as f64 / 8.0).clamp(0.0, 1.0);
    let density = (scene_count as f64 / 16.0).clamp(0.0, 1.0);
    let confidence =
        (0.48 * fit + 0.27 * margin + 0.15 * coverage + 0.10 * density).clamp(0.0, 0.99);

    Some(CropPrediction {
        crop: best.crop,
        confidence,
        scene_count,
        month_count,
    })
}

#[derive(sqlx::FromRow)]
struct SeriesRow {
    observed_at: DateTime<Utc>,
    ndvi: f64,
}

/// Store the latest usable scene's vegetation coverage. Older scenes may be processed after newer
/// ones during a STAC refresh, so the conflict update is acquisition-time guarded.
pub async fn record_vegetation(
    pool: &PgPool,
    parcel_id: Uuid,
    scene_id: Uuid,
    observed_at: DateTime<Utc>,
    clear_pixels: usize,
    vegetated_pixels: usize,
) -> anyhow::Result<()> {
    let cover_pct = if clear_pixels == 0 {
        0.0
    } else {
        100.0 * vegetated_pixels as f64 / clear_pixels as f64
    };
    let detected = clear_pixels >= 50 && cover_pct >= 5.0;
    sqlx::query(
        "INSERT INTO parcel_satellite_analysis
             (parcel_id, latest_scene_id, observed_at, vegetation_detected,
              vegetation_cover_pct, clear_pixel_count, vegetated_pixel_count, model_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (parcel_id) DO UPDATE SET
             latest_scene_id = EXCLUDED.latest_scene_id,
             observed_at = EXCLUDED.observed_at,
             vegetation_detected = EXCLUDED.vegetation_detected,
             vegetation_cover_pct = EXCLUDED.vegetation_cover_pct,
             clear_pixel_count = EXCLUDED.clear_pixel_count,
             vegetated_pixel_count = EXCLUDED.vegetated_pixel_count,
             model_version = EXCLUDED.model_version,
             updated_at = now()
         WHERE parcel_satellite_analysis.observed_at IS NULL
            OR EXCLUDED.observed_at >= parcel_satellite_analysis.observed_at",
    )
    .bind(parcel_id)
    .bind(scene_id)
    .bind(observed_at)
    .bind(detected)
    .bind(cover_pct)
    .bind(i32::try_from(clear_pixels).unwrap_or(i32::MAX))
    .bind(i32::try_from(vegetated_pixels).unwrap_or(i32::MAX))
    .bind(MODEL_VERSION)
    .execute(pool)
    .await?;
    Ok(())
}

/// Recompute and persist the parcel crop prediction after a refresh. High-confidence results fill
/// an unknown/satellite-managed crop; `crop_source='manual'` is an unconditional lock.
pub async fn refresh_prediction(pool: &PgPool, parcel_id: Uuid) -> anyhow::Result<()> {
    let rows: Vec<SeriesRow> = sqlx::query_as(
        "SELECT observed_at, mean AS ndvi
           FROM index_observations
          WHERE parcel_id = $1 AND source = 'sentinel-2' AND index_name = 'ndvi'
            AND observed_at >= now() - interval '400 days'
            AND (cloud_pct IS NULL OR cloud_pct < 40)
            AND (pixel_count IS NULL OR pixel_count >= 50)
          ORDER BY observed_at",
    )
    .bind(parcel_id)
    .fetch_all(pool)
    .await?;
    let samples: Vec<SpectralSample> = rows
        .into_iter()
        .map(|row| SpectralSample {
            observed_at: row.observed_at,
            ndvi: row.ndvi,
        })
        .collect();
    let Some(prediction) = classify(&samples) else {
        // Preserve vegetation evidence while making an old crop prediction explicitly pending.
        sqlx::query(
            "UPDATE parcel_satellite_analysis
                SET crop_type = NULL, crop_confidence = NULL,
                    crop_scene_count = $2, crop_month_count = $3,
                    model_version = $4, updated_at = now()
              WHERE parcel_id = $1",
        )
        .bind(parcel_id)
        .bind(i32::try_from(samples.len()).unwrap_or(i32::MAX))
        .bind(distinct_months(&samples) as i32)
        .bind(MODEL_VERSION)
        .execute(pool)
        .await?;
        return Ok(());
    };

    sqlx::query(
        "INSERT INTO parcel_satellite_analysis
             (parcel_id, crop_type, crop_confidence, crop_scene_count, crop_month_count,
              model_version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (parcel_id) DO UPDATE SET
             crop_type = EXCLUDED.crop_type,
             crop_confidence = EXCLUDED.crop_confidence,
             crop_scene_count = EXCLUDED.crop_scene_count,
             crop_month_count = EXCLUDED.crop_month_count,
             model_version = EXCLUDED.model_version,
             updated_at = now()",
    )
    .bind(parcel_id)
    .bind(prediction.crop)
    .bind(prediction.confidence)
    .bind(prediction.scene_count as i32)
    .bind(prediction.month_count as i32)
    .bind(MODEL_VERSION)
    .execute(pool)
    .await?;

    if prediction.crop != "other"
        && prediction.confidence >= AUTO_APPLY_CONFIDENCE
        && prediction.scene_count >= AUTO_APPLY_SCENES
        && prediction.month_count >= AUTO_APPLY_MONTHS
    {
        sqlx::query(
            "UPDATE parcels
                SET crop = $2, crop_source = 'sentinel-2', updated_at = now()
              WHERE id = $1
                AND (crop_source IS NULL OR crop_source = 'sentinel-2')",
        )
        .bind(parcel_id)
        .bind(prediction.crop)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn distinct_months(samples: &[SpectralSample]) -> usize {
    let mut seen = [false; 12];
    for sample in samples {
        seen[sample.observed_at.month0() as usize] = true;
    }
    seen.into_iter().filter(|v| *v).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn profile_samples(profile: Profile) -> Vec<SpectralSample> {
        profile
            .ndvi
            .iter()
            .enumerate()
            .flat_map(|(month, ndvi)| {
                [5, 20].map(|day| SpectralSample {
                    observed_at: Utc
                        .with_ymd_and_hms(2025, month as u32 + 1, day, 10, 0, 0)
                        .unwrap(),
                    ndvi: *ndvi,
                })
            })
            .collect()
    }

    #[test]
    fn identifies_each_supported_crop_profile() {
        for profile in PROFILES {
            let prediction = classify(&profile_samples(profile)).expect("prediction");
            assert_eq!(prediction.crop, profile.crop);
            assert!(prediction.confidence >= AUTO_APPLY_CONFIDENCE);
            assert_eq!(prediction.scene_count, 24);
            assert_eq!(prediction.month_count, 12);
        }
    }

    #[test]
    fn scene_dense_months_do_not_outvote_the_season() {
        let mut samples = profile_samples(PROFILES[3]); // wheat
        for day in 1..=25 {
            samples.push(SpectralSample {
                observed_at: Utc.with_ymd_and_hms(2025, 8, day, 10, 0, 0).unwrap(),
                ndvi: 0.12,
            });
        }
        assert_eq!(classify(&samples).unwrap().crop, "wheat");
    }

    #[test]
    fn refuses_sparse_or_out_of_family_series() {
        let sparse = profile_samples(PROFILES[0])
            .into_iter()
            .take(4)
            .collect::<Vec<_>>();
        assert!(classify(&sparse).is_none());

        let bare = (1..=12)
            .map(|month| SpectralSample {
                observed_at: Utc.with_ymd_and_hms(2025, month, 10, 10, 0, 0).unwrap(),
                ndvi: -0.05,
            })
            .collect::<Vec<_>>();
        assert!(classify(&bare).is_none());
    }
}
