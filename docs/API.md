# Arvo REST API contract — v1

Resource API base URL: `http://localhost:8787`. All endpoints under `/api/v1` unless noted.
Better Auth base URL: `http://localhost:3000` (`https://app.arvo.farm` in production).
Auth: `Authorization: Bearer <jwt>`. Better Auth issues a 15-minute EdDSA resource JWT with
claims `{sub: user_id, org: org_id, role, iss, aud, exp}`; the API verifies it against the
rotating `/api/auth/jwks` key set. The canonical login is an HttpOnly Better Auth session cookie.
All timestamps RFC3339 UTC. All IDs are UUIDs. Geometry is GeoJSON (EPSG:4326).

**Errors** — every non-2xx returns `{"error": {"code": "<snake_case>", "message": "<human text>"}}`.
Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `bad_request` 400, `conflict` 409,
`rate_limited` 429, `internal` 500. Cross-tenant access = `not_found` (do not leak existence).
Rust auth bridge endpoints are rate-limited per IP (30/min). Better Auth applies its own auth
endpoint protections.

**Media tokens** — session JWTs are never accepted in query strings. Endpoints that plain
`<img>`/tile/browser clients open directly (photos, tiles, GeoTIFF, the season report) accept
`?token=<media token>` instead: a short-lived (15 min) read-only JWT with `aud: "media"`, minted
via `POST /auth/media-token`. Media tokens cannot call any other endpoint; Bearer session tokens
keep working on these endpoints for API clients.

**Roles** (ordered): `viewer < operator < agronomist < admin < owner`. Minimum role per endpoint noted as `[role+]`. Default `[viewer+]` for GET, `[operator+]` for writes unless stated.

## Meta (no auth)
- `GET /healthz` → `ok`
- `GET /api/v1/meta` → `{"version": "0.1.0", "features": {"imagery": false}}`

## Auth

Better Auth endpoints live at the auth base URL:

- `POST /api/auth/sign-up/email` `{email, password, name, locale?}` — create an account and session.
- `POST /api/auth/sign-in/email` `{email, password}` — create the canonical session.
- `POST /api/auth/sign-out` — revoke the current session.
- `GET /api/auth/get-session` — Better Auth session and user.
- `GET /api/auth/token` — mint the active organization's 15-minute API JWT.
- `POST /api/auth/organization/create` `{name, slug}` — create an organization as owner.
- `POST /api/auth/organization/set-active` `{organizationId}` — switch active organization.
- `POST /api/auth/request-password-reset` `{email, redirectTo}` and
  `POST /api/auth/reset-password` `{token, newPassword}` — password reset flow.
- Better Auth's organization invitation/member endpoints own membership mutations.

Arvo-specific bridges:

- `GET /api/arvo/session` (auth base URL) → `{user, org, orgs, role}` — stable app session shape.
- `GET /api/v1/auth/me` → `{user: User, org: Org, role}` — verified resource-server identity.
- `POST /api/v1/auth/media-token` → `{token, expires_at}` — short-lived media token (see top).
- `GET /api/v1/orgs/members` → `[{user_id, email, full_name, role}]` — read-only projection.

`User = {id, email, full_name, locale}` · `Org = {id, name}`

## Farms
- `GET /api/v1/farms` → `[Farm]` · `POST /api/v1/farms` `{name}` → `201 Farm`
- `PATCH /api/v1/farms/{id}` `{name}` → `Farm` · `DELETE /api/v1/farms/{id}` [admin+] → 204
- `Farm = {id, name, created_at, parcel_count?}`

## Parcels
`Parcel = {id, farm_id, name, geometry: GeoJSON, area_ha, centroid: {lon, lat}, bbox: [w,s,e,n],
crop, variety, planting_date, season_year, cadastral_ref, photo_path, archived, created_at}`
crop is a free string; known crops (drive GDD base temp): `vine, olive, tomato, wheat, maize, other`.
`cadastral_ref` records provenance when the boundary came from the cadastre (FR-0-010b);
`photo_path` is the cover photo's server path (`/uploads/parcels/...`), null when unset.

- `GET /api/v1/parcels?farm_id=&include_archived=` → `[Parcel]`
- `POST /api/v1/parcels` `{farm_id, name, geometry (Polygon|MultiPolygon), crop?, variety?, planting_date?, season_year?, cadastral_ref?}`
  → `201 Parcel`. Validate: valid GeoJSON, `ST_IsValid`, area ≤ 10,000 ha. Geometry stored as MultiPolygon.
- `GET /api/v1/parcels/{id}` → `Parcel` · `PATCH /api/v1/parcels/{id}` (any field incl. geometry) → `Parcel`
  Omitted fields keep their value; sending `crop/variety/planting_date/season_year` as explicit
  `null` clears them. Caps: name ≤200, crop/variety ≤100, cadastral_ref ≤100, season_year 1900–2100.
- `DELETE /api/v1/parcels/{id}` → 204 (soft: `archived=true`)
- `POST /api/v1/parcels/import` `{farm_id, feature_collection: FeatureCollection}` → `201 {created: [Parcel]}`
  (per-feature `properties.name/crop/cadastral_ref` honored; skips invalid features, reports
  `{skipped: n}`; max 1000 features; all-or-nothing on DB errors)
- `GET /api/v1/parcels/export.geojson?farm_id=` → FeatureCollection (all parcel fields as properties)

### Parcel cover photo (FR-0-010b)
- `POST /api/v1/parcels/{id}/photo` — multipart field `file` (jpeg/png ≤ 10 MB, content-sniffed)
  → `201 {path}`. One cover per parcel: a new upload replaces and removes the previous file.
- `DELETE /api/v1/parcels/{id}/photo` → 204 (clears the column, removes the file)
- `GET /uploads/parcels/{parcel_id}/{file}` — serve; auth = media token (`?token=`) or Bearer,
  org-gated exactly like scouting photos (cross-tenant → 404).

## Cadastre (FR-0-010b — onboarding boundary detection)
Proxy over the Agenzia delle Entrate INSPIRE WFS (open data CC-BY 4.0, no key; MapServer,
DefaultCRS EPSG::6706 ≈ WGS84 over Italy). GML parsing stays server-side; the app only ever
sees GeoJSON. Endpoint override: `CADASTRE_WFS_URL` (tests, other providers).

- `GET /api/v1/cadastre/parcels?bbox=w,s,e,n` (EPSG:4326 viewport) →
  `{type: "FeatureCollection", features, truncated, source}` where each feature has
  `geometry` (Polygon|MultiPolygon, lon/lat) and
  `properties = {cadastral_ref, label, area_m2, existing_parcel_id}`.
  `existing_parcel_id` marks candidates already covered by one of the org's non-archived
  parcels (same `cadastral_ref`, or spatial overlap > 50% of the candidate) so the app offers
  only NEW parcels. `truncated=true` when the 60-feature cap was hit (zoom in).
  Validation → 400: malformed bbox, empty extent, span > 0.08°, outside Italy.
  Upstream failure or OGC exception document → `502 {error: {code: "upstream"}}`.

## Imagery — scenes & indices
`IndexName = ndvi | ndre | gndvi | ndmi | savi`
`IndexPoint = {observed_at, mean, median, p10, p90, stddev, pixel_count, cloud_pct, scene_id?, source: "sentinel-2"|"demo"}`

- `POST /api/v1/parcels/{id}/imagery/refresh` `{days?: 366, background?: false}` (clamped 1–366)
  → `{scenes_found, scenes_new, computed}` or `202 {started: true, ...}` for background work.
  Searches Earth Search STAC (`sentinel-2-l2a`, intersects parcel, cloud<60%), upserts `scenes`
  (incl. footprint bbox + BOA-offset flag). Upstream/STAC failure → 500 (details stay in logs).
  `computed` > 0 only when built with the `imagery` feature (GDAL); otherwise 0. Pixel compute
  selects the clearest acquisition per half-month (at most 26 for a 366-day search), preserving
  phenology while bounding remote COG reads.
- `GET /api/v1/imagery/status?parcel_ids=a,b,c` → `{ "<parcel_id>": {state, requested_at,
  started_at, finished_at, scenes_found, scenes_new, computed, error_code, updated_at} }` where
  `state = queued|running|ready|empty|failed`. This persisted lifecycle—not absence of an index—is
  the only source for processing UI. A queued/running row older than 45 minutes becomes
  `failed/refresh_timeout`, so process loss cannot create an indefinite spinner.
- `GET /api/v1/parcels/{id}/scenes?limit=50` → `[{id, stac_id, acquired_at, cloud_cover}]`
  Only scenes whose footprint intersects the parcel (rows ingested before footprints were stored
  are included until the next refresh backfills them).
- `GET /api/v1/parcels/{id}/satellite-analysis` → `{status, crop?, confidence?, scene_count?,
  month_count?, applied_to_parcel?, vegetation?, model_version?, resolution_m: 10,
  individual_plants_supported: false}`. Crop type is inferred from the clear-sky seasonal NDVI
  profile; vegetation presence/cover comes from Sentinel-2 L2A SCL class 4. A confident result may
  fill an unset or previously satellite-filled `parcels.crop`, but never replaces a manual value.
  `status="pending"` is a normal 200 while seasonal/clear-pixel evidence is insufficient.
  Sentinel-2 provides parcel-scale vegetation detection only; individual plants remain the
  high-resolution capture pipeline in `API-PLANT.md`.
- `GET /api/v1/parcels/{id}/indices?index=ndvi&from=&to=` → `{index, series: [IndexPoint]}` (asc by
  time; `from`/`to` accept RFC3339 or `YYYY-MM-DD`, anything else → 400)
- `GET /api/v1/parcels/{id}/indices/latest` → `{ndvi: IndexPoint|null, ndre: ..., gndvi: ..., ndmi: ..., savi: ...}`
- `GET /api/v1/indices/latest?parcel_ids=a,b,c` → `{"<parcel_id>": {"ndvi": IndexPoint|null, ...}}` (dashboard batch)
- `GET /api/v1/parcels/{id}/indices.csv?index=ndvi` → `text/csv` (`observed_at,mean,median,p10,p90,stddev,cloud_pct,source`)

## Raster tiles & GeoTIFF export (imagery builds only — FR-0-027)
Available when `/api/v1/meta` reports `features.imagery: true`; otherwise these routes return 404
with code `feature_disabled` semantics (plain `not_found` acceptable).

- `GET /api/v1/tiles/{parcel_id}/{index}/{z}/{x}/{y}.png?token=<media token>&scene=<scene_id|latest>`
  → 256×256 RGBA PNG in Web Mercator XYZ ("slippy map" / WMTS-compatible tiling).
  Auth: Bearer header (session token) **or** `?token=` (media token ONLY — session JWTs in query
  strings are rejected); org scoping via the parcel either way. Cross-tenant → 404.
  `scene=latest` (default) resolves the newest scene-backed index observation for that
  parcel+index. Pixels are NOT clipped to the parcel (Sentinel-2 is public data; the parcel gates
  access, not pixels); tiles fully outside the scene → transparent PNG.
  Colormaps: ndvi/ndre/gndvi/savi red→yellow→green over [-0.2, 0.9]; ndmi brown→white→blue over
  [-0.4, 0.6]. NoData/masked → transparent. Tiles are cached on disk under `var/tiles/{scene}/{index}/{z}/{x}/{y}.png`.
- `GET /api/v1/parcels/{id}/indices/{index}.tif?scene=latest&token=<media token>` → float32 GeoTIFF
  of the index clipped to the parcel bbox + 60 m buffer, `Content-Disposition: attachment`. Same auth rules.

## Weather & agronomy
`WeatherDaily = {date, t_min, t_max, t_mean, precip_mm, humidity_mean, wind_max_kmh, radiation_mj, et0_mm, is_forecast}`

- `GET /api/v1/parcels/{id}/weather?from=&to=` → `{daily: [WeatherDaily]}`.
  Lazy refresh: if newest non-forecast row is older than 6h, fetch Open-Meteo (archive: last 120d
  or since planting; forecast: 7d) before responding. Defaults: from = today−30d, to = today+7d.
- `POST /api/v1/parcels/{id}/weather/refresh` → `{days_written}` (forced refresh)
- `GET /api/v1/parcels/{id}/agro` → `{gdd: {sum, base_temp, from_date}, et0_7d_mm, precip_7d_mm,
  water_balance_7d_mm, water_balance_30d_mm, notes: [string]}` (GDD from planting_date, else season start Mar 1)
- `GET /api/v1/parcels/{id}/advisories` → `[{kind: frost_risk|heat_stress|spray_window, severity: info|warning|critical,
  date, message}]` — computed from forecast rows; messages in requester locale (`?lang=it|en`, default user locale).
  Critical frost/heat advisories are also upserted into `alerts` (dedupe_key = `kind:parcel:date`).

## Alerts
`Alert = {id, parcel_id, kind, severity: info|warning|critical, title, message, data, state: open|acked|snoozed|dismissed,
snoozed_until, assigned_to, created_at, updated_at}`
Kinds: `index_drop`, `frost_risk`, `heat_stress` (extensible).

- `GET /api/v1/alerts?state=open&parcel_id=&limit=200` → `[Alert]` (desc by created_at, `limit`
  clamped 1–500; `snoozed` with elapsed `snoozed_until` are reported as `open`)
- `POST /api/v1/alerts/{id}/ack` · `/dismiss` · `/snooze` `{until}` · `/assign` `{user_id}` → `Alert`
- `POST /api/v1/alerts/detect` [agronomist+] → `{created}` — runs the anomaly detector over all org parcels now.

## Devices & push notifications
One row per Expo push token; registration is self-service for every role (`[viewer+]`, a
device belongs to whoever is logged in on it).

- `POST /api/v1/devices` `{platform: "ios"|"android"|"web", token (≤512)}` → 204. Upsert by
  token: a device that logs into another user or org is re-bound (org, user, platform and
  `last_seen_at` refreshed), never duplicated.
- `DELETE /api/v1/devices/{token}` → 204 — idempotent and scoped to the caller's org (a token
  held by another org is a silent no-op, not an existence oracle).

**Push send** — after the anomaly detector inserts alerts it sends ONE Expo push per
(parcel, kind) per run to every device of the org: title = the parcel name, body = the app's
grouped copy ("Calo di vigore su N piante" for `index_drop`, else "N nuovi segnali"),
`data = {parcel_id, kind}`. Delivery is best-effort via `https://exp.host/--/api/v2/push/send`
(shared client, chunks of 100, 10 s timeout): failures are logged and never fail the job.
Kill switch: `ARVO_PUSH_DISABLED=1`; endpoint override: `PUSH_ENDPOINT` (tests). Per-user
locale and weather-advisory push are TODO (code comments in `jobs/detect.rs`).

## Observations (scouting) — offline sync protocol
`Observation = {id (client-generated uuid), parcel_id?, note, tags: [string], photos: [{path, taken_at?}],
lon, lat, taken_at, updated_at, deleted, author_id?, author_name?}`

- `POST /api/v1/observations/sync` `{last_pulled_at: ts|null, upserts: [Observation]}` →
  `{server_time, applied: [id], changes: [Observation]}`
  Rules: last-write-wins on `updated_at` (server keeps the newer); insert if unknown id; `deleted:true`
  tombstones. The pull cursor is SERVER-side: `changes` = all org observations whose
  server-received time > `last_pulled_at` (or all, if null) — skewed device clocks cannot hide
  rows from teammates. `server_time` is issued with a small overlap window, so recently-changed
  rows may be re-delivered on the next pull; the LWW merge makes that harmless. Client sets
  `last_pulled_at = server_time`. Idempotent — resending the same upserts is safe. Every processed
  id is echoed in `applied` (including ids the server will never apply, so clients drain their
  outbox). A `parcel_id` not in the caller's org is stored as `null`. Viewers may call with empty
  `upserts` (pull-only); pushing requires `[operator+]`. Caps: note ≤10k, ≤50 tags of ≤100 chars;
  `photos[].path` entries not under `/uploads/` are dropped.
- `GET /api/v1/observations?parcel_id=&limit=100` → `[Observation]` (excludes deleted)
- `POST /api/v1/observations/{id}/photos` — multipart field `file` (jpeg/png ≤ 10 MB, content
  sniffed) → `201 {path: "/uploads/observations/<id>/<uuid>.jpg"}` — appends to `photos`.
  409 when the observation is tombstoned.
- `GET /uploads/observations/{obs}/{file}?token=<media token>` — authenticated (media token or
  Bearer) + org-checked; photos are never publicly served.

## Reports & export
- `GET /api/v1/reports/parcels/{id}/season?lang=it&token=<media token>` → `text/html` — Bearer or
  media token (lets the app open it in a plain browser tab). Print-optimized single-file report:
  parcel header (name/crop/area/season), NDVI series inline-SVG chart, weather summary (GDD, ET0, rain),
  alert history, scouting log with photo thumbnails, and the decision-support disclaimer footer
  (required by FR-0-052/NFR-CMP-030).

## Audit (internal)
Every mutation calls `audit::record(org, user, action, entity, entity_id, data)`. No public read API in MVP.
