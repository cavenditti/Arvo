-- Phase P band 0070 (be-plants) — the crop-agnostic plant tier.
-- Contract: docs/API-PLANT.md §Plants, §"Blocks & rows", §Migrations. Additive only: nothing in
-- 0001/0002 is touched. Plants hang off `parcels`, so the org→farm→parcel tenancy spine and its
-- delete cascades carry over unchanged — `org_id` is denormalized onto every row so each query
-- can filter by the token's org without a join (the rule every module enforces).

-- One entity serves orchard / vineyard / horticulture (PHASE-PLANT §3): only the detector and the
-- extraction geometry differ per unit, never the schema, API or UI.
CREATE TYPE plant_unit AS ENUM ('tree', 'vine', 'row_segment', 'bush');

-- Lifecycle per FR-P-003. 'removed' is the *soft-delete terminal state*: rows are never physically
-- deleted, so a removed plant keeps its id, its observation series and its scouting history
-- (P-MVP has no hard delete). Reads exclude it unless explicitly requested.
CREATE TYPE plant_status AS ENUM ('alive', 'dead', 'missing', 'replanted', 'removed');

-- Optional grouping inside a parcel (FR-P-005) — a parcel may carry a flat plant set, hence both
-- `plants.block_id` and `plants.row_id` are nullable and both FKs are ON DELETE SET NULL: dropping
-- a grouping must never take the plants (and their history) with it.
--
-- geom is MultiPolygon so a block drawn as a Polygon and one drawn as a MultiPolygon land in the
-- same column (ST_Multi on write) — identical rule to parcels.geom.
CREATE TABLE plant_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    name text NOT NULL,
    geom geometry(MultiPolygon, 4326),
    notes text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plant_blocks_parcel_idx ON plant_blocks (parcel_id);
CREATE INDEX plant_blocks_org_idx ON plant_blocks (org_id);
CREATE INDEX plant_blocks_geom_gix ON plant_blocks USING gist (geom);
-- Import matches the `block` property by *name*, case-insensitively inside the parcel, and creates
-- the block when absent. Making that lookup key unique is what stops a re-imported as-planted map
-- (or two concurrent imports) from silently forking "Blocco A" into two blocks.
CREATE UNIQUE INDEX plant_blocks_parcel_name_key ON plant_blocks (parcel_id, lower(name));

-- Rows are deliberately NOT unique by name: two blocks in one parcel legitimately both contain a
-- row called "1". The index is a lookup index only (import resolves name → id through it, taking
-- the lowest id on a tie so repeated imports stay deterministic).
CREATE TABLE plant_rows (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    block_id uuid REFERENCES plant_blocks(id) ON DELETE SET NULL,
    name text NOT NULL,
    row_index int,
    geom geometry(LineString, 4326),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plant_rows_parcel_idx ON plant_rows (parcel_id);
CREATE INDEX plant_rows_org_idx ON plant_rows (org_id);
CREATE INDEX plant_rows_block_idx ON plant_rows (block_id);
CREATE INDEX plant_rows_geom_gix ON plant_rows USING gist (geom);
CREATE INDEX plant_rows_parcel_name_idx ON plant_rows (parcel_id, lower(name));

-- The plant itself. `geom` is the identity point (segment midpoint for row_segment) and is what
-- registration matches against across flights — it is never moved by the pipeline, so the id stays
-- stable (FR-P-003). `crown_geom` is the delineated canopy the extractor samples inside; it is
-- refreshed every capture and is null for vine/row_segment points.
CREATE TABLE plants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    block_id uuid REFERENCES plant_blocks(id) ON DELETE SET NULL,
    row_id uuid REFERENCES plant_rows(id) ON DELETE SET NULL,
    unit_type plant_unit NOT NULL DEFAULT 'tree',
    geom geometry(Point, 4326) NOT NULL,
    crown_geom geometry(Polygon, 4326),
    label text,
    row_index int,
    col_index int,
    variety text,
    rootstock text,
    planted_on date,
    status plant_status NOT NULL DEFAULT 'alive',
    external_ref text,
    -- How the row came to exist; immutable after creation (PATCH refuses it), because it is the
    -- provenance the registration step reasons about.
    source text NOT NULL DEFAULT 'detection' CHECK (source IN ('detection', 'manual', 'import')),
    -- Consecutive captures covering this plant that produced no detection. `register` increments
    -- it, a match resets it to 0, and 2 flips status to 'missing' — so one bad flight can never
    -- condemn a plant. Reported as ReplantEntry.captures_absent.
    missing_streak int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plants_parcel_idx ON plants (parcel_id);
CREATE INDEX plants_org_idx ON plants (org_id);
-- Spatial: MVT tiles (ST_AsMVT over a tile envelope) and the neighbour-anomaly KNN both live here.
CREATE INDEX plants_geom_gix ON plants USING gist (geom);
CREATE INDEX plants_status_idx ON plants (parcel_id, status);
CREATE INDEX plants_block_idx ON plants (block_id);
CREATE INDEX plants_row_idx ON plants (row_id);
-- The paginated list is ordered `row_index NULLS LAST, col_index NULLS LAST, id` and is expected to
-- page through tens of thousands of rows per parcel; matching the index to the sort keeps a deep
-- OFFSET an index scan instead of a full sort of the parcel.
CREATE INDEX plants_parcel_order_idx
    ON plants (parcel_id, row_index NULLS LAST, col_index NULLS LAST, id);
-- The grower's own tag is the upsert key for as-planted (re-)imports; partial so the (many) plants
-- created by detection, which have no tag, do not collide on NULL.
CREATE UNIQUE INDEX plants_parcel_extref_key
    ON plants (parcel_id, external_ref) WHERE external_ref IS NOT NULL;
