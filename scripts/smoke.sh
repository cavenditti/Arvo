#!/usr/bin/env bash
# Arvo end-to-end API acceptance (PHASE0 §8 + PHASE-PLANT §9). Requires the API running on
# $BASE and the demo tenant seeded (`arvo-api seed --demo`, which also seeds the Phase-P
# orchard). curl + jq, plus `cargo` for the one step that drives the capture pipeline through
# the `arvo-worker` binary (Part C2). Prints `PASS <n>` per step.
#
#   PORT=8787 bash scripts/smoke.sh
#
# Network-dependent steps (Open-Meteo, Earth Search STAC) are tolerant: they assert the API
# handled the request, and only WARN (never fail) when the upstream is unreachable.
set -euo pipefail

# Always run from the repo root so the compose file resolves regardless of caller cwd.
cd "$(dirname "$0")/.."

PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}"
COMPOSE="docker compose -f infra/docker-compose.yml"

# Temp files are registered here and removed on any exit (incl. fail()).
TMPFILES=()
cleanup() { rm -f "${TMPFILES[@]:-}"; }
trap cleanup EXIT
# Portable mktemp (BSD -t and GNU -t disagree); optional suffix as $2.
mkt() { local f; f="$(mktemp "${TMPDIR:-/tmp}/$1.XXXXXX")${2:-}"; TMPFILES+=("$f"); echo "$f"; }

N=0
pass() { N=$((N + 1)); echo "PASS ${N} — $1"; }
fail() { echo "FAIL — $1" >&2; exit 1; }
warn() { echo "WARN — $1" >&2; }

# Preflight: fail with a friendly message when the API isn't up at all.
curl -fsS -o /dev/null --max-time 5 "${BASE}/healthz" \
  || fail "API not reachable at ${BASE} — start it with \`make api\` (or \`make api-imagery\`) first"

# jq_get <json> <filter> : extract a value, failing loudly if absent/null.
jq_get() { echo "$1" | jq -er "$2" 2>/dev/null || fail "missing $2 in response: $1"; }

# api <method> <path> <token|-> [body] : echo "BODY<newline>HTTP_CODE".
api() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local args=(-sS -X "$method" -w $'\n%{http_code}' -H 'Content-Type: application/json')
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer ${token}")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "${BASE}${path}"
}
body_of() { echo "$1" | sed '$d'; }
code_of() { echo "$1" | tail -n1; }

RND="${RANDOM}${RANDOM}"
echo "== Arvo smoke @ ${BASE} (suffix ${RND}) =="

# ---------------------------------------------------------------------------
# Part A — fresh tenant: auth, parcels, weather, sync, photos, report, export
# ---------------------------------------------------------------------------

EMAIL_A="smoke-a-${RND}@arvo.test"
R=$(api POST /api/v1/auth/register - "{\"email\":\"${EMAIL_A}\",\"password\":\"smoke1234\",\"full_name\":\"Smoke A\",\"org_name\":\"Smoke Org A ${RND}\",\"locale\":\"it\"}")
[ "$(code_of "$R")" = "201" ] || fail "register A (got $(code_of "$R"))"
TOK_A=$(jq_get "$(body_of "$R")" '.token')
pass "register org A"

R=$(api POST /api/v1/auth/login - "{\"email\":\"${EMAIL_A}\",\"password\":\"smoke1234\"}")
[ "$(code_of "$R")" = "200" ] || fail "login A"
TOK_A=$(jq_get "$(body_of "$R")" '.token')
pass "login org A"

R=$(api GET /api/v1/auth/me "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "me"
[ "$(echo "$(body_of "$R")" | jq -r '.user.email')" = "$EMAIL_A" ] || fail "me email mismatch"
pass "auth/me"

R=$(api POST /api/v1/farms "$TOK_A" "{\"name\":\"Podere Smoke\"}")
[ "$(code_of "$R")" = "201" ] || fail "create farm"
FARM_A=$(jq_get "$(body_of "$R")" '.id')
pass "create farm"

GEOM='{"type":"Polygon","coordinates":[[[15.900,41.400],[15.904,41.400],[15.904,41.401],[15.900,41.401],[15.900,41.400]]]}'
R=$(api POST /api/v1/parcels "$TOK_A" "{\"farm_id\":\"${FARM_A}\",\"name\":\"Campo Smoke\",\"geometry\":${GEOM},\"crop\":\"wheat\",\"season_year\":2026}")
[ "$(code_of "$R")" = "201" ] || fail "create parcel"
PB=$(body_of "$R")
PARCEL_A=$(jq_get "$PB" '.id')
AREA=$(jq_get "$PB" '.area_ha')
awk "BEGIN{exit !(${AREA} > 0)}" || fail "parcel area_ha not positive (${AREA})"
echo "$PB" | jq -e '.centroid.lon and .centroid.lat' >/dev/null || fail "parcel centroid missing"
echo "$PB" | jq -e '.bbox | length == 4' >/dev/null || fail "parcel bbox missing"
pass "create parcel (area=${AREA} ha, centroid+bbox returned)"

FC='{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"Import 1","crop":"olive"},"geometry":{"type":"Polygon","coordinates":[[[15.905,41.400],[15.907,41.400],[15.907,41.401],[15.905,41.401],[15.905,41.400]]]}},{"type":"Feature","properties":{"name":"Bad"},"geometry":null}]}'
R=$(api POST /api/v1/parcels/import "$TOK_A" "{\"farm_id\":\"${FARM_A}\",\"feature_collection\":${FC}}")
[ "$(code_of "$R")" = "201" ] || fail "import FC"
[ "$(echo "$(body_of "$R")" | jq -r '.created | length')" = "1" ] || fail "import created count"
[ "$(echo "$(body_of "$R")" | jq -r '.skipped')" = "1" ] || fail "import skipped count"
pass "import FeatureCollection (1 created, 1 skipped)"

# Weather (real Open-Meteo; network-tolerant).
R=$(api POST "/api/v1/parcels/${PARCEL_A}/weather/refresh" "$TOK_A")
if [ "$(code_of "$R")" = "200" ]; then
  DW=$(echo "$(body_of "$R")" | jq -r '.days_written'); pass "weather refresh (days_written=${DW})"
else warn "weather refresh returned $(code_of "$R") (offline?)"; fi

R=$(api GET "/api/v1/parcels/${PARCEL_A}/weather" "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "weather read"
echo "$(body_of "$R")" | jq -e '.daily | type == "array"' >/dev/null || fail "weather.daily not array"
pass "weather read"

R=$(api GET "/api/v1/parcels/${PARCEL_A}/agro" "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "agro"
echo "$(body_of "$R")" | jq -e 'has("gdd") and has("et0_7d_mm") and has("water_balance_7d_mm")' >/dev/null || fail "agro fields"
pass "agro (GDD/ET0/water balance)"

R=$(api GET "/api/v1/parcels/${PARCEL_A}/advisories?lang=it" "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "advisories"
echo "$(body_of "$R")" | jq -e 'type == "array"' >/dev/null || fail "advisories not array"
pass "advisories"

# STAC scene refresh (Earth Search; network-tolerant).
R=$(api POST "/api/v1/parcels/${PARCEL_A}/imagery/refresh" "$TOK_A" '{"days":30}')
if [ "$(code_of "$R")" = "200" ]; then
  pass "STAC scene refresh (found=$(echo "$(body_of "$R")" | jq -r '.scenes_found'))"
else warn "STAC refresh returned $(code_of "$R") (offline?)"; fi

# Observations sync — upsert, LWW, pull-since.
OID=$(uuidgen | tr 'A-Z' 'a-z')
R=$(api POST /api/v1/observations/sync "$TOK_A" "{\"last_pulled_at\":null,\"upserts\":[{\"id\":\"${OID}\",\"parcel_id\":\"${PARCEL_A}\",\"note\":\"prima\",\"tags\":[\"smoke\"],\"lon\":15.902,\"lat\":41.4005,\"taken_at\":\"2026-06-01T09:00:00Z\",\"updated_at\":\"2026-06-01T09:00:00Z\",\"deleted\":false}]}")
[ "$(code_of "$R")" = "200" ] || fail "obs sync insert"
echo "$(body_of "$R")" | jq -e --arg id "$OID" '.applied | index($id)' >/dev/null || fail "obs not applied"
ST1=$(jq_get "$(body_of "$R")" '.server_time')
pass "observations sync (insert applied)"

# LWW: an OLDER update must not overwrite.
R=$(api POST /api/v1/observations/sync "$TOK_A" "{\"last_pulled_at\":null,\"upserts\":[{\"id\":\"${OID}\",\"parcel_id\":\"${PARCEL_A}\",\"note\":\"STALE\",\"tags\":[],\"lon\":15.902,\"lat\":41.4005,\"taken_at\":\"2020-01-01T00:00:00Z\",\"updated_at\":\"2020-01-01T00:00:00Z\",\"deleted\":false}]}")
[ "$(code_of "$R")" = "200" ] || fail "obs sync stale"
R=$(api GET "/api/v1/observations?parcel_id=${PARCEL_A}" "$TOK_A")
NOTE=$(echo "$(body_of "$R")" | jq -r --arg id "$OID" '.[] | select(.id==$id) | .note')
[ "$NOTE" = "prima" ] || fail "LWW failed: older write overwrote (note=${NOTE})"
pass "observations LWW (older write ignored)"

# LWW: a NEWER update wins.
R=$(api POST /api/v1/observations/sync "$TOK_A" "{\"last_pulled_at\":null,\"upserts\":[{\"id\":\"${OID}\",\"parcel_id\":\"${PARCEL_A}\",\"note\":\"FRESH\",\"tags\":[\"smoke\"],\"lon\":15.902,\"lat\":41.4005,\"taken_at\":\"2030-01-01T00:00:00Z\",\"updated_at\":\"2030-01-01T00:00:00Z\",\"deleted\":false}]}")
[ "$(code_of "$R")" = "200" ] || fail "obs sync fresh"
R=$(api GET "/api/v1/observations?parcel_id=${PARCEL_A}" "$TOK_A")
NOTE=$(echo "$(body_of "$R")" | jq -r --arg id "$OID" '.[] | select(.id==$id) | .note')
[ "$NOTE" = "FRESH" ] || fail "LWW failed: newer write not applied (note=${NOTE})"
pass "observations LWW (newer write wins)"

# Pull-since: request changes after ST1.
R=$(api POST /api/v1/observations/sync "$TOK_A" "{\"last_pulled_at\":\"${ST1}\",\"upserts\":[]}")
[ "$(code_of "$R")" = "200" ] || fail "obs pull-since"
echo "$(body_of "$R")" | jq -e '.changes | type == "array"' >/dev/null || fail "pull-since changes not array"
pass "observations pull-since"

# Photo upload + static serving.
TMPJPG="$(mkt arvo-smoke .jpg)"
base64 -d > "$TMPJPG" <<'B64'
/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a
HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA
AAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==
B64
R=$(curl -sS -w $'\n%{http_code}' -H "Authorization: Bearer ${TOK_A}" -F "file=@${TMPJPG};type=image/jpeg" "${BASE}/api/v1/observations/${OID}/photos")
[ "$(code_of "$R")" = "201" ] || fail "photo upload ($(code_of "$R"))"
PHOTO_PATH=$(jq_get "$(body_of "$R")" '.path')
pass "photo upload (${PHOTO_PATH})"

# Photos are private: bare fetch must 401, a short-lived media token must work.
R=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}${PHOTO_PATH}")
[ "$R" = "401" ] || fail "GET ${PHOTO_PATH} without auth should be 401 (got ${R})"
pass "GET /uploads rejects unauthenticated fetch (401)"

R=$(api POST /api/v1/auth/media-token "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "media token ($(code_of "$R"))"
MEDIA_A=$(jq_get "$(body_of "$R")" '.token')
pass "media token issued"

R=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}${PHOTO_PATH}?token=${MEDIA_A}")
[ "$R" = "200" ] || fail "GET ${PHOTO_PATH} with media token (${R})"
pass "GET /uploads served the photo (media token)"

# A full session JWT in the query string must be rejected (only media tokens ride in URLs).
R=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}${PHOTO_PATH}?token=${TOK_A}")
[ "$R" = "401" ] || fail "session JWT in query string should be rejected (got ${R})"
pass "session tokens rejected in query strings"

# GeoJSON export.
R=$(api GET "/api/v1/parcels/export.geojson?farm_id=${FARM_A}" "$TOK_A")
[ "$(code_of "$R")" = "200" ] || fail "geojson export"
[ "$(echo "$(body_of "$R")" | jq -r '.type')" = "FeatureCollection" ] || fail "export not a FeatureCollection"
pass "GeoJSON export"

# ---------------------------------------------------------------------------
# Part B — demo seed: index series, anomaly alert lifecycle, CSV, report
# ---------------------------------------------------------------------------

R=$(api POST /api/v1/auth/login - '{"email":"demo@arvo.local","password":"demo1234"}')
[ "$(code_of "$R")" = "200" ] || fail "login demo (is the demo tenant seeded?)"
TOK_D=$(jq_get "$(body_of "$R")" '.token')
pass "login demo tenant"

R=$(api GET /api/v1/parcels "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "list demo parcels"
VIGNETO=$(echo "$(body_of "$R")" | jq -r '.[] | select(.name=="Vigneto Nord") | .id')
[ -n "$VIGNETO" ] || fail "seeded Vigneto Nord not found"
pass "demo parcels present (Vigneto Nord)"

R=$(api GET "/api/v1/parcels/${VIGNETO}/indices?index=ndvi" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "ndvi series"
SLEN=$(echo "$(body_of "$R")" | jq -r '.series | length')
[ "$SLEN" -ge 10 ] || fail "ndvi series too short (${SLEN})"
pass "seeded NDVI series present (${SLEN} points)"

R=$(api GET "/api/v1/parcels/${VIGNETO}/indices.csv?index=ndvi" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "csv export"
# Pure-bash checks: with pipefail, early-exiting readers (head/grep -q) SIGPIPE the writer
# and fail the pipeline even on a successful match (races by pipe-buffer timing on Linux).
case "$(body_of "$R")" in observed_at,mean*) : ;; *) fail "csv header missing" ;; esac
[ "$(body_of "$R" | wc -l)" -ge 2 ] || fail "csv has no data rows"
pass "indices CSV export"

# No state filter: the alert may already be acked/snoozed from a prior run — we only assert it exists.
R=$(api GET "/api/v1/alerts?parcel_id=${VIGNETO}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "list alerts"
ALERT_ID=$(echo "$(body_of "$R")" | jq -r '[.[] | select(.kind=="index_drop") | .id][0] // empty')
[ -n "$ALERT_ID" ] || fail "no index_drop alert for Vigneto Nord (detector did not fire)"
pass "anomaly alert exists (index_drop)"

R=$(api POST "/api/v1/alerts/${ALERT_ID}/ack" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "alert ack"
[ "$(echo "$(body_of "$R")" | jq -r '.state')" = "acked" ] || fail "alert not acked"
pass "alert ack"

R=$(api POST "/api/v1/alerts/${ALERT_ID}/snooze" "$TOK_D" '{"until":"2030-01-01T00:00:00Z"}')
[ "$(code_of "$R")" = "200" ] || fail "alert snooze"
[ "$(echo "$(body_of "$R")" | jq -r '.state')" = "snoozed" ] || fail "alert not snoozed"
pass "alert snooze"

# Season report (HTML + mandatory decision-support disclaimer).
R=$(api GET "/api/v1/reports/parcels/${VIGNETO}/season?lang=it" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "season report"
case "$(body_of "$R")" in *"prescrizione agronomica"*) : ;; *) fail "report missing decision-support disclaimer" ;; esac
pass "season report HTML (disclaimer present)"

# ---------------------------------------------------------------------------
# Part C — plant tier (Phase P, docs/PHASE-PLANT.md §9, docs/API-PLANT.md §"Seed & smoke")
# Runs against the demo orchard on Uliveto Vecchio: ~300 `tree` plants, three `source="demo"`
# captures already `extracted`, a failing patch and one missing plant. This part needs no GDAL
# and no worker run — the seed writes the same rows the `demo` pipeline path would. Part C2 then
# drives that pipeline for real.
# ---------------------------------------------------------------------------

R=$(api GET /api/v1/parcels "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "list demo parcels (plant tier)"
ULIVETO=$(echo "$(body_of "$R")" | jq -r '.[] | select(.name=="Uliveto Vecchio") | .id')
[ -n "$ULIVETO" ] || fail "seeded Uliveto Vecchio not found"

# Plants exist for the parcel, and the list pages (limit/offset/total/has_more).
R=$(api GET "/api/v1/plants?parcel_id=${ULIVETO}&limit=5" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant list ($(code_of "$R"))"
PB=$(body_of "$R")
PLANTS=$(jq_get "$PB" '.total')
[ "$PLANTS" -ge 100 ] 2>/dev/null || fail "only ${PLANTS} plants on Uliveto Vecchio — re-run \`make seed\` (plant tier)"
pass "seeded plants present (${PLANTS} on Uliveto Vecchio)"

[ "$(echo "$PB" | jq -r '.items | length')" = "5" ] || fail "plant page 1 is not 5 items"
[ "$(echo "$PB" | jq -r '.has_more')" = "true" ] || fail "plant page 1 has_more should be true"
PAGE1=$(echo "$PB" | jq -c '[.items[].id]')
R=$(api GET "/api/v1/plants?parcel_id=${ULIVETO}&limit=5&offset=5" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant list page 2"
DUP=$(echo "$(body_of "$R")" | jq -r --argjson a "$PAGE1" '[.items[].id] as $b | [$a[] as $x | select($b | index($x))] | length')
[ "$DUP" = "0" ] || fail "plant paging overlaps: ${DUP} ids repeat between offset 0 and 5"
pass "plant list paginates (limit 5, total ${PLANTS}, no overlap at offset 5)"

# The demo flight: `source="demo"`, already at `extracted`.
R=$(api GET "/api/v1/captures?parcel_id=${ULIVETO}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "capture list"
CB=$(body_of "$R")
CAPTURE_ID=$(echo "$CB" | jq -r '[.[] | select(.status=="extracted")][0].id // empty')
[ -n "$CAPTURE_ID" ] || fail "no extracted capture on Uliveto Vecchio — re-run \`make seed\` (plant tier)"
COBS=$(echo "$CB" | jq -r --arg c "$CAPTURE_ID" '[.[] | select(.id==$c)][0].observation_count')
pass "demo capture extracted (${COBS} plant observations)"

R=$(api GET "/api/v1/captures/${CAPTURE_ID}/status" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "capture status"
[ "$(echo "$(body_of "$R")" | jq -r '.status')" = "extracted" ] || fail "capture status is not extracted"
pass "capture status endpoint (extracted)"

# Weakest-N: ranked ascending, ranks 1..n, resolved against a real capture (FR-P-042).
R=$(api GET "/api/v1/parcels/${ULIVETO}/plants/ranking?metric=ndvi&limit=5" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant ranking"
RB=$(body_of "$R")
echo "$RB" | jq -e '.capture_id != null' >/dev/null || fail "ranking resolved no capture"
echo "$RB" | jq -e '.page.items | length >= 1' >/dev/null || fail "ranking returned no plants"
echo "$RB" | jq -e '[.page.items[].value] as $v
                    | ($v == ($v | sort)) and ([.page.items[].rank] == [range(1; ($v|length)+1)])' \
  >/dev/null || fail "ranking is not weakest-first with 1-based ranks"
WEAKEST=$(jq_get "$RB" '.page.items[0].plant_id')
WVAL=$(jq_get "$RB" '.page.items[0].value')
pass "weakest-N ranking (worst NDVI ${WVAL}, ranked + paginated)"

# Plant detail — also the id the cross-tenant check below uses.
R=$(api GET "/api/v1/plants/${WEAKEST}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant detail"
DB=$(body_of "$R")
echo "$DB" | jq -e --arg id "$WEAKEST" '.id == $id and .unit_type == "tree" and .status == "alive"' \
  >/dev/null || fail "plant detail fields"
PLON=$(jq_get "$DB" '.lon'); PLAT=$(jq_get "$DB" '.lat')
PLABEL=$(echo "$DB" | jq -r '.label // .id')
pass "plant detail (${PLABEL}, block $(echo "$DB" | jq -r '.block_name // "—"'))"

# plant_observations: the per-plant series with capture lineage + quality + model_ver.
R=$(api GET "/api/v1/plants/${WEAKEST}/series?metric=ndvi" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant series"
SN=$(echo "$(body_of "$R")" | jq -r '.series | length')
[ "$SN" -ge 1 ] 2>/dev/null || fail "no plant_observations for ${PLABEL}"
echo "$(body_of "$R")" | jq -e '.series[0] | has("capture_id") and has("quality") and has("model_ver")' \
  >/dev/null || fail "plant observation missing capture lineage / quality / model_ver"
pass "plant_observations present (${SN} points for ${PLABEL})"

# Replant list: the seeded missing plant, plus any vigor collapse (FR-P-043).
R=$(api GET "/api/v1/parcels/${ULIVETO}/plants/replant" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "replant list"
RPT=$(echo "$(body_of "$R")" | jq -r '.total')
[ "${RPT:-0}" -ge 1 ] 2>/dev/null || fail "replant list is empty (expected the seeded missing plant)"
echo "$(body_of "$R")" | jq -e '[.items[] | select(.reason=="missing")] | length >= 1' \
  >/dev/null || fail "replant list carries no missing plant"
pass "replant list (${RPT} entries incl. a missing plant)"

# Neighbour-relative detector (FR-P-040) → plant alerts on the existing lifecycle (FR-P-061).
R=$(api POST "/api/v1/alerts/detect/plants?lang=it" "$TOK_D" "{\"parcel_id\":\"${ULIVETO}\"}")
[ "$(code_of "$R")" = "200" ] || fail "plant alert detector ($(code_of "$R"))"
pass "plant alert detector ran (scanned=$(echo "$(body_of "$R")" | jq -r '.scanned'))"

# No state filter: a prior run may have acked it — we only assert the alert exists.
R=$(api GET "/api/v1/plant-alerts?parcel_id=${ULIVETO}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "plant-alerts list"
PALERTS=$(echo "$(body_of "$R")" | jq -r '[.[] | select(.kind=="plant_vigor_outlier")] | length')
[ "${PALERTS:-0}" -ge 1 ] 2>/dev/null || fail "no plant_vigor_outlier alert (the neighbour detector did not fire)"
echo "$(body_of "$R")" | jq -e '[.[] | select(.kind=="plant_vigor_outlier")][0]
                                | .plant_id != null and (.data | has("z"))' \
  >/dev/null || fail "plant_vigor_outlier alert is missing plant_id / data.z"
pass "plant_vigor_outlier alert exists (${PALERTS})"

# Plant MVT tile: media token only, session JWT in the query rejected (FR-P-050, NFR-P-SEC).
R=$(api POST /api/v1/auth/media-token "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "media token (demo)"
MEDIA_D=$(jq_get "$(body_of "$R")" '.token')

PXY=$(awk -v lon="$PLON" -v lat="$PLAT" 'BEGIN{
  pi=atan2(0,-1); z=16; n=2^z;
  x=int((lon+180.0)/360.0*n);
  r=lat*pi/180.0; t=sin(r)/cos(r);
  y=int((1.0 - log(t+sqrt(t*t+1.0))/pi)/2.0*n);
  printf "%d %d", x, y }')
PTX=${PXY% *}; PTY=${PXY#* }

MVT="$(mkt arvo-plants .mvt)"
CODE=$(curl -sS -o "$MVT" -w '%{http_code}' "${BASE}/api/v1/tiles/plants/${ULIVETO}/16/${PTX}/${PTY}.mvt?token=${MEDIA_D}")
[ "$CODE" = "200" ] || fail "plant MVT tile z16 ${PTX}/${PTY} (${CODE})"
[ -s "$MVT" ] || fail "plant MVT tile is empty"
pass "plant MVT tile (z16 ${PTX}/${PTY}, $(wc -c < "$MVT" | tr -d ' ') bytes, media token)"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/v1/tiles/plants/${ULIVETO}/16/${PTX}/${PTY}.mvt?token=${TOK_D}")
[ "$CODE" = "401" ] || fail "session JWT in the MVT query string should be rejected (got ${CODE})"
pass "plant MVT rejects a session JWT in the query string (401)"

# Per-plant scouting through the UNCHANGED sync protocol (FR-P-060): the row carries plant_id
# out and back. Fixed client uuid → a re-run upserts it instead of piling notes into the demo.
POID="5b0c0000-0000-4000-8000-000000000001"
PNOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
R=$(api POST /api/v1/observations/sync "$TOK_D" "{\"last_pulled_at\":null,\"upserts\":[{\"id\":\"${POID}\",\"parcel_id\":\"${ULIVETO}\",\"plant_id\":\"${WEAKEST}\",\"note\":\"Controllo pianta (smoke ${RND})\",\"tags\":[\"smoke\"],\"lon\":${PLON},\"lat\":${PLAT},\"taken_at\":\"${PNOW}\",\"updated_at\":\"${PNOW}\",\"deleted\":false}]}")
[ "$(code_of "$R")" = "200" ] || fail "plant-pinned observation sync"
echo "$(body_of "$R")" | jq -e --arg id "$POID" '.applied | index($id)' >/dev/null || fail "plant-pinned observation not applied"
echo "$(body_of "$R")" | jq -e --arg id "$POID" --arg p "$WEAKEST" \
  '[.changes[] | select(.id==$id and .plant_id==$p)] | length == 1' >/dev/null \
  || fail "sync changes[] lost plant_id"
pass "per-plant scouting pin round-trips through sync"

R=$(api GET "/api/v1/observations?plant_id=${WEAKEST}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "observations by plant_id"
echo "$(body_of "$R")" | jq -e --arg id "$POID" '[.[] | select(.id==$id)] | length == 1' >/dev/null \
  || fail "plant_id filter did not return the pinned note"
pass "observations filter by plant_id"

# ---------------------------------------------------------------------------
# Part C2 — the pipeline itself (docs/API-PLANT.md §"Pipeline stages", §"Seed & smoke")
# Everything above reads rows the seed wrote directly. This part drives the real thing:
# capture -> process -> `arvo-worker run --once` -> `extracted`, which is the only place the
# `pipeline_jobs` state machine and the `arvo-worker` binary are exercised. `source="demo"` is
# the no-GDAL path (CI has no GDAL) and needs [agronomist+] — the demo user is `owner`.
# It runs last on purpose: it adds a newer capture, and every step above resolves `capture=latest`.
# ---------------------------------------------------------------------------

CAPTURED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
R=$(api POST /api/v1/captures "$TOK_D" "{\"parcel_id\":\"${ULIVETO}\",\"captured_at\":\"${CAPTURED_AT}\",\"source\":\"demo\",\"unit_type\":\"tree\",\"flight_ref\":\"smoke-${RND}\"}")
[ "$(code_of "$R")" = "201" ] || fail "create demo capture ($(code_of "$R")) — source=\"demo\" needs [agronomist+]"
PIPE_CAP=$(jq_get "$(body_of "$R")" '.id')
[ "$(echo "$(body_of "$R")" | jq -r '.status')" = "uploaded" ] || fail "new capture is not 'uploaded'"
pass "register source=\"demo\" capture (${PIPE_CAP} @ ${CAPTURED_AT})"

# demo/prebuilt skip SfM: /process enqueues `detect` and rewinds the status to that stage's input.
R=$(api POST "/api/v1/captures/${PIPE_CAP}/process" "$TOK_D")
[ "$(code_of "$R")" = "202" ] || fail "process capture ($(code_of "$R"))"
[ "$(echo "$(body_of "$R")" | jq -r '.status')" = "ortho" ] || fail "processed demo capture should sit at 'ortho' (detect enqueued)"
pass "POST /captures/{id}/process (202, detect queued)"

# The worker binary, scoped to this capture so an unrelated stale job can never fail the run.
# --once drains the jobs it enqueues itself (sfm->detect->register->extract) and exits 1 on failure.
command -v cargo >/dev/null 2>&1 \
  || fail "cargo not found — the smoke run drives \`arvo-worker run --once\` (docs/API-PLANT.md §Pipeline stages)"
WLOG="$(mkt arvo-worker .log)"
if (cd backend && cargo run --quiet -p arvo-worker -- run --once --capture "${PIPE_CAP}") >"$WLOG" 2>&1; then
  pass "arvo-worker run --once drained the pipeline"
else
  echo "--- arvo-worker output ---" >&2
  tail -n 40 "$WLOG" >&2
  fail "arvo-worker run --once exited non-zero (a pipeline stage ended 'failed')"
fi

# The app polls this endpoint; the drain above is synchronous, so a few tries is plenty.
SB=''
CSTATUS=''
for _ in 1 2 3 4 5 6 7 8 9 10; do
  R=$(api GET "/api/v1/captures/${PIPE_CAP}/status" "$TOK_D")
  [ "$(code_of "$R")" = "200" ] || fail "capture status poll ($(code_of "$R"))"
  SB=$(body_of "$R")
  CSTATUS=$(echo "$SB" | jq -r '.status')
  case "$CSTATUS" in extracted | failed) break ;; esac
  sleep 1
done
[ "$CSTATUS" = "extracted" ] \
  || fail "pipeline never reached 'extracted' (status=${CSTATUS}, stage=$(echo "$SB" | jq -r '.stage // "—"'), error=$(echo "$SB" | jq -r '.error // "—"'))"
echo "$SB" | jq -e '.plant_count > 0 and .observation_count > 0' >/dev/null \
  || fail "extracted capture wrote no plants/observations"
pass "capture reached 'extracted' via the worker ($(echo "$SB" | jq -r '.plant_count') plants, $(echo "$SB" | jq -r '.observation_count') observations)"

# FR-P-032 rollup seam: the parcel `index_observations` point this flight wrote must be the mean
# of its own plants. `from`/`to` pin the exact instant server-side, so the check never depends on
# how two endpoints format a timestamp.
RVALS="$(mkt arvo-rank .txt)"
: >"$RVALS"
ROFF=0
while :; do
  R=$(api GET "/api/v1/parcels/${ULIVETO}/plants/ranking?metric=ndvi&capture=${PIPE_CAP}&limit=500&offset=${ROFF}" "$TOK_D")
  [ "$(code_of "$R")" = "200" ] || fail "ranking for the pipeline capture ($(code_of "$R"))"
  RB=$(body_of "$R")
  [ "$(echo "$RB" | jq -r '.capture_id')" = "$PIPE_CAP" ] || fail "ranking resolved a different capture"
  echo "$RB" | jq -r '.page.items[].value' >>"$RVALS"
  [ "$(echo "$RB" | jq -r '.page.has_more')" = "true" ] || break
  ROFF=$((ROFF + 500))
  [ "$ROFF" -le 20000 ] || fail "ranking paging did not terminate"
done
RMEAN=$(awk 'NF{s+=$1;n++} END{if(n==0) exit 1; printf "%.10f\n", s/n}' "$RVALS") \
  || fail "the pipeline capture produced no ranked ndvi values"
RCOUNT=$(awk 'NF{n++} END{print n+0}' "$RVALS")

R=$(api GET "/api/v1/parcels/${ULIVETO}/indices?index=ndvi&from=${CAPTURED_AT}&to=${CAPTURED_AT}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "parcel ndvi series at the capture timestamp"
IB=$(body_of "$R")
[ "$(echo "$IB" | jq -r '.series | length')" = "1" ] || fail "no parcel rollup point at ${CAPTURED_AT} (FR-P-032 seam broken)"
[ "$(echo "$IB" | jq -r '.series[0].source')" = "drone" ] || fail "rollup point is not source=drone"
IMEAN=$(jq_get "$IB" '.series[0].mean')
IPX=$(echo "$IB" | jq -r '.series[0].pixel_count')
awk -v a="$IMEAN" -v b="$RMEAN" 'BEGIN{ d=a-b; if (d<0) d=-d; exit !(d <= 1e-6) }' \
  || fail "parcel rollup mean ${IMEAN} != mean ${RMEAN} of its ${RCOUNT} plants (FR-P-032)"
pass "parcel rollup matches the mean of its plants (ndvi ${IMEAN}, ${IPX} plants, source=drone)"

# ---------------------------------------------------------------------------
# Cross-tenant isolation + audit trail
# ---------------------------------------------------------------------------

EMAIL_B="smoke-b-${RND}@arvo.test"
R=$(api POST /api/v1/auth/register - "{\"email\":\"${EMAIL_B}\",\"password\":\"smoke1234\",\"full_name\":\"Smoke B\",\"org_name\":\"Smoke Org B ${RND}\"}")
[ "$(code_of "$R")" = "201" ] || fail "register B"
TOK_B=$(jq_get "$(body_of "$R")" '.token')

R=$(api GET "/api/v1/parcels/${PARCEL_A}" "$TOK_B")
[ "$(code_of "$R")" = "404" ] || fail "cross-tenant leak: org B got $(code_of "$R") on org A parcel"
pass "cross-tenant isolation (org B → 404 on org A parcel)"

# Plant tier, same rule: never a 403 — another org must not learn the id exists (FR-P-001).
R=$(api GET "/api/v1/plants/${WEAKEST}" "$TOK_B")
[ "$(code_of "$R")" = "404" ] || fail "cross-tenant leak: org B got $(code_of "$R") on the demo plant"
pass "cross-tenant isolation (org B → 404 on the demo plant)"

R=$(api GET "/api/v1/captures/${CAPTURE_ID}" "$TOK_B")
[ "$(code_of "$R")" = "404" ] || fail "cross-tenant leak: org B got $(code_of "$R") on the demo capture"
pass "cross-tenant isolation (org B → 404 on the demo capture)"

# A valid media token from the wrong org must not open the tile either.
R=$(api POST /api/v1/auth/media-token "$TOK_B")
[ "$(code_of "$R")" = "200" ] || fail "media token (org B)"
MEDIA_B=$(jq_get "$(body_of "$R")" '.token')
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/v1/tiles/plants/${ULIVETO}/16/${PTX}/${PTY}.mvt?token=${MEDIA_B}")
[ "$CODE" = "404" ] || fail "cross-tenant leak: org B media token got ${CODE} on the demo plant tile"
pass "cross-tenant isolation (org B media token → 404 on the demo plant tile)"

# Raw imagery and orthos are never publicly served (NFR-P-SEC): the org check runs through the
# parcel *before* the asset lookup, so the wrong org gets 404 and never learns the capture exists.
#
# This needs a POSITIVE CONTROL. The seed writes no capture_assets row, so the endpoint 404s for
# *every* caller — asserting only the 404 would pass identically if the ownership gate were
# deleted outright. So: upload a real asset, prove the owner can read it back, and only then is
# org B's 404 evidence of anything.
OTIF="$(mkt arvo-ortho .tif)"
# Only the 4-byte magic matters: the upload sniffs content type and never parses the raster.
printf 'II*\000arvo-smoke-ortho-placeholder' > "$OTIF"
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${TOK_D}" -F "file=@${OTIF}" \
  "${BASE}/api/v1/captures/${PIPE_CAP}/assets/ortho")
[ "$CODE" = "201" ] || fail "upload ortho asset: expected 201, got ${CODE}"
pass "capture ortho asset uploaded"

# Fresh media token: the one minted earlier may have aged past its 15 min while the worker built.
R=$(api POST /api/v1/auth/media-token "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "media token (demo, for asset read)"
MEDIA_A=$(jq_get "$(body_of "$R")" '.token')

AOUT="$(mkt arvo-asset .tif)"
CODE=$(curl -sS -o "$AOUT" -w '%{http_code}' "${BASE}/api/v1/captures/${PIPE_CAP}/assets/ortho?token=${MEDIA_A}")
[ "$CODE" = "200" ] || fail "owner cannot read its own capture asset: got ${CODE}"
[ -s "$AOUT" ] || fail "capture asset download was empty"
pass "capture asset readable by its owner ($(wc -c < "$AOUT" | tr -d '[:space:]') bytes)"

CODE=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/api/v1/captures/${PIPE_CAP}/assets/ortho?token=${MEDIA_B}")
[ "$CODE" = "404" ] || fail "cross-tenant leak: org B media token got ${CODE} on an asset org A can read"
pass "cross-tenant isolation (org B media token → 404 on the demo capture asset)"

AUDIT=$(${COMPOSE} exec -T -e PGPASSWORD=arvo db psql -U arvo -d arvo -tAc "SELECT count(*) FROM audit_log;" | tr -d '[:space:]')
[ "${AUDIT:-0}" -gt 0 ] || fail "audit_log empty"
pass "audit rows present (${AUDIT})"

# ---------------------------------------------------------------------------
# Raster tiles + GeoTIFF export (imagery builds only, FR-0-027) — skipped when
# /meta reports features.imagery=false, so featureless runs still pass.
# ---------------------------------------------------------------------------
IMAGERY=$(curl -sS "${BASE}/api/v1/meta" | jq -r '.features.imagery // false')
if [ "$IMAGERY" = "true" ]; then
  # Tile URLs carry media tokens, not session JWTs.
  R=$(api POST /api/v1/auth/media-token "$TOK_D")
  [ "$(code_of "$R")" = "200" ] || fail "media token (demo)"
  MEDIA_D=$(jq_get "$(body_of "$R")" '.token')

  # z15 XYZ tile over the demo parcel centroid (slippy math in awk).
  R=$(api GET "/api/v1/parcels/${VIGNETO}" "$TOK_D")
  CLON=$(jq_get "$(body_of "$R")" '.centroid.lon')
  CLAT=$(jq_get "$(body_of "$R")" '.centroid.lat')
  TXY=$(awk -v lon="$CLON" -v lat="$CLAT" 'BEGIN{
    pi=atan2(0,-1); z=15; n=2^z;
    x=int((lon+180.0)/360.0*n);
    r=lat*pi/180.0; t=sin(r)/cos(r);
    y=int((1.0 - log(t+sqrt(t*t+1.0))/pi)/2.0*n);
    printf "%d %d", x, y }')
  TX=${TXY% *}; TY=${TXY#* }

  TILE="$(mkt arvo-tile .png)"
  CODE=$(curl -sS -o "$TILE" -w '%{http_code}' "${BASE}/api/v1/tiles/${VIGNETO}/ndvi/15/${TX}/${TY}.png?token=${MEDIA_D}")
  [ "$CODE" = "200" ] || fail "tile fetch (${CODE})"
  MAGIC=$(od -An -tx1 -N4 "$TILE" | tr -d ' \n')
  [ "$MAGIC" = "89504e47" ] || fail "tile is not a PNG (magic=${MAGIC})"
  pass "raster tile PNG (z15 ${TX}/${TY}, $(wc -c < "$TILE" | tr -d ' ') bytes, magic 89504e47)"

  TIF="$(mkt arvo-idx .tif)"
  CODE=$(curl -sS -o "$TIF" -w '%{http_code}' "${BASE}/api/v1/parcels/${VIGNETO}/indices/ndvi.tif?token=${MEDIA_D}")
  [ "$CODE" = "200" ] || fail "geotiff export (${CODE})"
  [ -s "$TIF" ] || fail "geotiff export is empty"
  TMAGIC=$(od -An -tx1 -N2 "$TIF" | tr -d ' \n')
  case "$TMAGIC" in 4949|4d4d) : ;; *) fail "geotiff bad TIFF magic (${TMAGIC})";; esac
  pass "GeoTIFF export ($(wc -c < "$TIF" | tr -d ' ') bytes, TIFF magic ${TMAGIC})"
else
  warn "imagery feature off — skipping tile/GeoTIFF steps (FR-0-027)"
fi

echo "== ALL ${N} STEPS PASSED =="
