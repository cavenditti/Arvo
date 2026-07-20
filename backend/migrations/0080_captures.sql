-- Phase P band 0080–0089 (be-capture): the capture (drone flight) lifecycle.
-- Additive only. Depends on 0070 for the `plant_unit` enum and the `plants` table.
--
-- Contract: docs/API-PLANT.md §Captures, §"Storage layout", §"Pipeline stages".
-- Raster bytes never live here (NFR-P-STORE) — `capture_assets.path` is a store key
-- (`captures/{id}/ortho.tif`), resolved against STORE_DIR by the API and the worker.

-- One flight, or one pre-built ortho drop, or one synthetic `demo` capture (CI / seed).
-- `status` is the milestone reached; the unit of work is `pipeline_jobs.stage`.
CREATE TABLE captures (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    captured_at timestamptz NOT NULL,
    source text NOT NULL DEFAULT 'drone'
        CHECK (source IN ('drone', 'prebuilt', 'demo')),
    status text NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded', 'ortho', 'detected', 'registered', 'extracted', 'failed')),
    unit_type plant_unit NOT NULL DEFAULT 'tree',
    sensor text,
    gsd_cm double precision,
    -- reflectance band name → 1-based band index in ortho.tif, e.g. {"red":1,"nir":4}
    bands jsonb NOT NULL DEFAULT '{}',
    -- EASA flight metadata (NFR-P-OPS): the software records the flight, it does not fly.
    pilot_name text,
    operator_id text,
    drone_model text,
    flight_ref text,
    notes text,
    failed_stage text,
    error text,
    -- Written by the pipeline once the ortho footprint is known; drives "expected but absent".
    bbox geometry(Polygon, 4326),
    plant_count int NOT NULL DEFAULT 0,
    observation_count int NOT NULL DEFAULT 0,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    processed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX captures_parcel_idx ON captures (parcel_id, captured_at DESC);
CREATE INDEX captures_org_status_idx ON captures (org_id, status);

-- Uploaded/produced file manifest. Bytes live on disk under STORE_DIR + `path`.
CREATE TABLE capture_assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('raw', 'ortho', 'dsm')),
    path text NOT NULL,           -- store key, never an absolute path and never a URL
    file_name text NOT NULL,      -- sanitized original name ([A-Za-z0-9._-])
    bytes bigint NOT NULL DEFAULT 0,
    content_type text,
    checksum text,                -- sha256 hex of the stored bytes
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX capture_assets_capture_idx ON capture_assets (capture_id, kind);
-- `raw` appends (one row per photo); ortho/dsm are exactly one per capture and replace.
CREATE UNIQUE INDEX capture_assets_single_idx ON capture_assets (capture_id, kind)
    WHERE kind IN ('ortho', 'dsm');

-- The durable state machine. Exactly one row per (capture, stage), re-used across retries.
CREATE TABLE pipeline_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    stage text NOT NULL CHECK (stage IN ('sfm', 'detect', 'register', 'extract')),
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 3,
    run_after timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    error text,
    worker_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (capture_id, stage)
);
-- The worker's claim query: WHERE state='queued' AND run_after <= now()
--                           ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1
CREATE INDEX pipeline_jobs_poll_idx ON pipeline_jobs (state, run_after, created_at);
-- The startup sweep: WHERE state='running' AND started_at < now() - interval '2 hours'.
CREATE INDEX pipeline_jobs_running_idx ON pipeline_jobs (started_at) WHERE state = 'running';

-- Raw detector output for one capture, before registration assigns stable plant ids.
-- Kept (not folded into `plants`) so a detection run is auditable and re-runnable.
CREATE TABLE plant_detections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    plant_id uuid REFERENCES plants(id) ON DELETE SET NULL,
    geom geometry(Point, 4326) NOT NULL,       -- crown centroid
    crown_geom geometry(Polygon, 4326),        -- null for vine / row_segment points
    score double precision,                    -- 0..1 detector confidence
    height_m double precision,                 -- crown max CHM
    canopy_m2 double precision,
    match_dist_m double precision,
    match_kind text CHECK (match_kind IN ('matched', 'created')),
    model_ver text NOT NULL,                   -- "<detector>-<semver>" (NFR-P-REPRO)
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plant_detections_capture_idx ON plant_detections (capture_id);
CREATE INDEX plant_detections_geom_gix ON plant_detections USING gist (geom);
CREATE INDEX plant_detections_plant_idx ON plant_detections (plant_id)
    WHERE plant_id IS NOT NULL;
