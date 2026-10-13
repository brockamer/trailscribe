#!/usr/bin/env bash
# garmin-spec-watch.sh — report new revision rows in Garmin's IPC developer guides (#283).
#
# Why this exists: the reply design was built on a 2024 copy of IPC Inbound, and the
# change of the message maximum from 160 to 1600 characters went unnoticed for almost two
# years. .github/workflows/garmin-spec-watch.yml downloads both live guides every week and
# runs this script on them; scripts/garmin-spec-watch-test.sh proves it on known cases.
#
# For each document in the JSON, reads <pdf-dir>/<basename of its url>, extracts the
# Revision History table with `pdftotext -layout`, and reports the rows after the tracked
# `version`. "After" means later in the table, never a later date: the dates are not in
# order (Inbound 1.0.8 is dated 2012-05-21, the next row, 1.09, 2012-05-10).
#
# stdout   a JSON array with one element per changed document, carrying the issue `title`
#          and `body` ready to file. `[]` means nothing changed. Diagnostics go to stderr.
# exit 1   a document cannot be trusted: missing, not a PDF, no table, the tracked version
#          not in the table, or a title-page version ("V x.y.z") that is not the table's
#          last row. A parse that went wrong must fail the job, never report "no change".
#
# Usage:  ./scripts/garmin-spec-watch.sh <pdf-dir> [json]
#         (json defaults to materials/garmin-spec-revisions.json)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR="${1:?usage: garmin-spec-watch.sh <pdf-dir> [json]}"
JSON="${2:-$ROOT/materials/garmin-spec-revisions.json}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

die() {
  echo "garmin-spec-watch: $*" >&2
  exit 1
}

# revision_rows <text-file> — one TSV line per table row: version, date, description, author.
# Exits 3 when there is no "Revision History" heading followed by a Date/Version/Description
# header, so a changed layout fails instead of yielding an empty table.
#
# Layout (pdftotext -layout, both guides): the heading on its own line (the contents list
# has it too, but followed by dots and a page number), the header row, then one row per
# revision. A long description wraps onto lines indented to the Description column. Author
# is the last field after a run of 2+ spaces, and some rows have none. A blank line ends
# the table. Columns are measured on the header and on leading spaces only, which are
# ASCII; descriptions hold UTF-8 quotes, and mawk counts bytes.
revision_rows() {
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function flush() {
      if (version != "") print version "\t" date "\t" desc "\t" author
      version = ""
    }
    { line = $0; gsub(/\f/, "", line); gsub(/\t/, " ", line) }
    state == 0 { if (trim(line) == "Revision History") state = 1; next }
    state == 1 {
      if (trim(line) == "") next
      if (line !~ /^ *Date +Version +Description/) { state = 9; exit }
      col = index(line, "Description")
      state = 2
      next
    }
    state == 2 {
      if (line ~ /^ *[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] +[^ ]/) {
        flush()
        rest = trim(line)
        date = substr(rest, 1, 10)
        rest = trim(substr(rest, 11))
        n = index(rest, " ")
        if (n == 0) { version = rest; rest = "" }
        else { version = substr(rest, 1, n - 1); rest = trim(substr(rest, n)) }
        k = split(rest, f, "  +")
        desc = f[1]; author = ""
        if (k >= 2) {
          author = f[k]
          for (j = 2; j < k; j++) desc = desc " " f[j]
        }
        next
      }
      lead = match(line, /[^ ]/) - 1
      if (version != "" && lead >= col - 3 && lead <= col + 1) {
        desc = desc " " trim(line)
        next
      }
      flush()
      state = 3
      exit
    }
    END {
      flush()
      if (state != 2 && state != 3) exit 3
    }
  ' "$1"
}

results="[]"
count=$(jq '.documents | length' "$JSON")
[ "$count" -gt 0 ] || die "$JSON lists no documents"

for ((i = 0; i < count; i++)); do
  name=$(jq -r ".documents[$i].name" "$JSON")
  url=$(jq -r ".documents[$i].url" "$JSON")
  tracked=$(jq -r ".documents[$i].version" "$JSON")
  tracked_sha=$(jq -r ".documents[$i].sha256" "$JSON")
  pdf="$DIR/$(basename "$url")"
  text="$WORK/$i.txt"
  rows="$WORK/$i.tsv"

  [ -f "$pdf" ] || die "$name: $pdf not found"
  # Garmin's CDN could answer 200 with an HTML page; pdftotext would then find no table,
  # but say plainly what went wrong.
  [ "$(head -c 5 "$pdf")" = "%PDF-" ] || die "$name: $pdf is not a PDF (no %PDF- header)"
  pdftotext -layout "$pdf" "$text" 2>"$WORK/pdftotext.err" ||
    die "$name: pdftotext failed on $pdf: $(cat "$WORK/pdftotext.err")"

  title_version=$(sed -n '1,15s/^[[:space:]]*V[[:space:]]\{1,\}\([0-9][0-9.]*\)[[:space:]]*$/\1/p' "$text" | head -n 1)
  updated=$(sed -n '1,15s/^[[:space:]]*Updated:[[:space:]]*\([^[:space:]]*\).*$/\1/p' "$text" | head -n 1)

  revision_rows "$text" >"$rows" ||
    die "$name: no Revision History table with a Date/Version/Description header in $pdf"
  [ -s "$rows" ] || die "$name: the Revision History table in $pdf has no rows"

  total=$(wc -l <"$rows")
  latest=$(tail -n 1 "$rows" | cut -f1)
  # The title page and the table are separate parts of the PDF. If they disagree, the
  # table did not parse to its end (a page break, a new layout), so nothing it says is
  # trustworthy, including "no change".
  [ "$title_version" = "$latest" ] ||
    die "$name: the title page says V ${title_version:-<none>} but the last table row is $latest"

  pos=$(awk -F'\t' -v v="$tracked" '$1 == v { print NR; exit }' "$rows")
  [ -n "$pos" ] || die "$name: the tracked version $tracked is not in the revision table of $pdf"

  sha=$(sha256sum "$pdf" | cut -d' ' -f1)
  if [ "$pos" -eq "$total" ]; then
    echo "$name: no revision after $tracked (title page V $title_version, updated $updated)" >&2
    # A re-upload with no new row is logged for the record and opens no issue.
    if [ "$sha" != "$tracked_sha" ]; then
      echo "::notice::$name: the PDF changed (sha256 $sha) but its revision table has no row after $tracked" >&2
    fi
    continue
  fi

  echo "$name: $((total - pos)) new revision row(s) after $tracked, latest $latest" >&2
  tail -n +"$((pos + 1))" "$rows" >"$WORK/$i.new"
  element=$(jq -n \
    --arg document "$name" --arg tracked "$tracked" --arg latest "$latest" \
    --arg updated "$updated" --arg url "$url" --arg sha256 "$sha" \
    --rawfile tsv "$WORK/$i.new" '
    ($tsv | split("\n") | map(select(length > 0) | split("\t")
      | {version: .[0], date: .[1], description: .[2], author: .[3]})) as $rows
    | {
        document: $document, tracked: $tracked, latest: $latest, updated: $updated,
        url: $url, sha256: $sha256, rows: $rows,
        title: "Garmin IPC spec changed: \($document) \($tracked) -> \($latest)",
        body: ([
          "Garmin published a new revision of the \($document) developer guide. `materials/` tracks \($tracked); the live PDF is \($latest), updated \($updated).",
          "",
          "New rows in its revision table:",
          "",
          "| Date | Version | Description | Author |",
          "| --- | --- | --- | --- |"
        ] + ($rows | map("| \(.date) | \(.version) | \(.description | gsub("\\|"; "\\|")) | \(.author) |")) + [
          "",
          "PDF: \($url)",
          "sha256: `\($sha256)`",
          "",
          "To resolve: read the new revision against the code, replace the PDF in `materials/`, and update `materials/garmin-spec-revisions.json` in the same PR. #282 is the last refresh; #283 built this watch.",
          "",
          "Opened by `.github/workflows/garmin-spec-watch.yml`."
        ] | join("\n"))
      }')
  results=$(jq --argjson e "$element" '. + [$e]' <<<"$results")
done

echo "$results"
