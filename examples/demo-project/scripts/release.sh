#!/usr/bin/env bash
# Prepares a release: checks the tree, runs the checks and tags the version.
# Usage: scripts/release.sh 0.4.0
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch>" >&2
  exit 64
fi

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: the working tree has uncommitted changes" >&2
  exit 1
fi

if ! grep -q "## \[$version\]" CHANGELOG.md; then
  echo "error: CHANGELOG.md has no section for $version" >&2
  exit 1
fi

echo "Running checks"
bun test
bun run typecheck
(cd tools && go vet ./...)

echo "Tagging v$version"
git tag --annotate "v$version" --message "Orbit $version"
echo "Done. Push with: git push origin v$version"
