#!/usr/bin/env bash
set -uo pipefail

step() {
  printf '\n=== %s ===\n' "$1"
  shift
  if "$@"; then
    printf '  ok\n'
  else
    printf '  FAILED: %s\n' "$*"
    failures="${failures}\n  - $1"
  fi
}

failures=""

step "Build packages" bun run build
step "Lint" bun run lint
step "Typecheck" bun run typecheck
step "Emitted protocol schemas are current" bash -c 'bun run --filter "@tholus/engine-protocol" emit-schema && git diff --exit-code -- packages/engine-protocol/schema'
step "Release readiness" node scripts/check-release-readiness.mjs
step "Public API report is current" bash -c 'bun run api && git diff --exit-code -- api'
step "Fork rewrite tests" python -m unittest discover -s scripts -p "test_*.py"

if [ -n "$failures" ]; then
  printf '\nlocal gate failed:%b\n' "$failures"
  exit 1
fi
printf '\nlocal gate is green; the suite and coverage still run separately.\n'
