//! OWNER: be-detect — stages `detect` and `register`
//! (docs/API-PLANT.md §"Pipeline stages" → Detection / Registration).
//!
//! `detect`: label-free classical CV. CHM = DSM − rolling terrain baseline (p10 over a 15 m
//! window, no DTM), smooth, local maxima ≥ 1.5 m apart, watershed crown delineation, drop
//! crowns outside 0.5–80 m². One `plant_detections` row per crown (centroid point,
//! `crown_geom`, `height_m`, `canopy_m2`, `score`). Deletes its own rows for the capture
//! before inserting (idempotent). Capture → `detected`.
//!
//! `register`: greedy mutual nearest neighbour (`arvo_core::registration`) against the
//! parcel's existing non-`removed` plants; matched → `plant_id` + `match_kind='matched'`,
//! unmatched detection → new plant (`source='detection'`), plants inside the capture bbox
//! with no detection get `missing_streak + 1` (→ `missing` at
//! `registration::MISSING_AFTER_CAPTURES`). Capture → `registered`.
//!
//! Two detector backends, picked at runtime: `services/plant-detect` over HTTP when
//! `PLANT_DETECT_URL` is set (every unit type, no GDAL needed here), otherwise — and on **any**
//! service failure — the in-process `mod cv` path behind `--features imagery` (`tree`/`bush`).
//! With neither the stage returns [`crate::pipeline::STAGE_UNSUPPORTED`]; `source="demo"` runs
//! the synthetic detector ([`SYNTH_VER`]) so CI and `seed --demo-plants` work end to end.
//!
//! **Both stages are re-runnable.** `detect` owns exactly the `plant_detections` rows of its
//! capture and rewrites them. `register` derives everything from those rows: a re-run re-matches
//! the plants it created last time (distance 0 → matched, nothing new), and `missing_streak` is
//! *recomputed* from the capture history rather than incremented, so a retry can never
//! double-count an absence.
#![allow(dead_code)] // Some CV constants are only reachable under `--features imagery`.

use anyhow::{anyhow, Context};
use arvo_core::registration::{self, Point, Projection};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::pipeline::{Job, Worker};

/// `model_ver` stamped by the classical-CV detector (`"<detector>-<semver>"`).
pub const DETECTOR_VER: &str = "cv-chm-0.1.0";
/// `model_ver` stamped by the deterministic synthetic path (`source="demo"`).
pub const SYNTH_VER: &str = "synth-0.1.0";
/// Minimum spacing between CHM local maxima (metres).
pub const MIN_SPACING_M: f64 = 1.5;
/// Crowns outside this area range are dropped (m²).
pub const MIN_CROWN_M2: f64 = 0.5;
pub const MAX_CROWN_M2: f64 = 80.0;
/// Rolling window and percentile of the terrain baseline subtracted from the DSM.
pub const TERRAIN_WINDOW_M: f64 = 15.0;
pub const TERRAIN_PERCENTILE: f64 = 0.10;

/// Crown radius the synthetic detector draws around a point, per unit type — the same buffers
/// `core::plant_metrics` samples with, so demo extraction sees a plausible canopy.
/// `vine`/`row_segment` carry no crown polygon at all (docs/API-PLANT.md §Detection).
pub const SYNTH_CROWN_TREE_M: f64 = 1.5;
/// Nominal spacing of the synthetic grid laid inside a parcel that has no plants yet.
pub const SYNTH_SPACING_M: f64 = 5.0;
/// Deterministic sub-metre offset applied to synthetic detections, so `register` exercises the
/// real drift path instead of matching at exactly 0 m. Must stay well below the match radius.
pub const SYNTH_JITTER_M: f64 = 0.25;
/// Confidence stamped on synthetic detections.
pub const SYNTH_SCORE: f64 = 0.95;
/// Caps for the synthetic grid: cells per axis, and total plants for one demo capture.
const SYNTH_MAX_CELLS: i32 = 400;
const SYNTH_MAX_POINTS: i64 = 2_000;

/// Same cap the API enforces on `POST /plants` (docs/API-PLANT.md §Plants).
const MAX_PLANTS_PER_PARCEL: i64 = 200_000;
/// A detector that returns more than this for one capture is broken, not thorough.
const MAX_DETECTIONS: usize = 200_000;
/// Captures looked back over when recomputing `missing_streak`.
const RECENT_CAPTURES: i64 = 20;

/// One delineated plant, in lon/lat. `ring` is the crown's exterior ring (closed, empty when
/// the unit type carries no crown).
pub struct Crown {
    pub lon: f64,
    pub lat: f64,
    pub ring: Vec<(f64, f64)>,
    pub height_m: f64,
    pub canopy_m2: f64,
    pub score: f64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct Capture {
    id: Uuid,
    org_id: Uuid,
    parcel_id: Uuid,
    source: String,
    unit_type: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct DetectionRow {
    id: Uuid,
    lon: f64,
    lat: f64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct PlantRow {
    id: Uuid,
    lon: f64,
    lat: f64,
    /// The flight actually covered this plant — only those can go `missing` (FR-P-022).
    in_bbox: bool,
}

// --- stage: detect ----------------------------------------------------------

pub async fn run(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let cap = load_capture(&w.pool, job).await?;
    // Pixel work happens before the transaction: it is the slow part and it touches no rows.
    let crowns = match cap.source.as_str() {
        "demo" => None,
        _ => Some(cv_detect(w, &cap).await?),
    };

    let mut tx = w.pool.begin().await?;
    sqlx::query("DELETE FROM plant_detections WHERE capture_id = $1 AND org_id = $2")
        .bind(cap.id)
        .bind(cap.org_id)
        .execute(&mut *tx)
        .await
        .context("clear previous detections")?;

    let n = match &crowns {
        Some(c) => insert_crowns(&mut tx, &cap, c).await?,
        None => insert_synthetic(&mut tx, &cap).await?,
    };

    // `register` needs a footprint to tell "not detected" from "not overflown". A capture whose
    // bbox is already known (the ortho footprint written by `sfm`) keeps it.
    sqlx::query(
        "UPDATE captures
            SET bbox = COALESCE(bbox, (
                    SELECT ST_Envelope(ST_Buffer(ST_Collect(geom)::geography, 2.0)::geometry)
                      FROM plant_detections WHERE capture_id = $1 AND org_id = $2)),
                updated_at = now()
          WHERE id = $1 AND org_id = $2",
    )
    .bind(cap.id)
    .bind(cap.org_id)
    .execute(&mut *tx)
    .await
    .context("stamp capture bbox")?;
    tx.commit().await?;

    tracing::info!(capture = %cap.id, detections = n, source = %cap.source, "detect complete");
    Ok(())
}

/// Synthetic detections for `source="demo"`: no pixels, no GDAL, fully deterministic.
///
/// A parcel that already has plants is re-detected *where those plants are* (with a fixed
/// sub-metre offset) so ids stay stable across demo flights — which is the property the whole
/// registration stage exists to protect. Plants that are `dead`/`missing` are deliberately not
/// detected, so the seeded missing plant stays missing and the replant list keeps its entry.
/// A parcel with no plants gets a regular grid inside its polygon (the "first flight" case).
async fn insert_synthetic(
    tx: &mut Transaction<'_, Postgres>,
    cap: &Capture,
) -> anyhow::Result<u64> {
    let crown_m = crown_radius_m(&cap.unit_type);

    let from_plants = sqlx::query(
        "INSERT INTO plant_detections
             (org_id, capture_id, geom, crown_geom, score, height_m, canopy_m2, model_ver)
         SELECT $1, $2, d.pt,
                CASE WHEN $5::float8 IS NULL THEN NULL
                     ELSE ST_Buffer(d.pt::geography, $5::float8)::geometry END,
                $6::float8, d.h,
                CASE WHEN $5::float8 IS NULL THEN NULL
                     ELSE ST_Area(ST_Buffer(d.pt::geography, $5::float8)) END,
                $7
           FROM (SELECT ST_Project(
                            p.geom::geography, $4::float8,
                            atan2(sin(ST_X(p.geom) * 7919.0 + ST_Y(p.geom) * 104729.0),
                                  cos(ST_X(p.geom) * 7919.0 + ST_Y(p.geom) * 104729.0))
                        )::geometry AS pt,
                        GREATEST(0.4, 2.4 + 0.9 * sin(ST_X(p.geom) * 1533.0)
                                             * cos(ST_Y(p.geom) * 2311.0)) AS h
                   FROM plants p
                  WHERE p.org_id = $1 AND p.parcel_id = $3
                    AND p.status IN ('alive', 'replanted')) d",
    )
    .bind(cap.org_id)
    .bind(cap.id)
    .bind(cap.parcel_id)
    .bind(SYNTH_JITTER_M)
    .bind(crown_m)
    .bind(SYNTH_SCORE)
    .bind(SYNTH_VER)
    .execute(&mut **tx)
    .await
    .context("synthesize detections from existing plants")?
    .rows_affected();
    if from_plants > 0 {
        return Ok(from_plants);
    }

    // First flight over this parcel: a regular grid clipped to the polygon. Degrees per metre
    // are taken at the parcel centroid — good to a few cm at parcel scale.
    let grid = sqlx::query(
        "WITH par AS (
             SELECT geom FROM parcels WHERE id = $3 AND org_id = $1
         ), b AS (
             SELECT geom,
                    ST_XMin(geom) AS minx, ST_YMin(geom) AS miny,
                    ST_XMax(geom) AS maxx, ST_YMax(geom) AS maxy,
                    $4::float8 / 110540.0 AS dlat,
                    $4::float8 / GREATEST(111320.0 * cos(radians(ST_Y(ST_Centroid(geom)))), 1.0)
                        AS dlon
               FROM par
         ), g AS (
             SELECT ST_SetSRID(ST_MakePoint(b.minx + b.dlon * (gi.i + 0.5),
                                            b.miny + b.dlat * (gj.j + 0.5)), 4326) AS pt
               FROM b,
                    generate_series(0, LEAST(GREATEST(ceil((b.maxx - b.minx) / b.dlon)::int, 1),
                                             $8::int) - 1) AS gi(i),
                    generate_series(0, LEAST(GREATEST(ceil((b.maxy - b.miny) / b.dlat)::int, 1),
                                             $8::int) - 1) AS gj(j)
         ), d AS (
             SELECT g.pt,
                    GREATEST(0.4, 2.4 + 0.9 * sin(ST_X(g.pt) * 1533.0)
                                         * cos(ST_Y(g.pt) * 2311.0)) AS h
               FROM g, b
              WHERE ST_Contains(b.geom, g.pt)
              ORDER BY ST_Y(g.pt), ST_X(g.pt)
              LIMIT $9
         )
         INSERT INTO plant_detections
             (org_id, capture_id, geom, crown_geom, score, height_m, canopy_m2, model_ver)
         SELECT $1, $2, d.pt,
                CASE WHEN $5::float8 IS NULL THEN NULL
                     ELSE ST_Buffer(d.pt::geography, $5::float8)::geometry END,
                $6::float8, d.h,
                CASE WHEN $5::float8 IS NULL THEN NULL
                     ELSE ST_Area(ST_Buffer(d.pt::geography, $5::float8)) END,
                $7
           FROM d",
    )
    .bind(cap.org_id)
    .bind(cap.id)
    .bind(cap.parcel_id)
    .bind(SYNTH_SPACING_M)
    .bind(crown_m)
    .bind(SYNTH_SCORE)
    .bind(SYNTH_VER)
    .bind(SYNTH_MAX_CELLS)
    .bind(SYNTH_MAX_POINTS)
    .execute(&mut **tx)
    .await
    .context("synthesize detection grid")?
    .rows_affected();
    if grid > 0 {
        return Ok(grid);
    }

    // Parcel smaller than the grid step: one plant on the surface so the demo pipeline still
    // produces something downstream (ST_PointOnSurface is guaranteed inside the polygon).
    let one = sqlx::query(
        "INSERT INTO plant_detections
             (org_id, capture_id, geom, crown_geom, score, height_m, canopy_m2, model_ver)
         SELECT $1, $2, pt,
                CASE WHEN $4::float8 IS NULL THEN NULL
                     ELSE ST_Buffer(pt::geography, $4::float8)::geometry END,
                $5::float8, 2.4,
                CASE WHEN $4::float8 IS NULL THEN NULL
                     ELSE ST_Area(ST_Buffer(pt::geography, $4::float8)) END,
                $6
           FROM (SELECT ST_PointOnSurface(geom) AS pt
                   FROM parcels WHERE id = $3 AND org_id = $1) s",
    )
    .bind(cap.org_id)
    .bind(cap.id)
    .bind(cap.parcel_id)
    .bind(crown_m)
    .bind(SYNTH_SCORE)
    .bind(SYNTH_VER)
    .execute(&mut **tx)
    .await
    .context("synthesize fallback detection")?
    .rows_affected();
    if one == 0 {
        tracing::warn!(capture = %cap.id, "demo capture produced no detections");
    }
    Ok(one)
}

/// Bulk-insert the CV detector's crowns (one round trip, arrays unnested server side).
async fn insert_crowns(
    tx: &mut Transaction<'_, Postgres>,
    cap: &Capture,
    crowns: &[Crown],
) -> anyhow::Result<u64> {
    if crowns.is_empty() {
        return Ok(0);
    }
    let lon: Vec<f64> = crowns.iter().map(|c| c.lon).collect();
    let lat: Vec<f64> = crowns.iter().map(|c| c.lat).collect();
    let ring: Vec<Option<String>> = crowns.iter().map(|c| ring_geojson(&c.ring)).collect();
    let score: Vec<f64> = crowns.iter().map(|c| c.score).collect();
    let height: Vec<f64> = crowns.iter().map(|c| c.height_m).collect();
    let canopy: Vec<Option<f64>> = crowns
        .iter()
        .map(|c| (!c.ring.is_empty()).then_some(c.canopy_m2))
        .collect();

    let n = sqlx::query(
        "INSERT INTO plant_detections
             (org_id, capture_id, geom, crown_geom, score, height_m, canopy_m2, model_ver)
         SELECT $1, $2, ST_SetSRID(ST_MakePoint(c.lon, c.lat), 4326),
                CASE WHEN c.crown IS NULL THEN NULL
                     ELSE ST_SetSRID(ST_GeomFromGeoJSON(c.crown), 4326) END,
                c.score, c.height, c.canopy, $3
           FROM UNNEST($4::float8[], $5::float8[], $6::text[],
                       $7::float8[], $8::float8[], $9::float8[])
                AS c(lon, lat, crown, score, height, canopy)",
    )
    .bind(cap.org_id)
    .bind(cap.id)
    .bind(DETECTOR_VER)
    .bind(&lon)
    .bind(&lat)
    .bind(&ring)
    .bind(&score)
    .bind(&height)
    .bind(&canopy)
    .execute(&mut **tx)
    .await
    .context("insert detections")?
    .rows_affected();
    Ok(n)
}

// --- stage: register --------------------------------------------------------

pub async fn register(w: &Worker, job: &Job) -> anyhow::Result<()> {
    let cap = load_capture(&w.pool, job).await?;

    let detections = sqlx::query_as::<_, DetectionRow>(
        "SELECT id, ST_X(geom) AS lon, ST_Y(geom) AS lat
           FROM plant_detections
          WHERE capture_id = $1 AND org_id = $2
          ORDER BY id",
    )
    .bind(cap.id)
    .bind(cap.org_id)
    .fetch_all(&w.pool)
    .await
    .context("load detections")?;

    if detections.is_empty() {
        // Zero detections is a detector problem, not 300 dead trees: never let it mark a whole
        // parcel missing. The capture still advances (a re-run of `detect` fixes it).
        tracing::warn!(capture = %cap.id, "no detections to register");
        set_plant_count(&w.pool, &cap, 0).await?;
        return Ok(());
    }
    if detections.len() > MAX_DETECTIONS {
        return Err(anyhow!(
            "capture has {} detections, above the {MAX_DETECTIONS} cap",
            detections.len()
        ));
    }

    // Candidates: the parcel's live plants inside the capture footprint, plus a halo of one
    // match radius so a plant just outside the bbox can still claim its detection.
    let plants = sqlx::query_as::<_, PlantRow>(
        "SELECT p.id, ST_X(p.geom) AS lon, ST_Y(p.geom) AS lat,
                (c.bbox IS NULL OR ST_Intersects(p.geom, c.bbox)) AS in_bbox
           FROM captures c
           JOIN plants p ON p.org_id = c.org_id AND p.parcel_id = c.parcel_id
          WHERE c.id = $1 AND c.org_id = $2 AND p.status <> 'removed'
            AND (c.bbox IS NULL OR ST_DWithin(p.geom::geography, c.bbox::geography, $3))
          ORDER BY p.id",
    )
    .bind(cap.id)
    .bind(cap.org_id)
    .bind(registration::MATCH_RADIUS_MAX_M)
    .fetch_all(&w.pool)
    .await
    .context("load candidate plants")?;

    // One local metric plane for both sets (matching is metric, the DB is lon/lat).
    let mut lonlat: Vec<(f64, f64)> = detections.iter().map(|d| (d.lon, d.lat)).collect();
    lonlat.extend(plants.iter().map(|p| (p.lon, p.lat)));
    let proj = Projection::around(&lonlat).ok_or_else(|| anyhow!("nothing to register"))?;
    let det_pts: Vec<Point> = detections
        .iter()
        .map(|d| proj.point(d.lon, d.lat))
        .collect();
    let plant_pts: Vec<Point> = plants.iter().map(|p| proj.point(p.lon, p.lat)).collect();

    let radius_m = registration::match_radius_for(&det_pts);
    let outcome = registration::assign(&det_pts, &plant_pts, radius_m);

    if !outcome.created.is_empty() {
        let existing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM plants
              WHERE org_id = $1 AND parcel_id = $2 AND status <> 'removed'",
        )
        .bind(cap.org_id)
        .bind(cap.parcel_id)
        .fetch_one(&w.pool)
        .await
        .context("count parcel plants")?;
        if existing + outcome.created.len() as i64 > MAX_PLANTS_PER_PARCEL {
            return Err(anyhow!(
                "registering {} plants would exceed the {MAX_PLANTS_PER_PARCEL} per-parcel cap",
                outcome.created.len()
            ));
        }
    }

    let matched_det: Vec<Uuid> = outcome
        .matched
        .iter()
        .map(|m| detections[m.detection].id)
        .collect();
    let matched_plant: Vec<Uuid> = outcome.matched.iter().map(|m| plants[m.plant].id).collect();
    let matched_dist: Vec<f64> = outcome.matched.iter().map(|m| m.dist_m).collect();
    let created_det: Vec<Uuid> = outcome.created.iter().map(|i| detections[*i].id).collect();
    let created_plant: Vec<Uuid> = created_det.iter().map(|_| Uuid::new_v4()).collect();
    // Only plants the flight actually covered can be counted absent.
    let absent_plant: Vec<Uuid> = outcome
        .absent
        .iter()
        .filter(|i| plants[**i].in_bbox)
        .map(|i| plants[*i].id)
        .collect();

    let mut tx = w.pool.begin().await?;

    if !matched_det.is_empty() {
        sqlx::query(
            "UPDATE plant_detections d
                SET plant_id = m.plant_id, match_kind = 'matched', match_dist_m = m.dist
               FROM UNNEST($1::uuid[], $2::uuid[], $3::float8[]) AS m(det_id, plant_id, dist)
              WHERE d.id = m.det_id AND d.org_id = $4",
        )
        .bind(&matched_det)
        .bind(&matched_plant)
        .bind(&matched_dist)
        .bind(cap.org_id)
        .execute(&mut *tx)
        .await
        .context("link matched detections")?;

        // The plant's `geom` is deliberately NOT moved: identity is the point of this stage
        // (FR-P-003). Only the canopy footprint and the freshness marker are refreshed.
        sqlx::query(
            "UPDATE plants p
                SET crown_geom = COALESCE(d.crown_geom, p.crown_geom),
                    missing_streak = 0,
                    updated_at = now()
               FROM UNNEST($1::uuid[], $2::uuid[]) AS m(det_id, plant_id)
               JOIN plant_detections d ON d.id = m.det_id
              WHERE p.id = m.plant_id AND p.org_id = $3",
        )
        .bind(&matched_det)
        .bind(&matched_plant)
        .bind(cap.org_id)
        .execute(&mut *tx)
        .await
        .context("refresh matched plants")?;
    }

    if !created_det.is_empty() {
        sqlx::query(
            "INSERT INTO plants
                 (id, org_id, parcel_id, unit_type, geom, crown_geom, status, source,
                  missing_streak)
             SELECT n.plant_id, $1, $2, $3::plant_unit, d.geom, d.crown_geom,
                    'alive'::plant_status, 'detection', 0
               FROM UNNEST($4::uuid[], $5::uuid[]) AS n(plant_id, det_id)
               JOIN plant_detections d ON d.id = n.det_id AND d.org_id = $1",
        )
        .bind(cap.org_id)
        .bind(cap.parcel_id)
        .bind(&cap.unit_type)
        .bind(&created_plant)
        .bind(&created_det)
        .execute(&mut *tx)
        .await
        .context("create plants for unmatched detections")?;

        sqlx::query(
            "UPDATE plant_detections d
                SET plant_id = n.plant_id, match_kind = 'created', match_dist_m = NULL
               FROM UNNEST($1::uuid[], $2::uuid[]) AS n(plant_id, det_id)
              WHERE d.id = n.det_id AND d.org_id = $3",
        )
        .bind(&created_plant)
        .bind(&created_det)
        .bind(cap.org_id)
        .execute(&mut *tx)
        .await
        .context("link created detections")?;
    }

    if !absent_plant.is_empty() {
        update_missing_streaks(&mut tx, &cap, &absent_plant).await?;
    }

    set_plant_count(
        &mut *tx,
        &cap,
        (matched_det.len() + created_det.len()) as i32,
    )
    .await?;
    tx.commit().await?;

    tracing::info!(
        capture = %cap.id,
        matched = matched_det.len(),
        created = created_det.len(),
        absent = absent_plant.len(),
        radius_m,
        "register complete"
    );
    Ok(())
}

/// Recompute `missing_streak` for the plants this capture did not see (FR-P-022).
///
/// The streak is *derived*, never incremented: it is the number of the parcel's most recent
/// captures — counting only those whose footprint covers the plant — since the last one that
/// detected it. That makes the stage safe to retry, and it is exactly what
/// `ReplantEntry.captures_absent` reports. `alive`/`replanted` plants flip to `missing` at
/// [`registration::MISSING_AFTER_CAPTURES`]; coming back is a human decision
/// (`POST /plants/{id}/status`), so nothing here ever un-sets a status.
///
/// A capture only counts as "looked and did not find it" if it produced detections at all —
/// the same guard `register` applies to the *current* capture. A blind capture (detector
/// failure, or crowns all below [`MIN_CROWN_M2`]) leaves no `plant_detections` row and no
/// `bbox`, so without this it would read as a flight that covered every plant and saw none,
/// and one real absence afterwards would be enough to flip healthy plants to `missing`
/// (docs/API-PLANT.md §Registration: "a single capture never marks anything missing").
/// Every capture left in the window therefore has a real footprint, so coverage is an honest
/// spatial test rather than a vacuously true one.
async fn update_missing_streaks(
    tx: &mut Transaction<'_, Postgres>,
    cap: &Capture,
    plant_ids: &[Uuid],
) -> anyhow::Result<()> {
    sqlx::query(
        "WITH caps AS (
             SELECT c.id, c.captured_at, c.bbox
               FROM captures c
              WHERE c.org_id = $1 AND c.parcel_id = $2
                AND (c.id = $3 OR c.status IN ('registered', 'extracted'))
                AND c.bbox IS NOT NULL
                AND EXISTS (SELECT 1 FROM plant_detections d0
                             WHERE d0.capture_id = c.id AND d0.org_id = c.org_id)
              ORDER BY c.captured_at DESC, c.id DESC
              LIMIT $4
         ), cov AS (
             SELECT p.id AS plant_id, caps.id AS capture_id,
                    row_number() OVER (PARTITION BY p.id
                                       ORDER BY caps.captured_at DESC, caps.id DESC) AS rn
               FROM plants p
               JOIN caps ON ST_Intersects(p.geom, caps.bbox)
              WHERE p.org_id = $1 AND p.id = ANY($5::uuid[])
         ), streak AS (
             SELECT cov.plant_id,
                    (COALESCE(MIN(cov.rn) FILTER (WHERE d.plant_id IS NOT NULL),
                              COUNT(DISTINCT cov.capture_id) + 1) - 1)::int AS n
               FROM cov
               LEFT JOIN plant_detections d
                      ON d.capture_id = cov.capture_id AND d.plant_id = cov.plant_id
              GROUP BY cov.plant_id
         )
         UPDATE plants p
            SET missing_streak = streak.n,
                status = CASE WHEN streak.n >= $6 AND p.status IN ('alive', 'replanted')
                              THEN 'missing'::plant_status ELSE p.status END,
                updated_at = now()
           FROM streak
          WHERE p.id = streak.plant_id AND p.org_id = $1",
    )
    .bind(cap.org_id)
    .bind(cap.parcel_id)
    .bind(cap.id)
    .bind(RECENT_CAPTURES)
    .bind(plant_ids)
    .bind(registration::MISSING_AFTER_CAPTURES)
    .execute(&mut **tx)
    .await
    .context("recompute missing streaks")?;
    Ok(())
}

// --- helpers ----------------------------------------------------------------

async fn load_capture(pool: &PgPool, job: &Job) -> anyhow::Result<Capture> {
    sqlx::query_as::<_, Capture>(
        "SELECT id, org_id, parcel_id, source, unit_type::text AS unit_type
           FROM captures WHERE id = $1 AND org_id = $2",
    )
    .bind(job.capture_id)
    .bind(job.org_id)
    .fetch_optional(pool)
    .await
    .context("load capture")?
    .ok_or_else(|| anyhow!("capture {} not found", job.capture_id))
}

async fn set_plant_count<'e, E: sqlx::PgExecutor<'e>>(
    exec: E,
    cap: &Capture,
    count: i32,
) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE captures SET plant_count = $3, updated_at = now() WHERE id = $1 AND org_id = $2",
    )
    .bind(cap.id)
    .bind(cap.org_id)
    .bind(count)
    .execute(exec)
    .await
    .context("update capture plant_count")?;
    Ok(())
}

/// Crown buffer radius for a unit type; `None` when the unit carries no crown polygon.
fn crown_radius_m(unit_type: &str) -> Option<f64> {
    match unit_type {
        "tree" | "bush" => Some(SYNTH_CROWN_TREE_M),
        _ => None, // vine / row_segment are points along a row (docs/API-PLANT.md §Detection)
    }
}

/// A closed lon/lat ring as a GeoJSON Polygon string; `None` for an empty ring.
fn ring_geojson(ring: &[(f64, f64)]) -> Option<String> {
    if ring.len() < 4 {
        return None; // fewer than 3 distinct vertices + closure is not a polygon
    }
    let mut s = String::from("{\"type\":\"Polygon\",\"coordinates\":[[");
    for (i, (lon, lat)) in ring.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("[{lon:.9},{lat:.9}]"));
    }
    s.push_str("]]}");
    Some(s)
}

/// Detect plants for one capture.
///
/// `services/plant-detect` is tried first whenever `PLANT_DETECT_URL` is set: it covers every
/// unit type (`vine`/`row_segment` included, which the in-process path does not) and needs no
/// GDAL in this process, so even a default CI build can detect for real. **Any** service failure
/// — unset, unreachable, timeout, HTTP error, unparseable body — falls back to the in-process
/// classical-CV path, so a down service can never fail a capture the local path could have
/// handled (docs/API-PLANT.md §Detection).
async fn cv_detect(w: &Worker, cap: &Capture) -> anyhow::Result<Vec<Crown>> {
    if let Some(base) = w.detect_url.as_deref() {
        match service::detect(w, cap, base).await {
            Ok(crowns) => {
                tracing::info!(
                    capture = %cap.id,
                    detections = crowns.len(),
                    detector = "plant-detect",
                    "detection via service"
                );
                return Ok(crowns);
            }
            Err(e) => tracing::warn!(
                capture = %cap.id,
                error = %e,
                "plant-detect service failed — falling back to in-process CV"
            ),
        }
    }
    local_detect(w, cap).await
}

#[cfg(feature = "imagery")]
async fn local_detect(w: &Worker, cap: &Capture) -> anyhow::Result<Vec<Crown>> {
    if !matches!(cap.unit_type.as_str(), "tree" | "bush") {
        return Err(anyhow!(
            "crown detection covers tree/bush only in P-MVP, not {}",
            cap.unit_type
        ));
    }
    let key: Option<String> = sqlx::query_scalar(
        "SELECT path FROM capture_assets
          WHERE capture_id = $1 AND org_id = $2 AND kind = 'dsm'
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(cap.id)
    .bind(cap.org_id)
    .fetch_optional(&w.pool)
    .await
    .context("look up dsm asset")?;
    let key = key.ok_or_else(|| anyhow!("capture has no dsm asset"))?;
    let path = crate::pipeline::key_path(&w.store_dir, &key);

    // GDAL is blocking and CPU-bound — keep it off the async runtime.
    let crowns = tokio::task::spawn_blocking(move || cv::detect_crowns(&path))
        .await
        .context("crown detection panicked")??;
    Ok(crowns)
}

#[cfg(not(feature = "imagery"))]
async fn local_detect(_w: &Worker, _cap: &Capture) -> anyhow::Result<Vec<Crown>> {
    // docs/API-PLANT.md §"Builds without GDAL (CI default)": with no GDAL *and* no
    // `PLANT_DETECT_URL`, the capture fails with exactly this job error, and `source="demo"`
    // keeps working.
    Err(anyhow!(crate::pipeline::STAGE_UNSUPPORTED))
}

// --- plant-detect service client -------------------------------------------

/// HTTP client for `services/plant-detect`. The wire contract is that service's
/// `app/schemas.py` (`DetectRequest`/`DetectResponse`) — keep the two in step.
mod service {
    use anyhow::{anyhow, Context};
    use serde::{Deserialize, Serialize};

    use super::{Capture, Crown};
    use crate::pipeline::Worker;

    /// Fail fast when nothing is listening, so the in-process fallback starts promptly instead
    /// of stalling the stage.
    const CONNECT_TIMEOUT_S: u64 = 5;
    /// Crown delineation is CPU-bound over tens of millions of pixels (the service caps input at
    /// 400M px), so the *request* timeout is deliberately generous — a short one would abort real
    /// work and silently downgrade every flight to the fallback. Override with
    /// `PLANT_DETECT_TIMEOUT_S`.
    const REQUEST_TIMEOUT_S: u64 = 600;

    fn timeout_s() -> u64 {
        std::env::var("PLANT_DETECT_TIMEOUT_S")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(REQUEST_TIMEOUT_S)
    }

    #[derive(Serialize)]
    struct Request<'a> {
        capture_id: String,
        unit_type: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        ortho_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dsm_path: Option<String>,
        bands: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        parcel_geometry: Option<serde_json::Value>,
    }

    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        truncated: bool,
        #[serde(default)]
        detections: Vec<DetectionOut>,
    }

    #[derive(Deserialize)]
    struct DetectionOut {
        geom: serde_json::Value,
        #[serde(default)]
        crown_geom: Option<serde_json::Value>,
        #[serde(default)]
        score: f64,
        #[serde(default)]
        height_m: Option<f64>,
        #[serde(default)]
        canopy_m2: Option<f64>,
    }

    /// `{"error": {"code": ..., "message": ...}}` — the service's error envelope.
    #[derive(Deserialize)]
    struct ErrorBody {
        error: ErrorDetail,
    }

    #[derive(Deserialize)]
    struct ErrorDetail {
        code: String,
        message: String,
    }

    /// GeoJSON Point → (lon, lat).
    fn point_lonlat(v: &serde_json::Value) -> anyhow::Result<(f64, f64)> {
        let c = v
            .get("coordinates")
            .and_then(|c| c.as_array())
            .ok_or_else(|| anyhow!("detection geom has no coordinates"))?;
        let lon = c
            .first()
            .and_then(|n| n.as_f64())
            .ok_or_else(|| anyhow!("detection geom lon is not a number"))?;
        let lat = c
            .get(1)
            .and_then(|n| n.as_f64())
            .ok_or_else(|| anyhow!("detection geom lat is not a number"))?;
        Ok((lon, lat))
    }

    /// GeoJSON Polygon → its exterior ring. Anything else yields an empty ring, which
    /// [`super::ring_geojson`] then drops — a missing crown is not worth failing a flight over.
    fn polygon_ring(v: Option<&serde_json::Value>) -> Vec<(f64, f64)> {
        let Some(v) = v else { return Vec::new() };
        let Some(outer) = v
            .get("coordinates")
            .and_then(|c| c.as_array())
            .and_then(|r| r.first())
            .and_then(|r| r.as_array())
        else {
            return Vec::new();
        };
        outer
            .iter()
            .filter_map(|p| {
                let a = p.as_array()?;
                Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
            })
            .collect()
    }

    pub(super) async fn detect(
        w: &Worker,
        cap: &Capture,
        base: &str,
    ) -> anyhow::Result<Vec<Crown>> {
        // Store KEYS, not absolute paths — the service resolves them against its own mount
        // (services/plant-detect/README.md §Storage).
        let assets: Vec<(String, String)> = sqlx::query_as(
            "SELECT kind, path FROM capture_assets
              WHERE capture_id = $1 AND org_id = $2 AND kind IN ('ortho', 'dsm')
              ORDER BY created_at DESC",
        )
        .bind(cap.id)
        .bind(cap.org_id)
        .fetch_all(&w.pool)
        .await
        .context("look up capture assets")?;

        let pick = |kind: &str| {
            assets
                .iter()
                .find(|(k, _)| k == kind)
                .map(|(_, p)| p.clone())
        };
        let (ortho_path, dsm_path) = (pick("ortho"), pick("dsm"));
        if ortho_path.is_none() && dsm_path.is_none() {
            return Err(anyhow!("capture has no ortho or dsm asset"));
        }

        let (geometry, bands): (Option<String>, serde_json::Value) = sqlx::query_as(
            "SELECT ST_AsGeoJSON(p.geom)::text, c.bands
               FROM captures c JOIN parcels p ON p.id = c.parcel_id
              WHERE c.id = $1 AND c.org_id = $2",
        )
        .bind(cap.id)
        .bind(cap.org_id)
        .fetch_one(&w.pool)
        .await
        .context("load parcel geometry for detection")?;

        let body = Request {
            capture_id: cap.id.to_string(),
            unit_type: &cap.unit_type,
            ortho_path,
            dsm_path,
            bands,
            parcel_geometry: geometry
                .as_deref()
                .and_then(|g| serde_json::from_str(g).ok()),
        };

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_S))
            .timeout(std::time::Duration::from_secs(timeout_s()))
            .build()
            .context("build plant-detect client")?;

        let res = client
            .post(format!("{base}/detect"))
            .json(&body)
            .send()
            .await
            .context("plant-detect request failed")?;

        let status = res.status();
        let text = res.text().await.context("read plant-detect response")?;
        if !status.is_success() {
            // Surface the service's own code/message when it sent one; it is far more useful
            // than the bare status in the job's last_error.
            return match serde_json::from_str::<ErrorBody>(&text) {
                Ok(e) => Err(anyhow!(
                    "plant-detect {} {}: {}",
                    status.as_u16(),
                    e.error.code,
                    e.error.message
                )),
                Err(_) => Err(anyhow!("plant-detect returned {}", status.as_u16())),
            };
        }

        let parsed: Response =
            serde_json::from_str(&text).context("parse plant-detect response")?;
        if parsed.truncated {
            tracing::warn!(
                capture = %cap.id,
                "plant-detect truncated its detection list at its max_detections cap"
            );
        }

        let mut crowns = Vec::with_capacity(parsed.detections.len());
        for d in parsed.detections {
            let (lon, lat) = point_lonlat(&d.geom)?;
            crowns.push(Crown {
                lon,
                lat,
                ring: polygon_ring(d.crown_geom.as_ref()),
                height_m: d.height_m.unwrap_or(0.0),
                canopy_m2: d.canopy_m2.unwrap_or(0.0),
                score: d.score,
            });
        }
        Ok(crowns)
    }
}

// --- classical CV (needs GDAL) ---------------------------------------------

/// Canopy-height-model crown delineation: DSM − rolling p10 terrain → smooth → local maxima
/// ≥ [`MIN_SPACING_M`] apart → marker-controlled watershed flooded downhill from each apex.
/// Label-free: no training data, no model download (FR-P-023 baseline).
#[cfg(feature = "imagery")]
mod cv {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;
    use std::f64::consts::TAU;
    use std::path::Path;

    use anyhow::{anyhow, Context};
    use gdal::raster::ResampleAlg;
    use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
    use gdal::Dataset;

    use super::{
        Crown, MAX_CROWN_M2, MIN_CROWN_M2, MIN_SPACING_M, TERRAIN_PERCENTILE, TERRAIN_WINDOW_M,
    };

    /// Ground sampling the CHM is decimated to. Finer than this buys no crowns and costs memory.
    const WORK_RES_M: f64 = 0.10;
    /// Hard cap on the working grid (f32 → ~64 MB at the cap).
    const MAX_WORK_PIXELS: usize = 16_000_000;
    /// Below this canopy height there is no plant, only ground.
    const MIN_HEIGHT_M: f64 = 0.5;
    /// A crown stops growing below this fraction of its own apex height.
    const CROWN_FLOOR_FRAC: f64 = 0.35;
    /// Box-blur radius applied to the CHM before the maxima search.
    const SMOOTH_RADIUS_M: f64 = 0.25;
    /// Angular resolution of the crown outline (radial profile of the watershed region).
    const SECTORS: usize = 24;
    /// Height at which a detection scores 1.0 (linear from [`MIN_HEIGHT_M`]).
    const SCORE_FULL_HEIGHT_M: f64 = 3.0;
    const SCORE_FLOOR: f64 = 0.1;

    const UNLABELED: i32 = -1;

    pub fn detect_crowns(dsm: &Path) -> anyhow::Result<Vec<Crown>> {
        let ds = Dataset::open(dsm).with_context(|| format!("open {}", dsm.display()))?;
        let gt = ds.geo_transform().context("dsm geo_transform")?;
        if gt[2].abs() > 1e-12 || gt[4].abs() > 1e-12 {
            return Err(anyhow!("rotated DSM geotransforms are not supported"));
        }
        let (rw, rh) = ds.raster_size();
        if rw == 0 || rh == 0 {
            return Err(anyhow!("empty DSM"));
        }
        let srs = ds.spatial_ref().context("dsm srs")?;

        // Metres per CRS unit, so a UTM ortho (metres) and a lon/lat ortho (degrees) both work.
        let (ux, uy) = if srs.is_projected() {
            (1.0, 1.0)
        } else {
            let clat = gt[3] + gt[5] * rh as f64 / 2.0;
            (
                111_320.0 * clat.to_radians().cos().abs().max(0.01),
                110_540.0,
            )
        };

        // Decimate to the working resolution, then further if the grid is still too big.
        let native = (gt[1].abs() * ux).min(gt[5].abs() * uy).max(1e-9);
        let mut step = (WORK_RES_M / native).ceil().max(1.0) as usize;
        while (rw / step).max(1) * (rh / step).max(1) > MAX_WORK_PIXELS {
            step += 1;
        }
        let (w, h) = ((rw / step).max(1), (rh / step).max(1));
        // Signed CRS size of one working pixel, and its metric size.
        let (sx, sy) = (gt[1] * rw as f64 / w as f64, gt[5] * rh as f64 / h as f64);
        let (px, py) = (sx.abs() * ux, sy.abs() * uy);

        let band = ds.rasterband(1).context("dsm rasterband(1)")?;
        let nodata = band.no_data_value();
        // Nearest neighbour, not average: averaging would blend nodata into real elevations.
        let buf = band
            .read_as::<f32>(
                (0, 0),
                (rw, rh),
                (w, h),
                Some(ResampleAlg::NearestNeighbour),
            )
            .context("read dsm")?;
        let mut z = buf.data().to_vec();
        for v in z.iter_mut() {
            let bad = !v.is_finite() || nodata.is_some_and(|nd| ((*v as f64) - nd).abs() <= 1e-6);
            if bad {
                *v = f32::NAN;
            }
        }

        let chm = canopy_height(&z, w, h, px, py);
        let smooth = box_blur(
            &chm,
            w,
            h,
            (SMOOTH_RADIUS_M / px.min(py)).round().max(1.0) as usize,
        );
        let markers = local_maxima(&smooth, w, h, px, py);
        let regions = watershed(&smooth, w, h, px, py, &markers);

        // One bulk reprojection for every vertex of every crown.
        let mut wgs84 = SpatialRef::from_epsg(4326)?;
        wgs84.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        let to_wgs = CoordTransform::new(&srs, &wgs84)?;

        let mut xs = Vec::new();
        let mut ys = Vec::new();
        let mut kept = Vec::new();
        for r in &regions {
            let ring = profile_ring(&r.radius_m, px.min(py));
            let area = shoelace(&ring);
            if !(MIN_CROWN_M2..=MAX_CROWN_M2).contains(&area) {
                continue;
            }
            let (cx, cy) = (
                gt[0] + (r.col as f64 + 0.5) * sx,
                gt[3] + (r.row as f64 + 0.5) * sy,
            );
            xs.push(cx);
            ys.push(cy);
            for (dx, dy) in &ring {
                xs.push(cx + dx / ux);
                ys.push(cy + dy / uy);
            }
            kept.push((r.height_m, area));
        }
        if kept.is_empty() {
            return Ok(Vec::new());
        }
        let mut zs = vec![0.0f64; xs.len()];
        to_wgs
            .transform_coords(&mut xs, &mut ys, &mut zs)
            .context("reproject crowns")?;

        let stride = SECTORS + 1;
        let mut out = Vec::with_capacity(kept.len());
        for (i, (height_m, canopy_m2)) in kept.into_iter().enumerate() {
            let base = i * stride;
            let mut ring: Vec<(f64, f64)> = (0..SECTORS)
                .map(|s| (xs[base + 1 + s], ys[base + 1 + s]))
                .collect();
            ring.push(ring[0]); // GeoJSON rings are closed
            out.push(Crown {
                lon: xs[base],
                lat: ys[base],
                ring,
                height_m,
                canopy_m2,
                score: score_for(height_m),
            });
        }
        Ok(out)
    }

    fn score_for(height_m: f64) -> f64 {
        let t = (height_m - MIN_HEIGHT_M) / (SCORE_FULL_HEIGHT_M - MIN_HEIGHT_M);
        t.clamp(SCORE_FLOOR, 1.0)
    }

    /// CHM = DSM − terrain baseline, the baseline being the p10 of each
    /// [`TERRAIN_WINDOW_M`] block, bilinearly interpolated between block centres (no DTM needed).
    fn canopy_height(z: &[f32], w: usize, h: usize, px: f64, py: f64) -> Vec<f32> {
        let bw = ((TERRAIN_WINDOW_M / px).round() as usize).clamp(1, w.max(1));
        let bh = ((TERRAIN_WINDOW_M / py).round() as usize).clamp(1, h.max(1));
        let (nx, ny) = (w.div_ceil(bw), h.div_ceil(bh));
        let mut coarse = vec![f32::NAN; nx * ny];
        let mut scratch: Vec<f32> = Vec::with_capacity(bw * bh);
        for by in 0..ny {
            for bx in 0..nx {
                scratch.clear();
                for row in by * bh..((by + 1) * bh).min(h) {
                    for col in bx * bw..((bx + 1) * bw).min(w) {
                        let v = z[row * w + col];
                        if v.is_finite() {
                            scratch.push(v);
                        }
                    }
                }
                if scratch.is_empty() {
                    continue;
                }
                scratch.sort_by(|a, b| a.total_cmp(b));
                let k = ((scratch.len() - 1) as f64 * TERRAIN_PERCENTILE).round() as usize;
                coarse[by * nx + bx] = scratch[k];
            }
        }

        let mut chm = vec![f32::NAN; w * h];
        for row in 0..h {
            let fy = (row as f64 / bh as f64 - 0.5).clamp(0.0, (ny - 1) as f64);
            let (j0, ty) = (fy.floor() as usize, fy.fract());
            let j1 = (j0 + 1).min(ny - 1);
            for col in 0..w {
                let v = z[row * w + col];
                if !v.is_finite() {
                    continue;
                }
                let fx = (col as f64 / bw as f64 - 0.5).clamp(0.0, (nx - 1) as f64);
                let (i0, tx) = (fx.floor() as usize, fx.fract());
                let i1 = (i0 + 1).min(nx - 1);
                let g = |i: usize, j: usize| coarse[j * nx + i] as f64;
                let (a, b, c, d) = (g(i0, j0), g(i1, j0), g(i0, j1), g(i1, j1));
                // Corners with no data at all fall back to the nearest finite neighbour.
                let base = bilinear(a, b, c, d, tx, ty);
                if base.is_finite() {
                    chm[row * w + col] = (v as f64 - base) as f32;
                }
            }
        }
        chm
    }

    fn bilinear(a: f64, b: f64, c: f64, d: f64, tx: f64, ty: f64) -> f64 {
        let pick = |v: f64, alt: [f64; 3]| {
            if v.is_finite() {
                v
            } else {
                alt.into_iter().find(|x| x.is_finite()).unwrap_or(f64::NAN)
            }
        };
        let a = pick(a, [b, c, d]);
        let b = pick(b, [a, d, c]);
        let c = pick(c, [a, d, b]);
        let d = pick(d, [b, c, a]);
        let top = a + (b - a) * tx;
        let bottom = c + (d - c) * tx;
        top + (bottom - top) * ty
    }

    /// Separable box blur that ignores NaN (nodata) instead of spreading it.
    fn box_blur(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
        if r == 0 {
            return src.to_vec();
        }
        let mut tmp = vec![f32::NAN; w * h];
        for row in 0..h {
            for col in 0..w {
                let (mut sum, mut n) = (0.0f64, 0u32);
                for c in col.saturating_sub(r)..=(col + r).min(w - 1) {
                    let v = src[row * w + c];
                    if v.is_finite() {
                        sum += v as f64;
                        n += 1;
                    }
                }
                if n > 0 {
                    tmp[row * w + col] = (sum / n as f64) as f32;
                }
            }
        }
        let mut out = vec![f32::NAN; w * h];
        for row in 0..h {
            for col in 0..w {
                let (mut sum, mut n) = (0.0f64, 0u32);
                for rr in row.saturating_sub(r)..=(row + r).min(h - 1) {
                    let v = tmp[rr * w + col];
                    if v.is_finite() {
                        sum += v as f64;
                        n += 1;
                    }
                }
                if n > 0 {
                    out[row * w + col] = (sum / n as f64) as f32;
                }
            }
        }
        out
    }

    struct Marker {
        idx: usize,
        height_m: f64,
    }

    /// Strict local maxima of the CHM, thinned to one per [`MIN_SPACING_M`] disc. Ties are
    /// broken by index and candidates are visited tallest-first, so the set is deterministic.
    fn local_maxima(chm: &[f32], w: usize, h: usize, px: f64, py: f64) -> Vec<Marker> {
        let rx = ((MIN_SPACING_M / 2.0) / px).round().max(1.0) as isize;
        let ry = ((MIN_SPACING_M / 2.0) / py).round().max(1.0) as isize;
        let mut cands: Vec<Marker> = Vec::new();
        for row in 0..h as isize {
            for col in 0..w as isize {
                let i = row as usize * w + col as usize;
                let v = chm[i];
                if !v.is_finite() || (v as f64) < MIN_HEIGHT_M {
                    continue;
                }
                let mut peak = true;
                'window: for r in (row - ry).max(0)..=(row + ry).min(h as isize - 1) {
                    for c in (col - rx).max(0)..=(col + rx).min(w as isize - 1) {
                        let j = r as usize * w + c as usize;
                        if j == i {
                            continue;
                        }
                        let u = chm[j];
                        if u.is_finite() && (u > v || (u == v && j < i)) {
                            peak = false;
                            break 'window;
                        }
                    }
                }
                if peak {
                    cands.push(Marker {
                        idx: i,
                        height_m: v as f64,
                    });
                }
            }
        }

        // Enforce the full spacing between accepted apexes (the window above only guarantees
        // half of it), tallest first so the dominant tree keeps its own maximum.
        cands.sort_by(|a, b| b.height_m.total_cmp(&a.height_m).then(a.idx.cmp(&b.idx)));
        let mut accepted: Vec<Marker> = Vec::with_capacity(cands.len());
        for m in cands {
            let (mr, mc) = ((m.idx / w) as f64, (m.idx % w) as f64);
            let clash = accepted.iter().any(|a| {
                let (ar, ac) = ((a.idx / w) as f64, (a.idx % w) as f64);
                ((ac - mc) * px).hypot((ar - mr) * py) < MIN_SPACING_M
            });
            if !clash {
                accepted.push(m);
            }
        }
        accepted.sort_by_key(|m| m.idx);
        accepted
    }

    struct Region {
        row: usize,
        col: usize,
        height_m: f64,
        radius_m: [f64; SECTORS],
    }

    /// Marker-controlled watershed: flood from every apex, always taking the highest pending
    /// pixel next, growing only downhill and only while the pixel stays above the crown floor.
    /// Each region's radial extent is recorded per angular sector as it grows.
    fn watershed(
        chm: &[f32],
        w: usize,
        h: usize,
        px: f64,
        py: f64,
        markers: &[Marker],
    ) -> Vec<Region> {
        let max_r = (MAX_CROWN_M2 / std::f64::consts::PI).sqrt();
        let mut labels = vec![UNLABELED; w * h];
        let mut regions: Vec<Region> = markers
            .iter()
            .map(|m| Region {
                row: m.idx / w,
                col: m.idx % w,
                height_m: m.height_m,
                radius_m: [0.0; SECTORS],
            })
            .collect();

        // (quantised height, tie-broken index, label): a max-heap pops the tallest pixel first.
        let mut heap: BinaryHeap<(i32, Reverse<usize>, usize)> = BinaryHeap::new();
        for (label, m) in markers.iter().enumerate() {
            heap.push((quant(chm[m.idx]), Reverse(m.idx), label));
        }
        while let Some((_, Reverse(idx), label)) = heap.pop() {
            if labels[idx] != UNLABELED {
                continue;
            }
            labels[idx] = label as i32;
            let (row, col) = (idx / w, idx % w);
            let region = &mut regions[label];
            let dx = (col as f64 - region.col as f64) * px;
            let dy = (region.row as f64 - row as f64) * py; // north-positive
            let r = dx.hypot(dy);
            if r > 0.0 {
                let mut ang = dy.atan2(dx);
                if ang < 0.0 {
                    ang += TAU;
                }
                let s = ((ang / TAU * SECTORS as f64) as usize).min(SECTORS - 1);
                if r > region.radius_m[s] {
                    region.radius_m[s] = r;
                }
            }
            let floor = (region.height_m * CROWN_FLOOR_FRAC).max(MIN_HEIGHT_M);
            let here = chm[idx];
            for (nr, nc) in [
                (row.wrapping_sub(1), col),
                (row + 1, col),
                (row, col.wrapping_sub(1)),
                (row, col + 1),
            ] {
                if nr >= h || nc >= w {
                    continue;
                }
                let n = nr * w + nc;
                if labels[n] != UNLABELED {
                    continue;
                }
                let v = chm[n];
                // Downhill only, above the crown floor, inside the largest legal crown.
                if !v.is_finite() || (v as f64) < floor || v > here + 1e-4 {
                    continue;
                }
                let ndx = (nc as f64 - region.col as f64) * px;
                let ndy = (region.row as f64 - nr as f64) * py;
                if ndx.hypot(ndy) > max_r {
                    continue;
                }
                heap.push((quant(v), Reverse(n), label));
            }
        }
        regions
    }

    fn quant(v: f32) -> i32 {
        if v.is_finite() {
            (v as f64 * 1000.0).clamp(i32::MIN as f64, i32::MAX as f64) as i32
        } else {
            i32::MIN
        }
    }

    /// Radial profile → a closed star-shaped ring (metric offsets from the apex). Sectors the
    /// flood never reached borrow their radius from the nearest sector that it did, so a partly
    /// occluded crown stays convex-ish instead of collapsing into a spike.
    fn profile_ring(radius_m: &[f64; SECTORS], half_px: f64) -> Vec<(f64, f64)> {
        let mut r = *radius_m;
        for s in 0..SECTORS {
            if r[s] > 0.0 {
                continue;
            }
            let mut found = half_px.max(1e-3);
            for d in 1..=SECTORS / 2 {
                let a = radius_m[(s + SECTORS - d) % SECTORS];
                let b = radius_m[(s + d) % SECTORS];
                let near = a.max(b);
                if near > 0.0 {
                    found = near;
                    break;
                }
            }
            r[s] = found;
        }
        (0..SECTORS)
            .map(|s| {
                let ang = (s as f64 + 0.5) * TAU / SECTORS as f64;
                let rad = r[s] + half_px / 2.0; // half a pixel outward: pixels have extent
                (rad * ang.cos(), rad * ang.sin())
            })
            .collect()
    }

    /// Area (m²) of a metric ring, shoelace.
    fn shoelace(ring: &[(f64, f64)]) -> f64 {
        let n = ring.len();
        if n < 3 {
            return 0.0;
        }
        let mut two_a = 0.0;
        for i in 0..n {
            let (x0, y0) = ring[i];
            let (x1, y1) = ring[(i + 1) % n];
            two_a += x0 * y1 - x1 * y0;
        }
        (two_a / 2.0).abs()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A 20 m × 20 m plot at 10 cm/px with four gaussian "trees" on a 5 m grid.
        fn synthetic_chm(w: usize, h: usize, px: f64, peaks: &[(f64, f64, f64)]) -> Vec<f32> {
            let mut v = vec![0.0f32; w * h];
            for row in 0..h {
                for col in 0..w {
                    let (x, y) = (col as f64 * px, row as f64 * px);
                    let mut z: f64 = 0.0;
                    for (cx, cy, hgt) in peaks {
                        let d2 = (x - cx).powi(2) + (y - cy).powi(2);
                        z = z.max(hgt * (-d2 / (2.0 * 1.2f64.powi(2))).exp());
                    }
                    v[row * w + col] = z as f32;
                }
            }
            v
        }

        #[test]
        fn finds_one_maximum_per_tree() {
            let (w, h, px) = (200, 200, 0.1);
            let peaks = [(5.0, 5.0, 4.0), (10.0, 5.0, 3.5), (5.0, 10.0, 5.0)];
            let chm = synthetic_chm(w, h, px, &peaks);
            let markers = local_maxima(&chm, w, h, px, px);
            assert_eq!(markers.len(), peaks.len(), "one apex per tree");
            for (cx, cy, _) in peaks {
                let hit = markers.iter().any(|m| {
                    let (r, c) = ((m.idx / w) as f64 * px, (m.idx % w) as f64 * px);
                    (c - cx).abs() < 0.2 && (r - cy).abs() < 0.2
                });
                assert!(hit, "no apex near ({cx}, {cy})");
            }
        }

        #[test]
        fn watershed_splits_touching_crowns() {
            let (w, h, px) = (200, 200, 0.1);
            let chm = synthetic_chm(w, h, px, &[(7.0, 10.0, 4.0), (11.0, 10.0, 4.0)]);
            let markers = local_maxima(&chm, w, h, px, px);
            assert_eq!(markers.len(), 2);
            let regions = watershed(&chm, w, h, px, px, &markers);
            for r in &regions {
                let ring = profile_ring(&r.radius_m, px);
                let area = shoelace(&ring);
                assert!(
                    (MIN_CROWN_M2..=MAX_CROWN_M2).contains(&area),
                    "crown area {area} outside the accepted range"
                );
                // Neither crown may swallow the 4 m gap to its neighbour.
                assert!(area < 20.0, "crown area {area} leaked into the neighbour");
            }
        }

        #[test]
        fn shoelace_measures_a_square() {
            let ring = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
            assert!((shoelace(&ring) - 4.0).abs() < 1e-9);
            assert_eq!(shoelace(&ring[..2]), 0.0);
        }

        #[test]
        fn score_is_bounded_and_monotonic() {
            assert_eq!(score_for(10.0), 1.0);
            assert_eq!(score_for(0.0), SCORE_FLOOR);
            assert!(score_for(1.5) < score_for(2.5));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crowns_are_drawn_for_trees_and_bushes_only() {
        assert_eq!(crown_radius_m("tree"), Some(SYNTH_CROWN_TREE_M));
        assert_eq!(crown_radius_m("bush"), Some(SYNTH_CROWN_TREE_M));
        assert_eq!(crown_radius_m("vine"), None);
        assert_eq!(crown_radius_m("row_segment"), None);
    }

    #[test]
    fn ring_geojson_needs_a_closed_ring() {
        assert_eq!(ring_geojson(&[]), None);
        assert_eq!(ring_geojson(&[(1.0, 2.0), (3.0, 4.0)]), None);
        let ring = [(1.0, 2.0), (3.0, 4.0), (5.0, 6.0), (1.0, 2.0)];
        let js = ring_geojson(&ring).unwrap();
        assert!(js.starts_with("{\"type\":\"Polygon\",\"coordinates\":[[[1.000000000,"));
        assert!(js.ends_with("]]}"));
        assert_eq!(js.matches('[').count(), 3 + ring.len() - 1);
    }
}
