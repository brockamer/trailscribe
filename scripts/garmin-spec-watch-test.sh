#!/usr/bin/env bash
# garmin-spec-watch-test.sh — prove scripts/garmin-spec-watch.sh against known cases (#283).
#
# Why this exists: the watch runs unattended once a week, and a parser that silently
# reads zero rows would report "no change" forever. So the instrument is tested where
# the answer is already known: the PDFs tracked in materials/ (Inbound 3.1.4, Outbound
# 2.0.10) and the copies they replaced in #282, still in git at 6edf578^ (3.1.1, 2.0.8).
#
# Needs a full clone (for 6edf578^), jq and pdftotext (poppler-utils). No network.
#
# Usage:  ./scripts/garmin-spec-watch-test.sh
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WATCH="$ROOT/scripts/garmin-spec-watch.sh"
JSON="$ROOT/materials/garmin-spec-revisions.json"
OLD_COMMIT="6edf578^"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "ok   - $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL - $1"; [ -n "${2:-}" ] && echo "       $2"; }

# expect_eq <name> <expected> <actual>
expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi
}

# run <dir> <json> — runs the watch; sets OUT (stdout) and CODE (exit status).
run() {
  OUT=$(bash "$WATCH" "$1" "$2" 2>"$TMP/stderr")
  CODE=$?
}

# Lay out each PDF set under the file names the workflow downloads to (the URL basename).
mkdir -p "$TMP/current" "$TMP/old" "$TMP/html" "$TMP/notable" "$TMP/missing"
cp "$ROOT/materials/Garmin IPC Inbound.pdf" "$TMP/current/IPC_Inbound.pdf"
cp "$ROOT/materials/Garmin IPC Outbound.pdf" "$TMP/current/IPC_Outbound.pdf"
git -C "$ROOT" show "$OLD_COMMIT:materials/Garmin IPC Inbound.pdf" >"$TMP/old/IPC_Inbound.pdf"
git -C "$ROOT" show "$OLD_COMMIT:materials/Garmin IPC Outbound.pdf" >"$TMP/old/IPC_Outbound.pdf"

# with_versions <inbound> <outbound> — the committed JSON with other tracked versions.
with_versions() {
  jq --arg i "$1" --arg o "$2" \
    '.documents |= map(if .name == "IPC Inbound" then .version = $i else .version = $o end)' \
    "$JSON" >"$TMP/json-$1-$2.json"
  echo "$TMP/json-$1-$2.json"
}

echo "# The committed JSON agrees with the tracked PDFs"
for name in "IPC Inbound" "IPC Outbound"; do
  pdf=$(jq -r --arg n "$name" '.documents[] | select(.name == $n) | .pdf' "$JSON")
  want=$(jq -r --arg n "$name" '.documents[] | select(.name == $n) | .sha256' "$JSON")
  have=$(sha256sum "$ROOT/$pdf" | cut -d' ' -f1)
  expect_eq "$name: sha256 in the JSON is the sha256 of $pdf" "$want" "$have"
done

echo "# Known change: tracked at 3.1.1 / 2.0.8, live at 3.1.4 / 2.0.10"
run "$TMP/current" "$(with_versions 3.1.1 2.0.8)"
expect_eq "exits 0" "0" "$CODE"
expect_eq "reports both documents, by title" \
  "Garmin IPC spec changed: IPC Inbound 3.1.1 -> 3.1.4|Garmin IPC spec changed: IPC Outbound 2.0.8 -> 2.0.10" \
  "$(jq -r '[.[].title] | join("|")' <<<"$OUT" 2>/dev/null)"
expect_eq "Inbound: new rows in table order" "3.1.2 3.1.3 3.1.4" \
  "$(jq -r '.[] | select(.document == "IPC Inbound") | [.rows[].version] | join(" ")' <<<"$OUT" 2>/dev/null)"
expect_eq "Outbound: new rows in table order" "2.0.9 2.0.10" \
  "$(jq -r '.[] | select(.document == "IPC Outbound") | [.rows[].version] | join(" ")' <<<"$OUT" 2>/dev/null)"
expect_eq "a description that wraps onto a second line is joined (Outbound 2.0.9)" \
  "Update IMEI with Internet Messages when user has multiple devices" \
  "$(jq -r '.[].rows[] | select(.version == "2.0.9") | .description' <<<"$OUT" 2>/dev/null)"
expect_eq "a row with no Author keeps its whole description (Inbound 3.1.2)" \
  "Change message length constraint|" \
  "$(jq -r '.[].rows[] | select(.version == "3.1.2") | .description + "|" + .author' <<<"$OUT" 2>/dev/null)"
expect_eq "the Author column is split from the description (Inbound 3.1.4)" \
  "Major overhaul|NRW" \
  "$(jq -r '.[].rows[] | select(.version == "3.1.4") | .description + "|" + .author' <<<"$OUT" 2>/dev/null)"
expect_eq "the issue body links the live PDF" "true" \
  "$(jq -r '.[] | select(.document == "IPC Inbound") | .body | contains("https://developer.garmin.com/inReach/IPC_Inbound.pdf")' <<<"$OUT" 2>/dev/null)"
expect_eq "the issue body lists each new row" "true" \
  "$(jq -r '.[] | select(.document == "IPC Outbound") | .body | contains("2.0.9") and contains("2.0.10") and contains("Cleanup")' <<<"$OUT" 2>/dev/null)"

echo "# Newer means later in the table, not a later date"
# Inbound 1.0.8 is dated 2012-05-21; the next row, 1.09, is dated 2012-05-10.
run "$TMP/current" "$(with_versions 1.0.8 2.0.10)"
expect_eq "exits 0" "0" "$CODE"
expect_eq "the row after 1.0.8 is reported even though its date is earlier" "1.09" \
  "$(jq -r '.[0].rows[0].version' <<<"$OUT" 2>/dev/null)"

echo "# No change: the tracked versions are the last rows"
run "$TMP/current" "$JSON"
expect_eq "current PDFs, committed JSON: exits 0" "0" "$CODE"
expect_eq "current PDFs, committed JSON: reports nothing" "[]" "$(jq -c . <<<"$OUT" 2>/dev/null)"
run "$TMP/old" "$(with_versions 3.1.1 2.0.8)"
expect_eq "old PDFs, old versions: exits 0" "0" "$CODE"
expect_eq "old PDFs, old versions: reports nothing" "[]" "$(jq -c . <<<"$OUT" 2>/dev/null)"

echo "# Inputs the watch must refuse (exit 1, no report)"
run "$TMP/old" "$JSON"
expect_eq "tracked version not in the table (old PDFs, current JSON): exits 1" "1" "$CODE"
expect_eq "tracked version not in the table: prints no report" "" "$OUT"

printf '<!DOCTYPE html><html><body>Maintenance</body></html>\n' >"$TMP/html/IPC_Inbound.pdf"
cp "$TMP/current/IPC_Outbound.pdf" "$TMP/html/IPC_Outbound.pdf"
run "$TMP/html" "$JSON"
expect_eq "an HTML page saved as the PDF: exits 1" "1" "$CODE"

cp "$ROOT/materials/TrailScribe Deep Research Report.pdf" "$TMP/notable/IPC_Inbound.pdf"
cp "$TMP/current/IPC_Outbound.pdf" "$TMP/notable/IPC_Outbound.pdf"
run "$TMP/notable" "$JSON"
expect_eq "a real PDF with no revision table: exits 1" "1" "$CODE"

cp "$TMP/current/IPC_Outbound.pdf" "$TMP/missing/IPC_Outbound.pdf"
run "$TMP/missing" "$JSON"
expect_eq "a PDF that was not downloaded: exits 1" "1" "$CODE"

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
