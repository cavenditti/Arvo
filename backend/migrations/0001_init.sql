-- Arvo Tier-0 schema. Frozen: feature agents add NEW migrations in their band, never edit this file.
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE org_role AS ENUM ('viewer', 'operator', 'agronomist', 'admin', 'owner');
CREATE TYPE alert_state AS ENUM ('open', 'acked', 'snoozed', 'dismissed');

CREATE TABLE orgs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    password_hash text NOT NULL,
    full_name text NOT NULL DEFAULT '',
    locale text NOT NULL DEFAULT 'it',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE memberships (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    role org_role NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, org_id)
);

CREATE TABLE invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    email text NOT NULL,
    role org_role NOT NULL DEFAULT 'viewer',
    token text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE farms (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farms_org_idx ON farms (org_id);

CREATE TABLE parcels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    farm_id uuid NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name text NOT NULL,
    geom geometry(MultiPolygon, 4326) NOT NULL,
    crop text,
    variety text,
    planting_date date,
    season_year int,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcels_org_idx ON parcels (org_id);
CREATE INDEX parcels_geom_gix ON parcels USING gist (geom);

-- Public satellite scene catalog (not org-scoped: shared source data).
CREATE TABLE scenes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source text NOT NULL DEFAULT 'sentinel-2-l2a',
    stac_id text NOT NULL UNIQUE,
    acquired_at timestamptz NOT NULL,
    cloud_cover double precision,
    assets jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE index_observations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    scene_id uuid REFERENCES scenes(id) ON DELETE SET NULL,
    index_name text NOT NULL, -- ndvi|ndre|gndvi|ndmi|savi
    observed_at timestamptz NOT NULL,
    mean double precision NOT NULL,
    median double precision,
    p10 double precision,
    p90 double precision,
    stddev double precision,
    pixel_count int,
    cloud_pct double precision,
    source text NOT NULL DEFAULT 'sentinel-2', -- sentinel-2|demo
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (parcel_id, index_name, observed_at)
);
CREATE INDEX idxobs_series ON index_observations (parcel_id, index_name, observed_at);

CREATE TABLE weather_daily (
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    date date NOT NULL,
    t_min double precision,
    t_max double precision,
    t_mean double precision,
    precip_mm double precision,
    humidity_mean double precision,
    wind_max_kmh double precision,
    radiation_mj double precision,
    et0_mm double precision,
    is_forecast boolean NOT NULL DEFAULT false,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (parcel_id, date)
);

CREATE TABLE alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid REFERENCES parcels(id) ON DELETE CASCADE,
    kind text NOT NULL,     -- index_drop|frost_risk|heat_stress
    severity text NOT NULL, -- info|warning|critical
    title text NOT NULL,
    message text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}',
    state alert_state NOT NULL DEFAULT 'open',
    snoozed_until timestamptz,
    assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
    dedupe_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alerts_org_state_idx ON alerts (org_id, state, created_at DESC);
CREATE UNIQUE INDEX alerts_dedupe_key ON alerts (dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Scouting observations; id is CLIENT-generated (offline sync).
CREATE TABLE observations (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid REFERENCES parcels(id) ON DELETE SET NULL,
    author_id uuid NOT NULL REFERENCES users(id),
    lon double precision,
    lat double precision,
    note text NOT NULL DEFAULT '',
    tags text[] NOT NULL DEFAULT '{}',
    photos jsonb NOT NULL DEFAULT '[]', -- [{"path": "...", "taken_at": "..."}]
    taken_at timestamptz NOT NULL,
    deleted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX obs_org_updated_idx ON observations (org_id, updated_at);

-- Append-only audit trail (FR-0-004): mutations are blocked at the DB level.
CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    org_id uuid,
    user_id uuid,
    action text NOT NULL,
    entity text NOT NULL DEFAULT '',
    entity_id text NOT NULL DEFAULT '',
    data jsonb NOT NULL DEFAULT '{}',
    at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_org_idx ON audit_log (org_id, at DESC);

CREATE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only';
END $$;

CREATE TRIGGER audit_log_no_mutate
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
