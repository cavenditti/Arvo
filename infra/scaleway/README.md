# Scaleway production

Arvo runs as a single-host Docker Compose deployment in Scaleway Paris, behind Caddy's
automatic TLS. PostgreSQL and uploaded field data live in named Docker volumes.

## Current resources

- Project: `Arvo` (`405e5323-69ec-4189-9e01-444937eb0b16`)
- Instance: `arvo-prod` (`ca97ba64-a18c-4240-841b-26f246c339a8`), `DEV1-M`, `fr-par-1`
- Flexible IPv4: `51.15.244.35`
- Security group: `arvo-prod` (`73f7d4d4-972e-47f8-b8ae-b3cdf737bc31`)
- Transactional Email domain: `arvo.farm` (`b7bfb6e9-ce1e-49b7-a621-5465c8d44839`), Essential plan
- Send-only IAM application: `arvo-production-email` (`0b7cde83-1618-44ae-baeb-2793a14eb4b5`)

The firewall exposes TCP 80/443 and UDP 443 publicly. SSH is restricted to the operator
IP recorded in the security group.

## Deploy

From the repository root:

```sh
infra/scaleway/deploy.sh 51.15.244.35
```

The first deployment generates independent database, Better Auth, and media-token secrets
under `/opt/arvo/shared/.env.production`. The send-only `SCW_TEM_API_KEY` is provisioned
separately through IAM. Later releases reuse the secrets and activate a timestamped release
directory at `/opt/arvo/current`.

## DNS

These names resolve to the flexible IPv4:

- `arvo.farm` — public landing page
- `www.arvo.farm` — redirect to the apex
- `app.arvo.farm` — Expo web app and Better Auth
- `api.arvo.farm` — Rust resource API

Scaleway external-domain validation uses `_scaleway-challenge`; its authoritative name
servers are `ns0.dom.scw.cloud` and `ns1.dom.scw.cloud` after validation and registrar cutover.
