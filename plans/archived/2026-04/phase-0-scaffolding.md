---
**Shipped in #16, #17, #29 on 2026-04-24. Final decisions captured in issue body.**
---

# Phase 0 — Scaffolding

**Goal:** reach a state where Phase 1 (α-MVP implementation) is purely additive. Every broken thing in the current repo is fixed or replaced; Workers is the target; Hono + Vitest are wired; secrets model is defined; CI + staging deploy are green; grammar + link helpers are salvaged. **No α-MVP feature work in this milestone** — `!post`, `!mail`, `!todo` adapters stay stubs that return a canned "not implemented in α" string.

**Source of truth:** `docs/PRD.md` (signed off 2026-04-22).

## Issue(s)

- Epic: [#29 — Epic: Phase 0 — Workers scaffold + provisioning](https://github.com/brockamer/trailscribe/issues/29)
- Milestone: [Phase 0 — Workers scaffold](https://github.com/brockamer/trailscribe/milestone/1)
- Remaining stories: [#16 P0-07](https://github.com/brockamer/trailscribe/issues/16), [#17 P0-20](https://github.com/brockamer/trailscribe/issues/17) (both user-gated on Cloudflare credentials)

**Milestone exit criteria (all must be true):**
- [ ] `wrangler dev` serves a stub `POST /garmin/ipc` that verifies bearer auth, parses a Garmin V2 event, short-circuits duplicates via KV, and returns 200 OK
- [ ] `wrangler deploy --env staging` succeeds; staging URL receives a test Garmin payload and returns 200 OK
- [ ] CI runs typecheck + lint + Vitest on PR to `main`, all green
- [ ] Default branch is `main`; CI targets `main`
- [ ] Grammar parser tests pass under Vitest, including new test for the `!mail subj:` spaces bugfix
- [ ] All 4 KV namespaces exist in Cloudflare, bound in `wrangler.toml`
- [ ] All required secrets documented in `.dev.vars.example`; `wrangler secret put` run for each required key in staging
- [ ] `docs/PRD.md`, `docs/architecture.md`, `docs/setup-cloudflare.md`, `docs/garmin-setup.md` all reflect Workers reality
- [ ] Broken Pipedream/n8n examples archived to `docs/archive/`; README rewritten to Workers-first
- [ ] No references to `require.main`, `trailscribe/dist/...`, in-memory idempotency, or `JSON.stringify(cmd).length` token proxy remain in `src/` or docs

---

## Sprint-ready stories

Stories sized S (≤2h), M (≤half-day), L (≤day). Dependencies noted in brackets.

### P0-01 — Rename `master` → `main` and realign remotes [S]

**Context:** Repo is on `master`; CI targets `main`; GitHub default branch needs to match.

**Acceptance criteria:**
- [ ] Local branch renamed: `git branch -m master main`
- [ ] Remote default updated: `gh repo edit --default-branch main`
- [ ] Remote branch force-moved: `git push origin -u main && git push origin --delete master`
- [ ] CI workflow `.github/workflows/ci.yml` uses `branches: [main]` in both `push` and `pull_request` triggers
- [ ] `git config init.defaultBranch main` locally (for new branches)
- [ ] Confirm with `git status` and `gh repo view --json defaultBranchRef`

**Size:** S

---

### P0-02 — Fix `.github/workflows/ci.yml` paths [S]

**Context:** CI uses `working-directory: ./trailscribe` which doesn't exist inside the repo. Also targets `master` (to be fixed by P0-01) and still runs Jest (which we're replacing in P0-05).

**Acceptance criteria:**
- [ ] Remove all `working-directory: ./trailscribe` lines
- [ ] Update `branches:` to `main` (coupled with P0-01)
- [ ] Replace `npm install -g pnpm` with `uses: pnpm/action-setup@v3` (cached, pinned)
- [ ] Replace `pnpm test` (Jest) with `pnpm test` → wired to Vitest after P0-05
- [ ] Add typecheck step: `pnpm tsc --noEmit`
- [ ] Add lint step: `pnpm lint`
- [ ] CI passes on a PR that doesn't change any source (pure CI change)

**Size:** S
**Depends on:** P0-01, P0-05 (Vitest wiring happens before CI points at it)

---

### P0-03 — Package rewrite: remove Node deps, add Workers stack [M]

**Context:** `package.json` is Node/Express oriented. Workers needs no Express, no `ts-node-dev`, no Jest. Add Hono, Vitest, Wrangler, Workers types.

**Acceptance criteria:**
- [ ] Remove deps: `express`, `axios`, `@types/express`
- [ ] Remove dev deps: `jest`, `ts-jest`, `@types/jest`, `ts-node`, `ts-node-dev`
- [ ] Add deps: `hono`, `zod` (keep)
- [ ] Add dev deps: `vitest`, `@cloudflare/vitest-pool-workers`, `@cloudflare/workers-types`, `wrangler`, `typescript` (pin 5.x), `eslint`, `eslint-config-prettier`, `eslint-plugin-prettier`, `prettier`
- [ ] Scripts updated:
  - `dev` → `wrangler dev`
  - `test` → `vitest run`
  - `test:watch` → `vitest`
  - `typecheck` → `tsc --noEmit`
  - `lint` → `eslint "src/**/*.ts" "tests/**/*.ts"`
  - `format` → `prettier --write .`
  - `deploy:staging` → `wrangler deploy --env staging`
  - `deploy:prod` → `wrangler deploy --env production`
- [ ] Remove `"main": "dist/index.js"` (Workers builds differently)
- [ ] Remove the `"jest": {...}` config block
- [ ] `pnpm install` completes clean
- [ ] `pnpm typecheck` passes against the interim scaffold (may just be `src/index.ts` stub at this point)

**Size:** M

---

### P0-04 — `tsconfig.json` aligned for Workers [S]

**Context:** Current config targets Node ESM. Workers needs `lib: ["ES2022"]` only (no DOM), `types: ["@cloudflare/workers-types"]`, and `moduleResolution: "bundler"` for Wrangler.

**Acceptance criteria:**
- [ ] `compilerOptions.lib` = `["ES2022"]`
- [ ] `compilerOptions.types` = `["@cloudflare/workers-types", "vitest/globals"]`
- [ ] `compilerOptions.moduleResolution` = `"bundler"`
- [ ] `compilerOptions.module` = `"ES2022"`
- [ ] `compilerOptions.target` = `"ES2022"`
- [ ] `compilerOptions.strict` = `true`
- [ ] `compilerOptions.noUnusedLocals` = `true`
- [ ] `compilerOptions.noUnusedParameters` = `true`
- [ ] `include` = `["src/**/*.ts", "tests/**/*.ts"]`
- [ ] `exclude` = `["node_modules"]`
- [ ] `pnpm typecheck` green

**Size:** S
**Depends on:** P0-03

---

### P0-05 — Vitest scaffold + port grammar tests [M]

**Context:** Replace Jest with Vitest. Port the existing 5 tests and add the `!mail subj:` spaces regression test.

**Acceptance criteria:**
- [ ] `vitest.config.ts` at repo root using `@cloudflare/vitest-pool-workers` pool for Workers-compatible tests
- [ ] `tests/grammar.test.ts` runs under Vitest, all 4 existing tests pass
- [ ] New test: `parseCommand('!mail to:a@b.com subj:Hello World body:Hi')` returns `subj: "Hello World"` (currently fails — locked in by P0-09 bugfix)
- [ ] `tests/idempotency.test.ts` deleted (replaced by KV-based tests later in Phase 1)
- [ ] `pnpm test` runs green (with the new failing test allowed if P0-09 not done yet — mark as `.skip` temporarily; un-skip once P0-09 lands)

**Size:** M
**Depends on:** P0-03, P0-04

---

### P0-06 — `wrangler.toml` with bindings and envs [M]

**Context:** Need staging + production envs, 4 KV namespaces, vars, and secret placeholders documented.

**Acceptance criteria:**
- [ ] `wrangler.toml` at repo root
- [ ] `name = "trailscribe"`, `main = "src/index.ts"`, `compatibility_date = "2026-04-01"`, `compatibility_flags = ["nodejs_compat"]`
- [ ] Top-level `[vars]` block with non-secret defaults: `TRAILSCRIBE_ENV`, `GOOGLE_MAPS_BASE`, `MAPSHARE_BASE`, `OPENAI_MODEL`, `OPENAI_INPUT_COST_PER_1K`, `OPENAI_OUTPUT_COST_PER_1K`, `APPEND_COST_SUFFIX`, `DAILY_TOKEN_BUDGET`, `IPC_SCHEMA_VERSION`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`, `JOURNAL_POST_PATH_TEMPLATE`
- [ ] `[[kv_namespaces]]` entries for `TS_IDEMPOTENCY`, `TS_LEDGER`, `TS_CONTEXT`, `TS_CACHE` (IDs populated after P0-07)
- [ ] `[env.staging]` and `[env.production]` overrides where vars differ (e.g., `TRAILSCRIBE_ENV=staging` vs `production`)
- [ ] Comments listing required secrets (not values): `GARMIN_INBOUND_TOKEN`, `GARMIN_IPC_INBOUND_API_KEY`, `GARMIN_IPC_INBOUND_BASE_URL`, `IMEI_ALLOWLIST`, `OPENAI_API_KEY`, `TODOIST_API_TOKEN`, `RESEND_API_KEY`, `GITHUB_JOURNAL_TOKEN`, `GITHUB_JOURNAL_REPO`, `GITHUB_JOURNAL_BRANCH`
- [ ] `wrangler deploy --dry-run` succeeds against staging env

**Size:** M
**Depends on:** P0-03

---

### P0-07 — Create KV namespaces (staging + prod) [S]

**Context:** Four KV namespaces per PRD §3 must exist before bindings resolve.

**Acceptance criteria:**
- [ ] Run 8× `wrangler kv namespace create <NAME>` and `wrangler kv namespace create <NAME> --env staging` (or use `--preview` for staging pattern — pick one and document in `docs/setup-cloudflare.md`)
- [ ] Capture each `id` from output and paste into `wrangler.toml`
- [ ] `wrangler kv namespace list` shows all 8 (4 names × 2 envs)
- [ ] `wrangler deploy --env staging --dry-run` validates all bindings

**Size:** S
**Depends on:** P0-06
**User-performed step:** creating namespaces requires Cloudflare credentials interactively (`wrangler login`). Claude prepares the commands; user executes.

---

### P0-08 — `.dev.vars.example` + secret management doc [S]

**Context:** Wrangler's local-dev secrets format is `.dev.vars` (dotenv-compatible). Need an example checked in; real `.dev.vars` gitignored.

**Acceptance criteria:**
- [ ] `.dev.vars.example` created with every secret key from P0-06, values blank or placeholder (`<set-me>`)
- [ ] `.dev.vars` added to `.gitignore`
- [ ] `docs/setup-cloudflare.md` section "Secrets": documents `cp .dev.vars.example .dev.vars`, populate values, `wrangler secret put <KEY> --env staging` for each (exact commands listed)
- [ ] Instructions for rotating `GARMIN_INBOUND_TOKEN` documented (rotate yearly, update Garmin Portal Connect + `wrangler secret put`)
- [ ] No real secrets committed; `rg -i 'sk-|api[-_]key|bearer'` in `git diff` returns nothing sensitive

**Size:** S
**Depends on:** P0-06

---

### P0-09 — Salvage grammar into `src/core/grammar.ts` + types + links [M]

**Context:** Per Verdict B, grammar + types + links are the salvage. Port, trim to MVP commands, fix `!mail subj` regex.

**Acceptance criteria:**
- [ ] `src/core/types.ts` exports `ParsedCommand` discriminated union, trimmed to MVP 6: `ping`, `help`, `cost`, `post`, `mail`, `todo`. No `ai`, `where`, `drop`, `camp`, `brief`, `blast`, `share` (defer to Phase 2+).
- [ ] `src/core/grammar.ts` ports `parseCommand` with:
  - `!mail subj:` regex fixed to allow spaces in subject: `to:([^\s]+)\s+subj:(.+?)\s+body:(.+)`
  - `!post "Title" body:_` parser retained
  - `!todoist` alias removed (not documented, was drift)
  - Deferred verbs return `undefined` (unknown command); they'll be added in later phases
- [ ] `src/core/links.ts` ports `buildGoogleMapsLink` + `buildMapShareLink` (minor: take `env` instead of `config`)
- [ ] Unit tests updated: `tests/grammar.test.ts` includes `!mail` with spaces-in-subject, plus one negative test per removed verb (`!ai` should return `undefined` now)
- [ ] `pnpm test` green
- [ ] Old `src/agent/*` and `src/tools/links.ts` can remain temporarily; deleted in P0-17

**Size:** M
**Depends on:** P0-05

---

### P0-10 — `src/env.ts` zod schema for Workers `Env` [S]

**Context:** Replace the old `src/config/env.ts` Node-style loader with a Workers-native binding schema.

**Acceptance criteria:**
- [ ] `src/env.ts` exports `Env` interface matching `wrangler.toml` bindings (KV namespaces typed as `KVNamespace`; vars as `string`; secrets as `string`)
- [ ] Also exports `EnvSchema` zod object for runtime validation at Worker boot (validates string types and presence of required secrets at first request)
- [ ] Helper `parseEnv(env: unknown): Env` throws on missing/invalid bindings with a clear message
- [ ] Tested: a Vitest test passes a mock `Env` shape through `parseEnv` and asserts no throw; a second test with a missing field throws
- [ ] `pnpm typecheck` green

**Size:** S
**Depends on:** P0-06

---

### P0-11 — Hono scaffold at `src/index.ts` + `/garmin/ipc` stub [M]

**Context:** Minimal Worker entry that answers Garmin Outbound webhooks correctly at the network layer. No orchestrator logic yet.

**Acceptance criteria:**
- [ ] `src/index.ts` exports default `{ fetch: app.fetch }` from a Hono instance
- [ ] Route `POST /garmin/ipc` does in order:
  1. Verify `Authorization: Bearer <token>` matches `env.GARMIN_INBOUND_TOKEN` — on miss, return 200 OK with log entry `auth_fail` (intentionally 200 to avoid retry cascade)
  2. Parse body as JSON; if not a valid Garmin V2 envelope `{ Version, Events: [...] }`, log and return 200 OK
  3. Iterate events; for each, extract `imei`, `messageCode`, `timeStamp`, `freeText`, `point`; verify `imei` is in `env.IMEI_ALLOWLIST` (comma-sep), skip on miss
  4. Compute idempotency key `sha256(imei + ":" + timeStamp + ":" + messageCode + ":" + sha256(freeText || ""))`
  5. `TS_IDEMPOTENCY.get(key)` — if present, short-circuit
  6. `TS_IDEMPOTENCY.put(key, JSON.stringify({status:"received", receivedAt: Date.now()}), {expirationTtl: 172800})` (48h)
  7. Return 200 OK with body `"ok"`
- [ ] Route `GET /` returns `200 TrailScribe α-MVP (Phase 0)` — sanity endpoint
- [ ] Route `GET /health` returns `{ ok: true, env: <env.TRAILSCRIBE_ENV>, commit: <env.COMMIT_SHA || "dev">, timestamp }` as JSON
- [ ] No business logic (narrative, mail, todo) — leave a `// TODO: dispatch to orchestrator in Phase 1` comment at the right place
- [ ] Vitest integration test using `@cloudflare/vitest-pool-workers`: posts a fixture V2 event to `/garmin/ipc` with correct bearer; asserts 200 response and that the idempotency key was written to the mock KV
- [ ] Second test: same event posted twice → second call short-circuits (KV check fires)
- [ ] Third test: wrong bearer → 200 with no KV write

**Size:** M
**Depends on:** P0-09, P0-10

---

### P0-12 — Adapter stubs (compile-clean, no behavior) [M]

**Context:** Directory structure per CLAUDE.md module map. Each adapter exports a typed function that throws `"not implemented in α-Phase-0"` or returns a canned shape — enough that `pnpm typecheck` and `pnpm test` stay green while Phase 1 fills them in one at a time.

**Acceptance criteria:**
- [ ] Files exist (each with a 1-line module JSDoc and a typed stub function):
  - `src/adapters/outbound/garmin-ipc-inbound.ts` — `sendReply(imei, message, env): Promise<void>`
  - `src/adapters/mail/resend.ts` — `sendEmail({to, subject, body, env}): Promise<void>`
  - `src/adapters/tasks/todoist.ts` — `addTask({task, env}): Promise<void>`
  - `src/adapters/publish/github-pages.ts` — `publishPost({title, body, frontmatter, env}): Promise<{url: string}>`
  - `src/adapters/location/geocode.ts` — `reverseGeocode(lat, lon, env): Promise<string>`
  - `src/adapters/location/weather.ts` — `currentWeather(lat, lon, env): Promise<string>`
  - `src/adapters/ai/openai.ts` — `generateNarrative({position, note, env}): Promise<{title, haiku, body, usage}>`
  - `src/adapters/storage/kv.ts` — typed helpers: `getJSON<T>(ns, key): Promise<T | null>`, `putJSON(ns, key, value, opts?)`
  - `src/adapters/logging/worker-logs.ts` — `log({level, event, ...fields})` emits one JSON line to stdout
  - `src/core/orchestrator.ts` — `orchestrate(cmd, ctx): Promise<{body, lat?, lon?}>` switch returns canned `"α: not yet implemented"` for `!post`/`!mail`/`!todo`, real replies for `!ping`/`!help`/`!cost`
  - `src/core/narrative.ts`, `src/core/context.ts`, `src/core/ledger.ts` — class/fn stubs
  - `src/core/commands.ts` — per-command handler registry (thin)
- [ ] Every stub throws or returns a typed default; no `any`
- [ ] `pnpm typecheck` + `pnpm test` green
- [ ] Wire orchestrator into `/garmin/ipc` route behind a `TODO` flag; on Phase 0 the route does NOT invoke orchestrator — that's a Phase 1 story

**Size:** M
**Depends on:** P0-10, P0-11

---

### P0-13 — Archive broken deploy examples, rewrite README [M]

**Context:** The Pipedream example imports from a nonexistent `trailscribe/dist/...`. The n8n doc tells people to `cd ./trailscribe`. The README's top-matter sells Pipedream as primary. Workers is now primary.

**Acceptance criteria:**
- [ ] `docs/archive/` directory created
- [ ] Moved: `docs/pipedream-setup.md`, `docs/selfhost-n8n-proxmox.md`, `examples/pipedream-steps.md`, `examples/workers-minimal.md`, `examples/n8n-docker-compose.yml` → `docs/archive/`
- [ ] Each archived file gets a header: `> Archived 2026-04-22 — superseded by Workers-first architecture in docs/architecture.md. Kept for historical reference only.`
- [ ] `README.md` rewritten:
  - One-line hook: "AI-native satellite messaging for Garmin inReach."
  - Personas (Natalie / Marcus / Yuki) in a 3-row table
  - MVP command table (6 commands)
  - "Deploy" section points to `docs/setup-cloudflare.md` — no more Pipedream steps
  - "Status" says: α-MVP in development; see `docs/PRD.md`
  - Dev quickstart: `pnpm install && pnpm dev` (assumes `.dev.vars` populated)
  - Kills the stale directory-tree block (replace with reference to `docs/architecture.md`)
- [ ] No links to archived docs in README/architecture.md except "see archive"

**Size:** M
**Depends on:** P0-09 (directory shape is settled)

---

### P0-14 — Rewrite `docs/architecture.md` for Workers [M]

**Context:** Current arch doc describes Express on Pipedream/n8n/Workers. Now only Workers; also reflect bearer token auth, X-API-Key outbound, idempotency composite key.

**Acceptance criteria:**
- [ ] Single deployment target (Workers) — no mentions of Pipedream/n8n as primary paths
- [ ] Inbound flow matches PRD §3 + §4 (bearer verify → parse V2 → idempotency → dispatch)
- [ ] Outbound flow references IPC Inbound `/api/Messaging/Message` with X-API-Key
- [ ] Idempotency key formula matches PRD §5
- [ ] Architecture diagram (ASCII acceptable for α; SVG refresh deferred) updated to show Worker as the single gateway
- [ ] Deep links to `docs/PRD.md` sections instead of redefining scope
- [ ] Diff from previous version acknowledges archive docs are historical

**Size:** M
**Depends on:** PRD signed (done)

---

### P0-15 — New `docs/setup-cloudflare.md` [M]

**Context:** Replaces the archived Pipedream + n8n guides. Walks through Cloudflare account setup, Wrangler install, KV namespace creation, secret population, first deploy.

**Acceptance criteria:**
- [ ] Sections: Prerequisites (Cloudflare account, Wrangler, node 18+); `wrangler login`; create KV namespaces (exact commands); `cp .dev.vars.example .dev.vars` and populate; `wrangler secret put` for each secret (list every one); `wrangler deploy --env staging`; point Garmin Portal Connect at staging URL (reference `docs/garmin-setup.md`); verify with a curl-with-fixture test
- [ ] Covers secret rotation (yearly for `GARMIN_INBOUND_TOKEN`, `GARMIN_IPC_INBOUND_API_KEY`)
- [ ] Covers staging → production promotion path
- [ ] Mentions GitHub Actions auto-deploy (preview — actual workflow in P0-16)

**Size:** M
**Depends on:** P0-06, P0-07, P0-08

---

### P0-16 — `deploy-cloudflare.yml` GitHub Action [S]

**Context:** CI builds/tests on PR; this workflow deploys on push to `main`.

**Acceptance criteria:**
- [ ] `.github/workflows/deploy-cloudflare.yml` created
- [ ] Trigger: `push` to `main` only (production branch-based deploy); manual `workflow_dispatch` for ad-hoc
- [ ] Steps: checkout → setup-node + pnpm → install → typecheck → test → `wrangler deploy --env production` using `CF_API_TOKEN` repo secret
- [ ] Uses `cloudflare/wrangler-action@v3` with `apiToken: ${{ secrets.CF_API_TOKEN }}`
- [ ] Separate `deploy-staging` job fires on every push to any branch matching `staging/*`; uses `--env staging`
- [ ] Documents required repo secrets in workflow YAML comments: `CF_API_TOKEN`, `CF_ACCOUNT_ID`
- [ ] First push to main after this lands kicks a successful deploy — observable via `wrangler tail`

**Size:** S
**Depends on:** P0-06, P0-11 (something real to deploy)

---

### P0-17 — Rewrite `docs/garmin-setup.md` for Pro-tier + bearer token [S]

**Context:** Current guide mentions shared-secret in passing. Now we have authoritative contracts (materials/Garmin IPC Outbound.txt, Inbound.txt) and a specific bearer-token approach.

**Acceptance criteria:**
- [ ] Explicit "Professional tier required" callout at top
- [ ] IPC Outbound setup: Portal Connect → Add Endpoint → URL `https://<worker>.workers.dev/garmin/ipc` → Schema V2 → Static Token (paste value of `GARMIN_INBOUND_TOKEN`)
- [ ] IPC Inbound setup: Portal Connect → Inbound Settings → toggle on → Generate API Key (copy into `GARMIN_IPC_INBOUND_API_KEY`) → note `GARMIN_IPC_INBOUND_BASE_URL`
- [ ] IMEI lookup (15-digit, from device)
- [ ] Retry-schedule mention with quantitative numbers (2/4/8/16/32/64/128s; 12h pause cycles; 5-day suspension risk)
- [ ] 160-char outbound cap reminder
- [ ] Link to the authoritative PDFs in `materials/`

**Size:** S
**Depends on:** none (docs-only)

---

### P0-18 — Delete old src/ (Express, stubs, broken router) and examples [S]

**Context:** Keep salvaged files (grammar now at `src/core/grammar.ts`, types, links); delete everything else under old paths. Retain `docs/field-commands.md` and `docs/runbook-offgrid.md` — content is still valid.

**Acceptance criteria:**
- [ ] Deleted: `src/http/`, `src/agent/`, `src/tools/` (except any link-helper we already ported), `src/runtime/`, `src/config/`
- [ ] Deleted: `examples/env.example` (replaced by `.dev.vars.example`)
- [ ] Deleted: `tests/idempotency.test.ts` (in-memory idempotency no longer exists)
- [ ] `pnpm typecheck` + `pnpm test` still green
- [ ] No references to deleted files in any remaining doc or source

**Size:** S
**Depends on:** P0-09, P0-10, P0-11, P0-12

---

### P0-19 — Boilerplate cleanup: SECURITY, CoC, CONTRIBUTING [S]

**Context:** `SECURITY.md` and `CODE_OF_CONDUCT.md` have `[your-email@example.com]` placeholders. `CONTRIBUTING.md` describes a `pnpm dev` + Jest flow that's no longer accurate.

**Acceptance criteria:**
- [ ] Substitute a real contact email in `SECURITY.md` and `CODE_OF_CONDUCT.md` — use `brockamer@gmail.com` (confirmed public email of record) unless user provides a different address
- [ ] `CONTRIBUTING.md` updated: `wrangler dev` (not `pnpm dev`); Vitest (not Jest); Hono routes (not Express); KV (not in-memory)
- [ ] Add note to `CONTRIBUTING.md`: issues/PRs flow through the Jared project board (will be set up post-Phase-0)
- [ ] No more placeholder text matches `[your-email@example.com]`

**Size:** S
**Depends on:** none

---

### P0-20 — Verify staging end-to-end with fixture Garmin payload [S]

**Context:** Final gate for Phase 0 exit. Prove the Worker receives a real-shape Garmin V2 event and 200-OKs it with the right side effects (KV entry created).

**Acceptance criteria:**
- [ ] `tests/fixtures/garmin-outbound-v2-freetext.json` committed: realistic V2 envelope with `imei` from `IMEI_ALLOWLIST`, `messageCode: 3`, `freeText: "!ping"`, valid coordinates
- [ ] `curl` command documented in `docs/setup-cloudflare.md` that posts the fixture to staging URL with correct bearer
- [ ] Run the curl: response is `200 OK "ok"`
- [ ] `wrangler kv key list --binding TS_IDEMPOTENCY --env staging` shows the new key
- [ ] Re-run curl: response is still 200 (idempotency short-circuit works — observable via `wrangler tail` log)
- [ ] Screenshot/paste of `wrangler tail` output during these three curls attached to the story's completion note

**Size:** S
**Depends on:** all prior stories

---

## Sizing summary

| Size | Count |
|---|---|
| S | 10 |
| M | 10 |
| L | 0 |

**Rough total:** ~1.5–2 focused days of work, mostly because each story is scoped thin. Several can be parallelized (P0-13, P0-14, P0-15, P0-17, P0-19 are all doc-only and can land concurrently).

## Execution order (recommended sequencing)

Critical path (can't skip):
**P0-01 → P0-03 → P0-04 → P0-05 → P0-06 → P0-07 → P0-08 → P0-09 → P0-10 → P0-11 → P0-12 → P0-18 → P0-20**

Parallel tracks (can land in any order once unblocked):
- Docs: **P0-13, P0-14, P0-15, P0-17, P0-19** — start as soon as PRD is signed (now)
- CI: **P0-02** after P0-05; **P0-16** after P0-11

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Cloudflare API token not provisioned yet | H | P0-06/07 lay groundwork; user performs `wrangler login` interactively once |
| Resend free-tier domain/sender issues | L | `trailscribe@resend.dev` is their hosted subdomain; no DNS needed for α |
| GitHub PAT scoping for journal repo | M | P0-08 documents fine-grained PAT with `contents:write` on exactly one repo |
| `@cloudflare/vitest-pool-workers` API churn | M | Pin version in `package.json`; follow current docs at plan-time |
| Breaking CI during branch rename | L | P0-01 and P0-02 land as one PR |

## Out of scope for Phase 0 (reminder)

- Real OpenAI call (Phase 1)
- Real Resend send (Phase 1)
- Real Todoist call (Phase 1)
- Real GitHub Pages commit (Phase 1)
- Narrative generation (Phase 1)
- Ledger persistence + `!cost` math (Phase 1)
- Context rolling window (Phase 1)
- Durable Objects migration (Phase 2)
- Jared board setup (post-Phase-0)

## Sign-off gate

After P0-20 passes: walk through the milestone exit checklist at the top of this doc, confirm each item, then propose `plans/phase-1-alpha-mvp.md`. No Phase 1 code until that plan is signed off.
