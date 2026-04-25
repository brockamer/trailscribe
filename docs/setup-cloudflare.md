# Cloudflare Setup (first-time)

Step-by-step provisioning for TrailScribe on Cloudflare Workers. Follow once
per environment (staging, production).

## Prerequisites

> **Project-dedicated Cloudflare account.** TrailScribe runs under a
> project-owned Cloudflare account (not any contributor's personal account).
> When you `pnpm wrangler login`, confirm you're authenticating against the
> project account — `pnpm wrangler whoami` will print the account email and
> ID. Account ID for this project: `d445b6851a9736b713eca837cf6254fd`.

- Cloudflare account ([dash.cloudflare.com](https://dash.cloudflare.com))
- Node ≥20 and pnpm 9+ (via `corepack enable`)
- Wrangler CLI (installed as a dev dep; use `pnpm wrangler ...`)
- Authenticated: `pnpm wrangler login`
- Verify: `pnpm wrangler whoami` prints your account ID and email

## 1. Create KV namespaces

TrailScribe needs 4 KV bindings per environment (PRD §3).

```bash
# Development (used by `wrangler dev` with --local)
pnpm wrangler kv namespace create TS_IDEMPOTENCY
pnpm wrangler kv namespace create TS_IDEMPOTENCY --preview
pnpm wrangler kv namespace create TS_LEDGER
pnpm wrangler kv namespace create TS_LEDGER --preview
pnpm wrangler kv namespace create TS_CONTEXT
pnpm wrangler kv namespace create TS_CONTEXT --preview
pnpm wrangler kv namespace create TS_CACHE
pnpm wrangler kv namespace create TS_CACHE --preview

# Staging
pnpm wrangler kv namespace create TS_IDEMPOTENCY --env staging
pnpm wrangler kv namespace create TS_LEDGER --env staging
pnpm wrangler kv namespace create TS_CONTEXT --env staging
pnpm wrangler kv namespace create TS_CACHE --env staging

# Production
pnpm wrangler kv namespace create TS_IDEMPOTENCY --env production
pnpm wrangler kv namespace create TS_LEDGER --env production
pnpm wrangler kv namespace create TS_CONTEXT --env production
pnpm wrangler kv namespace create TS_CACHE --env production
```

Each command prints an `id` (and `preview_id` for the `--preview` variants).
Replace every `PLACEHOLDER_*` in `wrangler.toml` with the real IDs.

Verify:

```bash
pnpm wrangler kv namespace list
```

## 2. Populate secrets

α-MVP requires 10 secrets per environment. See `.dev.vars.example` for the
full list with per-secret provisioning notes.

### Local development

```bash
cp .dev.vars.example .dev.vars    # never commit .dev.vars (gitignored)
# Edit .dev.vars with real values, then:
pnpm dev                          # wrangler dev picks up .dev.vars automatically
```

### Staging / production

```bash
# One at a time — wrangler prompts for the value on stdin
pnpm wrangler secret put GARMIN_INBOUND_TOKEN --env staging
pnpm wrangler secret put GARMIN_IPC_INBOUND_API_KEY --env staging
pnpm wrangler secret put GARMIN_IPC_INBOUND_BASE_URL --env staging
pnpm wrangler secret put IMEI_ALLOWLIST --env staging
pnpm wrangler secret put LLM_API_KEY --env staging
pnpm wrangler secret put TODOIST_API_TOKEN --env staging
pnpm wrangler secret put RESEND_API_KEY --env staging
pnpm wrangler secret put GITHUB_JOURNAL_TOKEN --env staging
pnpm wrangler secret put GITHUB_JOURNAL_REPO --env staging
pnpm wrangler secret put GITHUB_JOURNAL_BRANCH --env staging

# Repeat for --env production.
```

Verify:

```bash
pnpm wrangler secret list --env staging
pnpm wrangler secret list --env production
```

### Generating `GARMIN_INBOUND_TOKEN`

```bash
openssl rand -hex 32
```

Use the same value in:
1. Cloudflare Secret (above)
2. Garmin Portal Connect → IPC Outbound → Static Token field

## 3. First deploy (staging)

```bash
pnpm test             # should be 24/24 green
pnpm typecheck        # clean
pnpm deploy:staging   # wrangler deploy --env staging
```

Wrangler prints the deployed URL. It will look like:
`https://trailscribe-staging.<your-subdomain>.workers.dev`

### Smoke-test the staging endpoint

```bash
STAGING_URL=https://trailscribe-staging.<your-subdomain>.workers.dev
curl -s "$STAGING_URL/"
# Expect: TrailScribe α-MVP (Phase 0)

curl -s "$STAGING_URL/health" | jq .
# Expect: { ok: true, env: "staging", timestamp: "..." }

# Post the canonical V2 fixture:
curl -s -X POST "$STAGING_URL/garmin/ipc" \
  -H "Authorization: Bearer $GARMIN_INBOUND_TOKEN" \
  -H "Content-Type: application/json" \
  --data @tests/fixtures/garmin-outbound-v2-freetext.json
# Expect: ok
```

Tail the logs in another terminal:

```bash
pnpm wrangler tail --env staging
```

You should see JSON log lines for `event_received`, and on a second POST with
the same payload, `idempotent_replay`.

## 4. Point Garmin Portal Connect at staging

See [`garmin-setup.md`](garmin-setup.md) for the full Portal Connect
configuration. Summary:

- IPC Outbound URL: `https://trailscribe-staging.<your-subdomain>.workers.dev/garmin/ipc`
- Schema: V2
- Auth: Static Token = value of `GARMIN_INBOUND_TOKEN`

## 5. Promote to production

Once staging has held up for a week (or sooner if you're impatient), repeat
§1–§3 with `--env production`, then push `main` to trigger
[`deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml). Update
Garmin Portal Connect to point at the production URL.

## Rotation

- `GARMIN_INBOUND_TOKEN`: yearly. Generate new, update both Wrangler Secret
  and Garmin Portal Connect atomically (brief 200-OK-but-log-warn window is OK).
- `GARMIN_IPC_INBOUND_API_KEY`: yearly. Generate new key in Garmin UI (up to
  3 concurrent keys supported), `wrangler secret put`, then revoke the old.
- Other API keys (OpenRouter `LLM_API_KEY`, Todoist, Resend, GitHub PAT):
  rotate per your normal cadence or on suspected compromise.

## Required GitHub Actions secrets

For automated deploy via [`deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml),
add at Settings → Secrets and variables → Actions:

- `CF_API_TOKEN` — create at https://dash.cloudflare.com/profile/api-tokens
  using the "Edit Cloudflare Workers" template
- `CF_ACCOUNT_ID` — from `pnpm wrangler whoami` output

## Troubleshooting

- **`wrangler dev` fails with "workerd binary failed to validate":** the
  runtime needs `libc++1` on Debian-based systems. On a Chromebook LDE or
  arm64 sandbox, local dev may not work — deploy to staging and test there.
- **`wrangler deploy` errors on KV binding:** re-run §1; the placeholder IDs
  in `wrangler.toml` weren't replaced.
- **Garmin sends a 401 when you send a reply:** `GARMIN_IPC_INBOUND_API_KEY`
  is wrong or expired — rotate per above.
- **Garmin queue grows but we never see posts:** check `wrangler tail`. If
  you see `auth_fail`, your `GARMIN_INBOUND_TOKEN` drifted between Cloudflare
  and Portal Connect.
