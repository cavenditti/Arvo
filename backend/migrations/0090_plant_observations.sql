-- Phase P, band 0090 (be-extract): the per-plant metric time-series (FR-P-030/031).
--
-- P-MVP ships this as a PLAIN table — no TimescaleDB, no hypertable, no continuous aggregates
-- (docs/PHASE-PLANT.md §11 "P-MVP", docs/API-PLANT.md §Migrations). One flight of one block is
-- a few thousand rows; a btree carries that comfortably.
--
-- P-scale migration path (deliberately NOT done here, so the intent is not lost): the table is
-- already keyed on `observed_at` and written by an idempotent per-capture delete+insert, which
-- is exactly what makes the promotion additive and safe (no in-place UPDATE churn on cold
-- chunks). When the per-plant volume arrives (~63M rows/farm/season, NFR-P-SCALE):
--     CREATE EXTENSION IF NOT EXISTS timescaledb;
--     SELECT create_hypertable('plant_observations', 'observed_at',
--                              chunk_time_interval => INTERVAL '30 days', migrate_data => true);
--     -- then continuous aggregates plant→row→block→parcel + compression on cold chunks.
-- Nothing in the API or the worker changes: they only ever see a table.

CREATE TABLE plant_observations (
    plant_id    uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    capture_id  uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    -- Denormalized tenancy + parcel. The ranking, tile and rollup reads all filter on them and
    -- must not pay a join to `plants` per row (NFR-P-PERF), and org_id keeps the org filter on
    -- the observation row itself (every statement filters by org_id).
    org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id   uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    metric      text NOT NULL,
    observed_at timestamptz NOT NULL,  -- = captures.captured_at, so series align with flights
    value       double precision NOT NULL,
    quality     smallint,              -- 0..100: share of usable pixels in the sampling geometry
    model_ver   text,                  -- detector/extractor build (NFR-P-REPRO)
    PRIMARY KEY (plant_id, metric, observed_at),
    CONSTRAINT plant_obs_metric_check CHECK (metric IN
        ('ndvi', 'ndre', 'gndvi', 'ndmi', 'savi', 'canopy_m2', 'height_m')),
    CONSTRAINT plant_obs_quality_check CHECK (quality IS NULL OR quality BETWEEN 0 AND 100)
);

-- Hot read 1 — one plant's series for one metric (plant detail, growth curve, per-plant
-- temporal anomaly): served by the primary key, no extra index needed.
-- Hot read 2 — every plant of one capture for one metric (MVT tiles, weakest-N ranking, the
-- parcel rollup): this is the tile/ranking query.
CREATE INDEX plant_obs_capture_metric_idx ON plant_observations (capture_id, metric);
-- Hot read 3 — "latest value per plant for a parcel+metric": resolving `capture=latest` and
-- the parcel-wide p5/p95 colour scale both start here.
CREATE INDEX plant_obs_parcel_metric_time_idx
    ON plant_observations (parcel_id, metric, observed_at DESC);
-- Hot read 4 — one plant across metrics, newest first (`GET /plants/{id}/captures`,
-- `/metrics/latest`); the PK cannot answer it because `metric` precedes `observed_at`.
CREATE INDEX plant_obs_plant_time_idx ON plant_observations (plant_id, observed_at DESC);

-- org_id is deliberately left un-indexed: it is a filter companion, never a lead column, and an
-- org delete cascades through plants/parcels (both indexed) anyway.

COMMENT ON TABLE plant_observations IS
    'Per-plant, per-metric time-series (FR-P-031). Plain table in P-MVP; promote to a '
    'TimescaleDB hypertable on observed_at in P-scale (see 0090_plant_observations.sql).';
