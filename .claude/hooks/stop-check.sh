#!/bin/bash
[ "$(jq -r '.stop_hook_active')" = "true" ] && exit 0

ERRORS=""
BIOME=$(pnpm exec biome check --no-errors-on-unmatched . 2>&1) || ERRORS+="$BIOME"$'\n'
# Two projects: plugin code (IINA globals) and tests (Node); see tsconfig*.json.
TSC=$(pnpm run -s typecheck 2>&1) || ERRORS+="$TSC"$'\n'

if [ -n "$ERRORS" ]; then
  jq -n --arg reason "$ERRORS" '{"decision":"block","reason":$reason}'
fi
