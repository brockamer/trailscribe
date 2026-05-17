#!/usr/bin/env bash
# scripts/format.sh — scoped Prettier wrapper for trailscribe.
#
# Behavior:
#   pnpm format               → formats files currently staged in git (index)
#   pnpm format <path> [...]  → formats the explicit paths instead (replaces
#                               the staged-default)
#   pnpm format:all           → whole-repo sweep (separate script in
#                               package.json; bypasses this wrapper)
#
# Background: PR #190 (closing #189) was nearly contaminated by a reflexive
# `prettier --write .` invocation that reformatted ~60 unrelated files,
# bloating a +4/-2 docs diff to +1068/-840. The repo runs strict
# PR-per-change with squash merges; a default that respects that discipline
# is safer than relying on per-invocation vigilance. See #191.

set -euo pipefail

if [ "$#" -gt 0 ]; then
  # Explicit paths win — caller knows what they want formatted.
  # --ignore-unknown silently skips files Prettier has no parser for
  # (e.g. shell scripts) so a mixed-extension path list doesn't error.
  exec pnpm exec prettier --write --ignore-unknown "$@"
fi

# No args: format only staged files.
# --diff-filter=ACMR excludes Deleted/Unmerged; -z handles paths with spaces.
mapfile -d '' staged < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ "${#staged[@]}" -eq 0 ]; then
  echo "format: nothing staged; no-op. Use 'pnpm format <path>' for explicit paths or 'pnpm format:all' for a whole-repo sweep."
  exit 0
fi

exec pnpm exec prettier --write --ignore-unknown "${staged[@]}"
