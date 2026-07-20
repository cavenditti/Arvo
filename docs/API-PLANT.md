# Arvo REST API contract — Phase P (per-plant tier), v1

**FROZEN.** This is additive to `docs/API.md` (v1): same base URL, same `/api/v1` prefix, same JWT
auth, same error shape, same media-token rules, same role lattice. Nothing in `docs/API.md` changes
except three additive details: `Observation.plant_id` (§Per-plant scouting), `Alert.plant_id`
(§Plant alerts), and `IndexPoint.source` gaining `"drone"` (§Pipeline stages → rollup). Build to
this document exactly; where it and `docs/PHASE-PLANT.md` differ, **this document wins** (the design
doc is indicative, this is the contract).

Scope is **P-MVP** (`docs/PHASE-PLANT.md` §11): one crop unit end to end — capture → ortho/DSM →
classical-CV detection → plants → per-plant metrics → MVT map + weakest-N + per-plant scouting.
Binding MVP decisions baked into this contract: **local-disk object store behind a `Store` trait**
(no S3 SDK), **no TimescaleDB** (`plant_observations` is a plain table), **label-free classical-CV
detector**, **MapLibre GL from CDN inside the existing WebView/iframe HTML bridge**.

All timestamps RFC3339 UTC · all ids UUID · geometry GeoJSON EPSG:4326 · errors
`{"error": {"code", "message"}}` with the codes in `docs/API.md` · `org_id` always from the token ·
cross-tenant → `not_found` (404), never a 403 · every mutation writes an `audit_log` row.

Roles: `viewer < operator < agronomist < admin < owner`. Default `[viewer+]` for GET,
`[operator+]` for writes, unless annotated.

**Routing note (axum 0.8 / matchit 0.8):** static and dynamic siblings coexist
(`/plants/import` next to `/plants/{id}`, `/tiles/plants/{parcel_id}/…` next to the imagery build's
`/tiles/{parcel_id}/…`) — matchit 0.8 backtracks, this is not a conflict. Path params are `{id}`,
never `:id`. Every module exposes `pub fn router() -> Router<AppState>` with full paths.

## Module & migration ownership (anti-collision map)

| Endpoint group | Module (owner agent) | Migration |
|---|---|---|
| §Plants, §Blocks & rows, §Import & export | `modules/plants.rs` (be-plants) | `0070_plants.sql` |
| §Captures, §Storage layout | `modules/captures.rs` + `storage/mod.rs` (be-capture) | `0080_captures.sql` |
| §Pipeline stages — `sfm` | `crates/worker/*` (be-sfm) | — |
| §Pipeline stages — `detect`, `register` | `worker/detect.rs`, `core/src/registration.rs`, `services/plant-detect/*` (be-detect) | — |
| §Pipeline stages — `extract`, rollup | `worker/extract.rs`, `core/src/plant_metrics.rs` (be-extract) | `0090_plant_observations.sql` |
| §Plant insights, §Plant alerts | `modules/plant_insights.rs`, `core/src/plant_anomaly.rs` (be-plant-insights) | `0100_plant_alerts.sql` |
| §Plant vector tiles | `modules/plant_tiles.rs` (be-plant-tiles) | — |
| §Per-plant scouting | `modules/observations.rs` (be-scouting-ext) | `0110_observations_plant.sql` |

`modules/alerts.rs` is **NOT edited in Phase P** — plant alerts are written and read by
`plant_insights.rs` and keep working with the existing lifecycle endpoints (they are alert rows).

## Types

```
PlantUnit    = tree | vine | row_segment | bush
PlantStatus  = alive | dead | missing | replanted | removed
PlantSource  = detection | manual | import
PlantMetric  = ndvi | ndre | gndvi | ndmi | savi | canopy_m2 | height_m
CaptureSource= drone | prebuilt | demo
CaptureStatus= uploaded | ortho | detected | registered | extracted | failed
PipelineStage= sfm | detect | register | extract
JobState     = queued | running | succeeded | failed
```

`Plant = {id, parcel_id, block_id, block_name, row_id, row_name, unit_type: PlantUnit, lon, lat,
crown: GeoJSON Polygon|null, label, row_index, col_index, variety, rootstock, planted_on,
status: PlantStatus, external_ref, source: PlantSource, created_at, updated_at}`
Nullable: `block_id, block_name, row_id, row_name, crown, label, row_index, col_index, variety,
rootstock, planted_on, external_ref`. `lon`/`lat` are the plant point (segment midpoint for
`row_segment`); `crown` is the delineated canopy footprint when one exists.

`PlantBlock = {id, parcel_id, name, geometry: GeoJSON Polygon|MultiPolygon|null, notes, plant_count, created_at, updated_at}`
`PlantRow   = {id, parcel_id, block_id, name, row_index, geometry: GeoJSON LineString|null, plant_count, created_at, updated_at}`

`Capture = {id, parcel_id, captured_at, source: CaptureSource, status: CaptureStatus, unit_type: PlantUnit,
sensor, gsd_cm, bands: {red?, green?, blue?, rededge?, nir?, swir?}, pilot_name, operator_id, drone_model,
flight_ref, notes, failed_stage, error, bbox: [w,s,e,n]|null, plant_count, observation_count,
processed_at, created_at, updated_at, assets?: [CaptureAsset], jobs?: [PipelineJob]}`
`assets`/`jobs` are present **only** on `GET /captures/{id}`; omitted in list responses.
`bands` maps a reflectance band name → 1-based band index in `ortho.tif`.

`CaptureAsset = {id, capture_id, kind: "raw"|"ortho"|"dsm", file_name, path, bytes, content_type, checksum, created_at}`
`path` is the **store-relative key** (§Storage layout), never an absolute path, never a URL.

`PipelineJob = {id, capture_id, stage: PipelineStage, state: JobState, attempts, max_attempts,
run_after, started_at, finished_at, error, created_at, updated_at}`

`CaptureStatusInfo = {capture_id, status, stage: PipelineStage|null, state: JobState|null, attempts,
failed_stage, error, plant_count, observation_count, asset_counts: {raw, ortho, dsm}, updated_at}`

`PlantObservation = {observed_at, value, capture_id, quality, model_ver}` — `quality` 0..100
(fraction of usable pixels), `model_ver` stamps the detector/extractor build (NFR-P-REPRO).

`PlantRanking = {plant_id, label, lon, lat, block_id, row_id, status, value, normalized, rank,
vs_block_pct, neighbour_z}` — `rank` is 1-based within the full filtered set (survives paging);
`normalized` uses the parcel scale of §Plant vector tiles; `vs_block_pct` = 100·(value−block_median)/|block_median|;
`neighbour_z` is the robust z frozen in §Plant insights (outliers) — null when it could not be computed.

`PlantOutlier = {plant_id, label, lon, lat, block_id, row_id, status, value, neighbour_median,
neighbour_mad, neighbour_count, z, severity: info|warning|critical}`

`ReplantEntry = {plant_id, label, lon, lat, block_id, block_name, row_id, row_index, col_index,
status, reason: "missing"|"dead"|"vigor_collapse", last_seen_at, last_value, captures_absent}`

`PlantSummary = {parcel_id, total, by_status: {alive, dead, missing, replanted, removed},
unit_types: [PlantUnit], block_count, row_count,
last_capture: {id, captured_at, status}|null,
latest: {"<PlantMetric>": {observed_at, capture_id, mean, median, p10, p90, stddev, plant_count}|null}}`

`MetricScale = {parcel_id, metric, capture_id, observed_at, p5, p95, min, max, mean, plant_count}`

`Page<T> = {items: [T], total, limit, offset, has_more}` — `total` is the exact count of the filtered
set (`COUNT(*) OVER ()` in the same query, one round trip).

## Plants

Plants are org-scoped through their parcel. `parcel_id` is immutable after creation.
Caps: `label` ≤ 64, `external_ref` ≤ 128, `variety`/`rootstock` ≤ 100, block/row `name` ≤ 200,
`notes` ≤ 2000, **200,000 plants per parcel** (exceeding → 400 `bad_request`).

- `GET /api/v1/plants?parcel_id=&block_id=&row_id=&status=&unit_type=&bbox=&q=&limit=200&offset=0`
  → `Page<Plant>`. One of `parcel_id`, `block_id`, `row_id` is **required** (else 400 — no unbounded
  org-wide scans). `status` accepts a comma list; default excludes `removed`. `bbox` = `w,s,e,n`
  (`ST_MakeEnvelope`). `q` = case-insensitive substring on `label`/`external_ref` (≤ 64 chars).
  `limit` clamped 1–1000, `offset` ≥ 0. Order is stable: `row_index NULLS LAST, col_index NULLS LAST, id`.
- `GET /api/v1/plants/{id}` → `Plant`
- `POST /api/v1/plants` `{parcel_id, lon, lat, unit_type?("tree"), label?, block_id?, row_id?,
  row_index?, col_index?, variety?, rootstock?, planted_on?, status?("alive"), external_ref?, crown?}`
  → `201 Plant` with `source = "manual"`. The point must fall inside the parcel geometry buffered by
  25 m (`ST_DWithin(geography)`), else 400 `bad_request` ("plant outside parcel"). `block_id`/`row_id`
  must belong to the same parcel (else 400). `crown` (Polygon) is optional. A duplicate
  `external_ref` inside the parcel → `409 conflict`.
- `PATCH /api/v1/plants/{id}` — any field except `id`, `parcel_id`, `source`. Omitted fields keep
  their value; explicit `null` clears a nullable field (same rule as parcels). Moving `lon`/`lat`
  re-runs the in-parcel check. → `Plant`
- `DELETE /api/v1/plants/{id}` → `204` — **soft**: sets `status = "removed"`, keeps history. Removed
  plants are excluded from lists, tiles, rankings and rollups unless `status=removed` is requested.
  There is no hard delete in P-MVP.
- `POST /api/v1/plants/{id}/status` `{status, note?}` → `Plant` — status transition with an audit
  entry (`plant.status`), used by the app's "mark dead / replanted" action. Legal transitions:
  `alive → dead|missing|removed`, `dead|missing → replanted|removed|alive`, `replanted → alive|dead|missing|removed`.
  Anything else → 400 `bad_request`.

Audit actions: `plant.create`, `plant.update`, `plant.delete`, `plant.status`, `plant.import`.

## Blocks & rows

Optional grouping inside a parcel (FR-P-005). Deleting a block/row nulls the plants' `block_id`/`row_id`.

- `GET /api/v1/parcels/{id}/plant-blocks` → `[PlantBlock]` (asc by name)
- `POST /api/v1/parcels/{id}/plant-blocks` `{name, geometry?, notes?}` → `201 PlantBlock`
- `PATCH /api/v1/plant-blocks/{id}` `{name?, geometry?, notes?}` → `PlantBlock`
- `DELETE /api/v1/plant-blocks/{id}` → `204`
- `GET /api/v1/parcels/{id}/plant-rows?block_id=` → `[PlantRow]` (asc by `row_index NULLS LAST, name`)
- `POST /api/v1/parcels/{id}/plant-rows` `{name, block_id?, row_index?, geometry?}` → `201 PlantRow`
- `PATCH /api/v1/plant-rows/{id}` · `DELETE /api/v1/plant-rows/{id}` → `PlantRow` / `204`

`plant_count` is computed live (`COUNT(*)` of non-`removed` plants) — no denormalized counter.

## Import & export

Import bodies are large: both import routes set `DefaultBodyLimit::max(32 * 1024 * 1024)` (32 MB).
Both cap at **50,000 features per request** and are **upserts**: a feature whose `external_ref`
matches an existing plant in the same parcel UPDATES it (as-planted maps can be re-imported);
otherwise it inserts with `source = "import"`. Invalid features are skipped, never fatal; DB errors
are all-or-nothing (single transaction).

- `POST /api/v1/plants/import` `{parcel_id, unit_type?("tree"), feature_collection: FeatureCollection}`
  → `201 {created, updated, skipped, errors: [{index, reason}]}` (`errors` truncated to the first 20).
  Only `Point` features are accepted. Honored `properties`: `label, row_index, col_index, variety,
  rootstock, planted_on, external_ref, status, block, row` (`block`/`row` are **names** — matched
  case-insensitively inside the parcel and created if absent).
- `POST /api/v1/plants/import.csv?parcel_id=&unit_type=` — raw `text/csv` body, header row required.
  Columns (any order, extras ignored): `lon,lat,label,row_index,col_index,variety,rootstock,
  planted_on,external_ref,status,block,row`. `lon`/`lat` required. Same response, same caps.
- `GET /api/v1/plants/export.geojson?parcel_id=&block_id=&status=&metric=&capture=latest&token=`
  → `application/geo+json` FeatureCollection, `Content-Disposition: attachment`. Point features,
  every `Plant` field as a property; when `metric` is given, `value` + `observed_at` +
  `capture_id` are added from that capture. Cap 100,000 features.
- `GET /api/v1/plants/export.csv?…same query…` → `text/csv`, header
  `id,label,lon,lat,block,row,row_index,col_index,unit_type,status,variety,rootstock,planted_on,external_ref,source,value,observed_at`.

Both exports accept a **media token** in `?token=` (browser downloads) or a Bearer header — same rule
as the season report. Session JWTs in query strings are rejected.

## Captures

A capture is one flight (or one pre-built ortho drop). Registering it does not start work; uploads
attach assets; `POST …/process` enqueues the pipeline.

- `POST /api/v1/captures` `{parcel_id, captured_at, source?("drone"), unit_type?("tree"), sensor?,
  gsd_cm?, bands?, pilot_name?, operator_id?, drone_model?, flight_ref?, notes?}` → `201 Capture`
  (`status = "uploaded"`). `source: "demo"` requires `[agronomist+]` (seed/CI path, §Pipeline stages).
  `captured_at` must be within ±10 years of now. `gsd_cm` 0.1–100. `bands` keys are limited to
  `red|green|blue|rededge|nir|swir`, values 1–16. Default when omitted and `source != "demo"`:
  `{"red":1,"green":2,"blue":3}` (RGB) — see the band rule in §Pipeline stages.
- `GET /api/v1/captures?parcel_id=&status=&limit=50` → `[Capture]` (desc by `captured_at`, `limit`
  clamped 1–200; `assets`/`jobs` omitted). `parcel_id` optional — without it, all org captures.
- `GET /api/v1/captures/{id}` → `Capture` **with** `assets` and `jobs`.
- `GET /api/v1/captures/{id}/status` → `CaptureStatusInfo` — the cheap poll target for the app
  (fe-capture polls this every 5 s while `status ∉ {extracted, failed}`).
- `POST /api/v1/captures/{id}/assets/{kind}` — `kind ∈ raw|ortho|dsm`. `multipart/form-data`, field
  `file` (repeatable for `raw`). → `201 {assets: [CaptureAsset], total_bytes}`.
  Rules: streamed to the store, never fully buffered in memory (`DefaultBodyLimit::disable()` + a
  manual byte counter). `raw` accepts `image/jpeg`, `image/tiff`, `application/zip`, ≤ 200 MB/file,
  ≤ 500 MB/request, ≤ 2,000 files/capture, and **appends**. `ortho`/`dsm` accept GeoTIFF
  (`image/tiff`) only, exactly one per capture, ≤ 2 GB, and **replace** any previous one.
  Content types are sniffed from magic bytes (`II*\0`/`MM\0*` TIFF, `\xFF\xD8\xFF` JPEG,
  `PK\x03\x04` ZIP) — a lying `Content-Type` is a 400. Uploading to a capture whose `status` is past
  `uploaded` → `409 conflict` (retry the stage instead), except `ortho`/`dsm` which are allowed while
  `status ∈ {uploaded, failed}`.
- `GET /api/v1/captures/{id}/assets/{kind}?file=&token=` → the asset bytes,
  `Content-Disposition: attachment`. `kind ∈ ortho|dsm` needs no `file`; `kind=raw` requires
  `file=<file_name>` from the asset list. Media token **or** Bearer, org-checked through the parcel;
  cross-tenant → 404. Raw imagery and orthos are never publicly served (NFR-P-SEC).
- `POST /api/v1/captures/{id}/process` → `202 Capture` — enqueues the first stage:
  `source="drone"` → `sfm` (requires ≥ 1 `raw` asset, else 400);
  `source="prebuilt"` → `detect` and the status moves straight to `ortho` (requires an `ortho`
  asset; `dsm` is required for `unit_type ∈ {tree,bush}`, optional otherwise);
  `source="demo"` → `detect` with the synthetic sampler (no assets required).
  Idempotent: if a job for the capture is already `queued`/`running`, returns `202` with the
  unchanged capture (never a duplicate job).
- `POST /api/v1/captures/{id}/retry` `{stage?}` → `202 Capture` — re-queues `stage` (default: the
  capture's `failed_stage`). Only allowed when `status = "failed"` or `stage` is ≤ the capture's
  current stage; otherwise `409 conflict`. Resets that job to `state="queued"`, `attempts=0`,
  `error=null`, `run_after=now()`, rewinds `captures.status` to the stage's input status and clears
  `failed_stage`/`error`.

No `PATCH` and no `DELETE` for captures in P-MVP.
Audit actions: `capture.create`, `capture.upload`, `capture.process`, `capture.retry`.

## Storage layout

Local disk behind a small `Store` trait (`put`, `get`, `path`, `exists`, `delete`) in
`crates/api/src/storage/mod.rs`. Root = env `STORE_DIR`, default `./var/store` (sibling of
`var/uploads` and `var/tiles`; git-ignored). **Keys are the contract** — they are the future S3 keys,
and the API and the worker each resolve `STORE_DIR` + key independently (no shared crate):

```
captures/{capture_id}/raw/{asset_id}.{ext}     # one per uploaded photo (ext from the sniffed type)
captures/{capture_id}/ortho.tif                # orthomosaic (COG when ODM produced it)
captures/{capture_id}/dsm.tif                  # surface model / canopy height source
captures/{capture_id}/work/…                   # ODM scratch, worker-only, never an asset row
```

`capture_assets.path` stores the key (e.g. `captures/…/ortho.tif`), never an absolute path.
`file_name` keeps the sanitized original name (`[A-Za-z0-9._-]`, ≤ 200 chars); keys never contain a
client-supplied component, so path traversal is structurally impossible. Bytes are served only
through `GET /captures/{id}/assets/{kind}` (media token + org check). S3/MinIO later = a second
`Store` impl and a config switch; no endpoint or DB change.

## Pipeline stages

`captures.status` is the milestone reached; `pipeline_jobs.stage` is the unit of work. Exactly four
stages, one job row per `(capture_id, stage)` (`UNIQUE`), re-used across retries.
(`docs/PHASE-PLANT.md` §6 lists a fifth stage `rollup` — it is the **final step inside `extract`**,
not a separate job, so `extracted` is only reached after the parcel rollup has been written.)

| stage | input | writes | status on success |
|---|---|---|---|
| `sfm` | `raw/` photos | `ortho.tif`, `dsm.tif` (ODM) | `ortho` |
| `detect` | ortho + dsm | `plant_detections` | `detected` |
| `register` | `plant_detections` | `plants` (matched / created / marked `missing`) | `registered` |
| `extract` | ortho + dsm + `plants` | `plant_observations`, then the parcel rollup into `index_observations` | `extracted` |

```
uploaded --sfm--> ortho --detect--> detected --register--> registered --extract--> extracted
   \__ source=prebuilt|demo: POST /process sets `ortho` directly and enqueues `detect` __/
any stage exhausting max_attempts:  status = failed, failed_stage = <stage>, error = <message>
POST /captures/{id}/retry:          status rewound to the stage's input status, job re-queued
```

- **Chaining:** the API enqueues only the first stage; on success the worker inserts/queues the next
  stage's job. `succeeded` jobs are never re-run unless explicitly retried.
- **Claiming** (both the worker and any future runner must use exactly this):
  `UPDATE pipeline_jobs SET state='running', started_at=now(), attempts=attempts+1, worker_id=$1
   WHERE id = (SELECT id FROM pipeline_jobs WHERE state='queued' AND run_after <= now()
   ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.
- **Failure:** `attempts < max_attempts` (default 3) → `state='queued'`,
  `run_after = now() + interval '1 minute' * 2^attempts` (cap 30 min), capture keeps its last-good
  status. On the last attempt → `state='failed'` **and** capture → `failed`.
- **Stale jobs:** on startup the worker re-queues `state='running' AND started_at < now() - interval '2 hours'`.
- **Idempotency:** every stage is safely re-runnable. `sfm` overwrites the two COGs; `detect` deletes
  its own `plant_detections` (`WHERE capture_id = $1`) before inserting; `register` is deterministic
  given the detections; `extract` deletes its own `plant_observations` before inserting and re-upserts
  the rollup row.
- **Worker CLI (frozen, integrate-backend depends on it):**
  `arvo-worker run [--once] [--interval-secs 5] [--capture <uuid>]`. `--once` drains every runnable
  job — including the ones it enqueues itself — then exits `0`; exit `1` if any job ended `failed`.

**Detection (`detect`, label-free classical CV).** CHM = DSM − a rolling terrain baseline (p10 over a
15 m window; no DTM required). Smooth, take local maxima with a minimum spacing of 1.5 m, delineate
crowns by watershed on the CHM. Drop crowns < 0.5 m² or > 80 m². Emits one `plant_detections` row per
crown: point (crown centroid), `crown_geom`, `height_m` (crown max CHM), `canopy_m2`
(`ST_Area(geography)`), `score` 0..1. `vine`/`row_segment` place points along detected row lines at a
fixed spacing instead (`crown_geom` null). `model_ver` format `"<detector>-<semver>"`, e.g.
`cv-chm-0.1.0`; the synthetic path uses `synth-0.1.0`.

**Decision — two detector backends, service first, in-process fallback.** The same CHM/crown
algorithm exists twice, and `detect` picks at runtime:

1. **`services/plant-detect`** (Python/FastAPI, `POST /detect`) — used whenever `PLANT_DETECT_URL`
   is set. It covers **every** unit type (including `vine`/`row_segment`) and needs no GDAL in the
   worker process, so even a default (non-`imagery`) build detects for real. Started with
   `make detect-up`; published on `127.0.0.1` only, because it has no authentication and reads
   capture rasters from a read-only store mount (NFR-P-SEC).
2. **`worker/detect.rs` `mod cv`** (Rust + GDAL, behind `--features imagery`) — the fallback, and
   the only path when `PLANT_DETECT_URL` is unset. `tree`/`bush` only.

**Any** service failure — unset, unreachable, timeout, HTTP error, unparseable body — falls back to
(2), so a down service can never fail a capture the local path could have handled. With neither
available the stage fails with `stage_unsupported` and `source="demo"` keeps working. The worker
sends **store keys** (never absolute paths); request/response shapes are
`services/plant-detect/app/schemas.py` — keep the Rust client in `worker/detect.rs` `mod service`
in step with it. Timeouts: 5 s connect (fail fast to the fallback), `PLANT_DETECT_TIMEOUT_S`
(default 600 s) for the request itself, since crown delineation is CPU-bound over tens of millions
of pixels. `model_ver` stays the seam: swapping backends (or an ML model) later changes where
crowns come from, never the `plant_detections` contract or anything downstream of it.

**Registration (`register`, `core::registration`, unit-tested).** Greedy mutual-nearest-neighbour
between this capture's detections and existing non-`removed` plants of the parcel, inside
`match_radius_m` = clamp(0.5 × median detection spacing, 1.0, 3.0). Matched → `plant_detections.plant_id`
set, `match_kind='matched'`, the plant's `crown_geom`/`updated_at` refreshed (its `geom` is **not**
moved — identity is stable, FR-P-003). Unmatched detection → new plant (`source='detection'`,
`status='alive'`, `match_kind='created'`). A plant inside the capture bbox with no detection has
`plants.missing_streak` incremented (matched plants reset it to 0); reaching
`MISSING_AFTER_CAPTURES = 2` flips `status` to `missing` (so a single capture never marks anything
missing). `missing_streak` is what `ReplantEntry.captures_absent` reports.

**Extraction (`extract`, `core::plant_metrics`, unit-tested).** Sampling geometry = `crown_geom`, else
the plant point buffered by 1.5 m (`tree`/`bush`) or 0.75 m (`vine`/`row_segment`). Canopy mask =
pixels with NDVI ≥ 0.25; fewer than 5 masked pixels → index metrics are skipped for that plant.
Index values are the **mean** over masked pixels, using the `core::indices` formulas and
`captures.bands`; a band that is absent skips its metrics (RGB-only ortho ⇒ only `canopy_m2` +
`height_m`). `canopy_m2` = sampling-geometry area in m²; `height_m` = p95 of the CHM inside it.
`quality = clamp(round(100 · used_pixels / pixels_in_geometry), 0, 100)`.
`observed_at = captures.captured_at` for every row, so series align with flights.

**Rollup (tail of `extract`).** For each index metric present, upsert one `index_observations` row for
the parcel: `observed_at = captured_at`, `mean/median/p10/p90/stddev` over the per-plant values,
`pixel_count` = contributing plant count, `cloud_pct = 0`, `scene_id = NULL`, `source = 'drone'`,
`ON CONFLICT (parcel_id, index_name, observed_at) DO UPDATE`. This is the seam that keeps the Tier-0
dashboard, series API and anomaly loop working unchanged (FR-P-032). The spine widens
`IndexPoint["source"]` to `'sentinel-2' | 'demo' | 'drone'` in `src/api/types.ts`.

**Builds without GDAL (CI default).** Real pixel work needs the `imagery` feature. In a default build
`sfm`/`detect`/`extract` on a `drone`/`prebuilt` capture fail with the job error string
`stage_unsupported` (capture → `failed`; the HTTP error-code vocabulary of `docs/API.md` is
unchanged), while `source="demo"` captures run the deterministic synthetic detector/sampler
(`model_ver = synth-*`) end to end. CI and `seed --demo-plants` therefore use `source="demo"`;
`/api/v1/meta`'s existing `features.imagery` flag tells the app which path is available (no new meta
field in Phase P).

## Plant insights

`capture` accepts `latest` (default) or a capture UUID; `latest` = the parcel's newest capture with
`status='extracted'` that has ≥ 1 observation for the requested metric. No such capture → the
endpoint returns an empty result with `capture_id: null` (200, never 404). `metric` defaults to
`ndvi`. Rankings and outliers consider **`alive` plants only** (missing/dead belong to the replant
list). `from`/`to` accept RFC3339 or `YYYY-MM-DD`; anything else → 400.

- `GET /api/v1/parcels/{id}/plants/summary` → `PlantSummary`
- `GET /api/v1/parcels/{id}/plants/ranking?metric=ndvi&capture=latest&block_id=&row_id=&order=asc&limit=50&offset=0`
  → `{metric, capture_id, observed_at, order, page: Page<PlantRanking>}` (FR-P-042).
  `order=asc` = weakest first (default), `desc` = strongest. Ties broken by `plant_id`.
  `limit` clamped 1–500. NFR-P-PERF: p95 < 300 ms at 30k plants/parcel — index
  `(capture_id, metric)` + `(parcel_id, metric, observed_at DESC)` carry this.
- `GET /api/v1/parcels/{id}/plants/outliers?metric=ndvi&capture=latest&block_id=&k=8&radius_m=25&z=-2.5&limit=200`
  → `{metric, capture_id, observed_at, k, radius_m, threshold, items: [PlantOutlier]}` (FR-P-040).
  **Frozen definition** (`core::plant_anomaly`, unit-tested): neighbours = the `k` nearest `alive`
  plants of the same parcel within `radius_m`, excluding self (`ST_DWithin` + `<->` KNN order);
  `z = 0.6745 · (value − neighbour_median) / neighbour_mad`; `neighbour_count < 3` or
  `neighbour_mad < max(0.002 · |neighbour_median|, 1e-9)` → the plant is skipped (no z) — a
  degenerate-spread floor, so a quantized neighbourhood cannot turn noise into a large z.
  Reported when `z ≤ threshold` (default −2.5) **and** the plant is materially below its
  neighbours: `neighbour_median − value ≥ max(0.05 · |neighbour_median|, 0.02)`. Without that
  second gate a 1.5% difference on a uniform block still scores `z ≤ −3.5` and sends an
  agronomist to replant a healthy tree; both floors are relative (with an index-unit absolute
  backstop for medians near 0) because the same code scores NDVI, `canopy_m2` and `height_m`.
  `severity` = `critical` if `z ≤ −3.5`, `warning` if `z ≤ −2.5`, else `info`.
  Both gates hold wherever this definition is used — this endpoint, `plant_vigor_outlier` alerts
  and the replant list's `vigor_collapse`; `PlantRanking.neighbour_z` reports the raw ungated z.
  Ranges: `k` 3–32 (default 8), `radius_m` 5–100 (default 25), `z` −6..−1, `limit` 1–1000.
- `GET /api/v1/parcels/{id}/plants/replant?block_id=&limit=200&offset=0` → `Page<ReplantEntry>` (FR-P-043).
  Includes plants with `status ∈ {missing, dead}` plus `alive` plants whose latest `ndvi` is
  `z ≤ −3.5` against their neighbours (`reason = "vigor_collapse"`). `captures_absent` = consecutive
  captures with no detection.
- `GET /api/v1/parcels/{id}/plants/replant.csv?…` → `text/csv`
  (`plant_id,label,block,row,row_index,col_index,lon,lat,status,reason,last_seen_at,last_value`)
  · `GET /api/v1/parcels/{id}/plants/replant.geojson?…` → FeatureCollection. Both accept a media token.
- `GET /api/v1/plants/{id}/series?metric=ndvi&from=&to=&limit=2000` → `{plant_id, metric, series: [PlantObservation]}`
  (asc by `observed_at`; `limit` clamped 1–2000). This **is** the per-plant growth curve for
  `canopy_m2`/`height_m` (FR-P-044) — there is no separate per-plant growth endpoint.
- `GET /api/v1/plants/{id}/metrics/latest` → `{"<PlantMetric>": PlantObservation|null}` for all seven metrics.
- `GET /api/v1/plants/{id}/captures?limit=20` → `[{capture_id, captured_at, observed_at, quality,
  model_ver, metrics: {"<PlantMetric>": number}}]` (desc by `captured_at`) — the plant-detail history table.
- `GET /api/v1/parcels/{id}/plants/growth?metric=canopy_m2&block_id=&from=&to=` →
  `{metric, points: [{observed_at, capture_id, plant_count, mean, median, p10, p90, min, max}]}`
  — the block/parcel growth curve (FR-P-044), asc by time.
- `POST /api/v1/alerts/detect/plants` `{parcel_id?, capture_id?}` `?lang=it|en` `[agronomist+]`
  → `{scanned, created, updated}` (§Plant alerts). Runs over one parcel or every org parcel.

The pipeline never creates alerts; this endpoint does (integrate-backend calls it from
`seed --demo-plants` and from the smoke run).

## Plant vector tiles

- `GET /api/v1/tiles/plants/{parcel_id}/{z}/{x}/{y}.mvt?metric=ndvi&capture=latest&token=<media token>`
  → `200 application/vnd.mapbox-vector-tile` (protobuf, `ST_AsMVT`), or `204 No Content` when the tile
  holds no features (MapLibre treats 204 as empty; never 404 for an empty tile).

Auth is **identical to the raster tiles** (`docs/API.md` §"Raster tiles"): Bearer header **or**
`?token=` media token only — a session JWT in the query string is rejected (401); org scoping goes
through the parcel row; cross-tenant → **404**; media tokens live 15 min and come from
`POST /api/v1/auth/media-token`.

- Layer name: **`plants`** (single layer). Geometry: Point. Extent 4096, buffer 64, tile envelope
  `ST_TileEnvelope(z,x,y)`, geometry transformed to 3857. Features = every non-`removed` plant of the
  parcel intersecting the buffered envelope (missing/dead plants are drawn too — the replant view
  needs them); only `p5`/`p95` are computed over `alive` plants.
- matchit 0.8 has **no dynamic suffixes**: register the route as
  `/tiles/plants/{parcel_id}/{z}/{x}/{y}` and strip the `.mvt` extension inside the handler (exactly
  what `modules/tiles.rs` does for `.png`). A request without the extension is accepted too.
- Feature properties (exactly these): `id` (uuid string), `label` (string, omitted when null),
  `status` (`PlantStatus`), `value` (double, omitted when the plant has no observation for
  metric+capture), `norm` (double 0..1, omitted with `value`), `alert` (bool, true when the plant has
  an `open` alert — requires migration `0100`).
- `norm` is computed against the **parcel-wide** distribution for that capture+metric, so colours are
  identical across tiles: `norm = clamp((value − p5) / (p95 − p5), 0, 1)` with `p5`/`p95` from
  `percentile_cont` over all `alive` plants of the parcel for that capture+metric; `p95 == p5` → `0.5`.
- `z` valid range **10–22** (outside → 400 `bad_request`; below 10 the app draws the parcel polygon).
  Per-tile cap **12,000** features (`ORDER BY p.id LIMIT 12000`; v4 UUID order is an unbiased sample),
  with header `X-Arvo-Truncated: 1` when the cap bites. `Cache-Control: private, max-age=60`.
  No disk cache in P-MVP (the gist index + `ST_AsMVT` meet NFR-P-PERF).
- `GET /api/v1/parcels/{id}/plants/metric-scale?metric=ndvi&capture=latest` → `MetricScale` — the
  legend/colour-ramp domain for the same tiles (`capture_id: null` when there is no capture yet).

Ortho/DSM raster overlay tiles (FR-P-053) are **not** in P-MVP.

## Per-plant scouting

**The offline sync protocol in `docs/API.md` §Observations is UNCHANGED** — same endpoint, same
last-write-wins merge, same server-side `server_updated_at` cursor, same overlap window, same
`applied`/`changes` semantics, same caps, same photo flow. Phase P adds exactly one optional field:

`Observation += {plant_id: uuid|null}`

- `POST /api/v1/observations/sync` — `upserts[].plant_id` is honored; a `plant_id` that is not in the
  caller's org is stored as `null` (identical to the existing `parcel_id` rule — never leak
  existence). When `plant_id` resolves and `parcel_id` is null, the server fills `parcel_id` from the
  plant. `changes[]` carries `plant_id` for every row. No protocol version bump; old clients that
  omit the field keep working, and rows they re-upsert keep their stored `plant_id` only if they echo
  it back (standard LWW on the whole row — the app writes the full row, as it already does).
- `GET /api/v1/observations?parcel_id=&plant_id=&limit=100` → `[Observation]` — `plant_id` filter added.

## Plant alerts

Plant alerts are ordinary `alerts` rows: the **existing lifecycle is reused unchanged**
(`GET /api/v1/alerts`, `POST /api/v1/alerts/{id}/ack|dismiss|snooze|assign`, dedupe via the unique
`alerts_dedupe_key` index). Phase P adds one column and four kinds:

`Alert += {plant_id: uuid|null}` · kinds `plant_vigor_outlier | plant_missing | plant_dead | plant_drop`

`PlantAlert = Alert & {plant_id, plant_label, parcel_id}` — the same row shape plus the plant's label.

- `GET /api/v1/plant-alerts?parcel_id=&plant_id=&state=open&kind=&limit=200` → `[PlantAlert]`
  (desc by `created_at`, `limit` clamped 1–500; elapsed `snoozed` reported as `open`, exactly like
  `GET /alerts`).
- `GET /api/v1/plants/{id}/alerts?state=&limit=50` → `[PlantAlert]`
- Lifecycle actions: use the existing `/api/v1/alerts/{id}/…` endpoints. `modules/alerts.rs` is not
  modified, so `GET /api/v1/alerts` returns plant alerts **without** the `plant_id` field; the app
  uses `/plant-alerts` when it needs it.

Detector (`POST /api/v1/alerts/detect/plants`, `[agronomist+]`, `?lang=it|en`, default = user locale):

| kind | trigger | severity | dedupe_key |
|---|---|---|---|
| `plant_vigor_outlier` | neighbour z ≤ −2.5 on the latest capture (§Plant insights) | `z ≤ −3.5` → critical, else warning | `plant_vigor_outlier:{plant_id}:{capture_date}` |
| `plant_drop` | `core::anomaly` trailing-baseline drop on the plant's own ndvi series (FR-P-041) | warning | `plant_drop:{plant_id}:{observed_date}` |
| `plant_missing` | `plants.status = 'missing'` | warning | `plant_missing:{plant_id}` |
| `plant_dead` | `plants.status = 'dead'` | critical | `plant_dead:{plant_id}` |

`{capture_date}`/`{observed_date}` are `YYYY-MM-DD`. Rows carry `parcel_id` (so existing parcel
filters keep working), `plant_id`, and
`data = {metric, value, neighbour_median, neighbour_mad, z, capture_id, model_ver}`.
Upsert on `dedupe_key`: re-running updates `severity`/`message`/`data`/`updated_at` and never
resurrects an `acked`/`dismissed` alert. Titles/messages are localized (it default) and carry the
decision-support tone required by FR-0-052.

## Migrations (frozen filenames — bands cannot collide)

Additive only. Never edit `0001`/`0002`, never DROP or TRUNCATE an existing table.

| File | Owner | Contents |
|---|---|---|
| `0070_plants.sql` | be-plants | types `plant_unit`, `plant_status`; tables `plant_blocks`, `plant_rows`, `plants` |
| `0080_captures.sql` | be-capture | `captures`, `capture_assets`, `pipeline_jobs`, `plant_detections` |
| `0090_plant_observations.sql` | be-extract | `plant_observations` — **plain table**, no `create_hypertable`, no continuous aggregates |
| `0100_plant_alerts.sql` | be-plant-insights | `ALTER alerts ADD plant_id` + index + plant-kind constraint |
| `0110_observations_plant.sql` | be-scouting-ext | `ALTER observations ADD plant_id` + index |

Frozen columns (other agents read these — do not rename; extra columns are fine):

```sql
-- 0070
CREATE TYPE plant_unit   AS ENUM ('tree','vine','row_segment','bush');
CREATE TYPE plant_status AS ENUM ('alive','dead','missing','replanted','removed');
plant_blocks(id, org_id, parcel_id, name, geom geometry(MultiPolygon,4326), notes, created_at, updated_at)
plant_rows  (id, org_id, parcel_id, block_id, name, row_index, geom geometry(LineString,4326), created_at, updated_at)
plants      (id, org_id, parcel_id, block_id, row_id, unit_type plant_unit, geom geometry(Point,4326) NOT NULL,
             crown_geom geometry(Polygon,4326), label, row_index, col_index, variety, rootstock, planted_on date,
             status plant_status NOT NULL DEFAULT 'alive', external_ref,
             source text NOT NULL DEFAULT 'detection' CHECK (source IN ('detection','manual','import')),
             missing_streak int NOT NULL DEFAULT 0, created_at, updated_at)
-- indexes: plants(parcel_id), plants(org_id), gist(geom), (parcel_id,status), (block_id), (row_id),
--          UNIQUE (parcel_id, external_ref) WHERE external_ref IS NOT NULL

-- 0080
captures       (id, org_id, parcel_id, captured_at, source CHECK IN ('drone','prebuilt','demo'),
                status CHECK IN ('uploaded','ortho','detected','registered','extracted','failed'),
                unit_type plant_unit NOT NULL DEFAULT 'tree', sensor, gsd_cm, bands jsonb NOT NULL DEFAULT '{}',
                pilot_name, operator_id, drone_model, flight_ref, notes, failed_stage, error,
                bbox geometry(Polygon,4326), plant_count int NOT NULL DEFAULT 0,
                observation_count int NOT NULL DEFAULT 0, created_by uuid REFERENCES users(id),
                processed_at, created_at, updated_at)
capture_assets (id, org_id, capture_id, kind CHECK IN ('raw','ortho','dsm'), path, file_name, bytes bigint,
                content_type, checksum, created_at)
pipeline_jobs  (id, org_id, capture_id, stage CHECK IN ('sfm','detect','register','extract'),
                state CHECK IN ('queued','running','succeeded','failed') DEFAULT 'queued',
                attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
                run_after timestamptz NOT NULL DEFAULT now(), started_at, finished_at, error, worker_id,
                created_at, updated_at, UNIQUE (capture_id, stage))
plant_detections(id, org_id, capture_id, plant_id uuid REFERENCES plants(id) ON DELETE SET NULL,
                geom geometry(Point,4326) NOT NULL, crown_geom geometry(Polygon,4326), score,
                height_m, canopy_m2, match_dist_m, match_kind CHECK (match_kind IN ('matched','created')),
                model_ver text NOT NULL, created_at)
-- indexes: captures(parcel_id, captured_at DESC), captures(org_id, status),
--          capture_assets(capture_id, kind), pipeline_jobs(state, run_after),
--          plant_detections(capture_id), gist(plant_detections.geom)

-- 0090  (PLAIN table — Timescale is P-scale, not now)
plant_observations(plant_id uuid NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
                capture_id uuid NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
                org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
                parcel_id uuid NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,  -- denormalized for ranking/tiles
                metric text NOT NULL CHECK (metric IN ('ndvi','ndre','gndvi','ndmi','savi','canopy_m2','height_m')),
                observed_at timestamptz NOT NULL, value double precision NOT NULL,
                quality smallint, model_ver text,
                PRIMARY KEY (plant_id, metric, observed_at))
-- indexes: (capture_id, metric), (parcel_id, metric, observed_at DESC), (plant_id, observed_at DESC)

-- 0100
ALTER TABLE alerts ADD COLUMN plant_id uuid REFERENCES plants(id) ON DELETE CASCADE;
CREATE INDEX alerts_plant_idx ON alerts (plant_id) WHERE plant_id IS NOT NULL;
ALTER TABLE alerts ADD CONSTRAINT alerts_plant_kind_check
  CHECK (plant_id IS NULL OR kind IN ('plant_vigor_outlier','plant_missing','plant_dead','plant_drop'));
-- alerts.kind itself stays unconstrained (Tier-A kinds will extend it, per 0002).

-- 0110
ALTER TABLE observations ADD COLUMN plant_id uuid REFERENCES plants(id) ON DELETE SET NULL;
CREATE INDEX obs_plant_idx ON observations (plant_id) WHERE plant_id IS NOT NULL;
```

## App-side contracts (spine-owned files, listed here so every agent agrees)

`src/api/types.ts` gains, mirroring this document 1:1: `PlantUnit`, `PlantStatus`, `PlantSource`,
`PlantMetric` (+ `PLANT_METRICS`), `CaptureSource`, `CaptureStatus`, `PipelineStage`, `JobState`,
`Plant`, `PlantBlock`, `PlantRow`, `Capture`, `CaptureAsset`, `PipelineJob`, `CaptureStatusInfo`,
`PlantObservation`, `PlantRanking`, `PlantOutlier`, `ReplantEntry`, `PlantSummary`, `MetricScale`,
`PlantAlert`, `Page<T>`; `Observation` and `Alert` each gain `plant_id: string | null`;
`IndexPoint["source"]` widens to `'sentinel-2' | 'demo' | 'drone'`.

`src/components/types.ts` gains the frozen `PlantMap` contract:

```ts
export interface PlantMapProps {
  parcelId: string;
  /** MVT template containing {z}/{x}/{y}, already carrying ?metric=&capture=&token= */
  tileUrlTemplate: string;
  /** parcel outline drawn under the plant layer */
  parcelGeometry?: ParcelGeometry;
  metric: PlantMetric;
  /** colour-ramp domain from GET /parcels/{id}/plants/metric-scale */
  scale?: { p5: number; p95: number };
  /** [lon, lat, zoom?] */
  focus?: [number, number, number?];
  selectedPlantId?: string | null;
  onSelectPlant?: (plantId: string) => void;
  height?: number;
}
```

Implementation is MapLibre GL JS **from CDN inside the existing shared-HTML WebView/iframe bridge**
(same architecture and `postMessage` JSON protocol as `src/components/map/mapHtml.ts`) — no new npm
package, no native module, and a type-only `PlantMap.d.ts` shim so Metro picks `.web`/`.native`.

## Seed & smoke (integrate-backend)

`arvo-api seed --demo-plants` (idempotent, re-runnable): one `tree` block **Blocco A** inside the
seeded parcel **Uliveto Vecchio**, a regular grid of ~300 plants, one `source="demo"` capture already
at `status='extracted'`, `plant_observations` for `ndvi/ndre/canopy_m2/height_m` with a plausible
vigor field containing a **cluster of ~8 low-vigor plants and one `status='missing'` plant**, then
`POST /alerts/detect/plants` semantics applied so ≥ 1 `plant_vigor_outlier` alert exists.
The seed writes `status='missing'` directly (`MISSING_AFTER_CAPTURES` needs two captures).

Smoke additions (extends `scripts/smoke.sh`, all org-scoped): register a **`source="demo"`** capture
(CI has no GDAL — §Pipeline stages) → `process` → `arvo-worker run --once` →
`GET /captures/{id}/status` is `extracted` → plants exist →
`GET /parcels/{id}/plants/ranking` returns ranked plants → MVT tile returns 200 with a media token
and **401 with a session JWT in `?token=`** → `plant_vigor_outlier` alert present →
observation with `plant_id` round-trips through `/observations/sync` → the parcel `index_observations`
rollup mean matches the mean of its plants → **second org gets 404 on the first org's plant, capture,
asset and tile**.

## Out of scope for P-MVP (do not build)

TimescaleDB hypertables/continuous aggregates · MinIO/S3 · Temporal · ML detectors and fruit counting
(FR-P-045) · `vine`/`row_segment` detectors (the schema and API already carry them; only `tree`/`bush`
detection ships) · ortho/DSM raster overlay tiles (FR-P-053) · the plant-health printable report
(FR-P-062) · capture `PATCH`/`DELETE` · plant hard delete · a WebSocket/SSE pipeline feed (the app
polls `GET /captures/{id}/status`).
