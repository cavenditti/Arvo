-- A missing index is not evidence that work is still running. Persist the lifecycle of each
-- parcel's Sentinel refresh so clients can distinguish queued/running from empty/failed and can
-- stop animated progress after a server restart or provider failure.
CREATE TABLE parcel_imagery_refreshes (
    parcel_id uuid PRIMARY KEY REFERENCES parcels(id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'empty', 'failed')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    scenes_found int NOT NULL DEFAULT 0 CHECK (scenes_found >= 0),
    scenes_new int NOT NULL DEFAULT 0 CHECK (scenes_new >= 0),
    computed int NOT NULL DEFAULT 0 CHECK (computed >= 0),
    error_code text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX parcel_imagery_refreshes_state_idx
    ON parcel_imagery_refreshes (state, updated_at);

-- Existing parcels with observations are complete. A no-data legacy parcel cannot safely be
-- called "running": any in-memory task was lost by this deployment, so surface a retry instead.
INSERT INTO parcel_imagery_refreshes
    (parcel_id, state, requested_at, finished_at, computed, error_code, updated_at)
SELECT p.id,
       CASE WHEN EXISTS (
           SELECT 1 FROM index_observations i WHERE i.parcel_id = p.id
       ) THEN 'ready' ELSE 'failed' END,
       p.created_at,
       now(),
       (SELECT count(DISTINCT i.scene_id)::int
          FROM index_observations i
         WHERE i.parcel_id = p.id AND i.scene_id IS NOT NULL),
       CASE WHEN EXISTS (
           SELECT 1 FROM index_observations i WHERE i.parcel_id = p.id
       ) THEN NULL ELSE 'refresh_interrupted' END,
       now()
  FROM parcels p;
