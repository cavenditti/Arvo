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
(NDVI & co. from COGs with SCL cloud masking) needs GDAL:

```bash
brew install gdal
cd backend && cargo run -p arvo-api --features imagery -- ingest-imagery
```

Without it, `make seed` synthesizes realistic index series so the full loop (series → anomaly →
alert → report) still runs. See [docs/PHASE0.md](docs/PHASE0.md) for scope, deviations, and the
FR traceability matrix.
