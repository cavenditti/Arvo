# Build conventions & file ownership (agent coordination contract)

You are one of several agents building this repo **in parallel in a shared working tree**.
Read `docs/PHASE0.md` (scope) and `docs/API.md` (REST contract) first. Spec: `agronomic-platform-spec.md` §6.

## Golden rules

1. **Touch only the files you own** (§Ownership). Shared spine files (`main.rs`, `routes.rs`,
   `security.rs`, `state.rs`, `error.rs`, `audit.rs`, `modules/mod.rs`, `core/src/lib.rs`,
   `src/api/types.ts`, `src/components/types.ts`, tab `_layout`s) are **read-only** for feature agents.
2. **Never edit** `Cargo.toml`, `package.json`, or `migrations/0001_init.sql`. All deps you need are
   already declared. If the schema blocks you, add a **new** migration in your band:
   auth 0010–0019 · farms/parcels 0020–0029 · weather 0030–0039 · imagery 0040–0049 ·
   alerts 0050–0059 · scouting 0060–0069. (Additive only.)
3. **No git commands.** The orchestrator commits at phase boundaries.
4. **No `sqlx::query!` macros** (compile-time DB dependency breaks parallel builds). Use runtime
   `sqlx::query` / `query_as::<_, T>` with `#[derive(sqlx::FromRow)]`.
5. axum **0.8**: path params are `/{id}` (not `/:id`). Handlers take `State<AppState>`.
6. Builds share one target dir — `cargo check -p arvo-api` may wait on the build lock; be patient,
   never `cargo clean`, never kill another build.
7. Backend agents: if you run a server for manual testing use your assigned port (below), then kill it.
8. App agents: never run `npm install` / `expo start`; verify with `npx tsc --noEmit` only.
9. Keep it lean. No new abstractions beyond the patterns here; no speculative config; small files.

## Backend patterns

- Module shape: each `crates/api/src/modules/<x>.rs` exposes `pub fn router() -> Router<AppState>`
  (already mounted in `routes.rs` under `/api/v1`). Define routes with full paths, e.g.
  `.route("/parcels/{id}/weather", get(get_weather))`.
- Auth: add `user: AuthUser` as a handler argument (extractor validates JWT). `user.org_id`,
  `user.user_id`, `user.require(Role::Operator)?`. **`org_id` never comes from the request body.**
- Every SQL statement filters by `org_id`. Cross-tenant → `ApiError::NotFound`.
- Errors: return `ApiResult<Json<T>>`; use `ApiError::BadRequest("msg".into())` etc.
- Audit every mutation: `audit::record(&state.pool, org, Some(user_id), "parcel.create", "parcel", id, json!({...})).await;` (best-effort, don't fail the request).
- Geometry: pass GeoJSON strings to SQL — insert `ST_Multi(ST_GeomFromGeoJSON($1))`, read
  `ST_AsGeoJSON(geom)::text`, area `ST_Area(geom::geography)/10000.0`, centroid `ST_X/ST_Y(ST_Centroid(geom))`,
  bbox via `ST_XMin/YMin/XMax/YMax(ST_Envelope(geom))`. No Rust geometry crates needed.
- HTTP out: `reqwest` with 15s timeout; external failures → `ApiError::BadRequest`/`Internal` with context; STAC/weather fetches must not panic offline.
- Locale: endpoints that render text accept `?lang=it|en`, default from `users.locale`.
- Unit tests: pure logic in `crates/core` **must** have `#[cfg(test)]` tests. Handlers: no tests required (smoke covers them).

## App patterns

- Expo **SDK 57**; routes live in `app/src/app/` (`@/*` alias = `app/src/*`). Read `app/AGENTS.md`
  (points to the versioned Expo docs) before using Expo APIs.
- Expo Router file routes; TypeScript strict; use `@tanstack/react-query` for all server state
  (`useQuery`/`useMutation`, keys like `['parcels']`, `['indices', parcelId, index]`).
- API access only via `src/api/client.ts` (`api.get/post/patch/del`), types from `src/api/types.ts`.
- i18n: `useTranslation()`; add keys to BOTH `src/i18n/it.json` and `src/i18n/en.json`, namespaced
  by feature (`"map.draw_start"`). Italian is the primary copy.
- Shared component **contracts are frozen** in `src/components/types.ts`; implementations replace the
  placeholder files in `src/components/` but must keep the exact exported name + props.
- Styling: plain `StyleSheet`, theme tokens from `src/theme.ts`. No UI kit. Keep screens simple and field-usable (big touch targets).
- Env: API base = `process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787'`.

## Ownership

| Agent | Owns (create/edit) |
|-------|--------------------|
| be-auth | `modules/auth.rs`, `modules/orgs.rs` |
| be-parcels | `modules/farms.rs`, `modules/parcels.rs` |
| be-weather | `modules/weather.rs`, `core/src/agro.rs` |
| be-imagery | `modules/scenes.rs`, `modules/indices.rs`, `imagery/stac.rs`, `imagery/worker.rs`, `imagery/synth.rs`, `imagery/mod.rs`, `core/src/indices.rs` |
| be-alerts | `modules/alerts.rs`, `jobs/detect.rs`, `jobs/mod.rs`, `core/src/anomaly.rs` |
| be-scouting | `modules/observations.rs`, `modules/reports.rs` |
| fe-shell | `app/src/app/_layout.tsx`, `app/src/app/login.tsx`, `app/src/app/register.tsx`, `app/src/app/(tabs)/settings.tsx`, `app/src/api/client.ts`, `app/src/auth/*`, `app/src/i18n/*` (owns files; others append keys), `app/src/theme.ts` |
| fe-map | `app/src/app/(tabs)/map.tsx`, `app/src/app/parcel/[id].tsx`, `app/src/app/parcel/new.tsx`, `app/src/components/MapView.native.tsx`, `MapView.web.tsx`, `app/src/components/map/mapHtml.ts`, `app/src/features/parcels/*` |
| fe-dashboard | `app/src/app/(tabs)/index.tsx`, `app/src/app/(tabs)/alerts.tsx`, `app/src/components/IndexChart.tsx`, `WeatherPanel.tsx`, `AlertList.tsx`, `app/src/features/insights/*` |
| fe-scouting | `app/src/app/(tabs)/scouting.tsx`, `app/src/app/observation/new.tsx`, `app/src/offline/*`, `app/src/features/scouting/*` |

Backend test ports: be-auth 8791 · be-parcels 8792 · be-weather 8793 · be-imagery 8794 · be-alerts 8795 · be-scouting 8796.
i18n JSONs are shared append-points: **add only your namespaced keys, never reformat the file.**

## Component contracts (frozen, in `src/components/types.ts`)

- `MapView {parcels: ParcelFeature[]; mode: 'view'|'draw'; onSelectParcel?(id); onDrawComplete?(geojson: GeoJSON.Polygon); focus?: [lon,lat,zoom?]; colorBy?: Record<string, string>; overlay?: {urlTemplate: string; opacity?: number; bounds?: [w,s,e,n]}}`
  — `overlay` renders an XYZ `L.tileLayer` (index raster) above the base map, below parcel polygons.
  — Leaflet inside `react-native-webview` (native) / iframe `srcDoc` (web); one shared HTML string in
  `src/components/map/mapHtml.ts`; bridge = JSON `postMessage` both ways (`{type:'init'|'select'|'drawn', ...}`); OSM tiles; draw = tap-to-add-vertex + finish button (or leaflet-draw from CDN).
- `IndexChart {series: IndexPoint[]; index: IndexName; height?: number}` — react-native-svg line +
  p10–p90 band, x = time, tap point → value label.
- `WeatherPanel {daily: WeatherDaily[]; agro?: AgroSummary; advisories?: Advisory[]}` — 7-day forecast strip + GDD/ET0/water-balance chips + advisory badges (with decision-support tone).
- `AlertList {alerts: Alert[]; onAction(id: string, action: 'ack'|'dismiss'|'snooze'): void}`.

## Offline sync engine (fe-scouting ↔ be-scouting)

Exactly the protocol in `docs/API.md §Observations`. Client: outbox in AsyncStorage
(`arvo.outbox.observations` = Observation[], `arvo.sync.lastPulledAt`); every local create/edit
writes the full row (client `updated_at = now`) to store+outbox; sync = POST outbox → on 2xx clear
applied, merge `changes` into local store (LWW), set lastPulledAt; runs on app focus, NetInfo
reconnect, and manual button; photos queue separately and upload after their observation is applied.

## Seed spec (`arvo-api seed --demo`, implemented by integrate-backend)

Idempotent (re-run = no dupes; key on emails/names). Creates:
- user `demo@arvo.local` / `demo1234` (locale it), org **Azienda Agricola Demo**, farm **Tenuta San Rocco**
  (Foggia plain, ~15.85E 41.45N); second user `agro@arvo.local` / `demo1234` as `agronomist`.
- 3 parcels with realistic hand-written MultiPolygons (~2–6 ha): **Vigneto Nord** (vine, planted 2026-03-15),
  **Uliveto Vecchio** (olive), **Orto 3** (tomato), season_year 2026.
- Weather: try real Open-Meteo backfill (120d + 7d forecast); on network failure fall back to
  plausible synthetic rows. Recompute nothing else — agro endpoints derive on read.
- Index series: `imagery::synth` per parcel per index, ~18 points Mar→mid-Jul, crop-plausible NDVI
  curve + noise; **inject a −25% NDVI dip in the last 2 points of Vigneto Nord** (must trigger the detector).
- Run the anomaly detector → ≥1 `index_drop` alert for Vigneto Nord; upsert frost/heat alerts if forecast warrants.
- 5 scouting observations (it-IT notes, geotagged inside parcels, 1 with `deleted:true` tombstone).
- STAC scene refresh for each parcel (best-effort, skip on network failure).

## smoke.sh expectations (integrate-backend)

`scripts/smoke.sh` = bash + curl + jq against `localhost:${PORT:-8787}`, `set -euo pipefail`, prints
`PASS <n>` per step, exits non-zero on failure. Steps per PHASE0 §8, including the cross-tenant 404
check (register a second org, GET first org's parcel by id → expect 404) and an audit-row count > 0
(via `docker compose -f infra/docker-compose.yml exec -T db psql -U arvo -d arvo -tAc ...`).
STAC/Open-Meteo steps tolerate network failure with a warning (assert HTTP handled, not external data).
