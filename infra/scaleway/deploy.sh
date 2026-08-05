#!/usr/bin/env bash
set -euo pipefail

server_ip=${1:?usage: deploy.sh SERVER_IP}
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
release_dir=$(mktemp -d)
archive=${release_dir}/arvo-release.tgz
trap 'rm -rf "${release_dir}"' EXIT

COPYFILE_DISABLE=1 tar -czf "${archive}" \
  --no-xattrs \
  --exclude='app/node_modules' \
  --exclude='app/ios' \
  --exclude='app/.expo' \
  --exclude='app/dist' \
  --exclude='auth-server/node_modules' \
  --exclude='auth-server/dist' \
  --exclude='backend/target' \
  --exclude='backend/var' \
  -C "${repo_dir}" \
  app auth-server backend infra landing services/plant-detect

scp -i /Users/carlo/.ssh/id_rsa "${archive}" "root@${server_ip}:/tmp/arvo-release.tgz"
scp -i /Users/carlo/.ssh/id_rsa \
  "${repo_dir}/infra/scaleway/activate-release.sh" \
  "root@${server_ip}:/tmp/arvo-activate-release.sh"
ssh -i /Users/carlo/.ssh/id_rsa "root@${server_ip}" \
  bash /tmp/arvo-activate-release.sh /tmp/arvo-release.tgz
