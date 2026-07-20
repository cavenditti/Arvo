# Phase P — Per-plant analytics tier (design)

> **Status (2026-07-19): design, not built.** This extends the shipped Tier-0 (`docs/PHASE0.md`)
> *downward* — a new spatial granularity **below `parcel`**: the individual plant. It is additive and
> independently shippable; it does **not** block or depend on the Tier A/B/C actuation roadmap. (It
> *strengthens* Tier B later: per-plant vigor → variable-rate prescriptions.)

Target: analytics on **individual plants** (orchard trees, vineyard vines, row-crop segments),
scaling to **tens of thousands of plants per farm**, fed by **own-drone cm-scale imagery processed
with self-hosted Structure-from-Motion**. Sentinel-2 stays as the cheap whole-parcel trend layer;
drone captures are the per-plant layer.

---

## 0. Why this is a new tier, not a feature

Two assumptions the Tier-0 build rests on both break at plant scale:

1. **Imagery = Sentinel-2 @ 10 m/px, finest object = parcel.** `imagery/worker.rs` resamples to a
   10 m grid and emits *one* aggregate stats row per index per scene per parcel. **10 m cannot see a
   plant** (a vine sits on 1–2 m spacing; one S2 pixel blends dozens). Per-plant is gated on a new
   **cm-scale sensing layer**, not on more SQL.
2. **One `index_observations` row per parcel.** Per-plant multiplies row count by the plant count
   (~10³–10⁴×). The plain PostGIS btree table will not carry it (see §5, NFR-P-SCALE).

Everything else in Tier-0 — the org→farm→parcel spine, JWT org-scoping, RBAC lattice, audit log,
`core/` agronomy math, the alert lifecycle, and the offline scouting sync — **extends cleanly** and
is reused, not rebuilt (§10).

---

## 1. Stack (additions to Tier-0)

| Layer | Choice | Why |
|-------|--------|-----|
| Object store | MinIO (S3-compatible), COGs | Orthomosaics/DSMs are GB-scale; never in the DB. Spec §5.2 already assumes S3-compatible. Closes PHASE0 deviation #7 (local-disk uploads). |
| SfM / photogrammetry | OpenDroneMap (ODM), containerised, invoked by the worker | Own-drone path: raw photos → orthomosaic + DSM. Self-hostable, open, reproducible. |
| Pipeline worker | new crate `crates/worker` → `arvo-worker` binary; Postgres-backed job table | Durable multi-stage state machine. Lean MVP; **Temporal is the P1 upgrade** (same exit path as PHASE0 deviation #5). |
| Plant detection | Python microservice `services/plant-detect` (HTTP/gRPC), GPU-optional | Classical CV baseline (label-free), ML models behind the same interface. Kept out of the Rust binary. |
| Time-series | **TimescaleDB** extension on the same PostGIS instance; hypertable + continuous aggregates | The per-plant row volume needs partitioning + rollups from day one (§5). |
| Map (plant layer) | **MapLibre GL** (`maplibre-gl` web / `@maplibre/maplibre-react-native`) consuming **MVT** | Leaflet+markers dies at ~1–2k features; WebGL + vector tiles draw 10⁴ points. Runs *alongside* the existing Leaflet parcel map, not replacing it. |
| Tiles | `ST_AsMVT` served from the API (media-token auth, like existing raster tiles) | Reuses the Tier-0 tile-auth pattern; no new tile server process. |

Everything else is unchanged: Rust axum 0.8 + sqlx 0.8 (runtime queries, **no macros**), PostGIS,
Expo SDK 57, react-query, i18next it-first, media tokens, REST v1.

---

## 2. Repo layout (additions)

```
backend/
  crates/
    core/src/
      registration.rs    # pure: detection↔plant spatial assignment (unit-tested)
      plant_metrics.rs    # pure: per-plant stats from sampled pixel buffers
      plant_anomaly.rs    # pure: neighbor-relative outlier detection (unit-tested)
    worker/               # NEW crate: arvo-worker binary (pipeline state machine)
      src/{main,pipeline,sfm,detect,extract,rollup}.rs
    api/src/
      modules/{plants,captures,plant_insights,plant_tiles}.rs
      storage/mod.rs       # S3/MinIO client (put/get/presign COGs)
  migrations/              # NEW bands (§5) — additive, never edit frozen 0001/0002
services/
  plant-detect/           # Python detection microservice (Dockerfile, models, tests)
app/src/
  app/plant/[id].tsx (+ .web.tsx)     # plant detail
  app/capture/new.tsx                  # flight upload + status
  components/PlantMap.native.tsx / .web.tsx / .d.ts   # WebGL plant layer (Metro .d.ts shim)
  features/plants/*                    # hooks, ranking, color scales
infra/
  docker-compose.yml       # += minio, odm (job image), plant-detect, timescale flag
```

---

## 3. Crop-agnostic model (tree · vine · row-crop)

The plant tier is **one entity** (`plants.unit_type`) so orchard, vineyard, and horticulture share the
schema, API, and UI. Only detection + the extraction unit diverge:

| unit_type | Layout | Detection method | Extraction unit | "Per-plant" means |
|-----------|--------|------------------|-----------------|-------------------|
| `tree` | crowns on a grid | DSM local-maxima + watershed crown delineation (label-free baseline) | crown polygon | one tree |
| `vine` | trellised rows, 1–2 m spacing | row-line detection → regular point placement along the row | point + fixed buffer | one vine **or** row-segment (config) |
| `row_segment` | continuous beds/rows | tile the row into fixed-length segments | segment polygon | a length of row / a bed cell |
| `bush` | discrete shrubs | crown delineation (as `tree`) | crown polygon | one bush |

The build is crop-agnostic; **orchard `tree` is the recommended first proof** (discrete crowns, the
cleanest detection + the cleanest "per-plant" semantics). `vine`/`row_segment` reuse the same tables
and endpoints with a different detector and extraction geometry.

---

## 4. Traceability — Phase-P functional requirements

**Tenancy & entity**
- **FR-P-001 (M):** Plant tier extends org→farm→parcel with an additive plant layer (blocks, rows,
  plants); every row is org-scoped; no cross-tenant access (same rule as FR-0-001).
- **FR-P-002 (M):** Plants are crop-agnostic units (`unit_type ∈ tree|vine|row_segment|bush`); one
  schema/API/UI serves orchard, vineyard, horticulture (§3).
- **FR-P-003 (M):** Stable plant identity across captures and seasons; status lifecycle
  `alive → dead|missing → replanted|removed`.
- **FR-P-004 (S):** Plants creatable by detection, manual map placement/edit, or import (GeoJSON/CSV
  point set, e.g. an as-planted map).
- **FR-P-005 (S):** Optional block/row grouping within a parcel; a plant may belong to a row and/or block.

**Capture & self-hosted SfM**
- **FR-P-010 (M):** Register a capture (drone flight): parcel, captured_at, sensor, GSD; upload raw
  imagery to the object store; record EASA flight metadata (NFR-P-OPS).
- **FR-P-011 (M):** Build orthomosaic + DSM (canopy height) from raw photos via self-hosted ODM;
  write both as COGs to the object store.
- **FR-P-012 (M):** The pipeline is a durable, resumable state machine
  (`uploaded → ortho → detected → registered → extracted`); each stage idempotent; failures retried
  and surfaced.
- **FR-P-013 (S):** Quality gate: reject/flag captures with insufficient overlap, GSD, or coverage
  of the parcel.
- **FR-P-014 (S):** Accept a **pre-built** orthomosaic/DSM (vendor path), skipping SfM — keeps the
  sensing choice swappable without touching downstream stages.

**Detection & registration**
- **FR-P-020 (M):** Detect plants from the capture per `unit_type` (crown delineation / row-following
  point placement / segment tiling).
- **FR-P-021 (M):** Register detections to existing plants (spatial nearest-neighbour + assignment) so
  ids are stable across flights; unmatched detections → new plant; expected-but-absent → missing.
- **FR-P-022 (S):** Flag missing/dead plants (absent where expected, or collapsed canopy/vigor).
- **FR-P-023 (S):** Detector is pluggable behind one interface: classical CV (DSM maxima + watershed,
  **no training labels**) as the baseline; instance-segmentation ML models later, same contract.

**Extraction & time-series**
- **FR-P-030 (M):** Extract per-plant metrics from the capture: per-plant index stats (NDVI, NDRE,
  GNDVI, NDMI, SAVI within the crown), canopy area (m²), height (DSM percentile). Reuses
  `core::indices` formulas.
- **FR-P-031 (M):** Per-plant, per-metric time-series with capture lineage + quality flags +
  detector/model version stamp (NFR-P-REPRO).
- **FR-P-032 (M):** Roll plant metrics up row → block → parcel; **the parcel rollup feeds the existing
  `index_observations`** so the Tier-0 dashboard, series, and anomaly loop keep working unchanged.
- **FR-P-033 (M):** The time-series store sustains the per-plant row volume (hypertable + continuous
  aggregates + compression) — see NFR-P-SCALE.

**Analytics**
- **FR-P-040 (M):** Neighbour-relative anomaly — flag a plant diverging from its row/block neighbours
  (robust z-score), distinct from a temporal drop. New pure fn `core::plant_anomaly`.
- **FR-P-041 (S):** Temporal per-plant drop — reuse the Tier-0 trailing-baseline detector
  (`core::anomaly`, already pure over a series) per plant.
- **FR-P-042 (M):** Ranking queries — "N lowest-vigor plants in block X", ranked + paginated.
- **FR-P-043 (S):** Replant list — missing/dead plants per block, exportable (CSV/GeoJSON).
- **FR-P-044 (C):** Growth curves — canopy-area/height trajectory per plant/block over captures.
- **FR-P-045 (W→C):** Fruit counting / per-plant yield estimate (ML; a later increment).

**Serving & visualisation**
- **FR-P-050 (M):** MVT endpoint serving a parcel's plant points + latest selected metric; media-token
  auth; org-scoped; cross-tenant → 404.
- **FR-P-051 (M):** WebGL plant map (MapLibre GL) in app + portal: 10⁴ points, colour-by-metric,
  cluster at low zoom, tap → plant. Runs alongside the Leaflet parcel map.
- **FR-P-052 (M):** Plant detail: identity, status, per-metric series, its captures, scouting.
- **FR-P-053 (S):** Orthomosaic/DSM overlay tiles from the capture COGs (reuses the raster-tile path).

**Scouting & reporting**
- **FR-P-060 (M):** Per-plant scouting — pin an offline observation to a plant via an optional
  `plant_id` on the existing sync protocol (no new protocol; extends `docs/API.md §Observations`).
- **FR-P-061 (M):** Plant-level alerts reuse the alert lifecycle (ack/snooze/assign/dismiss + dedupe);
  kinds `plant_vigor_outlier | plant_missing | plant_dead | plant_drop`.
- **FR-P-062 (S):** Block/parcel plant-health report (weakest-N, replant list, uniformity) as
  printable HTML/PDF (reuses the Tier-0 report path).

---

## 5. Data model (new migration bands — additive)

Existing bands stop at scouting (0060–0069). **New bands** (rule from `docs/AGENTS.md`: additive
only, never edit `0001`/`0002`):

| Band | Agent | Adds |
|------|-------|------|
| 0070–0079 | be-plants | `plant_blocks`, `plant_rows`, `plants` |
| 0080–0089 | be-capture | `captures`, `capture_assets`, `pipeline_jobs`; `plant_detections` |
| 0090–0099 | be-extract | `plant_observations` (**Timescale hypertable**) + continuous aggregates |
| 0100–0109 | be-plant-insights | `ALTER alerts ADD plant_id` + plant alert kinds |
| 0110–0119 | be-scouting (extension) | `ALTER observations ADD plant_id` (+ sync field) |

Core shapes (indicative; agents finalise columns):

```sql
-- 0070: crop-agnostic plant tier
CREATE TYPE plant_unit AS ENUM ('tree','vine','row_segment','bush');
CREATE TYPE plant_status AS ENUM ('alive','dead','missing','replanted','removed');

CREATE TABLE plants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    block_id uuid REFERENCES plant_blocks(id) ON DELETE SET NULL,
    row_id uuid REFERENCES plant_rows(id) ON DELETE SET NULL,
    unit_type plant_unit NOT NULL,
    geom geometry(Point, 4326) NOT NULL,          -- location (segment midpoint for row_segment)
    crown_geom geometry(Polygon, 4326),            -- delineated canopy footprint (null for vine points)
    label text,                                    -- human "R12-P34"
    row_index int, col_index int,                  -- grid position (nullable)
    variety text, rootstock text,
    planted_on date,
    status plant_status NOT NULL DEFAULT 'alive',
    external_ref text,                             -- grower's own tag
    source text NOT NULL DEFAULT 'detection',      -- detection|manual|import
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX plants_parcel_idx ON plants (parcel_id);
CREATE INDEX plants_org_idx ON plants (org_id);
CREATE INDEX plants_geom_gix ON plants USING gist (geom);
CREATE INDEX plants_status_idx ON plants (parcel_id, status);

-- 0090: the scale table — Timescale hypertable on observed_at, rolled up by continuous aggregate
CREATE TABLE plant_observations (
    plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
    capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    metric text NOT NULL,       -- ndvi|ndre|gndvi|ndmi|savi|canopy_m2|height_m
    observed_at timestamptz NOT NULL,
    value double precision NOT NULL,
    quality smallint,           -- 0..100; cloud/shadow/edge flags packed
    model_ver text,             -- detector/extractor version (NFR-P-REPRO)
    PRIMARY KEY (plant_id, metric, observed_at)
);
SELECT create_hypertable('plant_observations', 'observed_at', chunk_time_interval => INTERVAL '30 days');
-- continuous aggregate → per parcel/metric/day; a downstream job upserts these into
-- index_observations so the Tier-0 loop (series/anomaly/report) needs zero changes.
```

**Scale — the "tens of thousands" math (NFR-P-SCALE, M):**

> 30,000 plants × 7 metrics × ~weekly capture × ~30-week season ≈ **~63 M rows / farm / season**,
> before fruit counts. 100 farms → **~6 B rows/year.** A plain btree table won't hold it.
> → Timescale hypertable (time+space chunks) + **continuous aggregates** (plant→row→block→parcel) +
> native compression on cold chunks. Raster/DSM bytes live in the object store (NFR-P-STORE), **never**
> in the DB — the DB stores plant vectors + scalar metrics only.

---

## 6. Pipeline (own-drone, self-hosted SfM)

```
flight (own drone)
  → POST /captures  (register) + upload raw photos → MinIO  s3://captures/{id}/raw/
  → pipeline_jobs: state machine, driven by arvo-worker
      1. sfm      (ODM)      raw → ortho.tif (COG) + dsm.tif (COG) in MinIO
      2. detect   (service)  ortho+dsm → plant_detections (points/crowns) per unit_type
      3. register (core)     detections ↔ existing plants (spatial NN + assignment) → stable ids
      4. extract  (core)     sample ortho/dsm per crown → plant_observations (per metric)
      5. rollup              continuous-aggregate refresh → upsert parcel index_observations
  each stage idempotent + resumable; failure surfaced on the capture; retried with backoff
```

- **Orchestration:** MVP = `pipeline_jobs` table + `arvo-worker` polling loop (durable, lean).
  **P1 = Temporal** (same exit path as PHASE0 deviation #5) once stages fan out / need signals.
- **GPU:** detection service is GPU-optional (classical CV baseline is CPU-only). ODM is CPU-heavy;
  a GPU accelerates some steps but isn't required for the MVP.
- **Reproducibility (NFR-P-REPRO):** every `plant_observations` row stamps `capture_id` + `model_ver`;
  source photos → ortho → detection → metric is fully traceable (extends NFR-DAT-012).

---

## 7. Non-functional requirements (Phase-P)

- **NFR-P-SCALE (M):** ≥10⁷ plant-observations / farm-season and ≥10⁹ platform-wide/year with **no
  architectural change** → hypertable + continuous aggregates + compression (§5).
- **NFR-P-PERF (M):** plant MVT tile p95 < 300 ms at 30k plants/parcel; weakest-N query p95 < 300 ms;
  capture processing (`uploaded → extracted`) within an operational SLA (target ≤ a few hours/flight).
- **NFR-P-STORE (M):** orthomosaics/DSMs/raw photos as COGs in S3-compatible object store; DB holds
  vectors + metrics only.
- **NFR-P-OPS (M):** own-drone operations run under EASA Open/Specific-category (operator
  registration, pilot competency, insurance) — tracked operationally per NFR-CMP-050; the software
  records flight metadata but does not fly.
- **NFR-P-COST (S):** track marginal cost per **plant-season** (flight ops + SfM compute + storage)
  against SMB pricing (extends NFR-COST-011).
- **NFR-P-SEC (M):** capture uploads + COG tiles use the existing media-token + org-check pattern;
  raw imagery is never publicly served (same rule as `/uploads`).

---

## 8. Build workstreams (the agent horde — frozen ownership)

Same contract as `docs/AGENTS.md`: touch only owned files; shared spine read-only; new migrations in
your band; runtime sqlx only; `org_id` from token; audit every mutation; media-token auth on media.

| Agent | Owns (create/edit) | Band |
|-------|--------------------|------|
| be-plants | `modules/plants.rs`, migration 0070–0079 | 0070–0079 |
| be-capture | `modules/captures.rs`, `storage/mod.rs`, migration 0080–0089 | 0080–0089 |
| be-sfm | `crates/worker/*` (arvo-worker: pipeline, sfm/ODM invocation) | — |
| be-detect | `worker/detect.rs`, `core/src/registration.rs`, `services/plant-detect/*` | — |
| be-extract | `worker/extract.rs`, `core/src/plant_metrics.rs`, migration 0090–0099 | 0090–0099 |
| be-plant-insights | `modules/plant_insights.rs`, `core/src/plant_anomaly.rs`, migration 0100–0109 | 0100–0109 |
| be-plant-tiles | `modules/plant_tiles.rs` (`ST_AsMVT`) | — |
| be-scouting (ext) | `observations` `plant_id` column + sync field | 0110–0119 |
| fe-plant-map | `components/PlantMap.{native,web}.tsx` + `.d.ts`, `app/(tabs)` plant map route, `features/plants/*` | — |
| fe-plant-detail | `app/plant/[id].tsx` (+`.web.tsx`) | — |
| fe-capture | `app/capture/new.tsx`, capture-status UI | — |
| integrate-backend | worker wiring, compose (minio/odm/detect/timescale), seed `--demo-plants`, smoke steps | any backend |
| integrate-app | tsc clean, web export, MapLibre wiring, API alignment | any app |

**Frozen additions the spine owner makes** (not feature agents): `PlantMap` contract in
`src/components/types.ts`; new plant/capture types in `src/api/types.ts`; route mounts in
`routes.rs`; `arvo-worker` in the workspace `Cargo.toml`.

**App gotchas to honour** (from memory / `docs/DESIGN.md`): `PlantMap.d.ts` type-only shim so Metro
picks `.web`/`.native` (not a plain `.ts`); Terra design language is authoritative — **no state dots
/ no left-border accents**, fonts are family tokens (never `fontWeight`); i18n keys in **both**
`it.json` + `en.json`, Italian primary.

---

## 9. Acceptance (extends `scripts/smoke.sh`)

New steps (all org-scoped, network-tolerant where external): register capture → upload raw (or a
pre-built ortho **fixture** for CI, per FR-P-014) → run worker to `extracted` → plants exist for the
parcel → `plant_observations` exist → weakest-N returns ranked plants → MVT tile 200 (media token;
session-JWT-in-query rejected) → neighbour-anomaly produces a `plant_vigor_outlier` alert →
per-plant scouting pin round-trips through sync → parcel rollup matches the mean of its plants →
**cross-tenant: second org gets 404 on first org's plant / capture / tile**.

Seed: `arvo-api seed --demo-plants` synthesises one orchard block (~a few hundred `tree` plants on a
grid) with a plausible vigor field + a **cluster of low-vigor + one missing plant** so neighbour
anomaly and the replant list have something to find (mirrors the Tier-0 injected-NDVI-dip pattern).

---

## 10. Seams — what plugs into Tier-0 (reused, not rebuilt)

- **Tenancy spine** (org→farm→parcel, `AuthUser`, RBAC lattice, audit) → plants hang off `parcel_id`,
  same `org_id`-from-token rule, same `audit::record` on every mutation.
- **`core/` agronomy** (`indices`, GDD/ET0) → same formulas, applied per plant.
- **`core::anomaly`** (pure, trailing baseline) → runs per plant for FR-P-041 with zero changes.
- **Alert lifecycle** (`modules/alerts.rs`: ack/snooze/assign/dismiss + dedupe) → `alerts.plant_id`
  makes plant alerts first-class with no new lifecycle code.
- **Offline scouting** (client-UUID upsert, LWW, `server_updated_at` cursor) → add optional `plant_id`;
  the protocol is untouched.
- **`index_observations`** → becomes the **parcel rollup sink** of the plant tier, so the shipped
  dashboard, series API, choropleth, and season report keep working with no changes.
- **Media-token auth** → covers capture COG tiles + MVT + raw-photo access.
- **REST v1 + versioning** → plant/capture endpoints are additive under `/api/v1`.

## 11. Phasing

| Sub-phase | Scope | Gate |
|-----------|-------|------|
| **P-MVP** | one crop (`tree`), one block, one flight: ODM ortho in MinIO → classical-CV crowns → `plants` → per-plant NDVI/NDRE + canopy area → MVT + WebGL map colour-by-vigor + weakest-N + per-plant scouting. **No Timescale yet** (one flight fits Postgres). | Sensing→detection→analytics→viz proven end-to-end on real drone data. |
| **P-scale** | Timescale hypertable + continuous aggregates + Temporal + cross-flight registration + `vine`/`row_segment` detectors + object-store hardening. | 10⁴ plants × many flights sustained within NFR-P-PERF/SCALE. |
| **P-breadth** | ML detector, fruit counting / yield (FR-P-045), disease localisation, per-plant water/nutrient status, replant automation; per-plant → Tier-B variable-rate prescriptions. | Agronomic value validated per crop. |

---

*Design doc v0.1 — companion to `docs/PHASE0.md`. Every FR-P/NFR-P carries a stable id for
traceability into issues, tests, and acceptance, per the spec's convention.*
