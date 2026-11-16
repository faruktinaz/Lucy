#!/usr/bin/env bash
# Starts the API with file watching and seeds it with the sample tasks.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "No .env found; copying .env.example so the defaults apply."
  cp .env.example .env
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed. See https://bun.sh for instructions." >&2
  exit 1
fi

export ORBIT_SEED_FILE="${ORBIT_SEED_FILE:-data/sample-tasks.json}"

echo "Starting Orbit on port ${ORBIT_PORT:-4180} (seed: ${ORBIT_SEED_FILE})"
exec bun --watch src/server/index.ts
