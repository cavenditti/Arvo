#!/usr/bin/env bash

set -euo pipefail

if ! command -v eas >/dev/null 2>&1; then
  echo "EAS CLI is required. Install it with: npm install --global eas-cli"
  exit 1
fi

echo "Running release checks..."
npm run lint
npm run typecheck

echo "Confirming Expo authentication..."
eas whoami

echo "Starting the production iOS build and TestFlight submission..."
exec eas build \
  --platform ios \
  --profile production \
  --auto-submit \
  --non-interactive \
  "$@"
