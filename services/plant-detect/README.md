# plant-detect — label-free plant detection

Small Python/FastAPI service that turns a capture's **orthomosaic + DSM** into **plant
detections**: a point per plant, a crown polygon where one exists, a confidence score.

Classical computer vision only — **no training data, no labels, no model weights, no GPU**.
The only priors are the physics of a canopy (a tree is a tall, compact blob above local ground)
and the geometry of a planting (vines sit on straight, evenly spaced rows). That is what makes
it deployable on the first flight over a farm that has never been surveyed.

Contract: [`docs/API-PLANT.md`](../../docs/API-PLANT.md) §"Pipeline stages" → Detection ·
design: [`docs/PHASE-PLANT.md`](../../docs/PHASE-PLANT.md) §3, §6.

## Where it fits

```
flight → captures/{id}/raw/*          POST /captures/{id}/assets/raw
  sfm      (ODM)                      → captures/{id}/ortho.tif + dsm.tif
  detect   ← THIS SERVICE             → plant_detections (point, crown, score, height, canopy)
  register (core::registration)       → plants, stable ids across flights
  extract  (core::plant_metrics)      → plant_observations + the parcel rollup
```

`arvo-worker`'s `detect` stage also carries an in-process implementation of the same algorithm
behind its `imagery` cargo feature (`crates/worker/src/detect.rs`). This service is the
**pluggable detector behind one interface** required by FR-P-023: same inputs, same outputs,
same `model_ver` — run it when you want detection off the Rust box, on a bigger machine, or
swapped for an ML model later without touching the pipeline. The constants the two share are
diffed by `tests/test_contract.py`.

## Run it

```bash
make detect-up        # from the repo root: builds the image, serves on :8788 (compose profile `plant`)
make detect-logs
make detect-down
```

The container reads the store through a read-only bind mount. Under **colima** only paths
inside `$HOME` reach the VM, so keep `ARVO_STORE_DIR` there (the default,
`<repo>/backend/var/store`, already is).

Locally, without Docker (Python ≥ 3.10 — the rasterio pin's floor):

```bash
cd services/plant-detect
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
STORE_DIR=../../backend/var/store .venv/bin/uvicorn app.main:app --port 8788
.venv/bin/python -m pytest          # 50 tests, ~2 s, no drone data needed
```

| env | default | meaning |
|---|---|---|
| `STORE_DIR` | `./var/store` (`/var/store` in the image) | object-store root the request keys resolve against |
| `PORT` | `8788` | listen port |
| `WEB_CONCURRENCY` | `2` | uvicorn workers; one CPU-bound request each |
| `PLANT_DETECT_ALLOW_ABS_PATHS` | `0` | accept absolute raster paths in a request body |

## Contract

### `POST /detect`

```jsonc
{
  "capture_id": "…uuid…",                       // optional, echoed back (logs only)
  "unit_type": "tree",                          // tree | bush | vine | row_segment
  "dsm_path":   "captures/{capture_id}/dsm.tif",   // required for tree|bush
  "ortho_path": "captures/{capture_id}/ortho.tif", // optional for tree|bush, the mask source for vine|row_segment
  "bands": {"red": 1, "green": 2, "blue": 3, "nir": 4},   // = Capture.bands, 1-based indices in the ortho
  "parcel_geometry": {"type": "Polygon", "coordinates": [[[lon, lat], …]]},  // EPSG:4326, clips the search
  "params": {"min_spacing_m": 4.0}              // optional overrides, see §Tuning
}
```

`*_path` are **store keys**, exactly as `capture_assets.path` holds them
(`docs/API-PLANT.md` §"Storage layout") — never absolute paths, never URLs. A key is a
`/`-joined run of `[A-Za-z0-9._-]` segments resolved under `STORE_DIR`, the same rule
`crates/api/src/storage/mod.rs` enforces, so traversal cannot be expressed. Absolute paths are
rejected unless `PLANT_DETECT_ALLOW_ABS_PATHS=1`.

```jsonc
{
  "model_ver": "cv-chm-0.1.0",                  // → plant_detections.model_ver, plant_observations.model_ver
  "unit_type": "tree",
  "capture_id": "…uuid…",
  "count": 412,
  "truncated": false,                           // true when params.max_detections bit (lowest scores dropped)
  "pixel_size_m": 0.1,                          // working GSD after decimation
  "bbox": [w, s, e, n],                         // of the analysed window, EPSG:4326
  "params": { …the effective parameters… },
  "stats": {"seeds": 470, "crowns": 412, "dropped_small": 44, "dropped_large": 14,
            "canopy_px": 1284310, "veg_index": "ndvi", "elapsed_ms": 3820},
  "detections": [
    {
      "geom":  {"type": "Point", "coordinates": [15.8386, 41.4584]},        // crown centroid, EPSG:4326
      "crown_geom": {"type": "Polygon", "coordinates": [[[…], …]]},         // null for vine|row_segment
      "score": 0.83,                                                        // 0..1, see §Scoring
      "height_m": 4.12,                                                     // max CHM inside the crown
      "canopy_m2": 11.9                                                     // area of crown_geom
    }
  ]
}
```

The five detection fields map 1:1 onto the `plant_detections` columns the worker owns
(`geom`, `crown_geom`, `score`, `height_m`, `canopy_m2`), so both geometries go straight into
`ST_GeomFromGeoJSON($1)` with no reshaping. Exterior rings are counter-clockwise (RFC 7946) and
closed; `canopy_m2` is the area of the emitted polygon, so a row can never disagree with itself.

### `GET /health`

`{"status": "ok", "model_ver": "cv-chm-0.1.0", "unit_types": [...], "rasterio": "1.3.9", "gdal": "3.6.4"}`

### Errors

Arvo's shape and code vocabulary (`docs/API.md`): `{"error": {"code": "bad_request", "message": "…"}}`
with `bad_request` 400 (bad key, unknown unit type or parameter, geometry off the raster) and
`not_found` 404 (the key resolves but the file is absent).

## How detection works

**`tree` · `bush` — canopy height model + watershed.** The textbook individual-tree-crown
recipe, and the one the frozen contract specifies:

1. **CHM = DSM − rolling terrain baseline.** The baseline is the *p10 over a 15 m window*, so no
   DTM and no ground-classified point cloud is needed: over an orchard, the lowest decile of a
   15 m neighbourhood is inter-row ground. Result: height above *local* ground, immune to slope.
2. **Smooth** (σ = 0.6 m) so one crown becomes one local maximum instead of twenty leaf-level ones.
3. **Seed** with local maxima ≥ `min_spacing_m` (1.5 m) apart, above `min_height_m` — strongest
   first, so the apex wins and its shoulder is suppressed.
4. **Watershed on the inverted CHM**, masked to the canopy: apexes become basins, the saddle
   between two touching crowns becomes the divide. This is what separates plants whose canopies
   have closed.
5. **Filter** crowns outside 0.5–80 m², trace the outline (marching squares + Douglas–Peucker),
   emit centroid, polygon, max height, polygon area, score.

An **ortho** is optional here but recommended: with `nir` it gives NDVI, without it excess green
(ExG) from RGB, and the vegetation mask is what stops a shed, a polytunnel or a pole from being
detected as a tree (tested: `test_vegetation_gate_rejects_a_shed`).

**`vine` · `row_segment` — row lines.** Trellised rows have no separable crowns, so the geometry
of the planting carries the signal:

1. **Vegetation mask** from the ortho (NDVI/ExG), or from the CHM when only a DSM is available.
2. **Row angle** by Radon/Hough projection: for each candidate angle the across-row histogram *is*
   the Hough accumulator column, and the true row direction is the one whose accumulator is most
   sharply peaked (max Σh²). Coarse 1° sweep, then 0.1° refinement, in metric space.
3. **Row centres** = peaks of that (smoothed) profile; **row spacing** from its autocorrelation
   when not supplied.
4. **Along-row runs** split at gaps > 3 m (headlands, missing stretches), each run ≥
   `min_row_length_m` becomes a row.
5. **Points**: `vine` every `plant_spacing_m`, `row_segment` every `segment_length_m` (point =
   segment midpoint). Placement is centred, so a row never ends in an orphan stub. `crown_geom`
   is `null` — the extraction stage buffers the point (§3 of the design doc).

> P-MVP ships `tree`/`bush` through the Rust pipeline (`docs/API-PLANT.md` §"Out of scope"); the
> row detectors are implemented and tested here so the `vine` tier is a wiring job, not a rebuild.

### Scoring

`score` is a **ranking**, not a calibrated probability: `0.6·height + 0.4·shape`, and
`0.5·height + 0.3·shape + 0.2·vigour` when a vegetation index is available.

- *height* — `(height_m − min_height_m) / max(min_height_m, 0.5)`, clamped: twice the minimum
  height scores full marks.
- *shape* — isoperimetric quotient `4πA/P²`: 1 for a disc, low when the watershed leaked along a
  hedge. This is the term that flags "probably two plants" or "probably not a plant".
- *vigour* — mean index inside the crown, scaled between the canopy cut (NDVI 0.25) and 0.85.

Row detections score by local fill: the fraction of the point's own segment that is vegetated.

## Tuning

Everything below can be sent per request in `params`; defaults come from `app/config.py`
(`DEFAULTS` + a per-`unit_type` override). Unknown keys are **rejected** — a typo in a tuning
parameter would otherwise silently ruin a run.

| param | tree | bush | vine | row_segment | what it does |
|---|---|---|---|---|---|
| `min_height_m` | 1.0 | 0.4 | 0.6 | 0.3 | canopy floor; **the first thing to change** — set it below the shortest plant and above the tallest weed |
| `min_spacing_m` | 1.5 | 1.0 | 0.8 | 0.5 | minimum distance between two apexes ≈ half the planting distance |
| `min_crown_m2` / `max_crown_m2` | 0.5 / 80 | 0.2 / 20 | — | — | crown area window; tighten to the crop's real crown size to drop shrubs and merged blobs |
| `smooth_sigma_m` | 0.6 | 0.3 | — | — | raise if one tree yields several detections, lower if two trees merge into one |
| `terrain_window_m` / `terrain_percentile` | 15 / 10 | | | | ground estimate. Widen the window on flat terrain with closed canopy; narrow it on broken ground. A percentile ≤ 1 is read as a fraction (0.10 = p10) |
| `veg_index` / `veg_min` | `auto` / 0.25 (NDVI), 0.05 (ExG) | | | | `auto` → NDVI if the ortho has NIR, else ExG. `none` disables the gate |
| `target_gsd_cm` | 10 | 5 | 5 | 5 | working resolution; the read is decimated to it. Lower = slower and noisier, not necessarily better |
| `clip_buffer_m` | 2.0 | | | | how far outside `parcel_geometry` to look, so an edge tree is not cut in half |
| `row_spacing_m` / `row_angle_deg` | — | — | auto | auto | pin them when the estimate wobbles (short rows, heavy weed cover) |
| `plant_spacing_m` / `segment_length_m` | — | — | 1.0 | 5.0 | in-row spacing / segment length |
| `min_row_length_m` | — | — | 3.0 | 3.0 | shorter runs are noise, not rows |
| `max_pixels` / `max_detections` | 40 M / 200 k | | | | guards; `max_detections` matches the API's 200 k plants-per-parcel cap |

Typical starts: **olive** `min_height_m 1.5, min_spacing_m 4, max_crown_m2 60` ·
**apple/pear (dwarf, trellised)** `min_height_m 1.0, min_spacing_m 1.0, max_crown_m2 8` ·
**almond/walnut** `min_height_m 2.0, min_spacing_m 5` · **vine** `plant_spacing_m 0.9–1.2,
row_spacing_m 2.2–2.8` · **hedgerow/berry** `unit_type row_segment, segment_length_m 3–5`.

Iterate on **one block** with the same flight: change one parameter, re-`POST`, compare `count`
and `stats.dropped_*` against the grower's own plant count. `stats` is there for exactly this.

## Rasters it accepts

Anything GDAL reads with a CRS: ODM's UTM GeoTIFF/COG is the happy path. The DSM is read at band
1; the ortho's bands are named by the request's `bands` map and warped onto the DSM grid, so the
two need not share a resolution or a projection. A raster in EPSG:4326 works — pixel size is
converted to metres at the scene's latitude (~0.5 % error, harmless at these thresholds). Nodata
is honoured and never leaks into the terrain baseline.

Big files are safe: the read is windowed to `parcel_geometry` and decimated to `target_gsd_cm`,
then further if the window would exceed `max_pixels`. A 2 GB ortho is never fully loaded.

## Tests

```bash
python -m pytest        # tests/ — synthetic fixtures only, no drone data, no network
```

- `test_crowns.py` — the load-bearing one: a synthetic orchard (48 dome crowns on a 5 m grid over
  a 2 % slope with noise) must yield **exactly 48** detections on the right trees, plus touching
  crowns, area filters, the bush/tree height split, the shed rejection and the parcel clip.
- `test_rows.py` — rows at a known angle/spacing are recovered to <0.6° and <0.2 m.
- `test_geo.py` — crown outline, area/perimeter, ring orientation and closure.
- `test_api.py` — the HTTP contract end to end over a generated GeoTIFF: detections in EPSG:4326,
  NDVI warped from a coarser ortho, an RGB-only vineyard, truncation, and the store-key defences.
- `test_contract.py` — the constants shared with `crates/worker/src/detect.rs`.

## Limits (P-MVP)

No ML, no fruit counting, no per-plant species classification (FR-P-045 is P-breadth). No
tiling across a parcel bigger than `max_pixels` at the requested GSD — it decimates instead. The
detector has no memory: matching detections to *existing* plants is `core::registration`'s job,
which is what keeps plant ids stable across flights.

One response holds every detection (a crown polygon runs ~0.5 kB, so 20 k trees ≈ 10 MB of
JSON). That is fine on a LAN between the worker and this service; for a bigger parcel, call it
per block with a smaller `parcel_geometry` rather than raising `max_detections`.
