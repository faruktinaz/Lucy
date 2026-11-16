#!/usr/bin/env bash
# One-off migration for exports made before 0.2: renames the legacy status
# values and moves "notes" from a plain string into the notes array.
# Usage: scripts/migrate-v1-notes.sh old-export.json > new-export.json
set -euo pipefail

input="${1:?usage: $0 <export.json>}"

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required for this migration" >&2
  exit 1
fi

jq '
  map(
    .status |= (if . == "open" then "todo" elif . == "closed" then "done" else . end)
    | .tags |= (. // [])
    | del(.notes)
  )
' "$input"
