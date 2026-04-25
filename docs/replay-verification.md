# P1-22 — Idempotency Replay Verification

Manual procedure to verify that re-delivering the same Garmin webhook payload to staging produces no duplicate side-effects. Closes the PRD success criterion *"0 duplicate side-effects across 10 manual replays."*

## What replay safety means here

Garmin retries an Outbound webhook on this schedule when our 200 is delayed or the response is missing: **2 / 4 / 8 / 16 / 32 / 64 / 128 seconds, then 12-hour pauses for 5 days**. Without idempotency, a slow LLM call or a transient network blip means the user sees their `!post` published twice, gets two emails, or sees two Todoist tasks. The fix is the per-op `withCheckpoint` helper (P1-13) — every side-effecting step writes its result to `TS_IDEMPOTENCY` KV under a sha256 key derived from `imei + timeStamp + messageCode + content_hash`. On replay, completed ops short-circuit.

This doc is the manual verification of that mechanism end-to-end against a real staging deploy.

## Prerequisites (one-time)

1. **Phase 1 deployed to staging.** `pnpm deploy:staging` after PR #81 is merged.
2. **All required secrets in staging:**
   ```bash
   wrangler secret put GARMIN_INBOUND_TOKEN --env staging
   wrangler secret put LLM_API_KEY          --env staging
   wrangler secret put GITHUB_JOURNAL_TOKEN --env staging
   wrangler secret put RESEND_API_KEY       --env staging
   wrangler secret put TODOIST_API_TOKEN    --env staging
   ```
3. **Journal repo (#56 P1-20) exists** with a working theme + the `JOURNAL_URL_TEMPLATE` pinned to its actual URL pattern.
4. **`.env.replay`** in repo root (gitignored — `.env.*` pattern):
   ```bash
   STAGING_URL=https://trailscribe-staging.trailscribe.workers.dev/garmin/ipc
   GARMIN_INBOUND_TOKEN=<paste the same value you used in `wrangler secret put`>
   ```

## Procedure (per command)

The verification runs three times — once each for `!post`, `!mail`, `!todo`. Other commands (`!ping`, `!help`, `!cost`) are read-only or trivial-side-effect; replay safety for them is structural and covered by the unit tests in `tests/idempotency.test.ts` and `tests/p1-19-commands.test.ts`.

### Per-run prep

1. Edit `tests/fixtures/garmin-replay/<cmd>-replay.json`:
   - `imei` → your allowlisted IMEI (must match `IMEI_ALLOWLIST` in staging vars).
   - `timeStamp` → a unique integer. The idempotency key is derived from this; running with a stale value will collide with a previous test's record. Use `date +%s%3N` to generate a fresh one.
   - For `mail-replay.json`: set the `to:` recipient in `freeText` to a held-out email you can monitor (don't use a real user's address).

2. Open a second terminal:
   ```bash
   wrangler tail --env staging
   ```
   Leave it running so you can watch logs in real time.

3. Run the driver:
   ```bash
   ./scripts/replay-test.sh post 10
   # or: ./scripts/replay-test.sh mail 10
   # or: ./scripts/replay-test.sh todo 10
   ```

   Each invocation sends 10 identical POSTs at 1s intervals. Every one should return HTTP 200 (the script asserts this).

### Assertions

#### Log assertions (from `wrangler tail`)

In a clean replay run you should see:
- **Exactly 1** first-delivery log line — the `event:"orchestrate_ok"` entry with `cmd:"<post|mail|todo>"`.
- **Exactly 9** `event:"idempotent_replay"` log lines (for N=10).
- **Zero** `event:"orchestrate_error"` or `event:"reply_send_failed"` lines.

If you see more than one first-delivery, the idempotency record isn't being written — investigate `app.ts handleEvent`.

If you see fewer than 9 replay logs, something else is intervening (auth failure, IMEI mismatch, bad-envelope) — the script's HTTP 200s alone don't catch this; check the log lines.

#### Side-effect assertions (per command)

**`post`** — exactly 1 new commit on the journal repo's `main`:

```bash
gh api "repos/$GITHUB_JOURNAL_REPO/commits?per_page=5&sha=main" \
  --jq '.[].commit.message'
```

Look for one `trailscribe: <title>` commit whose title matches the LLM-generated title. If there are 10, replay safety is broken at the publish step.

**`mail`** — exactly 1 message in Resend's outbound log:

- Resend dashboard: <https://resend.com/emails> → filter by "to" matching the held-out recipient → confirm count = 1 in the relevant minute.
- Or via API:
  ```bash
  curl -s -H "Authorization: Bearer $RESEND_API_KEY" \
    "https://api.resend.com/emails?limit=20" | jq '.data | map(select(.to[0] == "<held-out>"))'
  ```

**`todo`** — exactly 1 new task in Todoist:

```bash
curl -s -H "Authorization: Bearer $TODOIST_API_TOKEN" \
  "https://api.todoist.com/rest/v2/tasks" | jq '[.[] | select(.content | startswith("replay-test"))] | length'
```

Should print `1`.

#### Ledger assertion (cross-cutting)

After all three replay runs, send `!cost` from the device. Inspect the reply (or query monthly totals via KV):

```bash
wrangler kv:key get --binding=TS_LEDGER --env staging "ledger:$(date -u +%Y-%m)" | jq '.by_command'
```

Expected:
```json
{
  "post": { "requests": 1, "usd_cost": <real-cost-from-LLM> },
  "mail": { "requests": 1, "usd_cost": 0 },
  "todo": { "requests": 1, "usd_cost": 0 }
}
```

If any `requests` shows 10 instead of 1, the ledger write is happening on every replay rather than only on first delivery.

## On failure: forensics

If any side-effect count > 1, fetch the idempotency record to see which step re-executed:

```bash
# Compute the same key the Worker uses (sha256 over imei:ts:msgcode:contentHash).
# Easier: just list all recent idem keys:
wrangler kv:key list --binding=TS_IDEMPOTENCY --env staging | head

# Inspect a specific record:
wrangler kv:key get --binding=TS_IDEMPOTENCY --env staging "idem:<sha256-hex>" | jq
```

The `status` + `completedOps` + `opResults` fields reveal where the pipeline got stuck on the first run; the duplicate count tells you which step's `withCheckpoint` failed to short-circuit.

If `status === "completed"` but a side-effect still duplicated, the bug is in `app.ts` — the replay short-circuit isn't firing before the dispatch.

If `status` is `"processing"` or `"failed"` *and* a side-effect duplicated, the `withCheckpoint` itself isn't reading the cached `opResults` — most likely a serialization issue or a renamed `opName`.

## Story completion note (paste-in template)

When the run is clean, drop this note on issue #58 to close it:

```
## Session <YYYY-MM-DD> — P1-22 verified

Procedure: ./scripts/replay-test.sh <cmd> 10 ran for post / mail / todo.

Logs (wrangler tail):
  post: 1 orchestrate_ok + 9 idempotent_replay (✓)
  mail: 1 orchestrate_ok + 9 idempotent_replay (✓)
  todo: 1 orchestrate_ok + 9 idempotent_replay (✓)

Side effects:
  post: <N>=1 commit on <journal-repo>/main (✓ no duplicates)
  mail: <N>=1 message in Resend log to <held-out> (✓)
  todo: <N>=1 task in Todoist (✓)

Ledger by_command (post-run):
  post: requests=1, usd_cost=$<real>
  mail: requests=1, usd_cost=$0.00
  todo: requests=1, usd_cost=$0.00

Verdict: replay-safe. PRD criterion "0 duplicate side-effects across 10
manual replays" met.
```
