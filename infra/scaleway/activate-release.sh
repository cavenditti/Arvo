#!/usr/bin/env bash
set -euo pipefail

archive=${1:?usage: activate-release.sh /path/to/arvo-release.tgz}
release_id=$(date -u +%Y%m%d%H%M%S)
release_dir=/opt/arvo/releases/${release_id}
shared_dir=/opt/arvo/shared

install -d -m 0755 "${release_dir}" "${shared_dir}"
tar -xzf "${archive}" -C "${release_dir}"
ln -sfn "${release_dir}" /opt/arvo/current

if [[ ! -f "${shared_dir}/.env.production" ]]; then
  umask 077
  postgres_password=$(openssl rand -hex 32)
  better_auth_secret=$(openssl rand -hex 32)
  media_jwt_secret=$(openssl rand -hex 32)
  printf 'POSTGRES_PASSWORD=%s\nBETTER_AUTH_SECRET=%s\nMEDIA_JWT_SECRET=%s\n' \
    "${postgres_password}" "${better_auth_secret}" "${media_jwt_secret}" \
    > "${shared_dir}/.env.production"
fi

cd /opt/arvo/current
docker compose \
  --env-file "${shared_dir}/.env.production" \
  -f infra/docker-compose.production.yml \
  up -d --build

docker compose \
  --env-file "${shared_dir}/.env.production" \
  -f infra/docker-compose.production.yml \
  ps
