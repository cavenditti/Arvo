# Arvo monorepo tasks. Prereqs: docker, rust, node 20+.

.PHONY: db-up db-down migrate api seed smoke app app-web check check-api check-app test

db-up:
	docker compose -f infra/docker-compose.yml up -d --wait

db-down:
	docker compose -f infra/docker-compose.yml down

migrate: db-up
	cd backend && cargo run -p arvo-api -- migrate

api: db-up
	cd backend && cargo run -p arvo-api -- serve

seed: db-up
	cd backend && cargo run -p arvo-api -- seed --demo

smoke:
	bash scripts/smoke.sh

app:
	cd app && npx expo start

app-web:
	cd app && npx expo start --web

check: check-api check-app

check-api:
	cd backend && cargo check --workspace && cargo test --workspace

check-app:
	cd app && npx tsc --noEmit
