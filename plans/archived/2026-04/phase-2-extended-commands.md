# Phase 2 — Extended Commands

**Goal:** From the same Garmin inReach Mini 3 Plus, send any of the eight commands deferred from α-MVP (`!where`, `!weather`, `!drop`, `!brief`, `!ai`, `!camp`, `!share`, `!blast`) **plus `!postimg`** and receive a valid reply on the device — end-to-end through real third-party APIs, idempotent, sharing the Phase 1 orchestrator + ledger + reply-formatter pipeline. No new storage tier (still KV); no new auth model (still bearer + IMEI allowlist); no new transport (still IPC Outbound webhook + IPC Inbound reply). One new external dependency: an image-gen provider (Replicate Flux schnell, locked for the first cut).

**Source of truth:** `docs/PRD.md` §2 (deferrals table) + this plan. Where the PRD's §2 table splits the deferred eight across Phase 2 / 3 / 4, this plan unifies them into Phase 2 — the splits in the original deferral table reflected complexity, not transport boundaries, and the user has elected to ship them as one phase. PRD §2 will be reconciled to match (story P2-13).

**Epic:** [#98 — Phase 2 — extended commands](https://github.com/brockamer/trailscribe/issues/98).
**Milestone:** [Phase 2 — extended commands](https://github.com/brockamer/trailscribe/milestone/4).
**Per-command issues:** #112 `!where`, #113 `!weather`, #114 `!drop`, #115 `!brief`, #116 `!ai`, #117 `!camp`, #118 `!blast`, #119 `!share`, **#125 `!postimg`** (folded into Phase 2 on operator decision 2026-04-28; was filed earlier as a Backlog/Low candidate). #112–#119 bodies were refreshed in P2-14 to match this plan; #125's body is already engineering-ready and gets a milestone + priority move rather than a body refresh.

**Supersedes nothing.** Builds on top of the Phase 1 stack as shipped (epic #30 / milestone #2).

## Assumptions

These shape the scope and are worth stating up front so a future session does not relitigate them.

- **Single-operator forever.** TrailScribe is a personal project, not a startup. There is exactly one Garmin IMEI in the allowlist for the lifetime of the project. No β-launch milestone, no per-IMEI cost attribution, no second-IMEI onboarding flow, no email-fallback reply path (D9 stays skipped). The original "β before Phase 2?" question on epic #98 is closed: skip β.
- **KV is sufficient.** The Durable Objects + D1 migration (Phase 3, epic #99) is *not* a prerequisite. FieldLog and the address book live on KV with bounded retention; eventual consistency is fine for journaling and a single-recipient address book. Migration is Phase 3's problem.
- **One new external dependency: image-gen provider for `!postimg`.** Locked to Replicate Flux schnell for the first cut. Apart from this, the Phase 1 stack (OpenRouter, Resend, Todoist, GitHub Pages, Nominatim, Open-Meteo) is the universe. The web-search angle for `!camp` was resolved as P2-08b deferral (LLM-only first cut).
- **Reply budget is sacred.** Every reply still ≤ 320 chars (two SMS). Where a Phase 2 command produces content longer than that, the device gets a 1-SMS pointer ("see email" / "see journal") and the full payload goes via Resend or GitHub Pages. Same pattern Phase 1 already uses for `!post`.
- **No new env vars without justification.** Per CLAUDE.md ground rule. The address book and any web-search provider are the only candidates, and both are evaluated below.

## Plain-language refresher (only what's new)

Phase 1's glossary still applies. Two new terms surface in Phase 2:

- **FieldLog** — a per-IMEI rolling list of structured journal entries (`!drop`-recorded observations). KV-backed, bounded by entry count (default 100) with FIFO eviction. Reads aggregate over the list (`!brief`) and writes append (`!drop`). Conceptually a Linux `~/.bash_history` for the field — not a relational table.
- **Address book** — for `!share` and `!blast`, a small JSON map of `{ alias → email }` resolved at command-parse time. The simplest viable form is an env var (`ADDRESS_BOOK_JSON`) loaded at request time, since this is a single-operator project. KV storage with an admin endpoint to edit is overkill until proven needed.

Story bodies inline-define anything else specialized.

## Critical guards (carry-forward from Phase 1)

The two non-obvious orchestrator-boundary guards from Phase 1 (P1-01) still apply and must not regress in Phase 2:

1. **Non-Free-Text events.** `messageCode !== 3` (especially `=0` Position Report breadcrumbs and `=4` SOS) must not invoke the orchestrator. New Phase 2 commands inherit this gate automatically since they all hang off the existing dispatcher in `src/core/orchestrator.ts`.
2. **No-GPS-fix events.** `gpsFix === 0 || (lat === 0 && lon === 0)` means location enrichment is skipped. Phase 2 commands that depend on location (`!where`, `!weather`, `!drop`, `!brief` when summarizing location, `!camp`) must accept `undefined` lat/lon and degrade gracefully — typically by replying `Need GPS fix — try again outdoors.` rather than guessing.

## Decisions (resolved 2026-04-28)

The four open questions were resolved by the operator as the recommended option in each case. Recording them here in resolved form so the per-story acceptance criteria are unambiguous.

1. **`!camp` web-search provider — RESOLVED: LLM-only first cut.** Ship `!camp` as a general-knowledge LLM call with a `(may be outdated)` prefix. No web-search dependency in Phase 2. Real web search filed as **P2-08b follow-up**, not blocking Phase 2 close. Promote P2-08b only if field experience shows LLM-only answers are insufficient.
2. **`!ai` overflow handling — RESOLVED: 1-SMS pointer + email full answer.** Replies > 320 chars send `Long answer sent by email.` on device and route the full LLM output to the operator email via Resend, mirroring `!post`'s overflow pattern. Two-SMS paging applies only when the answer fits naturally in two SMS without truncation. Reflected in P2-07 acceptance.
3. **Address-book storage — RESOLVED: env-var JSON.** `ADDRESS_BOOK_JSON` Wrangler secret holds the alias map. No KV admin endpoint, no CLI admin script. Migration to KV is YAGNI for a single operator. Reflected in P2-09 acceptance.
4. **`!brief` time window — RESOLVED: 24h default, configurable.** `!brief` defaults to the last 24 hours. Operator can override with `!brief 7d` (the grammar's `windowDays` slot). Reflected in P2-02 grammar and P2-06 handler.

## Milestone exit criteria

- [ ] All 8 deferred α commands work end-to-end on staging with real third-party APIs.
- [ ] All 8 deferred α commands work end-to-end against the production Worker on real Garmin traffic from the operator's Mini 3 Plus.
- [ ] `!postimg` (#125) works end-to-end on staging and production: image renders at the top of the GitHub Pages post; image-gen failure falls back to text-only `!post` without losing the caption; idempotency replay does not double-bill image-gen.
- [ ] Reply budget: every reply ≤ 320 chars. Overflow path (where it applies — `!ai`, `!camp`, `!brief`) goes via email or journal post, not by truncating silently.
- [ ] Idempotency: each new command is replay-safe. 5 manual webhook replays per command produce 0 duplicate side-effects (no duplicate FieldLog entries, no duplicate emails, no duplicate LLM calls beyond the cached first).
- [ ] FieldLog: bounded at 100 entries per IMEI; writes succeed under concurrent retries; reads return entries in chronological order.
- [ ] No-GPS-fix path: location-dependent commands reply gracefully with a "need GPS fix" message rather than crashing or guessing.
- [ ] Daily token budget gate: `!ai`, `!camp`, `!brief` (LLM-bearing commands) honor `DAILY_TOKEN_BUDGET=50000` and short-circuit with the canned cap message when exceeded.
- [ ] Cost: per-transaction cost budget unchanged from Phase 1 (≤ $0.05). LLM-bearing commands measured across ≥ 10 real transactions each.
- [ ] `!cost` reply continues to match the ledger month-to-date, including the new commands' ledger entries.
- [ ] Documentation refreshed: `docs/field-commands.md` reflects all 14 shipped commands with current adapter names; PRD §2 deferral table reconciled.
- [ ] CI green on `main`: typecheck + lint + Vitest.
- [ ] No `throw new Error("not implemented")` in Phase 2 command handlers.

## Story map

Stories are sized **S** (≤2 h), **M** (≤half-day), **L** (≤day). Dependencies are noted in brackets.

| Theme | Stories | Why grouped |
|---|---|---|
| A — Foundation | P2-01, P2-02 | Grammar extension + FieldLog adapter. Must land before any Phase 2 command can be parsed or any state-bearing command can persist. |
| B — Quick reads | P2-03, P2-04 | `!where`, `!weather`. Reuse existing `geocode.ts` + `weather.ts`; no new state, no new adapters. |
| C — FieldLog | P2-05, P2-06 | `!drop`, `!brief`. Depend on FieldLog adapter (Theme A). |
| D — AI / research | P2-07, P2-08 | `!ai`, `!camp`. Both LLM-heavy; both need overflow handling. |
| E — Distribution | P2-09, P2-10, P2-11 | Address-book config + `!share`, `!blast`. |
| G — Image-augmented journal | P2-17, P2-18 | `!postimg`. Image-gen adapter + grounded prompt builder; pipeline that mirrors `!post` plus a binary-image commit alongside the markdown. Closes #125. |
| F — Reconcile + verify | P2-12, P2-13, P2-14, P2-15, P2-16 | Doc refresh, PRD reconcile, sub-issue body refresh, staging burn-in, production turn-on. |

---

## Sprint-ready stories

### Theme A — Foundation

#### P2-01 — FieldLog KV adapter [M]

**Context.** `!drop` (P2-05) writes structured entries; `!brief` (P2-06) reads and aggregates them. Phase 1's `src/core/context.ts` already provides a KV-backed rolling window of recent positions/messages — model FieldLog on that pattern but as a separate KV namespace key (`fieldlog:<imei>` in `TS_CONTEXT`) to keep the rolling-position concerns isolated from journal entries.

**Acceptance criteria:**
- [ ] New module `src/core/fieldlog.ts` exports `appendEntry(env, imei, entry): Promise<void>` and `getEntries(env, imei, opts?): Promise<FieldLogEntry[]>`.
- [ ] `FieldLogEntry` shape: `{ id: string, ts: number, lat?: number, lon?: number, note: string, source: 'drop' | 'post' }` (the `source` field lets us optionally fold `!post` titles into `!brief` later without schema migration).
- [ ] Bounded at `FIELDLOG_MAX_ENTRIES` (default 100) per IMEI; FIFO eviction.
- [ ] Concurrent-append safe under Garmin's retry storms: idempotency-keyed by the orchestrator-level event idempotency key, not by entry content. (Garmin replays the same event with the same composite key; if FieldLog already has an entry tagged with that key, `appendEntry` is a no-op.)
- [ ] `getEntries` returns chronological order (oldest first) by default; supports `{ since: ms-epoch, limit: number }` for `!brief` time-window queries.
- [ ] Vitest cases: append + read round-trip; eviction at the cap; concurrent-replay no-op; empty-FieldLog read returns `[]`.

**Size:** M.
**Depends on:** nothing.

#### P2-02 — Grammar extension for the eight new commands [S]

**Context.** `src/core/grammar.ts` currently parses the six α-MVP commands. The deferred eight need to round-trip through the existing `parseCommand` discriminated-union pattern — no separate parser, no separate dispatcher path.

**Acceptance criteria:**
- [ ] Eight new variants on the `ParsedCommand` discriminated union: `Where`, `Weather`, `Drop`, `Brief`, `Ai`, `Camp`, `Share`, `Blast`.
- [ ] Argument shapes:
  - `!where` — no args.
  - `!weather` — no args (current location).
  - `!drop <note>` — `note: string` (rest-of-line).
  - `!brief` — no args; default 24h window. Optional trailing `7d` etc. captured as `windowDays?: number`.
  - `!ai <question>` — `question: string` (rest-of-line).
  - `!camp <query>` — `query: string` (rest-of-line).
  - `!share to:<addr|alias> <note>` — `to: string`, `note: string`.
  - `!blast <note>` — `note: string` (recipients come from address book).
- [ ] Vitest cases for each variant: happy path, empty-arg edge case (where applicable), case-insensitivity match.
- [ ] No regression in the six existing α commands (existing tests still pass).

**Size:** S.
**Depends on:** nothing.

---

### Theme B — Quick reads

#### P2-03 — `!where` command handler [M]

**Context.** Closes #112. Reverse-geocode the current GPS fix and return a one-line place description plus map links. Pure reuse of `adapters/location/geocode.ts`'s `reverseGeocode(lat, lon, env)`; no LLM call; no state write.

**Acceptance criteria:**
- [ ] New module `src/core/commands/where.ts` (matches the `post.ts` / `mail.ts` / `todo.ts` pattern); orchestrator's `switch (command.type)` gets a `case 'where':` branch.
- [ ] If `lat`/`lon` undefined (no GPS fix), reply `Need GPS fix — try again outdoors.` (~31 chars; well within budget).
- [ ] Otherwise: call `reverseGeocode(lat, lon, env)`; format reply as `<place name>. <Maps link> <MapShare link>` capped at 320 chars.
- [ ] Append cost suffix only if `APPEND_COST_SUFFIX=true` (consistent with Phase 1 reply formatter).
- [ ] Ledger entry written with `cmd: 'where'`, `usd_cost: 0` (no LLM call), `tokens: 0`.
- [ ] Vitest: happy path with mocked geocode; no-fix path; geocode-failure path (returns "Unknown location" + raw coords).
- [ ] Manual staging verification: `!where` from staging fixture returns plausible reply for at least three diverse fixture locations.

**Size:** M.
**Depends on:** P2-02.

#### P2-04 — `!weather` command handler [M]

**Context.** Closes #113. Current-location forecast summary via the existing Open-Meteo adapter. No LLM call.

**Acceptance criteria:**
- [ ] New module `src/core/commands/weather.ts`; orchestrator `case 'weather':` branch. Reuses `currentWeather(lat, lon, env)` from `adapters/location/weather.ts`.
- [ ] No-GPS-fix path replies `Need GPS fix — try again outdoors.` as in P2-03.
- [ ] Reply format: `<conditions>, <tempF>°F. Hi <hi>° / Lo <lo>°. <wind>kt <dir>.` with the next-24h summary appended if budget allows.
- [ ] Reuses the cached weather adapter; no new HTTP call when cache fresh.
- [ ] Ledger entry with `cmd: 'weather'`, `usd_cost: 0`.
- [ ] Vitest: happy path with mocked weather; no-fix path; cache-hit path.
- [ ] Manual staging verification across three fixture locations.

**Size:** M.
**Depends on:** P2-02.

---

### Theme C — FieldLog (write + read)

#### P2-05 — `!drop` command handler [M]

**Context.** Closes #114. Append a structured entry to FieldLog with timestamp + GPS + free-text note. Confirmation reply names the entry and total count.

**Acceptance criteria:**
- [ ] New module `src/core/commands/drop.ts`; orchestrator `case 'drop':` branch.
- [ ] Calls `fieldlog.appendEntry(env, imei, { id: idempotencyKey, ts: Date.now(), lat, lon, note, source: 'drop' })`. The `id` field is the existing event idempotency key, so a Garmin retry is a true KV no-op.
- [ ] Reply format: `Logged: <first-40-chars-of-note>. (<N> entries)` where `N` is the post-append entry count.
- [ ] Empty `note` rejected with `!drop needs a note.` (minimum useful entry).
- [ ] Ledger entry with `cmd: 'drop'`, `usd_cost: 0`.
- [ ] Vitest: happy-path append + reply; empty-note rejection; replay returns identical reply, no second entry.
- [ ] Manual staging verification: 3 `!drop` events from fixture, then `gh api` peek at the FieldLog KV key shows 3 entries.

**Size:** M.
**Depends on:** P2-01, P2-02.

#### P2-06 — `!brief` command handler [L]

**Context.** Closes #115. Aggregate FieldLog entries + ledger month-to-date + last 24h of context into a five-line LLM summary. The most expensive Phase 2 command; uses the same OpenRouter pipeline as `!post` and shares the daily-budget gate.

**Acceptance criteria:**
- [ ] New module `src/core/commands/brief.ts`; orchestrator `case 'brief':` branch.
- [ ] Default window: last 24 hours. Custom window via `cmd.windowDays`.
- [ ] Reads FieldLog `getEntries({ since: now - windowMs })`; reads ledger month-to-date; reads `context.ts` rolling-position summary.
- [ ] LLM call with structured prompt — output is plain text, no JSON-mode (unlike `!post` which produces `{title, haiku, body}`).
- [ ] Reply format: a 5-line summary fitting within 320 chars. If the LLM output exceeds 320 chars, the reply is `Brief sent by email.` and the full text goes via Resend (operator email already in env).
- [ ] Daily token budget gate enforced before the LLM call (existing `budget.ts` module).
- [ ] No-FieldLog-entries path: reply `No entries to brief on.`
- [ ] Ledger entry with real OpenRouter usage (consistent with Phase 1's accounting).
- [ ] Vitest: happy path with mocked FieldLog + LLM; budget-exceeded short-circuit; empty-FieldLog path; overflow → email path (with mocked Resend).
- [ ] Manual staging verification: drop 3 entries, run `!brief`, confirm reply summarizes them.

**Size:** L.
**Depends on:** P2-01, P2-02, P2-05 (for fixture data).

---

### Theme D — AI / research

#### P2-07 — `!ai` command handler [L]

**Context.** Closes #116. Open-ended LLM Q&A. Recommendation from open-question §2: replies > 320 chars go to email; ≤ 320 chars page within the device reply budget. The wider context the device has of the user's location stays out of this prompt — `!ai` is just a question; if the user wants location in the answer they can include it.

**Acceptance criteria:**
- [ ] New module `src/core/commands/ai.ts`; orchestrator `case 'ai':` branch.
- [ ] LLM prompt: `You are TrailScribe's field research assistant. Answer the user's question concisely. Aim for 280 characters or fewer; if more is needed, write the full answer and we will route it to email.`
- [ ] Reply path:
  - LLM output ≤ 320 chars (after page formatting): reply directly on device.
  - LLM output > 320 chars: reply `Long answer sent by email.` and Resend the full answer to the operator email (subject `TrailScribe !ai: <first-40-chars-of-question>`).
- [ ] Daily token budget gate enforced.
- [ ] Empty `question` rejected: `!ai needs a question.`
- [ ] Ledger entry with real OpenRouter usage.
- [ ] Vitest: short-reply happy path; long-reply email-path; budget-exceeded; empty-question rejection; replay no-op (idempotency).
- [ ] Manual staging verification: 3 `!ai` queries with mixed expected lengths.

**Size:** L.
**Depends on:** P2-02. Resend adapter already exists from Phase 1.

#### P2-08 — `!camp` command handler [L]

**Context.** Closes #117. Camp/water/feature suggestions for a query. Per open-question §1, first cut is **LLM-only with no web search** — the model answers from general knowledge and prefixes the reply with `(may be outdated)`. A follow-up story P2-08b adds real web search if the LLM-only path proves insufficient in field testing.

**Acceptance criteria:**
- [ ] New module `src/core/commands/camp.ts`; orchestrator `case 'camp':` branch.
- [ ] LLM prompt: `You are TrailScribe's outdoors-knowledge assistant. The user is in the field with no internet. Answer their question about camping/water/features concisely. Be conservative — say "uncertain" rather than guess. Aim for 280 characters.`
- [ ] Reply formatted as `(may be outdated) <answer>` capped at 320 chars; overflow → email per the `!ai` pattern.
- [ ] Daily token budget gate enforced.
- [ ] Empty `query` rejected: `!camp needs a query.`
- [ ] Ledger entry with real OpenRouter usage.
- [ ] Vitest: happy path; overflow path; budget-exceeded; empty-query.
- [ ] Manual staging verification: 3 `!camp` queries (e.g. "water sources near Onion Valley", "camp shelter Mineral King", "Tuolumne Meadows reservation"); operator subjective-quality check.

**Size:** L.
**Depends on:** P2-02.

**Follow-up (filed separately, not blocking Phase 2 close):** P2-08b — wire a web-search provider for `!camp`. Decide between OpenRouter tool-use, Brave Search API, Tavily. File once P2-08 has been used in the field and we have evidence it needs more than general-knowledge answers.

---

### Theme E — Distribution

#### P2-09 — Address-book config (env-var JSON) [M]

**Context.** `!share` (P2-10) and `!blast` (P2-11) need to resolve recipient names. Per open-question §3, env var is the simplest viable form for a single-operator project.

**Acceptance criteria:**
- [ ] New env var `ADDRESS_BOOK_JSON` validated by zod in `src/env.ts`. Schema: `{ aliases: Record<string, string> }` where keys are alias names (e.g. `"home"`, `"family"`, `"editor"`) and values are email addresses; an `"all"` key may map to a comma-separated list of addresses for `!blast`.
- [ ] New module `src/core/addressbook.ts` exports `resolve(env, alias): string[]` (returns one or more email addresses; throws on unknown alias).
- [ ] Validation rejects malformed JSON or non-email values with a typed `EnvValidationError` (already used in Phase 1's env validation).
- [ ] Wrangler secret + `.dev.vars.example` updated. CLAUDE.md secrets list updated.
- [ ] Vitest: resolve known alias → single address; resolve `all` → list; resolve unknown → throws; malformed JSON → env validation fails.

**Size:** M.
**Depends on:** nothing.

#### P2-10 — `!share` command handler [M]

**Context.** Closes #119. Single-recipient `!mail` variant: `!share to:<alias|email> <note>` sends the note plus current location to one recipient. Reuses the Phase 1 Resend adapter; the only new behavior is alias resolution.

**Acceptance criteria:**
- [ ] New module `src/core/commands/share.ts`; orchestrator `case 'share':` branch.
- [ ] Resolve `cmd.to` via `addressbook.resolve()` if it does not contain `@`; otherwise treat as a literal email.
- [ ] Email body: the note + Google Maps link + MapShare link + place name (if geocode succeeds). Subject: `TrailScribe — note from the field`.
- [ ] Reply format: `Shared with <alias-or-truncated-addr>.`
- [ ] No-GPS-fix path: send the email anyway, omit location lines, reply `Shared (no GPS).`.
- [ ] Ledger entry with `cmd: 'share'`, `usd_cost: 0`.
- [ ] Vitest: alias resolution path; literal email path; unknown alias rejection; no-fix path.
- [ ] Manual staging verification: `!share to:home …` from fixture → email arrives at the expected address.

**Size:** M.
**Depends on:** P2-02, P2-09.

#### P2-11 — `!blast` command handler [M]

**Context.** Closes #118. Broadcast a note to the address book's `all` group. Per-recipient send errors are tolerated (one bad address does not block the rest); the reply summarizes successes vs. failures.

**Acceptance criteria:**
- [ ] New module `src/core/commands/blast.ts`; orchestrator `case 'blast':` branch.
- [ ] Resolve recipients via `addressbook.resolve(env, 'all')`; if missing, reply `No blast group configured.`.
- [ ] Send one Resend call per recipient (Resend API has no broadcast primitive in the free tier; we accept N HTTP calls). Capture per-recipient outcome.
- [ ] Email body: same enriched format as `!share` (note + maps + MapShare + place).
- [ ] Reply format: `Blasted to <N> (<failures> failed).` — keep terse.
- [ ] Ledger entry with `cmd: 'blast'`, `usd_cost: 0` (Resend free tier; if the operator ever upgrades, add per-message cost via env var).
- [ ] Vitest: happy path 3-of-3; partial-failure 2-of-3; no-group-configured.
- [ ] Manual staging verification with a 2-address `all` group.

**Size:** M.
**Depends on:** P2-02, P2-09.

---

### Theme G — Image-augmented journal

#### P2-17 — Image-gen adapter + grounded prompt builder [M]

**Context.** Closes the adapter half of #125. The image generator is the new external dependency; the prompt builder is a small new module that grounds the image in device telemetry (lat/lon, altitude, time-of-day, weather, place name) plus the operator's caption. **Provider locked to Replicate Flux schnell or SDXL** for the first cut — its $0.003–$0.01 per-image cost keeps `!postimg` under the existing PRD §7 $0.05 ceiling without needing a premium-class exception. Upgrade to gpt-image-1 / DALL-E 3 is filed as P2-18b conditional on operator field-quality assessment.

**Engineering shape:**
- New module `src/adapters/ai/replicate.ts` (or whichever provider is locked at impl time; same wrapper shape as `openrouter.ts`). Supports `generateImage({ prompt, aspectRatio, env })` returning `{ bytes: ArrayBuffer, mimeType: string, model: string, costUsd: number }`.
- New module `src/core/imageprompt.ts`: `buildImagePrompt({ caption, place, lat, lon, altitudeM, localTime, weather })` returns a paragraph-style prompt with the constraints from #125's body baked in (realistic / plausible / no text overlays / lighting matches local time / do not invent named landmarks).
- New env vars (validated in `src/env.ts`): `IMAGE_PROVIDER` (`replicate`), `IMAGE_MODEL` (e.g. `black-forest-labs/flux-schnell`), `IMAGE_COST_PER_CALL_USD` (used for ledger; default `0.01`), and a Wrangler secret `IMAGE_API_KEY`.
- `src/core/ledger.ts` extended to record image-gen as a separate `kind: 'image'` line so `!cost` can break out image vs. text spend (see P2-18 acceptance for the `!cost` reply tweak).

**Acceptance criteria:**
- [ ] `generateImage` happy-path returns binary bytes + cost; failure-path throws a typed `ImageGenError` with provider response.
- [ ] `buildImagePrompt` returns a deterministic prompt for the same inputs (snapshot test) and includes every grounding axis when present, omits gracefully when absent (e.g. no GPS fix → no lat/lon line).
- [ ] Ledger entries for image-gen tag `kind: 'image'`; existing text-spend ledger entries are unchanged.
- [ ] Wrangler `.dev.vars.example` updated; CLAUDE.md secrets list updated.
- [ ] Vitest: `generateImage` happy-path + failure-path with mocked HTTP; `buildImagePrompt` snapshot tests for three telemetry profiles (coastal bluff, alpine, desert flank).

**Size:** M.
**Depends on:** nothing (foundation work, lands alongside Theme A).

#### P2-18 — `!postimg` command pipeline + binary journal commit [L]

**Context.** Closes the pipeline half of #125. Mirrors the existing `!post` handler in `src/core/commands/post.ts` with an image-gen step inserted before the GitHub Pages commit, and the GitHub Pages adapter extended to commit the binary image alongside the markdown post.

**Engineering shape:**
- New module `src/core/commands/postimg.ts` mirroring `post.ts`: enrich → narrative → **image-gen** → commit (markdown + image) → reply.
- Image-gen step wrapped in `withCheckpoint` from `src/core/idempotency.ts` so a Garmin retry replay does not re-bill image gen. Uses a new `OpName: 'image'`.
- `adapters/publish/github-pages.ts` extended to take an optional `image: { bytes, path, mimeType }` param. When present, commits the binary at `_images/<post-slug>.<ext>` *in the same atomic operation* as the markdown post (single GraphQL `createCommitOnBranch` mutation with two file additions; the existing commit path uses single-file Contents API — this story upgrades it to GraphQL so two files commit atomically and an interrupted run does not leave a markdown post pointing to a missing image).
- Markdown front-matter or first line includes `![<caption>](/_images/<slug>.<ext>)` so GitHub Pages renders the image at the top of the post.
- `!cost` reply (existing handler) updated to break out image vs. text spend when image entries are present; format: `MTD: <reqs> reqs · $<text> text + $<image> img · $<total>`.

**Acceptance criteria:**
- [ ] `!postimg <caption>` parses through `src/core/grammar.ts` (extension lands in P2-02 — confirm grammar table includes `postimg`).
- [ ] Pipeline order: idempotency → enrich (geocode + weather) → narrative LLM → image-gen → atomic commit → reply.
- [ ] Reply within the 320-char budget; format mirrors `!post`'s reply with the journal URL; the device reply does **not** include a raw image URL.
- [ ] Image-gen failure path: log `event: 'image_gen_failed'` with provider error; fall back to a text-only `!post` (do not lose the operator's caption); reply notes `(image gen failed; text-only)`.
- [ ] Idempotency replay test: send the same `!postimg` event twice; assert exactly one image-gen call to the mocked provider, exactly one commit, exactly one ledger image entry.
- [ ] Atomic-commit assertion: the markdown post and the image file appear in the same commit on the journal repo (`gh api` peek confirms a single commit SHA referencing both paths).
- [ ] Ledger `image` entries match the `IMAGE_COST_PER_CALL_USD` env var; `!cost` reply breaks them out.
- [ ] Vitest: parse, full happy-path with mocked image-gen + mocked GitHub commit; image-fail-fallback path; idempotency replay; cost-suffix breakout.
- [ ] Manual staging verification: 3 `!postimg` events from fixture, all three render image-at-top in the rendered GitHub Pages site.

**Size:** L.
**Depends on:** P2-02 (grammar), P2-17 (image-gen adapter + prompt builder).

**Follow-up (filed separately, not blocking Phase 2 close):** P2-18b — upgrade image provider to gpt-image-1 / DALL-E 3 if Replicate Flux schnell quality proves insufficient in field testing. Cost-envelope decision (premium-class exception in PRD §7 vs. per-call cap) gets made then with real field data, not now.

---

### Theme F — Reconcile + verify

#### P2-12 — Refresh `docs/field-commands.md` to current truth [S]

**Context.** The doc is structurally stale — references OpenAI (not OpenRouter), Posthaven (not GitHub Pages), Gmail (not Resend), and lists the original 13-verb grammar as if Phase 1 implemented all of them. Phase 2 ships eight new verbs; the doc must reflect ground truth before β-readers (the operator's future self, primarily) trust it.

**Acceptance criteria:**
- [ ] All 14 commands listed with current adapter names (OpenRouter for LLM, GitHub Pages for blog, Resend for email).
- [ ] Each Phase 2 command has its argument shape and a one-line example.
- [ ] Notes section updated: idempotency wording matches `docs/PRD.md` §5; reply-budget note matches PRD §2.
- [ ] No references to `!postimg` (filed under #125, not in Phase 2 scope) or anything else not actually implemented.
- [ ] Recipient + Include-Location section from #121 is preserved.

**Size:** S.
**Depends on:** can land any time during Phase 2 (the doc is descriptive, not prescriptive — refresh once per-command stories stabilize).

#### P2-13 — Reconcile PRD §2 deferral table to single Phase 2 [S]

**Context.** PRD §2 splits the deferred eight across Phase 2 / 3 / 4 (`!camp`, `!ai` → 3; `!share`, `!blast` → 4). The structural-review filing of epic #98 unified them as Phase 2; this plan does the same. The PRD must reconcile so that the PRD-as-source-of-truth claim (CLAUDE.md ground rule) holds.

**Acceptance criteria:**
- [ ] PRD §2 deferrals table: all eight commands point to **Phase 2** with reasons rewritten or kept where still apt (`!camp` complexity reason still applies — captured as P2-08b follow-up; `!ai` chunked-reply UX reason still applies — captured as P2-07's email overflow path).
- [ ] PRD §2 explicit cross-reference to this plan for the engineering shape ("see `plans/phase-2-extended-commands.md` for sequencing and per-command acceptance").
- [ ] `docs/PRD.md`'s "Phased evolution" section (§3) re-checked: Phase 2 description matches this plan's scope; Phase 3 narrowed to the storage migration (DO + D1) and any Phase 2 carry-forward (P2-08b web search, if not yet shipped).
- [ ] CLAUDE.md "Status" block updated: flip "Production-readiness — current live phase" to "Phase 2 — extended commands"; refresh the open-item count and the milestone framing.
- [ ] **Close the Production-readiness milestone** (`gh api repos/brockamer/trailscribe/milestones/3 -X PATCH -f state=closed`) — currently `state=open` with `0 open / 8 closed`. The reconcile commit is the right time because PRD + CLAUDE.md flip together.

**Size:** S.
**Depends on:** Phase 2 plan signed off (this file). Should land *before* P2-14 so per-issue body refreshes match the reconciled PRD.

#### P2-14 — Refresh #112–#119 sub-issue bodies to match plan [S]

**Context.** The eight per-command issues (#112–#119) are placeholders today (filed 2026-04-27 during structural review). Each story above (P2-03, P2-04, P2-05, P2-06, P2-07, P2-08, P2-10, P2-11) has the real engineering shape; the issues should mirror it so the board surfaces a real spec on each card.

**Acceptance criteria:**
- [ ] Each of #112–#119's body has: a Scope line citing the corresponding P2-XX story, an Acceptance section copied from this plan's per-story acceptance, and a Depends-on edge to its prerequisite stories (FieldLog, address book, etc.) via native `blockedBy`.
- [ ] Sub-issues promoted from Low → **Medium** (active phase, but not all eight strategic at once). The epic #98 alone goes to High; per `docs/project-board.md` "High is scarce by design," only the *currently-pulled* sub-issue gets promoted to High at the moment it moves into Up Next / In Progress. This avoids the "everything is High" dilution the board convention warns about.
- [ ] Epic #98's body trimmed of the open-question section (operator decision: skip β); replaced with a one-line link to this plan and an updated dependency note (Production-readiness milestone is now closed; not "blocking").

**Size:** S.
**Depends on:** P2-13.

#### P2-15 — Phase 2 staging burn-in [M]

**Context.** Mirror of P1-21. Once all command handlers (P2-03..P2-11) have landed, run a fixture-driven burn-in on staging: every command from a fixture that mirrors the operator's expected use (1×`!where`, 1×`!weather`, 3×`!drop`, 1×`!brief`, 2×`!ai`, 1×`!camp`, 1×`!share`, 1×`!blast`). Capture ledger snapshot. **Staging only** — production validation is its own gate (P2-16) so a green burn-in does not implicitly close the milestone.

**Acceptance criteria:**
- [ ] All 11 fixture commands produce expected replies on staging without operator intervention.
- [ ] Ledger snapshot pasted as a story comment: per-command count, total tokens, total USD.
- [ ] No errors in `wrangler tail --env staging` other than the deliberate empty-arg rejection cases.
- [ ] Idempotency check: replay 3 of the events; assert no duplicate side-effects (same checks as P1-22).

**Size:** M.
**Depends on:** P2-03, P2-04, P2-05, P2-06, P2-07, P2-08, P2-10, P2-11.

#### P2-16 — Phase 2 production turn-on (real-device) [S]

**Context.** Phase 1's analogue is #111: the milestone closes when the operator's Mini 3 Plus has sent each new command against the production Worker and received a valid reply. Filed as its own gate (not bundled into P2-15) because staging-fixture-green and device-validated are different signals. File a sibling tracking issue under the Phase 2 milestone analogous to #111's role under Phase 1.

**Acceptance criteria:**
- [ ] Tracking issue filed (analogous to #111) titled "Phase 2 production turn-on: send 9 commands from Mini 3 Plus → production Worker" (the eight α-deferred commands plus `!postimg`).
- [ ] Each of the nine new commands sent at least once from the device; reply received on-device for each.
- [ ] `!postimg`: the journal post URL in the device reply renders an image at the top when opened on the operator's phone after returning to cell coverage.
- [ ] Production ledger inspected: each command shows ≥ 1 transaction with reasonable cost (LLM-bearing commands match Phase 1 cost shape — ≤ \$0.05; `!postimg` records both text and image ledger lines).
- [ ] No regressions on the six Phase 1 commands during the same session.

**Size:** S.
**Depends on:** P2-15 (staging green is prerequisite for production exposure).

---

## Sizing summary

| Size | Count |
|---|---|
| S | 6 |
| M | 9 |
| L | 4 |

**Rough total:** 5–7 focused days. Phase 2 is lighter than Phase 1 (no foundational scaffolding, no first-time API integrations) but the LLM-bearing handlers (`!brief`, `!ai`, `!camp`) and the image-gen pipeline (`!postimg`) consume the bulk of the time on prompt tuning, overflow-path testing, and image-quality iteration.

## Execution order (recommended sequencing)

**Critical path:** P2-01 (FieldLog) and P2-02 (grammar) are the only true blockers for the rest. After they land, Themes B, C, D, E parallelize freely.

**Suggested sprint shape (one focused week, ~one-third the days of Phase 1):**

- Day 1: P2-01 + P2-02 + P2-09 + P2-17 (foundation stories — grammar, FieldLog, address book, image-gen adapter — all small and independent; unblock everything downstream).
- Day 2: P2-03 + P2-04 (quick wins; smoke-tests the parallelization model).
- Day 3: P2-05 + P2-10 + P2-11 (FieldLog write + email distribution).
- Day 4: P2-06 + P2-07 + P2-08 (the three text LLM-bearing commands; expect prompt-tuning overhead).
- Day 5: P2-18 (`!postimg` pipeline + atomic binary commit; expect image-prompt iteration overhead).
- Day 6: P2-12 + P2-13 + P2-14 + P2-15 (reconcile + staging burn-in).
- Day 7 (operator): P2-16 — real-device turn-on against production. Closes the milestone.

If `!brief` or `!ai` overflow paths surface bugs in the Phase 1 reply formatter, treat that as a spike under P2-15 and patch the formatter before continuing.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `!camp` LLM-only answers prove unhelpful in the field | M | Operator dissatisfied, command sees no use | Ship LLM-only first cut (P2-08); if field experience is poor, file P2-08b for real web search; the failure mode is "command not useful," not "system breaks." |
| `!ai` + `!brief` push past daily token budget on busy days | M | Cap message instead of answer; operator surprise | The cap is a feature, not a bug; ledger surfaces it via `!cost`; raise `DAILY_TOKEN_BUDGET` env var if needed. |
| FieldLog grows unbounded if cap config is wrong | L | KV usage drift | P2-01 acceptance asserts cap behavior with a dedicated Vitest case. |
| Address-book env-var JSON is fiddly to edit (single line, escaped) | M | Operator friction when adding a recipient | Document a `scripts/addressbook.sh` wrapper if it bites; KV migration is the YAGNI fallback. |
| Resend per-recipient calls in `!blast` hit free-tier limits | L | Some recipients miss the message | Resend free tier is 3000/mo; even daily blasts to a 5-person group is well within. Track in ledger. |
| Reply overflow path (email/journal) fires for replies that *almost* fit | L | Operator gets email when they expected on-device | P2-07 / P2-08 acceptance pins the threshold at 320 chars (post-paging); `!brief` at 320 chars (no paging — single SMS or email). |
| Phase 2 commands regress Phase 1 behavior via shared orchestrator | L–M | `!post` etc. break | Phase 1 Vitest suite must stay green throughout; CI gate on every PR. |
| `!postimg` Replicate quality is unacceptable for "plausibly realistic" bar | M | Operator stops using `!postimg`; effort wasted | P2-18 acceptance includes operator subjective check; if it fails, P2-18b upgrades the provider with real cost data and a PRD §7 premium-class exception decision. |
| `!postimg` atomic-commit upgrade (Contents API → GraphQL `createCommitOnBranch`) breaks `!post`'s existing single-file commit path | L–M | Phase 1 `!post` regresses on first deploy | P2-18 acceptance asserts both paths work in the same deploy; CI runs the existing `!post` Vitest cases; staging burn-in (P2-15) sends a `!post` *and* a `!postimg` and confirms both commit. |
| `!postimg` image-gen replay double-bills if `withCheckpoint` wrap is wrong | L | Cost overrun on every Garmin retry storm | P2-18 has an explicit replay-test acceptance bullet asserting exactly one image-gen call. |
| OpenRouter model-availability change mid-phase | L | LLM-bearing commands fail | Phase 1 already mitigates via `LLM_MODEL` env var swap; Phase 2 inherits. |
| Operator forgets the new commands' syntax | L | UX friction; commands fail with `parse_unknown` | `!help` reply is updated as part of P2-02 to list all 14 commands. |

---

## Out of scope for Phase 2

- **Durable Objects / D1 migration.** Phase 3 / epic #99. KV remains the only state tier.
- **β-launch milestone, second IMEI, per-IMEI cost attribution.** Closed by the single-operator assumption above.
- **Email-fallback reply for the IPC Inbound path.** Locked decision D9 — skipped permanently.
- **`!camp` real web search.** Filed as P2-08b follow-up; not blocking Phase 2 close.
- **Image-provider upgrade beyond Replicate Flux.** P2-18b follow-up; conditional on operator field-quality assessment. Phase 2 ships with Replicate Flux schnell to keep `!postimg` under the existing PRD §7 $0.05 ceiling without a premium-class exception.
- **Web dashboard / multi-user features.** Post-v1.0 per PRD §1 non-goals.
- **Schema V4 / encrypted messages.** Not handled (configure plaintext schema in Portal Connect).
- **Address-book admin UI / KV-stored address book.** YAGNI per open-question §3.
- **Production-readiness milestone items.** All closed pre-Phase-2 (#111, #33, #121, #14, #15, #26).

---

## Sign-off gate

After every checkbox in **Milestone exit criteria** is true:

1. Walk through the checklist on epic #98 or a tracking PR.
2. Confirm each item with a citation (commit, log capture, ledger snapshot).
3. Close epic #98; close each per-command issue (#112–#119); close the **Phase 2 — extended commands** milestone.
4. Archive this plan to `plans/archived/2026-MM/phase-2-extended-commands.md` mirroring the Phase 1 / Phase 0 pattern.
5. Decide next: Phase 3 storage migration (#99) or P2-08b web-search follow-up — depends on operator usage signal.
