# Arvo — agronomic monitoring platform (Tier-0 MVP)

Monorepo for the precision-agronomy platform specified in
[agronomic-platform-spec.md](agronomic-platform-spec.md). This is the **Phase 0 / Tier-0** build:
satellite index time series, weather + agronomic models, offline-first scouting, anomaly alerts and
season reports — multi-tenant, decision-support only (no actuation).

- **backend/** — Rust (axum + sqlx + PostGIS). Single binary: HTTP API + CLI (`migrate`, `seed`, `ingest-imagery`, `detect-anomalies`).
- **app/** — Expo (React Native, TypeScript). One codebase → iOS, Android **and web portal**. Italian-first i18n.
- **docs/** — [PHASE0.md](docs/PHASE0.md) (scope & traceability) · [API.md](docs/API.md) (REST contract) · [AGENTS.md](docs/AGENTS.md) (conventions).

## Quickstart

Prereqs: Docker, Rust, Node 20+.

```bash
cp .env.example .env
make db-up        # PostGIS on :5439 (docker)
make migrate      # apply schema
make seed         # demo tenant: demo@arvo.local / demo1234
make api          # backend on http://localhost:8787
make app          # Expo dev server — press `w` for the web portal
make smoke        # end-to-end API acceptance
```

Demo logins: `demo@arvo.local` / `demo1234` (owner) · `agro@arvo.local` / `demo1234` (agronomist).

Testing on a phone (Expo Go): set `EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:8787` in `app/.env`.

## Satellite imagery

The STAC scene catalog (Earth Search, Sentinel-2 L2A) works out of the box. Actual pixel compute
(NDVI & co. from COGs with SCL cloud masking) plus the raster tile server / GeoTIFF export are
behind the `imagery` cargo feature, which links **system GDAL**:

```bash
brew install gdal                 # GDAL 3.13+ (provides gdal-config)
make ingest                       # STAC refresh + compute indices from COGs (features=imagery)
make api-imagery                  # serve the API with tiles/GeoTIFF enabled
```

The `gdal` crate is pinned to the georust git master with the `bindgen` feature (see the workspace
`[patch.crates-io]` in `backend/Cargo.toml`), so bindings are generated against the locally
installed GDAL — no system-version guessing. `png` is an optional dep wired into the same feature.

When enabled, `/api/v1/meta` reports `"features": {"imagery": true}` and these routes light up
(FR-0-027):

- `GET /api/v1/tiles/{parcel}/{index}/{z}/{x}/{y}.png?token=<jwt>` — 256×256 RGBA Web-Mercator XYZ
  tiles (red→yellow→green for ndvi/ndre/gndvi/savi, brown→white→blue for ndmi; clouds/nodata
  transparent). Cached on disk under `TILE_CACHE_DIR` (default `./var/tiles`). Bearer header **or**
  `?token=` query param, since raster `<img>` clients cannot set headers.
- `GET /api/v1/parcels/{id}/indices/{index}.tif?token=<jwt>` — float32 GeoTIFF of the index clipped
  to the parcel bbox + 60 m buffer.

Without the feature the default build stays dependency-free: the platform still ingests the STAC
scene catalog, and `make seed` synthesizes realistic index series so the full loop (series →
anomaly → alert → report) runs end to end. See [docs/PHASE0.md](docs/PHASE0.md) for scope,
deviations, and the FR traceability matrix.
