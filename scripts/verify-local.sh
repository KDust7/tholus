#!/usr/bin/env bash
set -uo pipefail

failures=""

step() {
  local label="$1"
  shift
  printf '\n=== %s ===\n' "$label"
  if "$@"; then
    printf '  ok\n'
  else
    printf '  FAILED\n'
    failures="${failures}
  - ${label}"
  fi
}

regenerates_nothing() {
  local path="$1"
  shift
  local before
  before="$(mktemp -d)"
  cp -r "$path" "$before/snapshot"
  if ! "$@" >/dev/null 2>&1; then
    rm -rf "$before"
    return 1
  fi
  if diff -r "$before/snapshot" "$path" >/dev/null 2>&1; then
    rm -rf "$before"
    return 0
  fi
  printf '  the committed copies are stale; regenerating changed:\n'
  diff -rq "$before/snapshot" "$path" 2>&1 | sed 's/^/    /'
  rm -rf "$before"
  return 1
}

step "Build packages" bun run build
step "Lint" bun run lint
step "Typecheck" bun run typecheck
step "Emitted protocol schemas are current" \
  regenerates_nothing packages/engine-protocol/schema \
  bun run --filter "@tholus/engine-protocol" emit-schema
step "Release readiness" node scripts/check-release-readiness.mjs
step "Public API report is current" regenerates_nothing api bun run api
step "Fork rewrite tests" python -m unittest discover -s scripts -p "test_*.py"

if [ -n "$failures" ]; then
  printf '\nlocal gate failed:%b\n' "$failures"
  exit 1
fi
printf '\nlocal gate is green; the suite and coverage still run separately.\n'
