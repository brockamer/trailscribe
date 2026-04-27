#!/usr/bin/env bash
# scripts/cost-measurement.sh — P1-23 cost-measurement driver.
#
# Fires 20 `!post` fixtures at the staging Worker with unique freeText AND
# fresh timeStamps (both required to avoid same-hash idempotent dedup).
# Reads the monthly ledger before + after, prints a delta + per-tx mean.
#
# Prereqs:
#   1. .env.replay populated with STAGING_URL and GARMIN_INBOUND_TOKEN.
#   2. wrangler authenticated (run `pnpm exec wrangler login` once).
#   3. Staging Worker deployed with IPC_INBOUND_DRY_RUN=true, OR pass
#      --allow-real-sends to fire real Garmin replies. Default: aborts if
#      dry-run is off, since 20× real device sends is rarely intended.
#   4. Optionally: `wrangler tail --env staging` running in another terminal
#      for live spot-check of orchestrate_ok / narrative_diag.
#
# Flags:
#   --allow-real-sends   Skip the dry-run safety abort and proceed even if
#                        IPC_INBOUND_DRY_RUN is false on staging.
#
# Outputs: a summary block at the end suitable for pasting as the P1-23
# story-completion note on issue #59.

set -euo pipefail

ALLOW_REAL_SENDS=false
for arg in "$@"; do
  case "$arg" in
    --allow-real-sends) ALLOW_REAL_SENDS=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

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

FIXTURE="$(dirname "$0")/../tests/fixtures/garmin-replay/post-burn-in.json"
if [[ ! -f "$FIXTURE" ]]; then
  echo "Missing fixture: $FIXTURE" >&2
  exit 1
fi

# Wrangler auth precheck — required for the pre/post `kv key get` reads. Without
# auth, the silent `|| echo "{}"` fallback below would mask access errors and
# produce a misleading delta in the summary block. NB: `wrangler whoami` exits 0
# even when unauthenticated; we must grep the output text.
echo "--- Wrangler auth precheck ---"
WHOAMI_OUT=$(pnpm exec wrangler whoami 2>&1 || true)
if echo "$WHOAMI_OUT" | grep -qE "not authenticated|not logged in"; then
  echo "ERROR: wrangler is not authenticated. Cost-measurement reads staging KV;" >&2
  echo "       silent failure here would mask access errors and skew the summary." >&2
  echo "  Fix: pnpm exec wrangler login" >&2
  exit 1
fi
echo "  ✓ wrangler authenticated"
echo

# Dry-run safety check — query the deployed staging Worker's /health endpoint
# (which exposes IPC_INBOUND_DRY_RUN as `dry_run: bool`) and abort if it's off
# unless --allow-real-sends was passed. Without this, forgetting to deploy
# with --var IPC_INBOUND_DRY_RUN:true fires 20 real Garmin replies — the
# specific foot-gun that caused issue #59's first attempt to over-spam the
# operator's device.
HEALTH_URL="${STAGING_URL%/garmin/ipc}/health"
echo "--- Staging dry-run safety check ---"
echo "  GET $HEALTH_URL"
HEALTH=$(curl --silent --max-time 10 --fail "$HEALTH_URL" 2>&1) || {
  echo "ERROR: failed to fetch $HEALTH_URL — staging worker unreachable?" >&2
  echo "$HEALTH" >&2
  exit 1
}
DRY_RUN=$(echo "$HEALTH" | jq -r '.dry_run // "missing"')
case "$DRY_RUN" in
  true)
    echo "  ✓ staging is in dry-run mode (no real device sends)"
    ;;
  false)
    if [[ "$ALLOW_REAL_SENDS" == "true" ]]; then
      echo "  ⚠  staging is NOT in dry-run mode and --allow-real-sends was passed."
      echo "     20× real Garmin device replies WILL fire on the operator's inReach."
      echo "     Sleeping 5s — Ctrl-C now to abort."
      sleep 5
    else
      echo "ERROR: staging worker has IPC_INBOUND_DRY_RUN=false." >&2
      echo "       This script would fire 20 real Garmin device replies." >&2
      echo "  Fix:  pnpm exec wrangler deploy --env staging --var IPC_INBOUND_DRY_RUN:true" >&2
      echo "  Or:   re-run with --allow-real-sends if real-device sends are intended." >&2
      exit 1
    fi
    ;;
  missing)
    echo "ERROR: /health response did not include dry_run field. Worker may be" >&2
    echo "       running an older revision than src/app.ts. Redeploy staging." >&2
    echo "  Response: $HEALTH" >&2
    exit 1
    ;;
  *)
    echo "ERROR: unexpected dry_run value: $DRY_RUN" >&2
    echo "  Response: $HEALTH" >&2
    exit 1
    ;;
esac
echo

# Varied note text spanning the three personas + prompt-length variance, so
# the per-call cost reflects realistic field traffic rather than 20× the
# same prompt.
NOTES=(
  "alpenglow over Mount Whitney, granite glowing pink"
  "found a lupine meadow at 11k ft, scree-covered north face"
  "ridge gusts 40mph at Forester Pass, ice on the cables"
  "marmot in camp eating my cous-cous, classic"
  "summit Whitney 0612, 28F, no wind, perfect bluebird"
  "snow line dropping fast, 2 inches overnight at base camp"
  "stream crossing Kearsarge sketchy, water knee-deep and cold"
  "creek frozen this morning at Charlotte Lake, no liquid water"
  "JMT day 14, knees holding up, pack at 32 lbs"
  "bear canister mandatory above 9500ft per regs"
  "saw three ptarmigan above the col, snowy plumage"
  "navigated talus by headlamp, finally at Bishop Pass"
  "altitude headache 13k, pushing fluids and ibuprofen"
  "weather window 6h before next system rolls in tomorrow"
  "forest fire haze settling in valley, eyes burning"
  "found rare alpine columbine, flagging for return trip"
  "Forester Pass closed by NPS due to active rockfall"
  "trout rising in tarn at sunset, fly fishing tomorrow"
  "lightning offshore over Owens Valley, counting Mississippi"
  "summit register at Whitney signed, descending now"
)

if [[ ${#NOTES[@]} -ne 20 ]]; then
  echo "INTERNAL: NOTES array must have exactly 20 entries (got ${#NOTES[@]})" >&2
  exit 1
fi

YYYYMM=$(date -u +"%Y-%m")

echo "=== P1-23 cost measurement: 20× !post ==="
echo "Staging URL: $STAGING_URL"
echo "Period key:  ledger:$YYYYMM"
echo

echo "--- Pre-campaign ledger ---"
PRE=$(pnpm exec wrangler kv key get --binding=TS_LEDGER --env=staging "ledger:$YYYYMM" 2>/dev/null || echo "{}")
echo "$PRE" | jq '{requests, usd_cost, post: .by_command.post}'
PRE_POST_REQ=$(echo "$PRE" | jq -r '.by_command.post.requests // 0')
PRE_POST_USD=$(echo "$PRE" | jq -r '.by_command.post.usd_cost // 0')
echo

echo "--- Firing 20× !post (unique freeText + fresh timeStamp each) ---"
printf "%-3s  %-6s  %s\n" "#" "STATUS" "NOTE"
echo "---  ------  ----"

for i in $(seq 1 20); do
  TS=$(date +%s%3N)
  NOTE="${NOTES[$((i-1))]}"
  FT="!post run${i}: ${NOTE}"
  PAYLOAD=$(jq --arg ts "$TS" --arg ft "$FT" \
    '.Events[0].timeStamp = ($ts | tonumber) | .Events[0].freeText = $ft' \
    "$FIXTURE")

  STATUS=$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --max-time 60 \
    -X POST "$STAGING_URL" \
    -H "X-Outbound-Auth-Token: $GARMIN_INBOUND_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$PAYLOAD")

  printf "%-3s  %-6s  %s\n" "$i" "$STATUS" "$(echo "$NOTE" | cut -c 1-60)"

  if [[ "$STATUS" != "200" ]]; then
    echo "ABORT: call $i returned $STATUS — Garmin would retry; investigate before continuing" >&2
    exit 2
  fi

  # Pace the loop so async tail/journal-commit work settles between calls
  # and we don't trip OpenRouter / GitHub rate limits.
  sleep 6
done

echo
echo "--- Settling pause (10s for ledger writes to flush) ---"
sleep 10

echo "--- Post-campaign ledger ---"
POST=$(pnpm exec wrangler kv key get --binding=TS_LEDGER --env=staging "ledger:$YYYYMM" 2>/dev/null || echo "{}")
echo "$POST" | jq '{requests, usd_cost, post: .by_command.post}'
POST_POST_REQ=$(echo "$POST" | jq -r '.by_command.post.requests // 0')
POST_POST_USD=$(echo "$POST" | jq -r '.by_command.post.usd_cost // 0')
echo

DELTA_REQ=$((POST_POST_REQ - PRE_POST_REQ))
DELTA_USD=$(awk -v a="$POST_POST_USD" -v b="$PRE_POST_USD" 'BEGIN{printf "%.7f", a - b}')
MEAN=$(awk -v u="$DELTA_USD" -v n="$DELTA_REQ" 'BEGIN{ if (n>0) printf "%.7f", u/n; else print "n/a" }')

echo "=== Summary ==="
echo "post.requests:  $PRE_POST_REQ → $POST_POST_REQ  (Δ $DELTA_REQ)"
echo "post.usd_cost:  $PRE_POST_USD → $POST_POST_USD  (Δ \$$DELTA_USD)"
echo "mean per !post: \$$MEAN"
echo "PRD ceiling:    \$0.05/tx (hard \$0.08)"
if [[ "$DELTA_REQ" != "20" ]]; then
  echo "WARN: expected Δ=20, got Δ=$DELTA_REQ — possible dedup or ledger-write failure" >&2
fi
