-- Production-hardening pass (2026-07-18).
--
-- 1) Server-side sync cursor. The offline pull cursor must be a server clock: client
--    `updated_at` stamps are wall clocks, and a device running 2h behind would make its rows
--    permanently invisible to teammates whose `last_pulled_at` is already newer.
--    Existing rows get `now()`, which forces one harmless full re-pull per client
--    (the LWW merge is idempotent) instead of trusting historical client stamps.
ALTER TABLE observations
    ADD COLUMN server_updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX obs_org_server_updated_idx ON observations (org_id, server_updated_at);

-- 2) Scene footprint + processing metadata (imagery correctness).
--    bbox lets GET /parcels/{id}/scenes return scenes that actually cover the parcel instead
--    of the global catalog; NULL (pre-existing rows) is treated as "unknown, include" until
--    the next refresh backfills it. boa_offset_applied records the Earth Search
--    harmonization flag so reflectance conversion never double-applies the -1000 offset.
ALTER TABLE scenes
    ADD COLUMN bbox geometry(Polygon, 4326),
    ADD COLUMN boa_offset_applied boolean;
CREATE INDEX scenes_bbox_gix ON scenes USING gist (bbox);
CREATE INDEX scenes_acquired_idx ON scenes (acquired_at DESC);

-- 2b) Provenance for weather rows: the demo seed generates synthetic weather, and a re-run
--     while offline must never overwrite previously-fetched real Open-Meteo rows with
--     synthetic ones. Pre-existing rows are grandfathered as 'open-meteo' (the seed's
--     synthetic rows are indistinguishable retroactively; real refreshes overwrite anyway).
ALTER TABLE weather_daily
    ADD COLUMN source text NOT NULL DEFAULT 'open-meteo';

-- 3) audit_log append-only: row triggers don't fire on TRUNCATE; close that hole.
CREATE TRIGGER audit_log_no_truncate
    BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();

-- 4) Enum-ish text columns get real constraints so one bad insert can't silently break
--    app-side matching. (alerts.kind stays open: Tier-A intervention kinds will extend it.)
ALTER TABLE alerts
    ADD CONSTRAINT alerts_severity_check CHECK (severity IN ('info', 'warning', 'critical'));
ALTER TABLE index_observations
    ADD CONSTRAINT idxobs_index_name_check
    CHECK (index_name IN ('ndvi', 'ndre', 'gndvi', 'ndmi', 'savi'));

-- 5) FK indexes for hot paths and cascades (parcel/farm/scene deletes, member lists).
CREATE INDEX alerts_parcel_idx ON alerts (parcel_id);
CREATE INDEX idxobs_scene_idx ON index_observations (scene_id);
CREATE INDEX obs_parcel_idx ON observations (parcel_id);
CREATE INDEX parcels_farm_idx ON parcels (farm_id);
CREATE INDEX invites_org_idx ON invites (org_id);
CREATE INDEX memberships_org_idx ON memberships (org_id);

-- 6) idxobs_series duplicated the UNIQUE (parcel_id, index_name, observed_at) constraint's
--    implicit index column-for-column; drop the redundant copy.
DROP INDEX idxobs_series;
