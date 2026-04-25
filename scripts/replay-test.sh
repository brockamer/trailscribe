#!/usr/bin/env bash
# replay-test.sh — P1-22 idempotency replay verification (manual driver).
#
# Re-deliver the SAME Garmin webhook payload N times to staging and verify the
# Worker:
#   - returns HTTP 200 every time (Garmin retry-cascade gate);
#   - emits exactly ONE first-delivery log + (N-1) "idempotent_replay" logs;
#   - does NOT re-execute side-effects (no extra blog commit, email, or task).
#
# This is a manual driver: it sends the requests and prints the assertions
# YOU need to verify in external systems (journal repo, Resend dashboard,
# Todoist). It does not auto-verify those — they live behind separate APIs.
#
# Prerequisites (one-time, before first run):
#   1. Phase 1 deployed to staging.
#   2. Wrangler secrets present in staging:
#        wrangler secret put GARMIN_INBOUND_TOKEN --env staging
#        wrangler secret put LLM_API_KEY          --env staging
#        wrangler secret put GITHUB_JOURNAL_TOKEN --env staging
#        wrangler secret put RESEND_API_KEY       --env staging
#        wrangler secret put TODOIST_API_TOKEN    --env staging
#   3. Journal repo (P1-20 / #56) exists with a working theme.
#   4. .env.replay exists in repo root with the matching token + IMEI.
#
# Per-run prep:
#   1. Edit the matching tests/fixtures/garmin-replay/*.json file:
#        - Set "imei" to your real allowlisted IMEI.
#        - For mail-replay.json, set "to:" to a held-out recipient.
#        - Pick a UNIQUE timeStamp (otherwise prior runs' idem records still
#          match — set it to `date +%s%3N` if unsure).
#   2. Pick a command: post | mail | todo
#   3. Run:  ./scripts/replay-test.sh post 10
#
# Output:
#   - Each curl prints HTTP status (expect 200 every time).
#   - Tail wrangler logs in another terminal:  wrangler tail --env staging
#     The first delivery should NOT log idempotent_replay; deliveries 2..N
#     SHOULD log idempotent_replay every time.
#
# Post-run manual checks (the script prints these as a checklist):
#   - GitHub journal repo (post): exactly 1 new commit with the test slug.
#   - Resend dashboard       (mail): exactly 1 message to the held-out address.
#   - Todoist                 (todo): exactly 1 new task.
#   - !cost (run a !ping !cost from device): "post"/"mail"/"todo" by-command
#     count incremented by exactly 1, not by N.

set -euo pipefail

CMD="${1:-}"
N="${2:-10}"

if [[ -z "$CMD" || ! "$CMD" =~ ^(post|mail|todo)$ ]]; then
  echo "Usage: $0 <post|mail|todo> [N=10]" >&2
  exit 64
fi

if ! [[ "$N" =~ ^[0-9]+$ ]] || (( N < 1 )); then
  echo "N must be a positive integer; got: $N" >&2
  exit 64
fi

# Load endpoint + bearer token from .env.replay (gitignored).
ENV_FILE="$(dirname "$0")/../.env.replay"
if [[ ! -f "$ENV_FILE" ]]; then
  cat <<EOF >&2
Missing $ENV_FILE. Create it with:

  STAGING_URL=https://trailscribe-staging.trailscribe.workers.dev/garmin/ipc
  GARMIN_INBOUND_TOKEN=<the staging bearer token, must match wrangler secret>

This file is gitignored.
EOF
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

if [[ -z "${STAGING_URL:-}" || -z "${GARMIN_INBOUND_TOKEN:-}" ]]; then
  echo ".env.replay must export STAGING_URL and GARMIN_INBOUND_TOKEN" >&2
  exit 1
fi

FIXTURE="$(dirname "$0")/../tests/fixtures/garmin-replay/${CMD}-replay.json"
if [[ ! -f "$FIXTURE" ]]; then
  echo "Fixture not found: $FIXTURE" >&2
  exit 1
fi

# Sanity check the fixture has been customized.
if grep -q "REPLACE_WITH_REAL_IMEI" "$FIXTURE"; then
  cat <<EOF >&2
$FIXTURE still contains REPLACE_WITH_REAL_IMEI placeholder.
Edit it before running:
  - "imei":     your allowlisted IMEI
  - "timeStamp": a unique number (e.g. \$(date +%s%3N))
  - For mail:    set "to:<recipient>" in freeText
EOF
  exit 1
fi
if [[ "$CMD" == "mail" ]] && grep -q "REPLACE_WITH_HELDOUT_RECIPIENT" "$FIXTURE"; then
  echo "Set the to: recipient in $FIXTURE" >&2
  exit 1
fi

echo "==================================================================="
echo "P1-22 idempotency replay — $CMD × $N"
echo "Endpoint: $STAGING_URL"
echo "Fixture:  $FIXTURE"
echo
echo "Tail logs in another terminal:  wrangler tail --env staging"
echo "==================================================================="
echo

for i in $(seq 1 "$N"); do
  status=$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --max-time 30 \
    -X POST "$STAGING_URL" \
    -H "Authorization: Bearer $GARMIN_INBOUND_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$FIXTURE")
  if [[ "$status" != "200" ]]; then
    echo "[$i/$N] FAIL — got HTTP $status (expected 200; Garmin retry cascade triggered)"
    exit 2
  fi
  echo "[$i/$N] HTTP $status"
  # Brief pause so the wrangler tail output is readable.
  sleep 1
done

cat <<EOF

==================================================================="
All $N requests returned HTTP 200.

NOW VERIFY MANUALLY (the script can't reach these systems):

[1] wrangler tail output should show:
    - Exactly 1 first-delivery (event=orchestrate_ok or post/mail/todo log)
    - Exactly $((N - 1)) "event":"idempotent_replay" lines

[2] Side-effect verification per command:
EOF

case "$CMD" in
  post)
    echo "    - GitHub journal repo: exactly 1 new commit on \`main\`"
    echo "      gh api repos/<owner>/<journal-repo>/commits --jq '.[0:3] | map(.commit.message)'"
    ;;
  mail)
    echo "    - Resend dashboard: exactly 1 message to the held-out recipient"
    echo "      https://resend.com/emails (filter by recent)"
    ;;
  todo)
    echo "    - Todoist: exactly 1 new task"
    echo "      https://todoist.com/app or curl -H 'Authorization: Bearer \$TODOIST_API_TOKEN' https://api.todoist.com/rest/v2/tasks"
    ;;
esac

cat <<EOF

[3] !cost from the device should show by_command["$CMD"] incremented by 1
    (NOT by $N).

[4] If any side-effect count > 1, replay safety is broken — file a bug
    against P1-22 and inspect:
        wrangler kv:key get --binding=TS_IDEMPOTENCY --env staging "idem:<key>"
    The record's status + completedOps/opResults reveals which step
    re-executed.
EOF
