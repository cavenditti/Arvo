# Arvo REST API contract — v1

Base URL: `http://localhost:8787`. All endpoints under `/api/v1` unless noted.
Auth: `Authorization: Bearer <jwt>`. JWT claims: `{sub: user_id, org: org_id, role, exp}` (7 days).
All timestamps RFC3339 UTC. All IDs are UUIDs. Geometry is GeoJSON (EPSG:4326).

**Errors** — every non-2xx returns `{"error": {"code": "<snake_case>", "message": "<human text>"}}`.
Codes: `unauthorized` 401, `forbidden` 403, `not_found` 404, `bad_request` 400, `conflict` 409, `internal` 500.
Cross-tenant access = `not_found` (do not leak existence).

**Roles** (ordered): `viewer < operator < agronomist < admin < owner`. Minimum role per endpoint noted as `[role+]`. Default `[viewer+]` for GET, `[operator+]` for writes unless stated.

## Meta (no auth)
- `GET /healthz` → `ok`
- `GET /api/v1/meta` → `{"version": "0.1.0", "features": {"imagery": false}}`

## Auth
- `POST /api/v1/auth/register` `{email, password (≥8), full_name, org_name, locale?("it")}`
  → `201 {token, user: User, org: Org}` — creates org + owner membership. 409 if email taken.
- `POST /api/v1/auth/login` `{email, password, org_id?}` → `{token, user: User, orgs: [{id, name, role}]}`
  Token is scoped to `org_id` or the user's first org. 401 on bad credentials.
- `POST /api/v1/auth/switch-org` `{org_id}` [auth] → `{token}` (must be a member).
- `GET /api/v1/auth/me` → `{user: User, org: Org, role}`
- `POST /api/v1/orgs/invites` `{email, role}` [admin+] → `201 {id, token, email, role, expires_at}`
- `POST /api/v1/auth/accept-invite` `{token, email, password?, full_name?}` (no auth; registers the
  user if new, then adds membership) → `{token, user, org}`
- `GET /api/v1/orgs/members` → `[{user_id, email, full_name, role}]`

`User = {id, email, full_name, locale}` · `Org = {id, name}`

## Farms
- `GET /api/v1/farms` → `[Farm]` · `POST /api/v1/farms` `{name}` → `201 Farm`
- `PATCH /api/v1/farms/{id}` `{name}` → `Farm` · `DELETE /api/v1/farms/{id}` [admin+] → 204
- `Farm = {id, name, created_at, parcel_count?}`

## Parcels
`Parcel = {id, farm_id, name, geometry: GeoJSON, area_ha, centroid: {lon, lat}, bbox: [w,s,e,n],
crop, variety, planting_date, season_year, archived, created_at}`
crop is a free string; known crops (drive GDD base temp): `vine, olive, tomato, wheat, maize, other`.

- `GET /api/v1/parcels?farm_id=&include_archived=` → `[Parcel]`
- `POST /api/v1/parcels` `{farm_id, name, geometry (Polygon|MultiPolygon), crop?, variety?, planting_date?, season_year?}`
  → `201 Parcel`. Validate: valid GeoJSON, `ST_IsValid`, area ≤ 10,000 ha. Geometry stored as MultiPolygon.
- `GET /api/v1/parcels/{id}` → `Parcel` · `PATCH /api/v1/parcels/{id}` (any field incl. geometry) → `Parcel`
- `DELETE /api/v1/parcels/{id}` → 204 (soft: `archived=true`)
- `POST /api/v1/parcels/import` `{farm_id, feature_collection: FeatureCollection}` → `201 {created: [Parcel]}`
  (per-feature `properties.name/crop` honored; skips invalid features, reports `{skipped: n}`)
- `GET /api/v1/parcels/export.geojson?farm_id=` → FeatureCollection (all parcel fields as properties)

## Imagery — scenes & indices
`IndexName = ndvi | ndre | gndvi | ndmi | savi`
`IndexPoint = {observed_at, mean, median, p10, p90, stddev, pixel_count, cloud_pct, scene_id?, source: "sentinel-2"|"demo"}`

- `POST /api/v1/parcels/{id}/imagery/refresh` `{days?: 90}` → `{scenes_found, scenes_new, computed}`
  Searches Earth Search STAC (`sentinel-2-l2a`, intersects parcel, cloud<60%), upserts `scenes`.
  `computed` > 0 only when built with the `imagery` feature (GDAL); otherwise 0.
- `GET /api/v1/parcels/{id}/scenes?limit=50` → `[{id, stac_id, acquired_at, cloud_cover}]`
- `GET /api/v1/parcels/{id}/indices?index=ndvi&from=&to=` → `{index, series: [IndexPoint]}` (asc by time)
- `GET /api/v1/parcels/{id}/indices/latest` → `{ndvi: IndexPoint|null, ndre: ..., gndvi: ..., ndmi: ..., savi: ...}`
- `GET /api/v1/indices/latest?parcel_ids=a,b,c` → `{"<parcel_id>": {"ndvi": IndexPoint|null, ...}}` (dashboard batch)
- `GET /api/v1/parcels/{id}/indices.csv?index=ndvi` → `text/csv` (`observed_at,mean,median,p10,p90,stddev,cloud_pct,source`)

## Raster tiles & GeoTIFF export (imagery builds only — FR-0-027)
Available when `/api/v1/meta` reports `features.imagery: true`; otherwise these routes return 404
with code `feature_disabled` semantics (plain `not_found` acceptable).

- `GET /api/v1/tiles/{parcel_id}/{index}/{z}/{x}/{y}.png?token=<jwt>&scene=<scene_id|latest>`
  → 256×256 RGBA PNG in Web Mercator XYZ ("slippy map" / WMTS-compatible tiling).
  Auth: standard Bearer header **or** `?token=` query param (tile `<img>` clients cannot set
  headers); same claims validation + org scoping via the parcel. Cross-tenant → 404.
  `scene=latest` (default) resolves the newest scene-backed index observation for that
  parcel+index. Pixels are NOT clipped to the parcel (Sentinel-2 is public data; the parcel gates
  access, not pixels); tiles fully outside the scene → transparent PNG.
  Colormaps: ndvi/ndre/gndvi/savi red→yellow→green over [-0.2, 0.9]; ndmi brown→white→blue over
  [-0.4, 0.6]. NoData/masked → transparent. Tiles are cached on disk under `var/tiles/{scene}/{index}/{z}/{x}/{y}.png`.
- `GET /api/v1/parcels/{id}/indices/{index}.tif?scene=latest&token=<jwt>` → float32 GeoTIFF of the
  index clipped to the parcel bbox + 60 m buffer, `Content-Disposition: attachment`. Same auth rules.

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

- `GET /api/v1/alerts?state=open&parcel_id=` → `[Alert]` (desc by created_at; `snoozed` with elapsed `snoozed_until` are reported as `open`)
- `POST /api/v1/alerts/{id}/ack` · `/dismiss` · `/snooze` `{until}` · `/assign` `{user_id}` → `Alert`
- `POST /api/v1/alerts/detect` [agronomist+] → `{created}` — runs the anomaly detector over all org parcels now.

## Observations (scouting) — offline sync protocol
`Observation = {id (client-generated uuid), parcel_id?, note, tags: [string], photos: [{path, taken_at?}],
lon, lat, taken_at, updated_at, deleted, author_id?, author_name?}`

- `POST /api/v1/observations/sync` `{last_pulled_at: ts|null, upserts: [Observation]}` →
  `{server_time, applied: [id], changes: [Observation]}`
  Rules: last-write-wins on `updated_at` (server keeps the newer); insert if unknown id; `deleted:true`
  tombstones. `changes` = all org observations with server `updated_at > last_pulled_at` (or all, if null).
  Client then sets `last_pulled_at = server_time`. Idempotent — resending the same upserts is safe.
- `GET /api/v1/observations?parcel_id=&limit=100` → `[Observation]` (excludes deleted)
- `POST /api/v1/observations/{id}/photos` — multipart field `file` (jpeg/png ≤ 10 MB) →
  `201 {path: "/uploads/observations/<id>/<uuid>.jpg"}` — appends to the observation's `photos`.
- Files are served statically at `GET /uploads/...` (no auth in MVP; note in PHASE0 hardening list).

## Reports & export
- `GET /api/v1/reports/parcels/{id}/season?lang=it` → `text/html` — print-optimized single-file report:
  parcel header (name/crop/area/season), NDVI series inline-SVG chart, weather summary (GDD, ET0, rain),
  alert history, scouting log with photo thumbnails, and the decision-support disclaimer footer
  (required by FR-0-052/NFR-CMP-030).

## Audit (internal)
Every mutation calls `audit::record(org, user, action, entity, entity_id, data)`. No public read API in MVP.
