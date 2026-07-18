# Arvo monorepo tasks. Prereqs: docker, rust, node 20+.

.PHONY: db-up db-down migrate api api-imagery ingest seed smoke app app-web \
        check check-api check-app fmt fmt-check lint test

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
