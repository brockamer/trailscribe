#!/usr/bin/env bash
# check-mapshare.sh — verify the MapShare slug + access code for the CURRENT device.
#
# Why this exists: only a real Start/Stop Track cycle exercises MAPSHARE_PASSWORD in
# production, and that path sends no error reply on failure. This script tests the same
# credential from your laptop, for free, before you rely on it off-grid.
#
# The access code is read with `read -s` (never echoed, never in your shell history,
# never passed as an argv that shows up in `ps`).
#
# Usage:  ./scripts/check-mapshare.sh [slug]        (slug defaults to "trailscribe")
set -uo pipefail

SLUG="${1:-trailscribe}"
BASE="https://share.garmin.com"
FEED="$BASE/Feed/Share/$SLUG"

echo "Feed: $FEED"
echo

# --- Step 1: does the page exist at all? -------------------------------------------
# Calibrated 2026-09-11 against a known-bogus slug:
#   401 = page EXISTS and is password-protected   (what we want)
#   200 = NO such page -> Garmin serves an empty feed  (silent-failure case)
UNAUTH=$(curl -sS -o /dev/null -m 20 -w '%{http_code}' "$FEED")
case "$UNAUTH" in
  401) echo "[1/2] slug '$SLUG': EXISTS, password-protected (HTTP 401) — correct." ;;
  200) echo "[1/2] slug '$SLUG': HTTP 200 unauthenticated."
       echo "      WARNING: a NON-EXISTENT slug also returns 200 with an empty feed."
       echo "      Either this page has no access code, or the slug is wrong." ;;
  *)   echo "[1/2] slug '$SLUG': unexpected HTTP $UNAUTH — check $BASE/$SLUG in a browser." ;;
esac
echo

# --- Step 2: does the access code work? --------------------------------------------
printf 'MapShare access code (input hidden, press Enter to skip): '
read -rs CODE; echo; echo
if [ -z "${CODE:-}" ]; then echo "[2/2] skipped."; exit 0; fi

# Garmin uses HTTP Basic with an EMPTY username and the access code as the password.
# Window: last 30 days, matching what the Worker asks for on a Stop Track.
D1=$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
CODE_HTTP=$(curl -sS -m 30 -o "$BODY" -w '%{http_code}' -u ":$CODE" "$FEED?d1=$D1")
unset CODE

case "$CODE_HTTP" in
  200)
    PINGS=$(grep -c '<Placemark' "$BODY" 2>/dev/null || echo 0)
    echo "[2/2] access code ACCEPTED (HTTP 200)."
    echo "      placemarks in last 30 days: $PINGS"
    if [ "$PINGS" -eq 0 ]; then
      echo "      NOTE: authenticated but empty. Expected if you have not tracked recently."
      echo "      In production this logs 'track_no_pings' and refuses to publish (#197)."
    fi
    ;;
  401|403)
    echo "[2/2] access code REJECTED (HTTP $CODE_HTTP)."
    echo "      The MAPSHARE_PASSWORD secret will fail the same way."
    echo "      Fix: Garmin Explore -> MapShare -> Access Code, then:"
    echo "        echo -n '<code>' | pnpm exec wrangler secret put MAPSHARE_PASSWORD --env production"
    ;;
  *) echo "[2/2] unexpected HTTP $CODE_HTTP" ;;
esac
