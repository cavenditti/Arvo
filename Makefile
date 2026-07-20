# Arvo monorepo tasks. Prereqs: docker, rust, node 20+.

.PHONY: db-up db-down migrate api api-imagery ingest seed smoke app app-web \
        check check-api check-app fmt fmt-check lint test \
        worker worker-once worker-imagery seed-plants odm-pull \
        detect-up detect-build detect-down detect-logs

# Compose looks for `.env` next to the compose file (infra/), not at the repo root, and make
# does not export it either — so the targets that need a root-.env value source it, exactly
# like `smoke` does. Keeps every plant-tier knob in the one file the backend already reads.
DOTENV = set -a; [ -f .env ] && . ./.env; set +a

db-up:
	docker compose -f infra/docker-compose.yml up -d --wait

db-down:
	docker compose -f infra/docker-compose.yml down

migrate: db-up
	cd backend && cargo run -p arvo-api -- migrate

api: db-up
	cd backend && cargo run -p arvo-api -- serve

# Serve with real satellite pixel compute + raster tiles/GeoTIFF (needs system GDAL).
api-imagery: db-up
	cd backend && cargo run -p arvo-api --features imagery -- serve

# Refresh STAC scenes and compute NDVI & co. from Sentinel-2 COGs (needs system GDAL).
ingest: db-up
	cd backend && cargo run -p arvo-api --features imagery -- ingest-imagery

seed: db-up
	cd backend && cargo run -p arvo-api -- seed --demo

# Honors PORT from .env so smoke always targets the same port `make api` serves on.
smoke:
	set -a; [ -f .env ] && . ./.env; set +a; bash scripts/smoke.sh

app:
	cd app && npx expo start

app-web:
	cd app && npx expo start --web

# --- Plant tier (Phase P) — all optional; nothing above depends on any of it --------------

# Capture pipeline runner: claims pipeline_jobs and drives sfm -> detect -> register -> extract.
worker: db-up
	$(DOTENV); cd backend && cargo run -p arvo-worker -- run --interval-secs "$${WORKER_INTERVAL:-5}"

# Drain every runnable job, then exit (smoke/CI). Exits 1 if any job ended `failed`.
worker-once: db-up
	$(DOTENV); cd backend && cargo run -p arvo-worker -- run --once

# Real pixel work (ODM products, CHM crowns, per-plant sampling); needs system GDAL.
# Without it only `source="demo"` captures run end to end.
worker-imagery: db-up
	$(DOTENV); cd backend && cargo run -p arvo-worker --features imagery -- run --interval-secs "$${WORKER_INTERVAL:-5}"

# Demo orchard block + one extracted capture inside the `make seed` demo tenant (run that first).
seed-plants: db-up
	cd backend && cargo run -p arvo-api -- seed --demo-plants

# Plant detector service (services/plant-detect). Optional: when PLANT_DETECT_URL is set the
# worker's `detect` stage calls it and covers vine/row_segment too; when it is unset or down the
# worker falls back to its in-process CV path (docs/API-PLANT.md §Detection).
detect-up:
	$(DOTENV); docker compose -f infra/docker-compose.yml --profile plant up -d --wait plant-detect

detect-build:
	$(DOTENV); docker compose -f infra/docker-compose.yml --profile plant build plant-detect

detect-down:
	$(DOTENV); docker compose -f infra/docker-compose.yml --profile plant stop plant-detect

detect-logs:
	$(DOTENV); docker compose -f infra/docker-compose.yml --profile plant logs -f plant-detect

# Pre-pull the ODM image the sfm stage shells out to (multi-GB — do it before the first flight).
odm-pull:
	$(DOTENV); docker compose -f infra/docker-compose.yml --profile odm pull odm

check: check-api check-app

check-api:
	cd backend && cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace

check-app:
	cd app && npx tsc --noEmit && npm run --silent lint

fmt:
	cd backend && cargo fmt

fmt-check:
	cd backend && cargo fmt --check

lint:
	cd backend && cargo clippy --workspace --all-targets -- -D warnings

test:
	cd backend && cargo test --workspace
