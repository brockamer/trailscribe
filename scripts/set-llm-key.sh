#!/usr/bin/env bash
# scripts/set-llm-key.sh — install an OpenRouter key without it touching a
# command line, shell history, the process list or the terminal.
#
#   scripts/set-llm-key.sh dev    # .dev.vars + the staging Worker
#   scripts/set-llm-key.sh prod   # the production Worker
#
# The key is typed at a silent prompt, checked against OpenRouter first, and
# reaches Wrangler on stdin. Nothing is written anywhere if the check fails.
# OpenRouter shows a key once, so it is also recorded in ~/.secrets as
# OPENROUTER_TRAILSCRIBE_DEV / OPENROUTER_TRAILSCRIBE_PROD, before Wrangler is
# touched, so a failed deploy cannot lose it.
# The script prints the key's credit limit and usage, never the key.
#
# Run it in your own terminal, not through Claude Code's `!` prefix, which
# would put the session in the conversation transcript.
#
# Environment overrides:
#   PROD_URL      production Worker base URL (default: the workers.dev pattern;
#                 staging's real URL is in docs/, prod's is inferred from it)
#   STAGING_URL   staging Worker base URL
#   DEV_VARS_FILE file to update for `dev` (default: .dev.vars)
#   SECRETS_FILE  secrets record to update (default: ~/.secrets)
#   DRY_RUN=1     skip OpenRouter, Wrangler and /health; only rewrite the file.
#                 For testing the script itself with a dummy key.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  dev | prod) ;;
  *)
    echo "usage: $0 dev|prod" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."

DEV_VARS_FILE="${DEV_VARS_FILE:-.dev.vars}"
SECRETS_FILE="${SECRETS_FILE:-$HOME/.secrets}"
STAGING_URL="${STAGING_URL:-https://trailscribe-staging.trailscribe.workers.dev}"
PROD_URL="${PROD_URL:-https://trailscribe.trailscribe.workers.dev}"
DRY_RUN="${DRY_RUN:-0}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

KEY=""
trap 'KEY=""; unset KEY' EXIT

if [ "$TARGET" = "prod" ]; then
  label="PRODUCTION"
else
  label="DEV"
fi

printf 'Paste the %s OpenRouter key (input is hidden), then press Enter: ' "$label" >&2
IFS= read -rs KEY
printf '\n' >&2
KEY="${KEY//[$'\r\n\t ']/}" # a pasted key often carries a trailing newline or space

if [ "${#KEY}" -lt 8 ]; then
  echo "That is shorter than 8 characters (env.ts requires at least 8). Nothing changed." >&2
  exit 1
fi

# --- 1. Validate against OpenRouter -----------------------------------------
if [ "$DRY_RUN" != "1" ]; then
  # The Authorization header goes through a file descriptor, not argv.
  body="$(curl -sS --max-time 20 https://openrouter.ai/api/v1/auth/key \
    -H @<(printf 'Authorization: Bearer %s' "$KEY") || true)"
  if ! printf '%s' "$body" | jq -e '.data' >/dev/null 2>&1; then
    echo "OpenRouter rejected the key (or was unreachable). Nothing changed." >&2
    printf '%s' "$body" | jq -r '.error.message // empty' 2>/dev/null >&2 || true
    exit 1
  fi
  echo "OpenRouter accepts the key:" >&2
  printf '%s' "$body" | jq '.data | {limit, limit_remaining, usage}' >&2
  if [ "$TARGET" = "dev" ] && [ "$(printf '%s' "$body" | jq '.data.limit')" = "null" ]; then
    echo "WARNING: this dev key has no credit limit. Set one in OpenRouter (about \$5)." >&2
  fi
fi

if [ "$TARGET" = "prod" ] && [ "$DRY_RUN" != "1" ]; then
  printf 'Set this key as LLM_API_KEY on the PRODUCTION Worker now? [y/N] ' >&2
  IFS= read -r answer
  [ "$answer" = "y" ] || { echo "Cancelled. Nothing changed." >&2; exit 1; }
fi

# --- 2. Record the key in ~/.secrets (shown once by OpenRouter) -------------
if [ "$TARGET" = "prod" ]; then
  secret_name="OPENROUTER_TRAILSCRIBE_PROD"
else
  secret_name="OPENROUTER_TRAILSCRIBE_DEV"
fi
KEY="$KEY" SECRETS_FILE="$SECRETS_FILE" SECRET_NAME="$secret_name" python3 - <<'PY'
import os, re, sys
path, key, name = os.environ["SECRETS_FILE"], os.environ["KEY"], os.environ["SECRET_NAME"]
text = open(path).read() if os.path.isfile(path) else ""
pat = re.compile(r"(?m)^(\s*(?:export\s+)?)" + re.escape(name) + r"=.*$")
hits = len(pat.findall(text))
if hits > 1:
    sys.exit(f"{path} has {hits} {name} lines; fix it by hand. Nothing changed.")
if hits == 1:
    text = pat.sub(lambda m: m.group(1) + name + "=" + key, text)
    action = "replaced"
else:
    text += ("" if text.endswith("\n") or not text else "\n") + "export " + name + "=" + key + "\n"
    action = "added"
new_file = not os.path.isfile(path)
open(path, "w").write(text)  # same inode, so an existing mode (600) is kept
if new_file:
    os.chmod(path, 0o600)
back = re.search(r"(?m)^\s*(?:export\s+)?" + re.escape(name) + r"=(.*)$", open(path).read()).group(1)
print(f"{path}: {name} {action} ({'verified' if back == key else 'MISMATCH'})", file=sys.stderr)
sys.exit(0 if back == key else 1)
PY

# --- 3. dev: rewrite the LLM_API_KEY line in .dev.vars ----------------------
if [ "$TARGET" = "dev" ]; then
  if [ ! -f "$DEV_VARS_FILE" ]; then
    echo "$DEV_VARS_FILE does not exist (copy .dev.vars.example first). Nothing changed." >&2
    exit 1
  fi
  KEY="$KEY" DEV_VARS_FILE="$DEV_VARS_FILE" python3 - <<'PY'
import os, re, sys
path, key = os.environ["DEV_VARS_FILE"], os.environ["KEY"]
text = open(path).read()
hits = len(re.findall(r"(?m)^LLM_API_KEY=", text))
if hits > 1:
    sys.exit(f"{path} has {hits} LLM_API_KEY lines; fix it by hand. Nothing changed.")
if hits == 1:
    text = re.sub(r"(?m)^LLM_API_KEY=.*$", lambda m: "LLM_API_KEY=" + key, text)
else:
    text += ("" if text.endswith("\n") or not text else "\n") + "LLM_API_KEY=" + key + "\n"
open(path, "w").write(text)  # same inode, so the file mode (600) is kept
# Read back and compare, reporting only the result.
back = re.search(r"(?m)^LLM_API_KEY=(.*)$", open(path).read()).group(1)
print(f"{path}: LLM_API_KEY written ({'verified' if back == key else 'MISMATCH'}, {len(key)} chars)",
      file=sys.stderr)
sys.exit(0 if back == key else 1)
PY
fi

# --- 4. Wrangler secret + /health -------------------------------------------
if [ "$TARGET" = "dev" ]; then
  wrangler_env="staging"
  health_url="$STAGING_URL/health"
else
  wrangler_env="production"
  health_url="$PROD_URL/health"
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY_RUN: skipped wrangler secret put (--env $wrangler_env) and $health_url" >&2
  exit 0
fi

printf '%s' "$KEY" | pnpm exec wrangler secret put LLM_API_KEY --env "$wrangler_env" >&2
echo "Wrangler: LLM_API_KEY set on the $wrangler_env Worker." >&2

echo "Checking $health_url (env_ok should be true):" >&2
curl -sS --max-time 20 "$health_url" >&2 || echo "(health check failed: verify the URL)" >&2
printf '\n' >&2

if [ "$TARGET" = "prod" ]; then
  echo "Next: send one real !ai from the device, then revoke the old key." >&2
fi
