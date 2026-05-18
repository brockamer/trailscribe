# Tracking Session Artifacts — Design Spec

**Status:** Draft, pending review. **Mode B (MapShare pull-on-close) confirmed canonical 2026-05-03.**
**Author:** Claude (Opus 4.7) with Brock Amer
**Date:** 2026-05-01 (rewritten 2026-05-03 around MapShare data source — see §0, §13.7; amended 2026-05-17 — see §0.1)
**Related:** PRD §9 Roadmap, Epic #99 (Phase 3 — DO + D1, **dependency dropped**), Epic #187 (Tracking Sessions — Mode B hardening)

## Issue

- #187 — Epic: Tracking Sessions — Mode B hardening
- #168 — Implementation (closed 2026-05-04)
- #194 — 2026-05-17 empirical update (see §0.1): mc=0 events DO flow on Satellite transport

---

## 0. Critical empirical finding — 2026-05-03

> **The data we assumed flows over IPC Outbound is not flowing.** This finding is load-bearing for everything below and was discovered via real-device testing on 2026-05-02 and 2026-05-03. Read this section before reading the rest of the spec.

**What we expected (per the original design):** Garmin IPC Outbound delivers `messageCode: 0` (Position Report) events to our Worker every N minutes during a tracking session, alongside `Start Track` (10), `Track Interval` (11), and `Stop Track` (12) lifecycle events.

**What we observed:** Across two real tracking sessions and 5+ days of normal device traffic captured at the Worker (full payload, no sampling, verified via Cloudflare ray IDs):

| Code | Name | Count |
|---|---|---|
| 0 | Position Report | **0** events |
| 10 | Start Track | 1 |
| 11 | Track Interval | 1 (`intervalChange: 14400` — 4-hour power-saving auto-fallback) |
| 12 | Stop Track | 2 (one per session) |
| 3 | Free Text | works correctly |
| 20 | Mail Check | normal |
| 21 | Am I Alive | normal |

The **2026-05-02 PCH/Malibu session** (~50 min, real movement: 0.25mi run + beach walking + return — well past the 100m power-saving threshold) produced 0 Position Reports. Yesterday's session is the load-bearing data point because it had unambiguous movement.

**Diagnostics ruling out our-side bugs:**
- Auth passes (10/11/12 events arrive over the same channel with the same token)
- Outbound queue size = 0 with `Last Send Attempt` timestamps matching every POST we receive
- V4 envelope shape is identical to V2 (`topLevelKeys: ["Version", "Events"]`) — no sibling array carries position data
- Diagnostic `LOG_TRACK_PAYLOADS=true` flag confirmed live on production; would have captured payloads if any arrived

**Most likely explanations** (Pro Support email sent 2026-05-03 to disambiguate):

1. **`transportMode: "Internet"` (phone-paired) routing bypasses IPC entirely.** The phone-paired path may go phone → cellular → MapShare directly, skipping Iridium GSS and therefore IPC Outbound. Control-plane events (10/11/12) still flow because they're status messages, not position pings.
2. **Per-tenant configuration gate** that's not exposed in the Portal Connect UI; would require Garmin to flip a flag on our account.
3. **Position Reports are simply not part of IPC Outbound for Mini 3 Plus + V4 + Internet transport** under any configuration; tracking data lives only in MapShare KML feeds.

External research (2026-05-03 via Perplexity) confirmed: production integrations (CalTopo, GSatTrack, NCAR's `inreach-nodeorm`, j-arens' `garmin-ipc`) DO receive tracking positions via IPC Outbound somehow — but none publicly document the exact mechanism, and the official IPC_Outbound.pdf v2.0.8 documents *no* tenant-level toggle for `messageCode: 0` enablement. The MapShare KML/JSON feed at `share.garmin.com/<key>` is a documented alternative tracking-data surface used by many integrations.

**Resolution (2026-05-03):** validated MapShare KML returns the full breadcrumb stream — see §13.7 for the verified 14-Placemark dump from the 2026-05-02 PCH session. **The spec now uses MapShare as the canonical tracking-data source** (Mode B). The Stop Track event from IPC remains the trigger; the breadcrumb data comes from the KML feed. See §5 / §6 for the (much simpler) implementation.

---

## 0.1 Amendment — 2026-05-17 empirical update (mc=0 IS flowing)

> **§0 has been partially refuted by new evidence.** On 2026-05-17, during the #175 close-gate (611 km Pinal County → Redlands drive over ~8h37m, 205 MapShare breadcrumbs), `wrangler tail` captured a single `messageCode: 0` (Position Report) event with `transportMode: "Satellite"`, arriving ~20 s before the `mc=12` Stop Track. §0 is retained as historical record — it explains *why* Mode B was chosen — but its specific empirical claims are corrected below. Investigation: #194.

**Captured event** (2026-05-17T23:23:28Z UTC):

```json
{
  "event": "ipc_received",
  "version": "4.0",
  "rawBody": {
    "Events": [{
      "transportMode": "Satellite",
      "imei": "300052030374220",
      "messageCode": 0,
      "timeStamp": 1779060150000,
      "point": {"latitude": 34.0456223487854, "longitude": -117.15710878372192, "altitude": 489.23477, "gpsFix": 2, "course": 337.5, "speed": 107.994},
      "status": {"autonomous": 0, "lowBattery": 0, "intervalChange": 0, "resetDetected": 0}
    }]
  }
}
```

**§0 claims refuted by this event:**

- **§0 hypothesis #1** (`transportMode: "Internet"` phone-paired routing bypasses IPC entirely) — **refuted.** The 2026-05-17 mc=0 arrived on `transportMode: "Satellite"`, proving Iridium-routed Position Reports CAN reach the Worker.
- **§0 hypothesis #3** (Position Reports simply aren't part of IPC Outbound for Mini 3 Plus + V4 under any configuration) — **refuted.** mc=0 IS part of IPC Outbound for this device + tenant.
- **§4.3 first bullet** ("IPC Outbound mc 0 is empirically absent for our tenant") — **superseded.** Was true as of 2026-05-03; refuted 2026-05-17. Bullet softened in place to acknowledge the amendment.
- **§5.1 Mode A bullet** ("Mode A — empirically not viable: mc 0 events don't reach our Worker") — **superseded.** Mode A is empirically *possible* on Satellite transport; remains *deferred* on independent grounds (below).

**What §0 still gets right:** the 2026-05-02 PCH session (§0 table, §13.1) produced 0 Position Reports — that snapshot is historically accurate and unedited. Whether mc=0 was always flowing and the May-3 capture windows just missed active sessions, or whether something changed between 2026-05-03 and 2026-05-17 (tenant flip, firmware update, account tier change), cannot be disambiguated from one event. Mode B is architecturally unaffected either way.

**Worker behavior is unchanged.** `src/app.ts:217` continues to silent-drop mc=0 via the `non_free_text` log path — the correct behavior for Mode B. mc=0 carries no session-aggregate metadata that MapShare KML doesn't already provide better (no per-point GPS-fix flag, no units, no LineString, no operator/device metadata — see §4.2 and §13.7). Persisting mc=0 events live would require either (a) full Mode A re-architecture, or (b) a parallel breadcrumb buffer that duplicates MapShare; neither is justified by one data point.

**Mode A viability — deferred.** mc=0 is empirically *possible* on Satellite transport (the §0 blocker is gone), but Mode B remains canonical for three independent reasons that hold regardless of mc=0 enablement:

1. **Architectural simplicity.** Pull-on-close (one HTTP fetch at session end) avoids the per-IMEI live-state problem that Mode A's `parsePings()`-equivalent ingestion implies.
2. **Schema richness.** MapShare KML's named fields, explicit units, `Valid GPS Fix` flag, and pre-computed LineString are not derivable from IPC mc=0 alone (§4.3, §13.7).
3. **Reliability is unestablished.** One observed mc=0 is not a basis for re-architecture. §0's historical capture suggests mc=0 was effectively absent for at least 5 days in early May 2026; a single mid-May event doesn't establish "reliable stream."

**Reopen criteria for Mode A:**

- (a) Operator needs lower-latency post-session feedback than Mode B's wait-for-Stop-Track-then-KML-pull cycle provides.
- (b) Multiple tracking sessions confirm mc=0 reliability across transport modes (~95th-percentile coverage of expected pings).

If either is met, Mode A swaps in behind the existing `parsePings()`-equivalent abstraction (§5.1 line 133, §13.7) with no downstream changes.

**Garmin Pro Support** (§13.5): no reply as of 2026-05-18 (15 days after the email). Closing #170 as answered-by-empirical-evidence rather than awaiting confirmation. The 2026-05-17 observation answers #170's "is mc=0 currently configured?" question more authoritatively than Garmin's own confirmation would have.

---

## 1. Goal

Turn a Garmin inReach tracking session into a polished, AI-narrated journal artifact published on session end — without any operator-side ceremony beyond turning tracking on and off.

Today the Worker silent-drops every tracking event (`src/app.ts:118` rejects everything that isn't `messageCode === 3`). This spec routes `messageCode === 12` (Stop Track) to a new pipeline that fetches the session's breadcrumbs from MapShare KML, derives metrics, runs an LLM narrative, and commits a journal post.

**Audience for v1:** the operator, post-trip. ("Future-self artifacts" — chosen 2026-05-01.)
**Out of audience for v1:** watchers / family / followers. Watcher digests via Substack/Posthaven/RSS-style fan-out are a separate, follow-on epic.

## 2. In Scope (v1)

- Route `messageCode === 12` (Stop Track) to a new pipeline; log `messageCode` 10/11 for diagnostics but don't act on them.
- On Stop Track, fetch the session's breadcrumb stream from MapShare KML, derive metrics, run an LLM narrative.
- Commit the post to the existing journal repo via the existing `publishPost` path, with an extended frontmatter shape that captures the trajectory.
- Persist a closed-session record (raw KML + derived metrics) to KV for future re-derivation.
- Reply to the operator with a single confirmation SMS containing the journal URL.

## 3. Out of Scope (v1) — with rationale

- **Mid-session journal entries / "live narration."** Belongs to the watcher-channel epic; would also force decisions about how to update vs. append journal posts during a single trip.
- **Watcher digests / subscriber model.** Filed as Option C from the brainstorm. Would tie to Substack, Posthaven, or an RSS endpoint. Separate spec.
- **Proactive on-device nudges** ("battery low, sunset in 2h, want me to flag turn-around?"). Borders on safety-system territory which PRD §1 explicitly rules out.
- **Anomaly alerts** ("no movement for 90 min"). Same safety-adjacent concern, plus needs a watcher channel to be useful.
- **Persona-tagged output styles** (Yuki's Storyteller voice vs. Marcus's Logistics voice vs. Natalie's Field-Notes voice). Interesting v2 lever — single tone for v1.
- **Session-aware `!brief`** ("what have I done today" computed from the active track). Strictly Operator-Facing audience (Option A from brainstorm) — defer to a follow-up that can reuse the storage built here.
- **Map renders / GPX export / route GeoJSON.** v1 uses lat/lon arrays in frontmatter and a Google-Maps-link of waypoints; rendered map images come later.

## 4. Source-of-truth: what data we actually have

Per §0's empirical finding, this spec is built around **two complementary data sources** — IPC Outbound (control plane) and MapShare KML (data plane).

### 4.1 IPC Outbound — control plane (already wired)

These messageCodes are confirmed to flow over our existing webhook (`/garmin/ipc`) reliably:

| Code | Name | Role in this spec |
|---|---|---|
| `10` | Start Track | Could trigger session-open work, but we don't *need* it (see §6) |
| `11` | Track Interval | Power-saving / interval-change status; informational |
| `12` | **Stop Track** | **Trigger for the entire pipeline** — session ended, fetch KML now |

Per-event envelope shape (V4): `{Version: "4.0", Events: [<event>]}` where each event has `imei`, `messageCode`, `timeStamp`, `point.{latitude, longitude, altitude, gpsFix, course, speed}`, `status.{lowBattery, intervalChange}`, and (V3+) `transportMode: "Internet" | "Satellite"`.

### 4.2 MapShare KML — data plane (the breadcrumb stream)

`https://share.garmin.com/Feed/Share/<MAPSHARE_KEY>?d1=<startISO>&d2=<endISO>` returns a KML document with:

- **N `<Placemark>` elements**, one per breadcrumb position. Each has:
  - `<TimeStamp><when>` — ISO 8601 UTC
  - `<ExtendedData>` with named `<Data name="X"><value>Y</value></Data>` fields:
    - `Latitude`, `Longitude` — decimal degrees
    - `Elevation` — `"30.76 m from MSL"` (numeric value + unit suffix)
    - `Velocity` — `"12.2 km/h"` (numeric value + unit suffix)
    - `Course` — `"247.50 ° True"` (numeric value + unit suffix)
    - `Valid GPS Fix` — `"True" | "False"`
    - `IMEI`, `Map Display Name`, `Device Type`, `Name` (operator), `Time UTC`, `Time` (local)
- **One trailing `<Placemark>` with `<LineString><coordinates>`** containing all points as `lon,lat,alt\n` triples — pre-computed route geometry, no derivation needed.
- Auth: **none for public MapShare; password-protected MapShare adds basic auth or query string**. Our v1 setting is operator's choice (recommended: password-protected so the feed isn't public).

**Verified 2026-05-03** with `curl https://share.garmin.com/Feed/Share/trailscribe?d1=...&d2=...` for the 2026-05-02 PCH session: 14 individual Placemarks + 1 LineString summary, ~37KB total. See §13.

### 4.3 Why MapShare is the canonical data source

- **It actually contains the data.** As of 2026-05-03 IPC Outbound mc 0 was empirically absent for our tenant. A single mc=0 + Satellite event was later observed on 2026-05-17 (§0.1), but reliability is unestablished; Mode B remains canonical on architectural and schema grounds regardless.
- **The schema is richer than IPC mc 0 would have been.** MapShare provides explicit `Valid GPS Fix` per point, units on every numeric field, a pre-computed LineString, and operator/device metadata baked in.
- **Pull-on-close is architecturally simpler** than live ingestion. Single HTTP fetch at session end instead of per-IMEI Durable Object holding live session state.
- **Decouples this spec from Phase 3** (DO + D1 storage migration). Mode B doesn't need a per-IMEI DO; the existing KV stores are sufficient.

## 5. Architectural choices

### 5.1 Mode B (MapShare pull-on-close) is canonical

The original spec considered three modes:

- **Mode A — IPC ping stream (live ingestion).** As of 2026-05-03 empirically not viable: mc 0 events did not reach our Worker (§0). One mc=0 + Satellite event observed 2026-05-17 (§0.1); reliability unestablished, and the Mode B-vs-Mode-A trade-off is unchanged. Deferred — see §0.1 for reopen criteria.
- **Mode B — MapShare pull-on-close.** Verified working 2026-05-03 (§13.7). **Selected.**
- **Mode C — Bookend-only (start/end/duration only).** Degraded fallback. No longer needed.

Mode B beats Mode A even on architectural grounds: a single HTTP fetch at session close is simpler than a per-IMEI Durable Object holding live state, kills the missing-Stop-Track timeout problem (we just pull whatever's in MapShare), and decouples this spec from Phase 3 (#99). The KML schema is also richer than IPC mc 0 would have been (named fields, units, GPS-fix flags, pre-computed LineString).

If Garmin Pro Support later confirms mc 0 enablement, the live-IPC data source can replace MapShare behind the same `parsePings()`-equivalent abstraction with no downstream changes.

### 5.2 Trigger model — Stop Track triggers, MapShare delivers

```
Garmin device                      Worker                    External
┌─────────────┐                ┌─────────────┐         ┌──────────────┐
│ Track on    │                │             │         │              │
│ ┌──────────►│  mc 10 Start   │ logs only   │         │              │
│ │           │ ──────────────►│             │         │              │
│ │ (during   │                │             │         │              │
│ │  session, │  mc 11 Interval│ logs only   │         │              │
│ │  Garmin   │ ──────────────►│             │         │              │
│ │  posts no │                │             │         │              │
│ │  mc 0 to  │                │             │         │              │
│ │  us; data │                │             │         │              │
│ │  goes to  │                │             │         │ MapShare     │
│ │  MapShare)│ ───────────────────────────────────────►│ accumulates  │
│ │           │                │             │         │ breadcrumbs  │
│ │           │                │             │         │              │
│ Track off   │  mc 12 Stop    │ ◄── trigger │         │              │
│             │ ──────────────►│             │         │              │
│             │                │ ┌─────────────────────►│  GET KML    │
│             │                │ │           │         │              │
│             │                │ │ ◄────────────────────│  N pings +  │
│             │                │ │           │         │  LineString  │
│             │                │ ▼           │         │              │
│             │                │ parse       │         │              │
│             │                │ → metrics   │         │              │
│             │                │ → narrative │         │              │
│             │                │ → publish   │         │ GitHub Pages │
│             │                │ ──────────────────────►│ (commit md)  │
│             │                │             │         │              │
│             │  IPC Inbound   │ ◄── reply   │         │              │
│             │ ◄──────────────│ "Track      │         │              │
│             │                │  posted:    │         │              │
│             │                │  ...URL"    │         │              │
└─────────────┘                └─────────────┘         └──────────────┘
```

The whole pipeline is reactive: nothing happens until mc 12 arrives. There's no DO holding session state, no alarm timer, no live ingestion path. The Worker doesn't even need to know tracking is in progress.

### 5.3 Storage — KV only

A single new KV namespace `TS_TRACKS` storing closed-session records, keyed by `track:<imei>:<sessionId>` where `sessionId = sha256(imei + ":" + closedAtMs)`. TTL: 1 year (long enough for v2 re-derivation, short enough to bound storage). Existing KV is sufficient — no need to wait for Phase 3 D1.

Stored shape (`TrackSessionRecord`):

```ts
interface TrackSessionRecord {
  sessionId: string;
  imei: string;
  startedAt: number;        // ms epoch (from KML first-Placemark timestamp)
  closedAt: number;         // ms epoch (from mc 12 timeStamp)
  closeReason: "stop";      // future: "timeout" if we add safety nets
  pingCount: number;
  distanceKm: number;
  elevationGainM: number;
  durationSeconds: number;
  journalUrl: string | null;  // populated post-publish
  rawKml: string;            // verbatim KML response, for v2 re-derivation
}
```

`rawKml` is kept verbatim (~5-50 KB per session) so a future v2 with better metrics, persona styles, or map renders can re-derive without re-fetching from Garmin.

### 5.4 Edge cases handled by the design (vs. needing explicit code)

The trigger-and-pull architecture eliminates most of the original Mode A complexity:

| Edge case | How Mode B handles it |
|---|---|
| Missing Start Track | Irrelevant — we don't act on Start. KML feed reveals the actual session window. |
| Missing Stop Track | Session is never published. Operator can manually trigger replay (future feature) or notice "no track posted" and investigate. Acceptable v1 behavior. |
| Duplicate Stop Track | Idempotent at the existing `withCheckpoint` layer — second mc 12 finds an already-published session and short-circuits. |
| Position Report after Stop | We don't ingest Position Reports — non-issue. |
| Track Interval changes | Visible in `intervalChange` field of mc 11 events (logged for diagnostics) but not load-bearing for the narrative. |
| Worker crash mid-publish | KV record survives; replay finds an unpublished session and retries. |

### 5.5 One post per session

Same as the original spec: one published markdown per closed session. Multi-waypoint narratives are deferred.

## 6. Detailed design

### 6.1 Webhook ingestion change

`src/app.ts` currently silent-drops everything that isn't `messageCode === 3`. Change: route `messageCode === 12` (Stop Track) to a new handler. Other tracking codes (10, 11) get logged but not acted on.

```ts
if (event.messageCode === 3) {
  // existing free-text path unchanged
} else if (event.messageCode === 12) {
  // Trigger the tracking-session-publish pipeline.
  await handleStopTrack(event, env, key);
} else if (event.messageCode === 4) {
  log({ event: "sos_received_ignored", ... });   // unchanged
} else {
  // Includes mc 10, 11, 20, 21, etc. — log only, no action.
  log({ event: "non_free_text", ... });          // existing behavior preserved
}
```

`handleStopTrack` lives in a new module `src/core/tracking.ts`:

```ts
export async function handleStopTrack(
  event: GarminEvent,
  env: Env,
  idemKey: string,
): Promise<void> {
  await withCheckpoint(env, idemKey, "publish_track", async () => {
    // 1. Define session window (look back N hours from Stop)
    const closedAt = event.timeStamp;
    const startedAt = closedAt - TRACK_LOOKBACK_HOURS * 3_600_000;

    // 2. Fetch + parse KML
    const kml = await fetchMapShareKml(env, startedAt, closedAt);
    const pings = parsePings(kml);
    if (pings.length === 0) {
      log({ event: "track_no_pings", level: "warn", imei: event.imei, idemKey });
      return { skipped: "no_pings" };
    }

    // 3. Derive metrics
    const metrics = computeMetrics(pings);

    // 4. Reverse-geocode + weather (existing adapters)
    const startPlace = await reverseGeocode(pings[0], env);
    const endPlace = await reverseGeocode(pings.at(-1)!, env);
    const weather = await fetchWeather(midpointInTime(pings), env);

    // 5. LLM narrative (extension of core/narrative.ts)
    const narrative = await generateTrackNarrative({ pings, metrics, startPlace, endPlace, weather, env });

    // 6. Publish to journal repo (existing publishPost)
    const result = await publishTrackPost({ narrative, metrics, pings, env });

    // 7. Persist record + reply
    await storeTrackRecord(env, { ..., journalUrl: result.url });
    await sendReply(event.imei, [`Track posted: ${formatStats(metrics)}\n${result.url}`], env);

    return { sessionId, journalUrl: result.url };
  });
}
```

### 6.2 KML adapter — `src/adapters/location/mapshare.ts`

Single new adapter. Two functions:

```ts
export async function fetchMapShareKml(
  env: Env,
  startedAt: number,
  closedAt: number,
): Promise<string> {
  const url = `${env.MAPSHARE_BASE}/Feed/Share/${env.MAPSHARE_KEY}` +
    `?d1=${new Date(startedAt).toISOString()}&d2=${new Date(closedAt).toISOString()}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.google-earth.kml+xml" } });
  if (!res.ok) throw new MapShareError(`KML fetch ${res.status}`);
  return res.text();
}

export interface KmlPing {
  t: number;            // ms epoch from <when>
  lat: number; lon: number; alt: number;
  velocityKmh: number;
  courseDeg: number;
  validFix: boolean;
}

export function parsePings(kml: string): KmlPing[] { ... }
```

**Parsing approach:** regex-based extraction of `<Placemark>` blocks, then per-Placemark regexes for `<when>` and each `<Data name="X"><value>Y</value></Data>` field. Skip the trailing LineString Placemark (no `<TimeStamp>`). Strip unit suffixes (`" m from MSL"`, `" km/h"`, `" ° True"`) before number parsing. **Do not pull in a full XML parser** — Workers' bundle size matters and the schema is tightly constrained. ~80 lines of TypeScript total.

### 6.3 Derived metrics — `src/core/track-metrics.ts`

Pure functions over `KmlPing[]`. Same shape as the original Mode A spec, mostly unchanged:

- `totalDistanceKm(pings)` — Haversine sum (or use the LineString-derived path length if we prefer; equivalent at this resolution).
- `elevationProfile(pings)` — `{ gainM, lossM, maxM, minM }` with 5-point median smoothing.
- `paceStats(pings)` — `{ avgKmh, p50Kmh, p95Kmh }` from `velocityKmh` (already populated by Garmin).
- `stopsAndBreaks(pings)` — clusters of ≥3 consecutive low-velocity pings within 50m. Useful as natural narrative paragraph breaks.
- `routeShape(pings)` — `"out-and-back" | "loop" | "point-to-point"` from start/end/midpoint geometry.
- `activityHint(pings)` — speed-distribution classifier: `"walk" | "hike" | "run" | "bike" | "drive" | "mixed"`. Input to the LLM, not surfaced as fact.

All testable against the 2026-05-02 PCH session fixture (will be committed at `tests/fixtures/mapshare/pch-2026-05-02.kml`).

### 6.4 Narrative pipeline — `core/narrative.ts` extension

Add `generateTrackNarrative(input)` alongside `generateNarrative`. Input: pings + metrics + place names + weather. Output: same `{title, haiku, body, usage}` shape, `body` cap raised from 500 → 1200 chars (the SMS reply budget doesn't apply to track posts — operator only sees the URL).

Third system-prompt variant (alongside `SYSTEM_PROMPT_WITH_NOTE` and `SYSTEM_PROMPT_NO_NOTE`):

```
You write field-journal entries from a backcountry tracking session. Constraints:
- "title": ≤60 chars, evocative, anchored to place + activity
- "haiku": 5/7/5 syllables, ≤110 chars, observational
- "body": ≤1200 chars. Describe the route, place, conditions, and pace.
  Use stops/breaks as natural paragraph breaks. Do not invent companions,
  destinations, or motivations not present in metrics or place names.
```

Place-name strategy: reverse-geocode start + end + route midpoint via existing `adapters/location/geocode.ts`. Three lookups, all cached. Don't geocode every ping.

Weather strategy: one call to existing `adapters/location/weather.ts` for the time-midpoint of the session. Don't reconstruct hour-by-hour weather.

### 6.5 Journal post format

Same shape as the original spec:

```yaml
---
title: "..."
date: 2026-05-02T16:24:30Z         # closedAt
type: track
track:
  started_at: 2026-05-02T15:51:30Z
  duration_seconds: 1980
  distance_km: 1.2
  elevation_gain_m: 60
  activity_hint: run
  route_shape: out-and-back
  start_place: "PCH near Pepperdine, Malibu"
  end_place: "PCH near Pepperdine, Malibu"
  pings: 14
  close_reason: stop
location: { lat: 34.0265, lon: -118.7603, place: "<endPlace>" }
weather: "..."
tags: [trailscribe, track]
---

<haiku>

<body>

[View route on map](<MAPSHARE_BASE>?d1=...&d2=...)
```

The map link points back to the user's MapShare page with the session's time window pre-filtered. Rendering the actual map (static image via Mapbox/Stadia) is deferred to v2.

### 6.6 Reply to the device

On successful publish, single SMS:

```
Track posted: 1.2km, 60m gain, 33min
brockamer.github.io/trailscribe-journal/2026/05/02/pch-pepperdine.html
```

Format helpers: `{distance}km, {gain}m gain, {duration_in_minutes_or_hours}` then a newline, then the URL. Total stays ≤320 chars in realistic ranges.

If publish fails after retries: log and send `Track save failed; rawKml retained` — operator can investigate; KV record survives for manual replay.

### 6.7 Idempotency

- **Stop Track retried after publish.** `withCheckpoint(env, idemKey, "publish_track", ...)` short-circuits — second invocation finds the cached result and returns without re-fetching/re-publishing.
- **MapShare fetch fails transiently.** Bubble the error so the wrapping `withCheckpoint` doesn't store success, allowing Garmin's webhook retry (or a manual replay) to try again.
- **KML returns an empty session.** Log `track_no_pings` warning, send a single SMS notice (`Track ended; no breadcrumbs in MapShare for this window`), don't crash, don't publish. May indicate the device wasn't actually tracking, or MapShare isn't enabled for the device.
- **Identical Stop Track delivered twice.** Composite idempotency key in the existing `idempotency.ts` deduplicates at the webhook entry, before `handleStopTrack` is ever called.
- **Operator runs `!post` during an active tracking session.** Today's `!post` is unchanged. v1 does not cross-link the two; v2 might emit "your `!post` was made during track session XYZ".
- **No GPS fix on every ping.** If the entire session has `gpsFix === 0`, derived metrics fall back to `null` and the narrative reads as a duration-only summary. Don't crash; don't invent a position.

## 7. Env additions

Two new vars, no new secrets, no new D1 binding:

- `MAPSHARE_KEY` — the operator's MapShare identifier (`trailscribe`, set via Garmin Explore). Combined with the existing `MAPSHARE_BASE` to form the feed URL. Add to `wrangler.toml` per env.
- `TRACK_LOOKBACK_HOURS` — default `12`. How far back from the Stop Track timestamp to query MapShare. 12h handles all-day hikes; bumpable for multi-day if needed.
- `TRACK_NARRATIVE_BODY_MAX` — default `1200`. Cap for the track-narrative body schema.

A new KV namespace `TS_TRACKS` for closed-session records — provisioned via `wrangler kv namespace create TS_TRACKS [--env <env>]`. Same setup pattern as the four existing KV namespaces.

## 8. Cost budget

Per published track session:

- **One LLM call** at session close: ~1500 prompt tokens (metrics + place names + weather) + ~600 completion tokens (title/haiku/body) at Claude Sonnet 4.6 pricing → **~$0.012**.
- **MapShare KML fetch:** free. Garmin doesn't rate-limit the share feed.
- **Reverse-geocode:** 3 calls per session, all cached via `TS_CACHE`. Effectively free amortized.
- **Weather:** 1 call per session, cached. Effectively free amortized.
- **GitHub Contents API:** free.

**Per session: ~$0.012**, well under the $0.05 PRD §6 ceiling.

Storage:
- KV: ~5-50 KB raw KML per session under `TS_TRACKS`. A year of daily sessions ≈ 18 MB. Comfortable.

## 9. Test strategy

- **KML fixture** at `tests/fixtures/mapshare/pch-2026-05-02.kml` — the verified 2026-05-02 PCH session, 14 Placemarks + 1 LineString. Real ground-truth, not synthesized.
- **Unit tests** for `parsePings()` — assert 14 pings extracted with correct timestamps, lat/lon, velocity, course, elevation, validFix flag. Negative case: empty KML, malformed KML, KML with no `<Placemark>` elements.
- **Unit tests** for every function in `track-metrics.ts` — Haversine on the PCH fixture should yield ~1.2 km total distance, route shape "out-and-back", activityHint "mixed" (run + walk velocities), stopsAndBreaks should detect the ~5-min gap as a break.
- **Integration test** for `handleStopTrack()` end-to-end with mocked `fetch` (KML fixture) + mocked OpenRouter (canned narrative) + mocked GitHub Contents API. Asserts: one publishPost call, one sendReply call, one TS_TRACKS write, idempotent on replay.
- **Empty-session test:** mock fetch returns KML with zero Placemarks → assert `track_no_pings` log + degraded reply, no publish, no crash.
- **Idempotency test:** replay the same Stop Track event twice through the webhook → assert one publish (existing `withCheckpoint` covers this).

## 10. Implementation phasing

The Mode B design is small enough to ship as a single PR. If split:

1. **Cut 1 — KML adapter + parser.** `src/adapters/location/mapshare.ts` with `fetchMapShareKml` + `parsePings`. Unit tests against the fixture. No webhook changes yet. Pure plumbing — provable in isolation.
2. **Cut 2 — Metrics module.** `src/core/track-metrics.ts`. Unit tests against the parsed PCH session. Validates the derivations the narrative will use.
3. **Cut 3 — End-to-end pipeline.** `src/core/tracking.ts handleStopTrack` + `narrative.ts generateTrackNarrative` + journal frontmatter extension + webhook routing change in `src/app.ts`. Integration tests + first real-device close-gate.

Cuts 1 and 2 are independent (can parallelize). Cut 3 depends on both.

## 11. Open questions for review

- **Garmin Pro Support response (informational).** Email sent 2026-05-03 (see §13.5). With Mode B confirmed this was never a blocker; a positive reply was anticipated to enable a future Mode A swap. The empirical question was answered directly by #194 on 2026-05-17 (§0.1): mc=0 events DO reach the Worker, at least on Satellite transport. #170 closed 2026-05-18 as answered-by-evidence; Mode A swap evaluation deferred — see §0.1 reopen criteria.
- **Should this spec become its own epic, or fold into Phase 3 (#99)?** With Mode B canonical, Phase 3 dependency is gone. **Recommendation: file as its own epic** ("Phase 3.5 — Tracking session artifacts" or similar), independent of Phase 3 timing.
- **Map render in v1?** Spec says no — frontmatter has a MapShare deep-link, that's enough. Static map image rendering (Mapbox/Stadia/Maptiler) is a clean v2 add.
- **MapShare privacy.** Operator should password-protect their MapShare to keep position history private. Worker fetches with the password baked into `MAPSHARE_KEY` env (or as a separate `MAPSHARE_PASSWORD` secret if Garmin requires basic auth on protected feeds). Verify the auth shape during Cut 1.
- **`!brief` becomes session-aware?** The original Mode A "session-aware brief" idea is now trivial in Mode B — `!brief` could fetch the same KML with `d1=now-Xh` and produce a recent-activity summary. Out of scope for this spec but a clean follow-up.
- **Persona styling — v1 or v2?** Single tone for v1. Persona-tagged variants are a v2 lever (~20% scope growth).
- **Real-device close-gate.** Need at least one end-to-end test session producing a real published journal post before this can be marked shipped. The operator's 2026-05-02 PCH session is the fixture seed; the close-gate is a *fresh* tracking session with the implementation deployed.

## 12. Decision log (to be filled as we converge)

- 2026-05-01 — Audience locked: future-self artifacts (B). Watcher channels (C) deferred to a follow-up epic that may target Substack/Posthaven/RSS.
- 2026-05-01 — Storage approach: build on Phase 3 DO + D1 (recommendation B above). To be confirmed.
- 2026-05-01 — One-post-per-session vs. multi-waypoint: one post for v1.
- 2026-05-03 — **Empirical reality discovered (§0):** Position Reports (mc 0) do not flow over IPC Outbound for our tenant. Spec now branches across Modes A / B / C in §5.0. Garmin Pro Support email sent. PR #163 (`LOG_TRACK_PAYLOADS`) and PR #166 (`ipc_received` envelope diagnostic) shipped during this investigation.
- 2026-05-03 — **Mode B confirmed canonical (§13.7):** MapShare KML at `share.garmin.com/trailscribe` returns the full 14-Placemark breadcrumb stream for the 2026-05-02 PCH session, with richer schema than IPC mc 0 would have provided. Spec rewritten — §5/§6 now describe MapShare pull-on-close as the only design. Mode A retained as a future swap target (the abstraction allows it). Mode C dropped (no longer needed). PR #167 set `MAPSHARE_BASE = "https://share.garmin.com/trailscribe"` across envs.
- 2026-05-03 — **Phase 3 dependency dropped:** Mode B's pull-on-close architecture eliminates the need for a per-IMEI Durable Object. This spec is now independent of Phase 3 (#99) — both can ship in any order.
- 2026-05-17 — **mc=0 IS flowing on Satellite transport (§0.1):** During the #175 close-gate (611 km Pinal County → Redlands drive), `wrangler tail` captured a single `messageCode: 0` event with `transportMode: "Satellite"` ~20 s before the `mc=12` Stop Track. Refutes §0 hypothesis #1 ("Internet transport bypasses IPC") and hypothesis #3 ("Position Reports simply aren't part of IPC Outbound for Mini 3 Plus + V4"). Mode B is architecturally unaffected (`src/app.ts:217` silent-drops mc=0 — correct behavior; KML pull at session close provides richer schema per §4.2 / §13.7). Mode A swap evaluation deferred (single observation, reliability unestablished); reopen criteria recorded in §0.1. #170 (Garmin Pro Support reply pin) closed 2026-05-18 as answered-by-evidence.

---

## 13. Empirical evidence appendix (2026-05-03)

Raw data behind §0. Kept for traceability when Garmin replies and we collapse to a single mode.

### 13.1 What we observed across the 2026-05-02 PCH session

Operator: Daniel Brock. Device: inReach Mini 3 Plus, IMEI `300052030374220`. Session ended 2026-05-02T16:26:42Z.

- 1 × `messageCode: 12` (Stop Track) at the session-end timestamp
- 0 × `messageCode: 0` (Position Report) for the entire session
- 0 × `messageCode: 10` (Start Track) — note this — yesterday's session lacks a Start Track event, only a Stop. May be a separate quirk to investigate.

Real movement during this session: ~0.25 mile run + beach walking + return to start. Well past the 100m power-saving threshold.

### 13.2 What we observed across the 2026-05-03 indoor session

Same device. Session 16:29:58Z (Start Track) → 17:20:39Z (Stop Track), ~50 minutes, mostly indoors and stationary.

- 1 × `messageCode: 10` Start Track at 16:29:58Z, `intervalChange: 120` (2-min interval as user-set)
- 1 × `messageCode: 11` Track Interval at 16:31:59Z (~2 min after Start), `intervalChange: 14400` (= 4-hour power-saving auto-fallback)
- 1 × `messageCode: 12` Stop Track at 17:20:39Z
- 0 × `messageCode: 0` Position Report

The 14400s interval bump is *correct device behavior* per Garmin docs (CalTopo-quoted): *"The inReach device has a power-saving function that will change the Send Interval to 4 hours if the device has not traveled more than 100 meters."* So this session's 0 Position Reports is consistent with stationary behavior. **The 2026-05-02 session is the cleaner test** for the IPC-Position-Report question because real movement happened.

### 13.3 V4 envelope shape

All POSTs in this period (5 captured) had identical top-level shape: `{Version: "4.0", Events: [<single event>]}`. No `Tracks[]`, `Positions[]`, or other sibling arrays. The advisor-suggested "V4 moved tracking to a separate top-level field" hypothesis is empirically refuted. V4's only addition over V2 (visible in our data) is a per-event `transportMode` field with values `"Internet"` (phone-paired, observed) or `"Satellite"` (Iridium, presumed but not observed in this period).

### 13.4 Production integrations that *do* receive tracking via IPC

Per 2026-05-03 research:

- **CalTopo** — explicitly says it uses IPC Outbound for Pro accounts to receive tracking locations
- **GSatTrack** — Pro account + IPC Outbound + "Share Map View" toggle for tracking visibility
- **SafetyLine** — Pro + Outbound URL only, no extra toggles documented
- **NCAR `inreach-nodeorm`** (GitHub) — production app reading IPC Outbound events, displays "latest locations"
- **j-arens `garmin-ipc`** (GitHub) — explicitly built around IPC Outbound carrying tracking events for inReach-to-inReach forwarding

None of these public sources document a tenant-side enablement step. So either (a) they have a configuration our account lacks, (b) Garmin enabled mc 0 for them on request, or (c) they receive tracking via a path that's incidentally not Internet-transport.

### 13.5 Pro Support question (sent 2026-05-03)

Email to inreach.professional@garmin.com sent on 2026-05-03 covering: tenant + IMEI + V4 schema + empirical findings + four specific questions (mc 0 currently configured; per-tenant flag mechanism; tracking-via-different-surface; Internet-transport routing path). Awaiting reply.

### 13.6 Diagnostic instrumentation shipped during this investigation

- **PR #163 (merged 2026-05-02):** `LOG_TRACK_PAYLOADS` env flag, default off; when true, `non_free_text` log lines for tracking events carry the full event JSON.
- **PR #166 (merged 2026-05-03):** unconditional `ipc_received` log line right after JSON parse on every webhook POST; captures `version`, `topLevelKeys`, `bodyBytes`, `eventsLength`, and first 1KB of raw body. This is the diagnostic that surfaced the V4-envelope-is-same-as-V2 finding and made it possible to ray-correlate Garmin's "Last Send Attempt" timestamps with our received POSTs.

Both diagnostics are still live on production as of 2026-05-03. Production is on `LOG_TRACK_PAYLOADS=true` via `--var` deploy override (not toml change) — will be reset on next normal `pnpm deploy:production`. Scheduled remote agent (`trig_01ErxEExpBUzbNngPqAaEbaB`, fires 2026-05-16) will verify the override has been cleared.

### 13.7 Mode B canonical — KML feed validation (2026-05-03)

After the operator enabled MapShare on 2026-05-03 (identifier: `trailscribe`, set via Garmin Explore), `curl https://share.garmin.com/Feed/Share/trailscribe?d1=2026-05-02T15:00Z&d2=2026-05-02T17:00Z` returned **HTTP 200, 37,435 bytes, 15 `<Placemark>` elements** (14 individual breadcrumbs + 1 trailing LineString summary).

Extracted ping stream from yesterday's PCH session:

```
ping  timestamp                lat        lon      elev   v_kmh  course
  1   2026-05-02T15:51:30Z  34.026825 -118.760255  30.76    0.0   0.00
  2   2026-05-02T15:53:30Z  34.026440 -118.761820  22.63   12.2 247.50  running W
  3   2026-05-02T15:55:30Z  34.025495 -118.765748   2.34    4.0 202.50  reaching beach
  4   2026-05-02T15:57:30Z  34.025645 -118.762786  10.46   11.1  90.00  running E
  5   2026-05-02T15:59:30Z  34.025688 -118.758795   6.40   12.2  90.00
  6   2026-05-02T16:01:30Z  34.026310 -118.755920   0.31    0.0   0.00  stopped
  7   2026-05-02T16:03:30Z  34.026331 -118.755898   0.31    0.0   0.00  stopped
  -- (5-min gap — intermittent walking, breadcrumbs filtered) --
  8   2026-05-02T16:08:30Z  34.025656 -118.759353   6.40    5.0 247.50  walking W
  9   2026-05-02T16:13:30Z  34.025485 -118.765726   4.37    3.0   0.00  beach turn
 10-12                          (back along beach + up)
 13   2026-05-02T16:23:30Z  34.026911 -118.760296  34.82    0.0   0.00  returned
 14   2026-05-02T16:24:30Z  34.026515 -118.760276  32.79    0.0   0.00  final
```

This is **the entire breadcrumb stream the original Mode A design wanted from IPC mc 0** — and it's already accessible via a single HTTP GET, with a richer schema (named fields, units, GPS-fix flags, pre-computed LineString) than IPC would have provided. Mode B is decisively viable.

**Conclusion:** Mode B is canonical. Spec rewritten 2026-05-03 (this version) to make MapShare pull-on-close the only design path. Mode A is retained as a future swap target — if Garmin Pro Support enables mc 0, the live-IPC data source could replace MapShare behind the same `parsePings()`-equivalent abstraction with no downstream changes.
