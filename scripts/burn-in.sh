#!/usr/bin/env bash
# scripts/burn-in.sh — P1-21 staging burn-in driver.
#
# Sends one fixture per command (!ping, !help, !cost, !post, !mail, !todo) to
# the staging Worker with a fresh timeStamp each, exercising real third-party
# APIs (OpenRouter, Resend, Todoist, GitHub Pages). Records each response and
# prints a summary table.
#
# Prerequisites:
#   1. .env.replay populated with STAGING_URL and GARMIN_INBOUND_TOKEN
#      (gitignored; same file replay-test.sh uses).
#   2. `wrangler tail --env staging` running in another terminal (for log
#      capture into the P1-21 completion note).
#
# This is a one-shot burn-in, NOT a replay/dedupe test (use replay-test.sh
# for that). Each command fires exactly once with a unique timestamp.

set -euo pipefail

ENV_FILE="$(dirname "$0")/../.env.replay"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — see scripts/replay-test.sh for format." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$ENV_FILE"

if [[ -z "${STAGING_URL:-}" || -z "${GARMIN_INBOUND_TOKEN:-}" ]]; then
  echo ".env.replay must export STAGING_URL and GARMIN_INBOUND_TOKEN" >&2
  exit 1
fi

FIXDIR="$(dirname "$0")/../tests/fixtures/garmin-replay"

# Order matters: cheap+side-effect-free commands first, expensive last,
# so the run aborts early on any failure without spending money.
CMDS=(ping help cost post mail todo)

printf "%-6s  %-6s  %s\n" "CMD" "STATUS" "FIXTURE"
echo "------  ------  -------"

for CMD in "${CMDS[@]}"; do
  FIXTURE="$FIXDIR/${CMD}-burn-in.json"
  if [[ ! -f "$FIXTURE" ]]; then
    echo "MISSING fixture: $FIXTURE" >&2
    exit 1
  fi
  # Stamp the fixture with the current epoch ms so each run gets a fresh
  # idempotency key (no replay dedup).
  TS=$(date +%s%3N)
  PAYLOAD=$(jq --arg ts "$TS" '.Events[0].timeStamp = ($ts | tonumber)' "$FIXTURE")

  # 60s timeout: gpt-5-mini reasoning + journal commit can take 25-40s on !post.
  STATUS=$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --max-time 60 \
    -X POST "$STAGING_URL" \
    -H "X-Outbound-Auth-Token: $GARMIN_INBOUND_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD")

  printf "%-6s  %-6s  %s\n" "!$CMD" "$STATUS" "$(basename "$FIXTURE") (ts=$TS)"

  if [[ "$STATUS" != "200" ]]; then
    echo "ABORT: $CMD returned $STATUS — Garmin would retry; investigate before continuing" >&2
    exit 2
  fi

  # Brief pause between commands so async work (LLM call, email send, GitHub
  # commit) settles in tail and we don't run into provider-side rate limits.
  sleep 5
done

echo
echo "All 6 commands returned 200. Now verify in:"
echo "  - wrangler tail (orchestrate_ok per command)"
echo "  - GitHub journal repo: 1 new commit from !post"
echo "  - your inbox: 1 email from !mail"
echo "  - Todoist: 1 new task from !todo"
echo "  - !cost output: by-command counts incremented (or inspect TS_LEDGER KV)"
