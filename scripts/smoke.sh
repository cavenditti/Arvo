#!/usr/bin/env bash
# Arvo end-to-end API acceptance (PHASE0 §8). Requires the API running on $BASE and the
# demo tenant seeded (`arvo-api seed --demo`). curl + jq only. Prints `PASS <n>` per step.
#
#   PORT=8787 bash scripts/smoke.sh
#
# Network-dependent steps (Open-Meteo, Earth Search STAC) are tolerant: they assert the API
# handled the request, and only WARN (never fail) when the upstream is unreachable.
set -euo pipefail

PORT="${PORT:-8787}"
BASE="http://localhost:${PORT}"
COMPOSE="docker compose -f infra/docker-compose.yml"

N=0
pass() { N=$((N + 1)); echo "PASS ${N} — $1"; }
fail() { echo "FAIL — $1" >&2; exit 1; }
warn() { echo "WARN — $1" >&2; }

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
TMPJPG="$(mktemp -t arvo-smoke).jpg"
base64 -d > "$TMPJPG" <<'B64'
/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a
HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA
AAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==
B64
R=$(curl -sS -w $'\n%{http_code}' -H "Authorization: Bearer ${TOK_A}" -F "file=@${TMPJPG};type=image/jpeg" "${BASE}/api/v1/observations/${OID}/photos")
[ "$(code_of "$R")" = "201" ] || fail "photo upload ($(code_of "$R"))"
PHOTO_PATH=$(jq_get "$(body_of "$R")" '.path')
pass "photo upload (${PHOTO_PATH})"

R=$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}${PHOTO_PATH}")
[ "$R" = "200" ] || fail "GET ${PHOTO_PATH} served (${R})"
pass "GET /uploads served the photo"

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
echo "$(body_of "$R")" | head -1 | grep -q '^observed_at,mean' || fail "csv header missing"
[ "$(body_of "$R" | wc -l)" -ge 2 ] || fail "csv has no data rows"
pass "indices CSV export"

# No state filter: the alert may already be acked/snoozed from a prior run — we only assert it exists.
R=$(api GET "/api/v1/alerts?parcel_id=${VIGNETO}" "$TOK_D")
[ "$(code_of "$R")" = "200" ] || fail "list alerts"
ALERT_ID=$(echo "$(body_of "$R")" | jq -r '.[] | select(.kind=="index_drop") | .id' | head -1)
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
echo "$(body_of "$R")" | grep -q 'prescrizione agronomica' || fail "report missing decision-support disclaimer"
pass "season report HTML (disclaimer present)"

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

AUDIT=$(${COMPOSE} exec -T -e PGPASSWORD=arvo db psql -U arvo -d arvo -tAc "SELECT count(*) FROM audit_log;" | tr -d '[:space:]')
[ "${AUDIT:-0}" -gt 0 ] || fail "audit_log empty"
pass "audit rows present (${AUDIT})"

rm -f "$TMPJPG"
echo "== ALL ${N} STEPS PASSED =="
