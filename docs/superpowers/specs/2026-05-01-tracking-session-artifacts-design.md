# Tracking Session Artifacts — Design Spec

**Status:** Draft, pending review
**Author:** Claude (Opus 4.7) with Brock Amer
**Date:** 2026-05-01
**Related:** PRD §9 Roadmap, Epic #99 (Phase 3 — DO + D1), Epic-candidate (this spec → new epic)

---

## 1. Goal

Turn the *tracking ping stream* that a Garmin inReach already emits during an active tracking session into a polished, AI-narrated journal artifact published on session end — without any operator-side ceremony beyond turning tracking on and off.

Today the Worker silent-drops every tracking event (`src/app.ts:118` rejects everything that isn't `messageCode === 3`). This spec opens that path, persists the session, and produces a future-self artifact when the session closes.

**Audience for v1:** the operator, post-trip. ("Future-self artifacts" — chosen 2026-05-01.)
**Out of audience for v1:** watchers / family / followers. Watcher digests via Substack/Posthaven/RSS-style fan-out are a separate, follow-on epic.

## 2. In Scope (v1)

- Ingest `messageCode` 0 (Position Report), 10 (Start Track), 11 (Track Interval), 12 (Stop Track) instead of dropping them.
- Persist a per-IMEI tracking session: Start → N pings → Stop, idempotent under Garmin retries.
- On Stop Track (or session timeout), derive metrics from the position stream and generate an LLM-narrated journal post.
- Commit the post to the existing journal repo via the existing `publishPost` path, with an extended frontmatter shape that captures the trajectory.
- Reply to the operator with a single confirmation SMS containing the journal URL.

## 3. Out of Scope (v1) — with rationale

- **Mid-session journal entries / "live narration."** Belongs to the watcher-channel epic; would also force decisions about how to update vs. append journal posts during a single trip.
- **Watcher digests / subscriber model.** Filed as Option C from the brainstorm. Would tie to Substack, Posthaven, or an RSS endpoint. Separate spec.
- **Proactive on-device nudges** ("battery low, sunset in 2h, want me to flag turn-around?"). Borders on safety-system territory which PRD §1 explicitly rules out.
- **Anomaly alerts** ("no movement for 90 min"). Same safety-adjacent concern, plus needs a watcher channel to be useful.
- **Persona-tagged output styles** (Yuki's Storyteller voice vs. Marcus's Logistics voice vs. Natalie's Field-Notes voice). Interesting v2 lever — single tone for v1.
- **Session-aware `!brief`** ("what have I done today" computed from the active track). Strictly Operator-Facing audience (Option A from brainstorm) — defer to a follow-up that can reuse the storage built here.
- **Map renders / GPX export / route GeoJSON.** v1 uses lat/lon arrays in frontmatter and a Google-Maps-link of waypoints; rendered map images come later.

## 4. Source-of-truth: what each event actually carries

From `materials/Garmin IPC Outbound.txt` (V2 schema), every event has the same envelope. The fields that matter to this spec:

| Code | Name | What it tells us |
|---|---|---|
| `0` | Position Report | A breadcrumb. `point.{latitude, longitude, altitude, gpsFix, course, speed}` + `status.{lowBattery, intervalChange}`. |
| `10` | Start Track | Tracking session began on the device. |
| `11` | Track Interval | Operator changed the tracking interval mid-session. `status.intervalChange` = new interval in seconds. |
| `12` | Stop Track | Tracking session ended cleanly. |

**Speed** is over-ground in km/h. **Course** is true bearing in degrees (0-360). **gpsFix:** 0=no fix, 1=2D, 2=3D, 3=3D+. **lowBattery:** 0=ok, 1=below 25%, 2=not reported.

A test-fixture for a position report already exists at `tests/fixtures/garmin/breadcrumb-position-report.json` — same envelope as a Free Text event. No new auth, no new transport.

## 5. Architectural choices

### 5.1 Storage approach — three options

**A. KV-only, pre-Phase-3.** Add a `TS_TRACKS` KV namespace; key `track:<imei>:<sessionId>`; append-on-write to a JSON array of pings. Simple but inherits KV's eventual-consistency caveat (`src/core/context.ts:30-34` already documents the read-modify-write race) — much worse for tracking because pings arrive on a 2-minute cadence, sometimes faster on interval change. A burst of replays after a brief Worker outage could lose pings.

**B. Build on the Phase-3 Durable Object as the forcing function.** Phase 3 (epic #99) was filed as an infra migration. Extend its scope: the per-IMEI DO that already serializes idempotency-write contention also owns the active tracking session. DO storage is strongly consistent and serialized — exactly the right semantics for an append-only ping stream. The DO holds the in-progress session; on Stop Track it flushes a record to D1 (the same D1 instance the Phase-3 ledger migration is about to provision) and publishes the post.

**C. KV now, migrate later.** Ship v1 on KV; migrate to DO when Phase 3 lands. Carries migration cost twice and risks a partial-session at cutover.

**Recommended: B.** Phase 3 is already in-flight (milestone #5, due 2026-05-15) and its scope is being extended for storage migration anyway. Folding tracking-session ownership into the same per-IMEI DO is the natural unit of work, gives us the consistency guarantees this feature genuinely needs, and avoids a second migration. The cost is that this spec depends on Phase 3 landing; the upside is that it gives Phase 3 a *product* deliverable, not just an infra one.

**Timing coupling — explicit:** if Phase 3 slips, this spec slips with it. That risk is acceptable given Phase 3 is already on the active milestone and the alternative (option A or C) burns engineering cost building a KV path we'd then throw away. If Phase 3 timing becomes uncertain, revisit and consider option A as a temporary path. (Tracked as an open question in §11.)

### 5.2 Session boundaries

**Cleanest case:** `Start Track → … → Stop Track`, both received exactly once. The DO opens a session on Start, accumulates Position Reports, closes and publishes on Stop.

**Real-world cases we have to handle:**

- **Missing Start Track.** Position Reports arrive without a preceding Start. Auto-open a session on the first Position Report seen for an IMEI without an active session. Edge: device was tracking before the Worker came online.
- **Missing Stop Track.** Battery dies, device crashes, operator just turns off without proper Stop. Resolved by a **session-idle timeout**: if no ping arrives within `TRACK_SESSION_IDLE_TIMEOUT_SECONDS` (proposed default: 30 min — long enough to absorb a 10-min interval × 3, short enough that a session ends in the same day it started), the DO auto-closes and publishes. Implemented with Workers' DO `setAlarm` API — no polling cron needed.
- **Duplicate Start Track.** Garmin retries until 200 OK. Idempotent under our existing key. If a Start arrives while a session is already open, log and ignore.
- **Stop Track with no open session.** Log and ignore (Garmin retried Stop after we'd already auto-closed).
- **Track Interval mid-session.** Record the interval change in the session record so derived metrics (cadence-per-leg) reflect it; not load-bearing for v1 narrative.
- **Position Report after Stop.** Likely a retry from before the Stop. Idempotent key handles dedup.

### 5.3 One post per session vs. many

**Choice for v1: one post per session, published on close.** Maps directly to the existing `publishPost` shape (no new commit semantics). Multi-waypoint narratives (a post for the trailhead, one for the summit, one for camp) are a richer surface but require deciding how subsequent commits relate to the first — defer.

## 6. Detailed design

### 6.1 Webhook ingestion change

`src/app.ts:118-131` is the silent-drop block. Replace with:

```ts
if (event.messageCode === 3) {
  // existing free-text path unchanged
} else if (event.messageCode === 0 || event.messageCode === 10 ||
           event.messageCode === 11 || event.messageCode === 12) {
  await ingestTrackEvent(event, env, key);
} else if (event.messageCode === 4) {
  log({ event: "sos_received_ignored", ... }); // unchanged
} else {
  log({ event: "non_tracked_message_code", ... }); // unchanged for 64/66/etc.
}
```

`ingestTrackEvent` lives in a new module `src/core/tracking.ts` and routes the event to the per-IMEI DO. Idempotency for tracking events uses the same composite key (`imei + timeStamp + messageCode + content_hash`) — Position Reports with empty `freeText` hash to a stable key per `(imei, timeStamp)`, so Garmin retries dedup naturally.

### 6.2 Per-IMEI Durable Object — extended responsibilities

(Pre-existing Phase-3 scope: serialize idempotency writes, hold the rolling context window.)

**New responsibilities for this spec:**

- `openSession(startEvent)` — creates a session record with `sessionId = sha256(imei + ":" + startEvent.timeStamp)`, opens the alarm timer.
- `appendPing(positionEvent)` — appends to the session's ping array; resets the alarm timer.
- `recordIntervalChange(event)` — appends to a leg-boundary array.
- `closeSession(reason: "stop" | "timeout")` — finalizes the record, calls the publish pipeline, clears state.
- `alarm()` — DO-internal handler; calls `closeSession("timeout")`.

**Storage shape inside the DO:**

```ts
interface ActiveSession {
  sessionId: string;
  imei: string;
  startedAt: number;        // ms epoch
  lastPingAt: number;
  pings: Array<{
    t: number;              // ms epoch
    lat: number; lon: number; alt?: number;
    course?: number; speed?: number;
    fix?: number;
    lowBattery?: number;
  }>;
  intervals: Array<{ t: number; intervalSeconds: number }>;
  startEvent: GarminEvent;  // kept for diag
}
```

D1 schema for closed sessions (lives alongside the Phase-3 ledger table):

```sql
CREATE TABLE track_sessions (
  session_id TEXT PRIMARY KEY,
  imei TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  closed_at INTEGER NOT NULL,
  close_reason TEXT NOT NULL,           -- 'stop' | 'timeout'
  ping_count INTEGER NOT NULL,
  distance_km REAL,
  elevation_gain_m REAL,
  duration_seconds INTEGER NOT NULL,
  journal_url TEXT,                     -- null until publish succeeds
  raw_pings_json TEXT NOT NULL,         -- the full ping array, for re-derivation later
  CHECK (close_reason IN ('stop', 'timeout'))
);
CREATE INDEX idx_track_sessions_imei_started ON track_sessions(imei, started_at DESC);
```

`raw_pings_json` is kept verbatim so a future v2 (better metrics, persona styles, map renders) can re-derive without replaying the device.

### 6.3 Derived metrics — pure functions on the ping array

A new module `src/core/track-metrics.ts` exports pure functions over `Ping[]`:

- `totalDistanceKm(pings)` — Haversine sum between consecutive points.
- `elevationProfile(pings)` — `{ gainM, lossM, maxM, minM }`. Apply a small smoothing window (5-point median) to reject GPS altitude noise — handheld GPS altitude is ±10-15m and would otherwise inflate gain.
- `paceStats(pings)` — `{ avgKmh, p50Kmh, p95Kmh }` from `point.speed` (already provided per ping; no need to derive from positions).
- `stopsAndBreaks(pings)` — clusters of ≥3 consecutive pings within 50m of each other; returns `Array<{ at, lat, lon, durationSeconds }>`. Useful as paragraph breaks in narrative.
- `routeShape(pings)` — `"out-and-back" | "loop" | "point-to-point"` heuristic from start/end/midpoint distances.
- `activityHint(pings)` — naive speed-distribution classifier: `"hike" | "run" | "bike" | "drive" | "mixed"` (5/10/20/40 km/h band centers). Input to the LLM, not surfaced as a hard claim.

All pure, all testable with fixtures from a real session.

### 6.4 Narrative pipeline — extension of `core/narrative.ts`

Add a new mode to `narrative.ts`:

```ts
export interface TrackNarrativeInput {
  startedAt: number;
  closedAt: number;
  closeReason: "stop" | "timeout";
  metrics: {
    distanceKm: number;
    durationSeconds: number;
    elevationGainM: number;
    avgSpeedKmh: number;
    activityHint: string;
    routeShape: string;
    stops: Array<{ at: number; placeName?: string; durationSeconds: number }>;
  };
  startPlace?: string;       // reverse-geocoded
  endPlace?: string;
  midpointPlace?: string;
  weatherSummary?: string;   // experienced weather along the route, summarized
  env: Env;
}
```

Output: same `{ title, haiku, body, usage }` as existing `NarrativeOutput`. `body` cap can grow from 500 → 1200 chars for track narratives — these have more to say and are not constrained by the SMS reply budget (the device only sees the URL).

System prompt is a third variant alongside `SYSTEM_PROMPT_WITH_NOTE` and `SYSTEM_PROMPT_NO_NOTE`. Forbids inventing companions, motivations, or destinations not present in the metrics.

**Place-name strategy:** reverse-geocode the start, the end, and the route midpoint via the existing `adapters/location/geocode.ts` (Nominatim, cached). Don't reverse-geocode every ping — wasteful and slow. Three lookups is enough for the LLM to ground a narrative.

**Weather strategy:** call `adapters/location/weather.ts` once for the *midpoint* in *time* (not space) — the weather the operator most likely experienced. Don't try to reconstruct hour-by-hour weather; it's expensive and overkill for v1.

### 6.5 Journal post format — extended frontmatter

Existing `publishPost` markdown shape (from `src/adapters/publish/github-pages.ts:219-236`):

```yaml
---
title: "..."
date: 2026-05-01T18:30:00.000Z
location: { lat: ..., lon: ..., place: "..." }
weather: "..."
tags: [trailscribe]
---
<haiku>

<body>
```

Extension for track posts — add to the existing renderer or split a `renderTrackMarkdown`:

```yaml
---
title: "..."
date: 2026-05-01T22:14:00.000Z       # closedAt
type: track                            # discriminator: 'post' | 'postimg' | 'track'
track:
  started_at: 2026-05-01T18:30:00Z
  duration_seconds: 13440
  distance_km: 8.7
  elevation_gain_m: 412
  activity_hint: hike
  route_shape: out-and-back
  start_place: "Onion Valley TH, Inyo NF"
  end_place: "Onion Valley TH, Inyo NF"
  pings: 84
  close_reason: stop
location: { lat: <end>, lon: <end>, place: "<endPlace>" }
weather: "..."
tags: [trailscribe, track]
---
<haiku>

<body>

<!-- optional v1 extra: a Google-Maps multi-waypoint URL of, say, every 10th ping -->
[Map of route](https://www.google.com/maps/dir/...)
```

`type: track` is the discriminator a future Jekyll/Hugo theme can switch on to render differently from a regular `!post`.

### 6.6 Reply to the device

On successful publish, send a single SMS to the operator (well within the 320-char budget):

```
Track posted: 8.7km, 412m gain, 3h44m
trailscribe-journal/2026/05/01-onion-valley-loop.md
```

If publish fails after retries: log + send `Track save failed; raw pings retained` and *don't* delete the DO state — the next attempt or a manual replay can re-publish from `raw_pings_json` in D1.

If the session closes by timeout (not Stop Track), the same SMS is sent but with the `close_reason` baked in: `Track auto-closed (no Stop): ...`. Operator learns their device went dark mid-session.

### 6.7 Idempotency & failure modes

- **Position Report retries.** Composite key already covers them — appending the same ping twice is short-circuited by the existing `idempotency.ts` path.
- **Stop Track retried after publish.** The DO has already cleared state; `closeSession` on a missing session is a no-op (`log + return`).
- **Worker crash mid-publish.** The DO state survives. On the next inbound event for that IMEI, the DO sees a closed-but-unpublished session and retries the publish step. Use `withCheckpoint` (existing) to avoid double-publishing.
- **Operator runs `!post` during an active tracking session.** Today's `!post` is unchanged. v1 does not cross-link the two; v2 might emit "your `!post` was made during track session XYZ".
- **No GPS fix on every ping.** If the entire session has `gpsFix === 0`, derived metrics fall back to `null` and the narrative reads as a duration-only summary. Don't crash; don't invent a position.

## 7. Env additions

Two new vars (no new secrets):

- `TRACK_SESSION_IDLE_TIMEOUT_SECONDS` — default `1800` (30 min). Stop-track-missing detection.
- `TRACK_NARRATIVE_BODY_MAX` — default `1200`. Cap for the track-narrative body schema.

(Optional, deferred to v2: `TRACK_PERSONA_PROFILE` for tone selection.)

A new D1 binding (`TS_DB`) is part of the Phase-3 scope already; this spec consumes it.

## 8. Cost budget

Cost depends on which Cut from §10 is live:

- **Cut 1 only (ingest + persist, no narrative):** effectively $0/session. No LLM, no geocode, no weather call. Just D1 + DO storage.
- **Cut 2 (with narrative + publish):** **~$0.013/session typical.**
  - One LLM call at session close: ~1500 prompt tokens (metrics + place names + weather) + ~600 completion tokens (title/haiku/body) at Claude Sonnet 4.6 pricing → ~$0.012.
  - Reverse-geocode: 3 calls per session, all cached via `TS_CACHE`. Effectively free amortized.
  - Weather: 1 call per session, cached. Effectively free amortized.
  - GitHub Contents API: free.

Per-session: **≤ $0.013** typical at full v1 (Cuts 1 + 2), well under the $0.05 PRD §6 ceiling.

Storage:
- D1: bounded — typical session is 50-200 pings × ~80 bytes JSON each = 5-20 KB. Even a year of daily 6-hour walks fits in MB.
- DO: only the *active* session lives in DO storage; closed sessions are flushed to D1 and the DO state is cleared.

## 9. Test strategy

- **Unit tests** for every function in `track-metrics.ts` against fixture ping arrays (Haversine, smoothing, clustering).
- **A real fixture from the operator's test session** committed to `tests/fixtures/garmin/track-session-*.json` — the 2026-05-01 test walk is the seed. This fixture replays through the full DO + D1 + publish path under Miniflare.
- **Integration test** for the session-lifecycle state machine: open → ping × N → stop → publish (mock GitHub + LLM).
- **Auto-close timeout test**: open → ping × N → `setAlarm` fires → publish.
- **Idempotency test**: replay the entire fixture twice through the webhook, assert one publish.

## 10. Implementation phasing (within this spec)

If the work has to land incrementally:

1. **Cut 1 — Ingest + persist (no narrative).** Open the webhook path, route to DO, accept Start/Position/Interval/Stop, flush to D1 on close. Operator gets no journal post yet — just a `Track ingested: 84 pings, 8.7km` reply. Validates the storage and lifecycle in production with real device traffic.
2. **Cut 2 — Narrative + publish.** Add `track-metrics.ts`, the `TrackNarrativeInput` mode in `narrative.ts`, and the `publishTrackPost` helper. Operator gets the URL.
3. **Cut 3 — Auto-close on timeout.** Add the DO `alarm()` path and the timeout flow.

Cuts 1 and 2 land sequentially; cut 3 can land before or after cut 2.

## 11. Open questions for review

- **Should this spec become its own epic, or be folded into Phase 3 (#99) as added scope?** Recommendation: new epic ("Phase 3.5 — Tracking session artifacts" or similar), filed as soft-blocked-by #99 so it doesn't muddy the storage-migration milestone. But Phase 3's plan needs to know about it so the DO interface is designed with this in mind.
- **Auto-close timeout default.** 30 min feels right for hiking; might be too short for a multi-hour bike ride at variable cadence. Could make it variable based on the most recent `intervalChange` (e.g., `idle_timeout = max(30 min, 3 × current_interval)`).
- **Persona styling — do we need it for v1?** Spec currently says no (single tone). If you want Yuki-mode in v1, scope grows ~20% (prompt variants, env knob, test matrix).
- **Map render in v1?** Spec says no — Google-Maps-link-of-waypoints only. A static map image (Mapbox/Stadia/Maptiler) would be richer but adds a provider, an env, a cost line, and potentially a `publishPostWithImage` parallel. Defer unless it's a hard product requirement.
- **What does "real device verification" look like?** Need at least one end-to-end test with the Mini 3 Plus going for an actual walk before this can be marked shipped. The operator's 2026-05-01 test session is the fixture-source; a separate real-device burn-in is the close-gate.

## 12. Decision log (to be filled as we converge)

- 2026-05-01 — Audience locked: future-self artifacts (B). Watcher channels (C) deferred to a follow-up epic that may target Substack/Posthaven/RSS.
- 2026-05-01 — Storage approach: build on Phase 3 DO + D1 (recommendation B above). To be confirmed.
- 2026-05-01 — One-post-per-session vs. multi-waypoint: one post for v1.
