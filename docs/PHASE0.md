# Phase 0 — Tier-0 MVP implementation plan

Target: a working, self-hostable Tier-0 slice of the platform (spec §6): multi-tenant field
management, satellite index time series, weather + agronomic models, offline-first scouting,
anomaly alerts, season report — one Rust backend, one Expo (React Native) app that ships to
iOS, Android **and web** (the web build is the "portal").

## 1. Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | Rust, axum 0.8, sqlx 0.8, PostgreSQL 16 + PostGIS | single static binary, lean |
| DB | PostGIS via docker compose (port 5439) | geometry math done in SQL |
| Auth | email+password (argon2) → JWT (HS256, org-scoped claims) | OIDC deferred, see §4 |
| Satellite | Earth Search STAC (`https://earth-search.aws.element84.com/v1`, collection `sentinel-2-l2a`) | free, no key |
| Pixel compute | GDAL via cargo feature `imagery` (off by default; needs system gdal) | keeps default build dep-free |
| Weather | Open-Meteo forecast + archive APIs (free, no key; includes ET0 FAO) | zero-signup |
| App | Expo (expo-router, TypeScript), react-query, i18next (it/en) | one codebase = app + portal |
| Map | Leaflet inside WebView (native) / iframe (web) — single shared HTML | avoids per-platform map SDKs |
| Offline | AsyncStorage outbox + LWW sync protocol (see docs/API.md §Observations) | lean, spec-compliant |

## 2. Repo layout

```
arvo/
  backend/            Cargo workspace
    crates/core/      pure domain logic (index math, GDD/ET0/water balance, anomaly, advisories) — unit tested
    crates/api/       axum binary: HTTP API, ingest clients, jobs, seed, CLI
    migrations/       sqlx migrations (embedded in binary; `arvo-api migrate`)
  app/                Expo app (expo-router) — iOS/Android/web
  docs/               API.md (REST contract), AGENTS.md (conventions + ownership), PHASE0.md
  infra/              docker-compose.yml (PostGIS)
  scripts/smoke.sh    end-to-end API acceptance script
  Makefile            db-up / migrate / api / seed / smoke / app / check
```

## 3. Traceability — spec §6 Musts (status updated at end of build)

| FR | Requirement | MVP scope | Status |
|----|-------------|-----------|--------|
| FR-0-001 | Multi-tenant isolation org→farm→parcel | JWT org claim + org_id filter on every query + cross-tenant smoke test | ✅ |
| FR-0-002 | OIDC + RBAC | **Deviation:** JWT+argon2 now, role lattice viewer<operator<agronomist<admin<owner; OIDC behind same module later | ✅ (deviation) |
| FR-0-004 | Append-only audit log | `audit_log` table + DB trigger blocking UPDATE/DELETE + helper called on mutations | ✅ |
| FR-0-010 | Parcels: draw on map or import | Draw in Leaflet + GeoJSON FeatureCollection import (KML/SHP/ISO-XML deferred) | ✅ |
| FR-0-011 | Geometry, area, centroid, bbox | PostGIS `ST_Area(geography)`, `ST_Centroid`, `ST_Envelope` | ✅ |
| FR-0-012 | Crop, variety, planting date, season | parcel columns | ✅ |
| FR-0-020 | Sentinel-2 L2A via STAC | Earth Search catalog search per parcel; scenes stored with cloud % | ✅ |
| FR-0-021 | Cloud masking | SCL-class mask in the `imagery` worker; per-obs `cloud_pct` recorded | ✅ (feature-gated) |
| FR-0-022 | NDVI, NDRE, GNDVI, NDMI, SAVI | formulas in `core::indices`; computed by worker or demo synth | ✅ |
| FR-0-023 | Per-parcel per-index time series | `index_observations` + series API | ✅ |
| FR-0-027 | Web tiles + GeoTIFF | **Deferred** — app renders parcel polygons colored by latest index + stats/series instead | ⏸ |
| FR-0-030 | Weather forecast+observed per parcel | Open-Meteo daily archive + 7-day forecast, cached with staleness refresh | ✅ |
| FR-0-040 | Geotagged scouting w/ photos | mobile form, expo-location + camera/picker, photo upload | ✅ |
| FR-0-041 | Offline + lossless sync | client-UUID upserts, AsyncStorage outbox, LWW on `updated_at`, pull-since | ✅ |
| FR-0-050 | Index anomaly detection | drop vs trailing baseline (`core::anomaly`), runs post-ingest/seed + CLI | ✅ |
| FR-0-051 | Alerts w/ severity + explanation | alerts table + kinds + plain-language messages (it/en) | ✅ in-app (push/email deferred) |
| FR-0-052 | Decision-support framing | disclaimer in report footer + advisories UI copy | ✅ |
| FR-0-060 | Per-season PDF report | **Deviation:** print-optimized HTML report (browser → PDF); server-side PDF later | ✅ (deviation) |
| FR-0-070/071 | Web portal + iOS/Android apps | one Expo codebase, web export verified | ✅ |
| FR-0-072 | i18n Italian-first | i18next, `it` default + `en` | ✅ |

Should/Could shipped: FR-0-024 (per-acquisition stats: mean/median/p10/p90/σ), FR-0-031 (GDD),
FR-0-032 (ET0 + simple water balance), FR-0-033 (frost/heat/spray-window advisories),
FR-0-042 (scouting points on map), FR-0-053 (ack/snooze/assign/dismiss), FR-0-061 (GeoJSON/CSV export),
FR-0-003 (basic scoped invites).
Deferred: FR-0-013/014/025/026/043/054/062, GraphQL (REST-only v1), WMTS/GeoTIFF, push/email channels.

## 4. Explicit deviations & their exit paths

1. **OIDC → JWT+argon2.** All token issuance is in `crates/api/src/security.rs`; swapping to an
   OIDC issuer later touches only that module + login screens. RBAC roles per spec §3 are in place.
2. **GraphQL → REST v1** (`/api/v1`, versioned per NFR-MNT-012). GraphQL can be layered on later.
3. **Tiles/GeoTIFF deferred** — MVP visualizes per-parcel index stats + choropleth polygons; raster
   serving (titiler-style) is P0.5.
4. **PDF → printable HTML** (FR-0-060). Same data, `?format=html&lang=it`.
5. **No background scheduler** — ingest/refresh are on-demand (API/CLI) + lazy staleness refresh on
   read (weather >6h). A cron/Temporal loop is the P1 upgrade (NFR-PERF-011 then applies).
6. **Imagery pixel compute behind `--features imagery`** (needs system GDAL; reads COGs over
   `/vsicurl/` from the public `sentinel-cogs` bucket, SCL cloud mask). Without it the platform still
   ingests the STAC scene catalog, and `seed --demo` synthesizes realistic index series so the whole
   agronomy loop (series → anomaly → alert → report) runs end to end.
7. **Uploads on local disk** (`UPLOAD_DIR`), served at `/uploads`. S3-compatible store is a config
   swap later.

## 5. Data model (migrations/0001_init.sql)

`orgs`, `users`, `memberships(role)`, `invites`, `farms`, `parcels(geom MultiPolygon 4326, area_ha,
centroid, crop, variety, planting_date, season_year)`, `scenes(stac_id, acquired_at, cloud_cover,
assets)`, `index_observations(parcel, index_name, observed_at, mean/median/p10/p90/stddev,
pixel_count, cloud_pct, source)`, `weather_daily(parcel, date, t*, precip, et0, is_forecast)`,
`alerts(kind, severity, state, dedupe_key, data)`, `observations(client-generated uuid, geom point,
note, tags[], photos jsonb, taken_at, updated_at, deleted)`, `audit_log(append-only, trigger-guarded)`.

## 6. Security & tenancy model

- JWT claims `{sub, org, role, exp(7d)}`; every handler goes through the `AuthUser` extractor.
- **Rule: `org_id` always comes from the token, never from the request body**; every SQL statement
  filters by it. Cross-tenant access returns 404 and is exercised by `scripts/smoke.sh`.
- Role lattice: `viewer < operator < agronomist < admin < owner`; write endpoints declare a minimum.
- Audit: `audit::record()` on every mutation; table rejects UPDATE/DELETE at the DB level.

## 7. Build workstreams (the agent horde)

| Agent | Scope | Owns |
|-------|-------|------|
| be-auth | register/login/me/switch-org, invites, members | `modules/auth.rs`, `modules/orgs.rs` |
| be-parcels | farms + parcels CRUD, GeoJSON import/export, PostGIS ops | `modules/farms.rs`, `modules/parcels.rs` |
| be-weather | Open-Meteo ingest+cache, agro models, advisories | `modules/weather.rs`, `core/src/agro.rs` |
| be-imagery | STAC client, index endpoints, GDAL worker, demo synth | `modules/{scenes,indices}.rs`, `imagery/*`, `core/src/indices.rs` |
| be-alerts | anomaly detector, alert lifecycle | `modules/alerts.rs`, `jobs/detect.rs`, `core/src/anomaly.rs` |
| be-scouting | observation sync, photo upload, season report | `modules/observations.rs`, `modules/reports.rs` |
| fe-shell | auth flow, api client, i18n, settings | `src/api`, `src/auth`, root layouts |
| fe-map | Leaflet map component, parcel create/import/detail | `src/components/map`, map tab, parcel screens |
| fe-dashboard | dashboard, index charts, weather panel, alerts tab | dashboard/alerts tabs, chart components |
| fe-scouting | offline outbox, scouting UI, camera, sync engine | scouting tab, `src/offline` |
| integrate-backend | seed --demo, smoke.sh, full build+run+smoke green | any backend file |
| integrate-app | tsc clean, expo web export green, API alignment | any app file |

## 8. Acceptance (scripts/smoke.sh)

register → login → me → create farm → create parcel (GeoJSON, area/centroid returned) → import FC →
weather refresh+read (real Open-Meteo) → agro (GDD/ET0/balance) → advisories → STAC scene refresh
(best-effort, network-tolerant) → seeded index series present → anomaly alert exists → ack/snooze →
observations sync (upsert, pull-since, LWW) → photo upload → season report HTML 200 → CSV/GeoJSON
export → **cross-tenant isolation: second org gets 404 on first org's parcel** → audit rows exist.

## 9. Runbook

```bash
cp .env.example .env
make db-up migrate      # start PostGIS, apply schema
make seed               # demo org: demo@arvo.local / demo1234 (3 parcels, series, alerts)
make api                # backend on :8787
make app                # Expo: press w for web portal, or scan QR in Expo Go
make smoke              # end-to-end acceptance
```

## 10. P1 seams (where Tier A attaches)

- `Intervention` tables + AAL adapter trait land beside `jobs/`; the confirmation gate reuses the
  role lattice and audit trail.
- Weather/imagery refresh loops move from lazy/on-demand into a scheduler.
- MQTT/LNS ingest becomes a new module behind the same tenancy spine.
