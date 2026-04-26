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

## 3. Journal repo bootstrap (one-time, before first `!post`)

`!post` commits markdown to a separate GitHub Pages repo (PRD §6 D5). Set
this up once before any `!post` is invoked; otherwise the publisher adapter
will fail and the device reply will return an error.

### Create the repo

```bash
gh repo create <owner>/trailscribe-journal --public \
  --description "TrailScribe field journal"
```

The repo name is arbitrary — store whatever you pick as the
`GITHUB_JOURNAL_REPO` secret (e.g. `brockamer/trailscribe-journal`).

### Pick and commit a Jekyll theme

GitHub Pages auto-builds Jekyll sites with no Action required. Two reasonable
choices:

- **Recommended:** `mmistakes/minimal-mistakes` — polished, themed for
  personal sites. Wired in via `remote_theme` in `_config.yml`.
- **Zero-config alternative:** `jekyll/minima` (the GitHub Pages default).
  No `remote_theme` line needed; GitHub builds it automatically.

Minimum `_config.yml` for `minimal-mistakes`:

```yaml
title: TrailScribe Journal
description: Field notes from off-grid trips, posted via Garmin inReach.
remote_theme: "mmistakes/minimal-mistakes@4.28.0"
minimal_mistakes_skin: "dirt"
permalink: /:year/:month/:day/:title.html   # MUST match JOURNAL_URL_TEMPLATE
plugins:
  - jekyll-feed
  - jekyll-include-cache
  - jekyll-remote-theme
defaults:
  - scope: { path: "", type: posts }
    values:
      layout: single
      author_profile: false
      read_time: false
      share: false
      related: false
      show_date: true
```

The `permalink:` line is critical — the URL it generates **must** match the
`JOURNAL_URL_TEMPLATE` env var in `wrangler.toml`, or `!post` reply links
will 404. The default Jekyll permalink (`/:year/:month/:day/:title.html`)
lines up with the canonical template
`https://<owner>.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html`.
If you change one, change the other.

Commit `_config.yml` plus a minimal `Gemfile`, `index.html`, and the
`_includes/` directory (empty is fine for v1 — `minimal-mistakes` ships sane
defaults).

### Enable GitHub Pages

```bash
gh api -X POST repos/<owner>/trailscribe-journal/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```

Or via UI: Settings → Pages → Source = `main` branch, `/` (root). Wait
30–60s for the first build. Verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://<owner>.github.io/trailscribe-journal/
# Expect: 200
```

### Commit a placeholder post matching `publishPost`'s frontmatter shape

The placeholder is a live integration fixture: it proves what the Worker
will write at runtime renders correctly under the chosen theme. Match
`renderMarkdown` in `src/adapters/publish/github-pages.ts`:

```yaml
---
title: "Hello"
date: 2026-04-25T12:00:00.000Z
location: { lat: 37.1682, lon: -118.5891, place: "Lake Sabrina, California" }
weather: "46°F, 8mph, clear"
tags: [trailscribe]
---
silver lake at dusk
mountains hold the falling sun
trail finds its own way

First post — a placeholder.
```

Save as `_posts/YYYY-MM-DD-hello.md` (Jekyll requires a date prefix on every
post filename). After a 30–60s Pages rebuild, verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<owner>.github.io/trailscribe-journal/<yyyy>/<mm>/<dd>/hello.html"
# Expect: 200
```

A 200 here is the empirical proof that `!post` will produce reachable URLs.

### Generate a fine-grained PAT scoped to the journal repo

The Worker writes to the journal repo via the GitHub Contents API. Use a
fine-grained PAT, **not** a classic token, scoped to **exactly** this one
repo with the minimum permission `Contents: Read and write`.

1. https://github.com/settings/personal-access-tokens/new
2. Token name: `trailscribe-journal-write`
3. Resource owner: your account
4. Repository access: **Only select repositories** → `trailscribe-journal`
5. Repository permissions:
   - `Contents`: Read and write
   - (everything else default)
6. Generate. Copy the `github_pat_*` value once.
7. Store as Wrangler secret in both envs:
   ```bash
   pnpm wrangler secret put GITHUB_JOURNAL_TOKEN --env staging
   pnpm wrangler secret put GITHUB_JOURNAL_TOKEN --env production
   ```

Also set the companion secrets (already in §2 above):

- `GITHUB_JOURNAL_REPO` — e.g. `brockamer/trailscribe-journal`
- `GITHUB_JOURNAL_BRANCH` — e.g. `main`

Rotation: yearly, or on suspected compromise. PATs expire — set a calendar
reminder for the chosen expiration date.

### Pin `JOURNAL_URL_TEMPLATE`

In `wrangler.toml`, the URL template must produce real, reachable URLs:

```toml
JOURNAL_URL_TEMPLATE = "https://<owner>.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html"
```

This template is read at runtime by `publishPost` to construct the reply
link the device sees. The placeholder post's URL is the verification step —
if that 200s, the template is right.

## 4. First deploy (staging)

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
  -H "X-Outbound-Auth-Token: $GARMIN_INBOUND_TOKEN" \
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

## 5. Point Garmin Portal Connect at staging

See [`garmin-setup.md`](garmin-setup.md) for the full Portal Connect
configuration. Summary:

- IPC Outbound URL: `https://trailscribe-staging.<your-subdomain>.workers.dev/garmin/ipc`
- Schema: V2
- Auth: Static Token = value of `GARMIN_INBOUND_TOKEN`

## 6. Promote to production

Once staging has held up for a week (or sooner if you're impatient), repeat
§1–§4 with `--env production`, then push `main` to trigger
[`deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml). Update
Garmin Portal Connect to point at the production URL.

## Synthetic load runs against staging (`IPC_INBOUND_DRY_RUN`)

When you need to exercise the full pipeline (parse → orchestrate → narrative
LLM → publish → ledger) without delivering real SMS to your inReach device —
e.g. P1-23-style cost measurement campaigns or load tests — flip the staging
dry-run flag.

Two ways to enable it:

1. **Inline edit + redeploy (recommended for one-offs).** Edit
   `wrangler.toml` `[env.staging.vars]` to set `IPC_INBOUND_DRY_RUN = "true"`,
   run `pnpm deploy:staging`, run your campaign, then revert and redeploy.
   The flag is checked into git in the OFF position — leaving it ON in a
   committed file is the loud, visible failure mode (CI / code review will
   catch it).

2. **CLI override (faster).** `pnpm exec wrangler deploy --env staging
   --var IPC_INBOUND_DRY_RUN:true` — applies just for that deploy. Re-run the
   normal `pnpm deploy:staging` to revert.

When ON, `sendReply` short-circuits the Garmin POST and emits a structured
`ipc_inbound_dry_run` log line (visible in `wrangler tail --env staging`)
showing IMEI, sender, page count, total chars, and a per-page preview.

**Production is locked.** `parseEnv` throws at Worker startup if
`TRAILSCRIBE_ENV=production` AND `IPC_INBOUND_DRY_RUN=true` — production must
always deliver real replies.

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
