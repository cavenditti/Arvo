//! OWNER: be-extract — stage `extract`: per-plant metrics from the capture
//! (docs/API-PLANT.md §"Pipeline stages" → Extraction).
//!
//! Sampling geometry = `plants.crown_geom`, else the point buffered by
//! `plant_metrics::BUFFER_TREE_M` (`tree`/`bush`) or `BUFFER_VINE_M` (`vine`/`row_segment`).
//! Canopy mask = NDVI ≥ `plant_metrics::CANOPY_NDVI_MIN`; fewer than
//! `MIN_CANOPY_PIXELS` masked pixels → index metrics skipped for that plant. Index values are
//! the mean over masked pixels using `arvo_core::indices` and `captures.bands` (a missing band
//! skips its metrics); `canopy_m2` = geometry area, `height_m` = CHM p95.
//! `observed_at = captures.captured_at` for every row.
//!
//! Idempotent: deletes its own `plant_observations` for the capture before inserting, then
//! runs the parcel rollup — the rollup is the tail of this stage, so `extracted` is only
//! reached once `index_observations` has been upserted.
//!
//! Pixel access sits behind [`Sampler`] so the stage builds without GDAL: `source="demo"`
//! captures use the deterministic synthetic sampler, everything else reports
//! [`STAGE_UNSUPPORTED`] until the raster sampler lands with the `imagery` feature.

use anyhow::{anyhow, Context};
use arvo_core::plant_metrics::{self as pm, Bands, Sample};
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::pipeline::{Job, Worker, STAGE_UNSUPPORTED};

/// `model_ver` stamped on every `plant_observations` row this extractor writes (NFR-P-REPRO).
/// Unused until the raster sampler lands — the synthetic path stamps [`SYNTH_EXTRACTOR_VER`].
#[allow(dead_code)]
pub const EXTRACTOR_VER: &str = "extract-0.1.0";
/// `model_ver` of the deterministic synthetic sampler (`source="demo"`, no GDAL).
pub const SYNTH_EXTRACTOR_VER: &str = "synth-extract-0.1.0";

/// Rows per INSERT; a 30k-plant parcel is ~200k rows and one statement per capture would build
/// an unreasonably large bind buffer.
const INSERT_CHUNK: usize = 5_000;

pub async fn run(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let capture = load_capture(w, job).await?;
    // Resolve the pixel source first: a `drone` capture in a GDAL-less build must fail before
    // it touches the DB, with the frozen `stage_unsupported` error.
    let sampler = sampler_for(&capture)?;
    let plants = load_plants(w, &capture).await?;

    let mut rows: Vec<ObsRow> = Vec::with_capacity(plants.len() * pm::PLANT_METRICS.len());
    for plant in &plants {
        let extracted = pm::extract(&sampler.sample(plant)?);
        for (metric, value) in extracted.metrics {
            // A non-finite value is a bug upstream, not a measurement — never store it.
            if value.is_finite() {
                rows.push(ObsRow {
                    plant_id: plant.id,
                    metric: metric.to_string(),
                    value,
                    quality: extracted.quality,
                });
            }
        }
    }

    let mut tx = w.pool.begin().await?;
    // Idempotency: this capture owns its rows, so a re-run starts from a clean slate. Rows for
    // plants that no longer qualify (removed since the last run) disappear with it.
    sqlx::query("DELETE FROM plant_observations WHERE capture_id = $1")
        .bind(capture.id)
        .execute(&mut *tx)
        .await?;
    for chunk in rows.chunks(INSERT_CHUNK) {
        insert_chunk(&mut tx, &capture, sampler.model_ver(), chunk).await?;
    }
    sqlx::query("UPDATE captures SET observation_count = $2, updated_at = now() WHERE id = $1")
        .bind(capture.id)
        .bind(rows.len() as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    // The parcel rollup is the tail of this stage, not a job of its own: `extracted` is only
    // reached once `index_observations` carries the drone point (FR-P-032). It reads the rows
    // just committed, so it runs after the transaction — and a failure here fails the stage,
    // whose retry replays the whole idempotent delete+insert+rollup.
    crate::rollup::run(w, capture.id).await?;

    tracing::info!(
        capture = %capture.id,
        plants = plants.len(),
        observations = rows.len(),
        model_ver = sampler.model_ver(),
        "extracted per-plant metrics"
    );
    audit(w, &capture, plants.len(), rows.len(), sampler.model_ver()).await;
    Ok(())
}

// --- DB shapes -------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct CaptureRow {
    id: Uuid,
    org_id: Uuid,
    parcel_id: Uuid,
    captured_at: DateTime<Utc>,
    source: String,
}

/// One plant to sample. `sample_geom` is the GeoJSON of the frozen sampling geometry (crown, or
/// the point buffered per `unit_type`) and `area_m2` its true ground area — both computed by
/// PostGIS, so `canopy_m2` is honest even when the pixels are synthetic.
#[derive(Debug, sqlx::FromRow)]
struct PlantRow {
    id: Uuid,
    lon: f64,
    lat: f64,
    status: String,
    area_m2: f64,
    #[allow(dead_code)] // consumed by the raster sampler (see `sampler_for`)
    sample_geom: String,
}

struct ObsRow {
    plant_id: Uuid,
    metric: String,
    value: f64,
    quality: i16,
}

async fn load_capture(w: &Worker, job: &Job) -> anyhow::Result<CaptureRow> {
    sqlx::query_as::<_, CaptureRow>(
        "SELECT id, org_id, parcel_id, captured_at, source::text AS source
           FROM captures WHERE id = $1 AND org_id = $2",
    )
    .bind(job.capture_id)
    .bind(job.org_id)
    .fetch_optional(&w.pool)
    .await?
    .ok_or_else(|| anyhow!("capture {} not found", job.capture_id))
}

/// Every non-`removed` plant of the capture's parcel that the flight actually covered.
/// `missing`/`dead` plants are sampled too: their collapsed canopy is the signal the replant
/// list reads, and the canopy mask keeps them out of the index metrics on its own.
async fn load_plants(w: &Worker, capture: &CaptureRow) -> anyhow::Result<Vec<PlantRow>> {
    sqlx::query_as::<_, PlantRow>(
        "SELECT p.id,
                ST_X(p.geom)::double precision AS lon,
                ST_Y(p.geom)::double precision AS lat,
                p.status::text AS status,
                ST_Area(g.geom::geography)::double precision AS area_m2,
                ST_AsGeoJSON(g.geom)::text AS sample_geom
           FROM plants p
           JOIN captures c ON c.id = $1
           CROSS JOIN LATERAL (
                SELECT COALESCE(
                    p.crown_geom,
                    ST_Buffer(
                        p.geom::geography,
                        CASE WHEN p.unit_type::text IN ('tree', 'bush') THEN $2 ELSE $3 END
                    )::geometry
                ) AS geom
           ) g
          WHERE p.org_id = c.org_id
            AND p.parcel_id = c.parcel_id
            AND p.status::text <> 'removed'
            AND (c.bbox IS NULL OR ST_Intersects(p.geom, c.bbox))
          ORDER BY p.id",
    )
    .bind(capture.id)
    .bind(pm::BUFFER_TREE_M)
    .bind(pm::BUFFER_VINE_M)
    .fetch_all(&w.pool)
    .await
    .context("load plants for extraction")
}

/// Bulk upsert. The DELETE above already cleared this capture's rows; `ON CONFLICT DO UPDATE`
/// covers the other collision — a *different* capture of the same parcel at the exact same
/// `captured_at`, which the primary key `(plant_id, metric, observed_at)` folds together.
async fn insert_chunk(
    tx: &mut Transaction<'_, Postgres>,
    capture: &CaptureRow,
    model_ver: &str,
    chunk: &[ObsRow],
) -> anyhow::Result<()> {
    let plant_ids: Vec<Uuid> = chunk.iter().map(|r| r.plant_id).collect();
    let metrics: Vec<String> = chunk.iter().map(|r| r.metric.clone()).collect();
    let values: Vec<f64> = chunk.iter().map(|r| r.value).collect();
    let qualities: Vec<i16> = chunk.iter().map(|r| r.quality).collect();

    sqlx::query(
        "INSERT INTO plant_observations
             (plant_id, capture_id, org_id, parcel_id, metric, observed_at, value, quality, model_ver)
         SELECT u.plant_id, $1, $2, $3, u.metric, $4, u.value, u.quality, $5
           FROM UNNEST($6::uuid[], $7::text[], $8::double precision[], $9::smallint[])
                AS u(plant_id, metric, value, quality)
         ON CONFLICT (plant_id, metric, observed_at) DO UPDATE
            SET capture_id = EXCLUDED.capture_id,
                org_id     = EXCLUDED.org_id,
                parcel_id  = EXCLUDED.parcel_id,
                value      = EXCLUDED.value,
                quality    = EXCLUDED.quality,
                model_ver  = EXCLUDED.model_ver",
    )
    .bind(capture.id)
    .bind(capture.org_id)
    .bind(capture.parcel_id)
    .bind(capture.captured_at)
    .bind(model_ver)
    .bind(plant_ids)
    .bind(metrics)
    .bind(values)
    .bind(qualities)
    .execute(&mut **tx)
    .await
    .context("insert plant_observations")?;
    Ok(())
}

/// Best-effort provenance row (NFR-P-REPRO): the worker has no `AuthUser`, so `user_id` is null.
/// Never fails the stage — the metrics are already committed.
async fn audit(w: &Worker, capture: &CaptureRow, plants: usize, rows: usize, model_ver: &str) {
    let data = serde_json::json!({
        "plants": plants,
        "observations": rows,
        "model_ver": model_ver,
        "worker_id": w.worker_id,
    });
    let res = sqlx::query(
        "INSERT INTO audit_log (org_id, user_id, action, entity, entity_id, data)
         VALUES ($1, NULL, 'capture.extract', 'capture', $2, $3)",
    )
    .bind(capture.org_id)
    .bind(capture.id.to_string())
    .bind(data)
    .execute(&w.pool)
    .await;
    if let Err(e) = res {
        tracing::warn!(capture = %capture.id, error = %e, "audit row not written");
    }
}

// --- pixel sources ---------------------------------------------------------

/// Pixel source for one plant's sampling geometry — the single seam the raster implementation
/// plugs into, so this stage compiles and runs without GDAL.
trait Sampler {
    /// Stamped on every row the sampler produces.
    fn model_ver(&self) -> &'static str;
    fn sample(&self, plant: &PlantRow) -> anyhow::Result<Sample>;
}

/// `demo` → the synthetic sampler; `drone`/`prebuilt` → real pixels, which need GDAL.
///
/// **The raster sampler is not implemented in P-MVP** (it lands with the ODM/detector pixel path
/// behind `--features imagery`), so those captures fail with the frozen job error
/// `stage_unsupported` and the capture ends `failed` — docs/API-PLANT.md §"Builds without GDAL".
/// The hookup, when GDAL arrives (it also needs the `Worker` here, for the store root): open
/// `pipeline::ortho_key`/`dsm_key` under the worker's `store_dir`, build the CHM once (DSM − the
/// rolling p10 terrain baseline `detect` already computes), then per plant rasterize
/// `PlantRow::sample_geom` into a pixel window and fill [`Bands`]/`chm_m` with the pixels it
/// covers — nodata as NaN, never 0. `captures.bands` maps each band name to a 1-based band index
/// in `ortho.tif`; a name that is absent stays `None` in [`Bands`], which is what makes an
/// RGB-only ortho yield `canopy_m2` + `height_m` only.
fn sampler_for(capture: &CaptureRow) -> anyhow::Result<Box<dyn Sampler>> {
    match capture.source.as_str() {
        "demo" => Ok(Box::new(SynthSampler)),
        _ => Err(anyhow!(STAGE_UNSUPPORTED)),
    }
}

/// Deterministic synthetic sampler for `source="demo"` captures: no raster, no RNG crate.
///
/// It synthesises *pixels*, not metrics, so the demo path runs the exact same
/// `core::plant_metrics` code as a real flight. A smooth spatial field over lon/lat gives a
/// plausible vigor gradient (neighbours agree, which is what the neighbour-relative detector
/// needs), a splitmix64 over the plant UUID adds stable per-plant jitter, a deterministic 1-in-50
/// plant is weak (so `plant_vigor_outlier` has something real to find), and a `missing`/`dead`
/// plant samples as bare soil. `captures.bands` is ignored: the demo sensor is defined as
/// red/green/rededge/NIR — no SWIR, hence no `ndmi`.
struct SynthSampler;

/// Synthetic sensor: a 10 cm GSD keeps the per-plant buffers small while `quality` still reads
/// as the canopy share of the sampling geometry, exactly as in the raster path.
const SYNTH_PIXELS_PER_M2: f64 = 100.0;
const SYNTH_MIN_PIXELS: usize = 8;
const SYNTH_MAX_PIXELS: usize = 256;
/// One plant in `SYNTH_WEAK_EVERY` is a deterministic low-vigor outlier.
const SYNTH_WEAK_EVERY: u64 = 50;

impl Sampler for SynthSampler {
    fn model_ver(&self) -> &'static str {
        SYNTH_EXTRACTOR_VER
    }

    fn sample(&self, plant: &PlantRow) -> anyhow::Result<Sample> {
        let h = hash64(plant.id);
        let jitter = unit(h) - 0.5; // ±0.5, stable per plant
        let present = matches!(plant.status.as_str(), "alive" | "replanted");

        // Smooth vigor field (~300 m wavelength) + per-plant jitter; absent plants are soil.
        let field = 0.5 * ((plant.lon * 1800.0).sin() + (plant.lat * 2300.0).sin());
        let mut vigor = 0.68 + 0.07 * field + 0.04 * jitter;
        if h.is_multiple_of(SYNTH_WEAK_EVERY) {
            vigor *= 0.55;
        }
        if !present {
            vigor = 0.10 + 0.03 * jitter;
        }
        let vigor = vigor.clamp(0.02, 0.90);

        let pixels = ((plant.area_m2.max(0.0) * SYNTH_PIXELS_PER_M2).round() as usize)
            .clamp(SYNTH_MIN_PIXELS, SYNTH_MAX_PIXELS);
        // Canopy share of the sampling geometry: a vigorous crown fills more of it than a weak
        // one, and an absent plant fills none (its pixels then fall below the NDVI cut anyway).
        let share = if present {
            0.55 + 0.35 * ((vigor - 0.30) / 0.60).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let canopy_px = ((pixels as f64 * share).round() as usize).min(pixels);
        let height = if present {
            (1.6 + 3.0 * vigor + 0.4 * jitter).clamp(0.4, 8.0)
        } else {
            0.15
        };

        let mut red = Vec::with_capacity(pixels);
        let mut green = Vec::with_capacity(pixels);
        let mut rededge = Vec::with_capacity(pixels);
        let mut nir = Vec::with_capacity(pixels);
        let mut chm_m = Vec::with_capacity(pixels);
        for i in 0..pixels {
            let u = unit(splitmix64(h ^ (i as u64).wrapping_mul(0x9E37_79B9)));
            let canopy = i < canopy_px;
            // Bare soil sits well below CANOPY_NDVI_MIN so the mask separates the two cleanly.
            let target = if canopy {
                vigor + 0.04 * (u - 0.5)
            } else {
                0.12 + 0.04 * (u - 0.5)
            };
            let (r, g, re, n) = reflectance(target.clamp(0.02, 0.90), u);
            red.push(r);
            green.push(g);
            rededge.push(re);
            nir.push(n);
            chm_m.push(if canopy {
                (height + 0.25 * (u - 0.5)) as f32
            } else {
                (0.05 + 0.20 * u) as f32
            });
        }

        Ok(Sample {
            bands: Bands {
                red: Some(red),
                green: Some(green),
                rededge: Some(rededge),
                nir: Some(nir),
                swir: None, // drone multispectral sensors carry no SWIR → no ndmi
            },
            chm_m,
            area_m2: plant.area_m2,
            pixels,
        })
    }
}

/// Reflectance quadruple whose NDVI is exactly `ndvi`, with NDRE ≈ 0.68·NDVI and
/// GNDVI ≈ 0.72·NDVI — the band ratios `imagery::synth` already uses for the demo series.
fn reflectance(ndvi: f64, u: f64) -> (f32, f32, f32, f32) {
    let red = 0.05 + 0.02 * u;
    let nir = red * (1.0 + ndvi) / (1.0 - ndvi);
    let solve = |target: f64| nir * (1.0 - target) / (1.0 + target);
    (
        red as f32,
        solve(0.72 * ndvi) as f32,
        solve(0.68 * ndvi) as f32,
        nir as f32,
    )
}

fn hash64(id: Uuid) -> u64 {
    let (hi, lo) = id.as_u64_pair();
    splitmix64(hi ^ splitmix64(lo))
}

fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Hash → [0, 1).
fn unit(h: u64) -> f64 {
    (h >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plant(id: u128, status: &str, area_m2: f64) -> PlantRow {
        PlantRow {
            id: Uuid::from_u128(id),
            lon: 15.85,
            lat: 41.45,
            status: status.into(),
            area_m2,
            sample_geom: String::new(),
        }
    }

    fn value(e: &pm::Extracted, metric: &str) -> Option<f64> {
        e.metrics
            .iter()
            .find(|(m, _)| *m == metric)
            .map(|(_, v)| *v)
    }

    fn extract_one(p: &PlantRow) -> pm::Extracted {
        pm::extract(&SynthSampler.sample(p).unwrap())
    }

    #[test]
    fn synth_is_deterministic_per_plant() {
        // Re-running the stage must reproduce the same numbers, not just the same row count.
        let p = plant(7, "alive", 7.07);
        assert_eq!(extract_one(&p), extract_one(&p));
    }

    #[test]
    fn synth_alive_plant_yields_the_demo_metric_set() {
        let e = extract_one(&plant(1, "alive", 7.07));
        let names: Vec<&str> = e.metrics.iter().map(|(m, _)| *m).collect();
        // No SWIR on a drone sensor ⇒ no ndmi.
        assert_eq!(
            names,
            ["ndvi", "ndre", "gndvi", "savi", "canopy_m2", "height_m"]
        );
        let ndvi = value(&e, "ndvi").unwrap();
        assert!((0.35..0.90).contains(&ndvi), "implausible ndvi {ndvi}");
        assert!(value(&e, "ndre").unwrap() < ndvi); // ndre ≈ 0.68 × ndvi
        assert_eq!(value(&e, "canopy_m2"), Some(7.07)); // the real PostGIS area, untouched
        let h = value(&e, "height_m").unwrap();
        assert!((1.0..8.0).contains(&h), "implausible height {h}");
        assert!(e.quality > 50 && e.quality <= 100, "quality {}", e.quality);
    }

    #[test]
    fn synth_missing_plant_keeps_its_footprint_but_reports_no_vigor() {
        let e = extract_one(&plant(2, "missing", 7.07));
        assert_eq!(value(&e, "ndvi"), None); // bare soil never passes the canopy mask
        assert_eq!(e.quality, 0);
        assert_eq!(value(&e, "canopy_m2"), Some(7.07));
        assert!(value(&e, "height_m").unwrap() < 0.5);
    }

    #[test]
    fn synth_field_is_smooth_with_a_sprinkling_of_weak_plants() {
        // What the neighbour-relative detector needs: neighbours agree, outliers stand out.
        let values: Vec<f64> = (0..300u128)
            .map(|i| {
                let mut p = plant(i + 1, "alive", 7.07);
                p.lon += (i % 20) as f64 * 0.00005; // ~4 m spacing
                p.lat += (i / 20) as f64 * 0.00005;
                value(&extract_one(&p), "ndvi").unwrap()
            })
            .collect();
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let weak = values.iter().filter(|v| **v < 0.75 * mean).count();
        assert!(weak > 0, "no low-vigor plants to detect");
        assert!(
            weak < values.len() / 10,
            "{weak} weak plants is a broken field"
        );
    }
}
