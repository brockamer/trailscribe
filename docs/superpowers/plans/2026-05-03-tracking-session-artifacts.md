# Tracking Session Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Garmin tracking session ends, fetch the session's breadcrumbs from MapShare KML, derive metrics, generate an LLM narrative, and publish a journal post — triggered by the existing IPC Outbound `messageCode: 12` (Stop Track) webhook.

**Architecture:** Stop Track event triggers a `withCheckpoint`-wrapped pipeline that fetches the MapShare KML feed, parses pings via a regex-based parser (no XML library), runs pure-function metrics over the ping array, calls OpenRouter for a structured narrative, commits markdown via the existing `publishPost` infrastructure, persists a session record to a new `TS_TRACKS` KV namespace, and replies to the device with the journal URL. No Durable Objects, no D1, no live ingestion.

**Tech Stack:** TypeScript (strict ESM), Cloudflare Workers, Hono, zod, Vitest + Miniflare, OpenRouter (Claude Sonnet 4.6), Garmin IPC Outbound + MapShare KML, GitHub Contents API.

**Spec:** `docs/superpowers/specs/2026-05-01-tracking-session-artifacts-design.md`

**Reference fixture (real-device, 2026-05-02 PCH session):** `tests/fixtures/mapshare/pch-2026-05-02.kml` (created in Cut 1 — see Task 1.2). 14 individual `<Placemark>` breadcrumbs + 1 trailing LineString summary. Verified live via `curl https://share.garmin.com/Feed/Share/trailscribe?d1=2026-05-02T15:00Z&d2=2026-05-02T17:00Z`.

---

## File Structure

**Create:**

- `src/adapters/location/mapshare.ts` — KML feed fetcher + regex-based ping parser. Exposes `fetchMapShareKml`, `parsePings`, `KmlPing` interface, `MapShareError` class.
- `src/core/track-metrics.ts` — pure functions over `KmlPing[]`. Exposes `haversineKm`, `totalDistanceKm`, `elevationProfile`, `paceStats`, `routeShape`, `activityHint`, `computeMetrics`.
- `src/core/tracking.ts` — orchestrator. Exposes `handleStopTrack` (called from webhook), `storeTrackRecord` (KV writer), `TrackSessionRecord` interface.
- `tests/fixtures/mapshare/pch-2026-05-02.kml` — real ground-truth fixture from operator's 2026-05-02 PCH session.
- `tests/mapshare.test.ts` — tests for `fetchMapShareKml` + `parsePings`.
- `tests/track-metrics.test.ts` — tests for every metric function against the fixture.
- `tests/tracking.test.ts` — integration tests for `handleStopTrack` end-to-end (mocked LLM + GitHub).

**Modify:**

- `wrangler.toml` — add `TS_TRACKS` KV namespace per env (3 places); add `TRACK_LOOKBACK_HOURS`, `TRACK_NARRATIVE_BODY_MAX` vars per env. Secret `MAPSHARE_KEY` provisioned via `wrangler secret put`.
- `src/env.ts` — add `TS_TRACKS: KVNamespace`, `MAPSHARE_KEY: string`, `TRACK_LOOKBACK_HOURS: string`, `TRACK_NARRATIVE_BODY_MAX: string` to `Env` + zod schema.
- `src/core/idempotency.ts` — add `"publish_track"` to `OpName` union.
- `src/core/narrative.ts` — add `TrackNarrativeInput`, `SYSTEM_PROMPT_TRACK`, `generateTrackNarrative` alongside existing `generateNarrative`.
- `src/adapters/publish/github-pages.ts` — add `publishTrackPost` wrapper that uses existing `publishPost` machinery with track-shaped frontmatter.
- `src/app.ts` — webhook routing change: route `messageCode === 12` to `handleStopTrack`; log mc 10/11 unchanged; existing free-text path unchanged.
- `tests/helpers/env.ts` — add `TS_TRACKS: makeMemKV()`, plus the 3 new env vars to the test Env.
- `tests/app.test.ts` — extend with `messageCode: 12` routing test.

---

## Cut 1 — KML adapter + fixture (independent, can ship alone)

### Task 1.0: Provision the `TS_TRACKS` KV namespace

**Files:**

- Modify: `wrangler.toml`

- [ ] **Step 1: Create the KV namespaces in Cloudflare**

Run, one at a time:

```
unset GH_TOKEN
pnpm wrangler kv namespace create TS_TRACKS
pnpm wrangler kv namespace create TS_TRACKS --preview
pnpm wrangler kv namespace create TS_TRACKS --env staging
pnpm wrangler kv namespace create TS_TRACKS --env production
```

Each prints an `id = "..."` line. **Copy each ID** — Step 2 wires them into the toml.

- [ ] **Step 2: Add the binding to wrangler.toml in 3 env blocks**

Edit `wrangler.toml`. Find the existing `TS_CACHE` block in the default `[[kv_namespaces]]` section (around line 58) and add a sibling block right after it:

```
[[kv_namespaces]]
binding = "TS_TRACKS"
id = "<paste the dev id from Step 1>"
preview_id = "<paste the preview id from Step 1>"
```

Then in the `[[env.staging.kv_namespaces]]` section (after `TS_CACHE` at ~line 124), add:

```
[[env.staging.kv_namespaces]]
binding = "TS_TRACKS"
id = "<paste the staging id from Step 1>"
```

Then in `[[env.production.kv_namespaces]]` (after `TS_CACHE` at ~line 173), add:

```
[[env.production.kv_namespaces]]
binding = "TS_TRACKS"
id = "<paste the production id from Step 1>"
```

- [ ] **Step 3: Verify wrangler.toml parses cleanly**

Run: `unset GH_TOKEN && pnpm wrangler --env production deploy --dry-run 2>&1 | grep -E "TS_TRACKS|Error" | head -5`
Expected: line showing `- TS_TRACKS: "<id>"` and no errors. Don't actually deploy yet.

- [ ] **Step 4: Commit**

Use `git add wrangler.toml` then commit with message:

```
chore(env): provision TS_TRACKS KV namespace per env

Storage for closed tracking-session records. See spec
docs/superpowers/specs/2026-05-01-tracking-session-artifacts-design.md
section 5.3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 1.1: Add new env vars to schema and test helper

**Files:**

- Modify: `src/env.ts`
- Modify: `tests/helpers/env.ts`
- Modify: `wrangler.toml`

- [ ] **Step 1: Add `MAPSHARE_KEY` as a secret + new vars to wrangler.toml**

In `wrangler.toml`, find the existing `MAPSHARE_BASE` line in `[vars]` (line ~18) and add two new vars below it:

```
MAPSHARE_BASE = "https://share.garmin.com/trailscribe"
TRACK_LOOKBACK_HOURS = "12"
TRACK_NARRATIVE_BODY_MAX = "1200"
```

Repeat in `[env.staging.vars]` (~line 92) and `[env.production.vars]` (~line 145) — same values. Don't add `MAPSHARE_KEY` to the toml; it's a secret.

- [ ] **Step 2: Add fields to the `Env` interface**

Edit `src/env.ts`. In the `Env` interface, find the `MAPSHARE_BASE` line (~line 19) and add the new fields after it:

```ts
MAPSHARE_BASE: string;
TRACK_LOOKBACK_HOURS: string;
TRACK_NARRATIVE_BODY_MAX: string;
```

In the secrets section (after `IMAGE_API_KEY` ~line 52), add:

```ts
IMAGE_API_KEY: string;
MAPSHARE_KEY: string;
TS_TRACKS: KVNamespace;
```

- [ ] **Step 3: Add fields to the zod schema**

In the same file, find the `EnvSchema` definition. After `MAPSHARE_BASE: z.string(),` (~line 78), add:

```ts
  MAPSHARE_BASE: z.string(),
  TRACK_LOOKBACK_HOURS: z.string(),
  TRACK_NARRATIVE_BODY_MAX: z.string(),
```

After the four KV namespaces at the top:

```ts
  TS_CACHE: KVNamespaceLike,
  TS_TRACKS: KVNamespaceLike,
```

After `IMAGE_API_KEY: z.string().min(8),` near the bottom of the schema:

```ts
  IMAGE_API_KEY: z.string().min(8),
  MAPSHARE_KEY: z.string().min(1),
```

- [ ] **Step 4: Add the new fields to `tests/helpers/env.ts`**

In the `makeTestEnv` function, in the `base` object, find the existing KV namespace block (top of object, ~line 59) and add `TS_TRACKS` alongside the other four:

```ts
    TS_TRACKS: makeMemKV(),
```

In the vars section, after `MAPSHARE_BASE: "",` (~line 67), add (and update `MAPSHARE_BASE` to a non-empty test value to align with prod toml):

```ts
    MAPSHARE_BASE: "https://share.garmin.com/trailscribe",
    TRACK_LOOKBACK_HOURS: "12",
    TRACK_NARRATIVE_BODY_MAX: "1200",
```

In the secrets section near the bottom, after `IMAGE_API_KEY: "test-image-api-key",`:

```ts
    IMAGE_API_KEY: "test-image-api-key",
    MAPSHARE_KEY: "trailscribe",
```

- [ ] **Step 5: Run typecheck and tests**

Run: `pnpm typecheck`
Expected: clean exit.

Run: `pnpm test tests/env.test.ts`
Expected: 4 passed.

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Set the `MAPSHARE_KEY` secret in production + staging**

Run:

```
unset GH_TOKEN
echo -n "trailscribe" | pnpm wrangler secret put MAPSHARE_KEY --env production
echo -n "trailscribe" | pnpm wrangler secret put MAPSHARE_KEY --env staging
```

Per project memory feedback_secret_pasting.md: always pipe via `echo -n` to strip trailing newlines.

- [ ] **Step 7: Commit**

Stage `wrangler.toml`, `src/env.ts`, `tests/helpers/env.ts`. Commit message:

```
chore(env): add MAPSHARE_KEY + TRACK_* vars for tracking session artifacts

MAPSHARE_KEY secret holds the operator's MapShare identifier. The base
URL is already in MAPSHARE_BASE; the fetcher composes them.

TRACK_LOOKBACK_HOURS bounds how far back from a Stop Track timestamp the
KML feed is queried (12h covers most day hikes).

TRACK_NARRATIVE_BODY_MAX caps the LLM body schema for track posts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 1.2: Capture the real KML fixture

**Files:**

- Create: `tests/fixtures/mapshare/pch-2026-05-02.kml`

- [ ] **Step 1: Create the fixture directory**

Run: `mkdir -p tests/fixtures/mapshare`

- [ ] **Step 2: Fetch the canonical fixture from MapShare**

Run:

```
curl -sS "https://share.garmin.com/Feed/Share/trailscribe?d1=2026-05-02T15:00Z&d2=2026-05-02T17:00Z" \
  -o tests/fixtures/mapshare/pch-2026-05-02.kml
```

- [ ] **Step 3: Verify the fixture content**

Run: `grep -c "<Placemark>" tests/fixtures/mapshare/pch-2026-05-02.kml`
Expected: `15` (14 individual breadcrumbs + 1 trailing LineString summary).

Run: `wc -c tests/fixtures/mapshare/pch-2026-05-02.kml`
Expected: ~37000 bytes (33-40 KB range).

- [ ] **Step 4: Commit**

Stage the fixture file. Commit message:

```
test: add real MapShare KML fixture from 2026-05-02 PCH session

14 breadcrumb Placemarks + 1 LineString summary. Captured live from
share.garmin.com/Feed/Share/trailscribe for the operator's 0.25mi run +
beach walking + return session. Ground-truth seed for parsePings tests
and end-to-end integration tests of the handleStopTrack pipeline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 1.3: Define `KmlPing` type + `MapShareError` class

**Files:**

- Create: `src/adapters/location/mapshare.ts`

- [ ] **Step 1: Create the file with the type and error class only**

Write `src/adapters/location/mapshare.ts`:

```ts
import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

/**
 * One breadcrumb position parsed out of a Garmin MapShare KML feed.
 *
 * Sourced from Placemark elements with a TimeStamp (the trailing LineString
 * Placemark has no TimeStamp and is filtered out by the parser).
 */
export interface KmlPing {
  /** Milliseconds since epoch. */
  t: number;
  lat: number;
  lon: number;
  /** Meters above mean sea level. */
  alt: number;
  /** Over-ground speed in km/h, as Garmin reports it. */
  velocityKmh: number;
  /** True bearing in degrees (0-360). */
  courseDeg: number;
  /** True if Garmin marked the GPS fix as valid for this point. */
  validFix: boolean;
}

export class MapShareError extends Error {
  public readonly status: number;
  constructor(opts: { status: number; message: string }) {
    super(opts.message);
    this.name = "MapShareError";
    this.status = opts.status;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 3: Commit**

Stage `src/adapters/location/mapshare.ts`. Commit message:

```
feat(mapshare): KmlPing interface + MapShareError class

Skeleton for the KML feed adapter. Subsequent commits add fetchMapShareKml
and parsePings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 1.4: Write `parsePings` — failing tests first

**Files:**

- Create: `tests/mapshare.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/mapshare.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePings } from "../src/adapters/location/mapshare.js";
import type { KmlPing } from "../src/adapters/location/mapshare.js";

const FIXTURE_PATH = resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml");
const fixtureKml = readFileSync(FIXTURE_PATH, "utf8");

describe("parsePings — PCH 2026-05-02 fixture", () => {
  test("extracts exactly 14 individual breadcrumb pings (excludes LineString)", () => {
    const pings = parsePings(fixtureKml);
    expect(pings).toHaveLength(14);
  });

  test("first ping matches the known 15:51:30Z trailhead position", () => {
    const pings = parsePings(fixtureKml);
    const first = pings[0];
    expect(first.t).toBe(Date.parse("2026-05-02T15:51:30Z"));
    expect(first.lat).toBeCloseTo(34.026825, 5);
    expect(first.lon).toBeCloseTo(-118.760255, 5);
    expect(first.alt).toBeCloseTo(30.76, 1);
    expect(first.velocityKmh).toBe(0);
    expect(first.courseDeg).toBe(0);
    expect(first.validFix).toBe(true);
  });

  test("second ping matches the known 15:53:30Z running-W breadcrumb", () => {
    const pings = parsePings(fixtureKml);
    const p2 = pings[1];
    expect(p2.t).toBe(Date.parse("2026-05-02T15:53:30Z"));
    expect(p2.velocityKmh).toBeCloseTo(12.2, 1);
    expect(p2.courseDeg).toBeCloseTo(247.5, 1);
  });

  test("pings are sorted oldest-first by timestamp", () => {
    const pings = parsePings(fixtureKml);
    for (let i = 1; i < pings.length; i++) {
      expect(pings[i].t).toBeGreaterThanOrEqual(pings[i - 1].t);
    }
  });

  test("returns empty array for KML with no Placemarks", () => {
    const empty = `<?xml version="1.0"?><kml><Document></Document></kml>`;
    expect(parsePings(empty)).toEqual([]);
  });

  test("returns empty array for KML with only a LineString Placemark", () => {
    const onlyLine = `<?xml version="1.0"?><kml><Document>
      <Placemark><name>track log</name>
        <LineString><coordinates>0,0,0 1,1,1</coordinates></LineString>
      </Placemark>
    </Document></kml>`;
    expect(parsePings(onlyLine)).toEqual([]);
  });

  test("strips unit suffixes from Elevation, Velocity, Course", () => {
    const pings = parsePings(fixtureKml);
    for (const p of pings) {
      expect(typeof p.alt).toBe("number");
      expect(typeof p.velocityKmh).toBe("number");
      expect(typeof p.courseDeg).toBe("number");
      expect(Number.isFinite(p.alt)).toBe(true);
      expect(Number.isFinite(p.velocityKmh)).toBe(true);
      expect(Number.isFinite(p.courseDeg)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/mapshare.test.ts`
Expected: 7 tests fail with "parsePings is not a function" or import error.

- [ ] **Step 3: Implement `parsePings` minimally**

Append to `src/adapters/location/mapshare.ts`:

```ts
/**
 * Regex-based KML parser for Garmin MapShare share-page feeds.
 *
 * Garmin's KML schema is tightly constrained — a single XML namespace, fixed
 * ExtendedData field names, no embedded HTML. So we extract Placemark blocks
 * and per-field values via regex rather than pulling a full XML parser into
 * the Workers bundle.
 *
 * The trailing Placemark in a Garmin share KML has no TimeStamp — it's the
 * route LineString summarizing the whole session. We filter it by requiring
 * a TimeStamp/when block per ping.
 *
 * Returned pings are sorted oldest-first by timestamp.
 */
export function parsePings(kml: string): KmlPing[] {
  const pings: KmlPing[] = [];
  const placemarkRe = /<Placemark>([\s\S]*?)<\/Placemark>/g;
  let match: RegExpExecArray | null;
  while ((match = placemarkRe.exec(kml)) !== null) {
    const block = match[1];
    const whenMatch = /<TimeStamp>\s*<when>([^<]+)<\/when>/.exec(block);
    if (!whenMatch) continue;
    const t = Date.parse(whenMatch[1]);
    if (!Number.isFinite(t)) continue;

    const lat = readNumberField(block, "Latitude");
    const lon = readNumberField(block, "Longitude");
    const alt = readNumberField(block, "Elevation");
    const velocityKmh = readNumberField(block, "Velocity");
    const courseDeg = readNumberField(block, "Course");
    const validFixRaw = readStringField(block, "Valid GPS Fix");

    if (lat === null || lon === null) continue;

    pings.push({
      t,
      lat,
      lon,
      alt: alt ?? 0,
      velocityKmh: velocityKmh ?? 0,
      courseDeg: courseDeg ?? 0,
      validFix: validFixRaw === "True",
    });
  }
  pings.sort((a, b) => a.t - b.t);
  return pings;
}

function readStringField(block: string, name: string): string | null {
  const re = new RegExp(`<Data name="${name}">\\s*<value>([\\s\\S]*?)<\\/value>\\s*<\\/Data>`);
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

function readNumberField(block: string, name: string): number | null {
  const raw = readStringField(block, name);
  if (raw === null) return null;
  const m = /^(-?\d+(?:\.\d+)?)/.exec(raw);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/mapshare.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

Stage `src/adapters/location/mapshare.ts` and `tests/mapshare.test.ts`. Commit message:

```
feat(mapshare): parsePings — regex-based KML breadcrumb parser

No XML library — Workers bundle stays small. Filters out the trailing
LineString Placemark by requiring a TimeStamp per ping. Strips unit
suffixes from numeric Garmin fields. Sorts oldest-first.

Tests verified against the real-device fixture from 2026-05-02.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 1.5: Write `fetchMapShareKml` — failing tests first

**Files:**

- Modify: `tests/mapshare.test.ts`
- Modify: `src/adapters/location/mapshare.ts`

- [ ] **Step 1: Add failing tests for `fetchMapShareKml`**

Append to `tests/mapshare.test.ts`:

```ts
import { fetchMapShareKml, MapShareError } from "../src/adapters/location/mapshare.js";
import { vi, beforeEach } from "vitest";
import { makeTestEnv } from "./helpers/env.js";

describe("fetchMapShareKml", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("composes the URL from MAPSHARE_BASE + MAPSHARE_KEY + ISO timestamps", async () => {
    const env = makeTestEnv();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<kml/>", { status: 200 }));
    await fetchMapShareKml(
      env,
      Date.parse("2026-05-02T15:00:00Z"),
      Date.parse("2026-05-02T17:00:00Z"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://share.garmin.com/trailscribe/Feed/Share/trailscribe?d1=2026-05-02T15:00:00.000Z&d2=2026-05-02T17:00:00.000Z",
    );
  });

  test("returns the response body on 200", async () => {
    const env = makeTestEnv();
    const expectedBody = "<kml>payload</kml>";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(expectedBody, { status: 200 }));
    const body = await fetchMapShareKml(env, 0, 1);
    expect(body).toBe(expectedBody);
  });

  test("throws MapShareError on non-200 status", async () => {
    const env = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fetchMapShareKml(env, 0, 1)).rejects.toBeInstanceOf(MapShareError);
  });

  test("MapShareError exposes status code", async () => {
    const env = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server error", { status: 503 }));
    try {
      await fetchMapShareKml(env, 0, 1);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MapShareError);
      expect((e as MapShareError).status).toBe(503);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/mapshare.test.ts`
Expected: 4 new tests fail with "fetchMapShareKml is not a function".

- [ ] **Step 3: Implement `fetchMapShareKml`**

Append to `src/adapters/location/mapshare.ts`:

```ts
/**
 * GET the operator's MapShare KML feed for a session window.
 *
 * URL composes from MAPSHARE_BASE (e.g. https://share.garmin.com/trailscribe)
 * + the standard /Feed/Share/<key> suffix + d1/d2 ISO 8601 query params.
 * d1/d2 are inclusive bounds in UTC.
 *
 * No retry — Garmin's share endpoint is fast and the caller (handleStopTrack)
 * runs inside withCheckpoint; transient failures bubble up so a Garmin webhook
 * retry can re-attempt. Throws MapShareError with the HTTP status on non-200.
 */
export async function fetchMapShareKml(
  env: Env,
  startedAtMs: number,
  closedAtMs: number,
): Promise<string> {
  const d1 = new Date(startedAtMs).toISOString();
  const d2 = new Date(closedAtMs).toISOString();
  const url = `${env.MAPSHARE_BASE}/Feed/Share/${env.MAPSHARE_KEY}?d1=${d1}&d2=${d2}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.google-earth.kml+xml" },
  });
  if (!res.ok) {
    log({
      event: "mapshare_fetch_failed",
      level: "warn",
      status: res.status,
      url,
    });
    throw new MapShareError({
      status: res.status,
      message: `MapShare fetch returned HTTP ${res.status}`,
    });
  }
  return res.text();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/mapshare.test.ts`
Expected: 11 passed total (7 parser + 4 fetcher).

- [ ] **Step 5: Run full test suite to confirm no regressions**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

Stage `src/adapters/location/mapshare.ts` and `tests/mapshare.test.ts`. Commit message:

```
feat(mapshare): fetchMapShareKml — KML feed fetcher

Composes the URL from MAPSHARE_BASE + MAPSHARE_KEY + ISO 8601 d1/d2
window bounds. Throws MapShareError with HTTP status on non-200; no
retry (caller runs inside withCheckpoint, which absorbs transient
failures via Garmin webhook retries).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Cut 2 — Metrics module (independent of Cut 3, depends on Cut 1's `KmlPing` type)

### Task 2.1: `haversineKm` — distance between two points

**Files:**

- Create: `src/core/track-metrics.ts`
- Create: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/track-metrics.test.ts`:

```ts
import { describe, test, expect } from "vitest";
import { haversineKm } from "../src/core/track-metrics.js";

describe("haversineKm", () => {
  test("zero distance for identical points", () => {
    expect(haversineKm(34.0, -118.0, 34.0, -118.0)).toBe(0);
  });

  test("~111 km for one degree of latitude difference", () => {
    const km = haversineKm(34.0, -118.0, 35.0, -118.0);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  test("known PCH-fixture leg: ping 1 to ping 2 ~ 0.16 km", () => {
    const km = haversineKm(34.026825, -118.760255, 34.02644, -118.76182);
    expect(km).toBeGreaterThan(0.13);
    expect(km).toBeLessThan(0.18);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 3 tests fail with "haversineKm is not a function".

- [ ] **Step 3: Implement `haversineKm`**

Create `src/core/track-metrics.ts`:

```ts
import type { KmlPing } from "../adapters/location/mapshare.js";

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lon points in kilometers, using the
 * Haversine formula. Sufficient accuracy for trail-distance work — within
 * ~0.5% of geodesic methods over the < 1000 km ranges we care about.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

Stage both files. Commit message:

```
feat(track-metrics): haversineKm — pure distance helper

First brick of the metrics module. Subsequent commits build aggregate
metrics on top: totalDistanceKm, elevationProfile, paceStats, etc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.2: `totalDistanceKm` — sum of consecutive ping distances

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { totalDistanceKm } from "../src/core/track-metrics.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePings } from "../src/adapters/location/mapshare.js";

const FIXTURE_KML = readFileSync(
  resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml"),
  "utf8",
);

describe("totalDistanceKm", () => {
  test("zero pings returns 0", () => {
    expect(totalDistanceKm([])).toBe(0);
  });

  test("one ping returns 0", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(totalDistanceKm([pings[0]])).toBe(0);
  });

  test("PCH fixture totals roughly 1-4 km", () => {
    const pings = parsePings(FIXTURE_KML);
    const km = totalDistanceKm(pings);
    expect(km).toBeGreaterThan(1.0);
    expect(km).toBeLessThan(4.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 3 new tests fail with "totalDistanceKm is not a function".

- [ ] **Step 3: Implement `totalDistanceKm`**

Append to `src/core/track-metrics.ts`:

```ts
/** Cumulative Haversine distance across all consecutive ping pairs. */
export function totalDistanceKm(pings: KmlPing[]): number {
  if (pings.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < pings.length; i++) {
    km += haversineKm(pings[i - 1].lat, pings[i - 1].lon, pings[i].lat, pings[i].lon);
  }
  return km;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

Stage both files. Commit message:

```
feat(track-metrics): totalDistanceKm

Cumulative Haversine across consecutive pings. Validated against the
PCH fixture (~2.5 km expected for the actual session).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.3: `elevationProfile` — gain/loss/min/max with smoothing

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { elevationProfile } from "../src/core/track-metrics.js";
import type { KmlPing } from "../src/adapters/location/mapshare.js";

function makePing(secOffset: number, alt: number): KmlPing {
  return {
    t: secOffset * 1000,
    lat: 34.0,
    lon: -118.0,
    alt,
    velocityKmh: 0,
    courseDeg: 0,
    validFix: true,
  };
}

describe("elevationProfile", () => {
  test("zero-pings input returns all zeros", () => {
    expect(elevationProfile([])).toEqual({ gainM: 0, lossM: 0, minM: 0, maxM: 0 });
  });

  test("monotonic-up sequence: gain matches total rise, loss is 0", () => {
    const pings = [10, 20, 30, 40].map((alt, i) => makePing(i, alt));
    const profile = elevationProfile(pings);
    expect(profile.gainM).toBeCloseTo(30, 0);
    expect(profile.lossM).toBe(0);
    expect(profile.maxM).toBe(40);
    expect(profile.minM).toBe(10);
  });

  test("smoothing rejects single-point spikes", () => {
    const pings = [10, 10, 100, 10, 10].map((alt, i) => makePing(i, alt));
    const profile = elevationProfile(pings);
    expect(profile.gainM).toBeLessThan(5);
  });

  test("PCH fixture: trail starts ~30m, drops to beach ~0m, returns ~30m", () => {
    const pings = parsePings(FIXTURE_KML);
    const profile = elevationProfile(pings);
    expect(profile.maxM).toBeGreaterThan(25);
    expect(profile.minM).toBeLessThan(5);
    expect(profile.gainM).toBeGreaterThan(20);
    expect(profile.gainM).toBeLessThan(80);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 4 new tests fail with "elevationProfile is not a function".

- [ ] **Step 3: Implement `elevationProfile` with median smoothing**

Append to `src/core/track-metrics.ts`:

```ts
export interface ElevationProfile {
  gainM: number;
  lossM: number;
  minM: number;
  maxM: number;
}

/**
 * Elevation aggregates over a smoothed altitude series.
 *
 * Handheld GPS altitude is noisy (10-15 m even with a fix). Without smoothing,
 * a single bad sample can inflate gain by 50+ meters. We apply a 5-point
 * median filter before differencing.
 */
export function elevationProfile(pings: KmlPing[]): ElevationProfile {
  if (pings.length === 0) return { gainM: 0, lossM: 0, minM: 0, maxM: 0 };
  const smoothed = medianSmooth(
    pings.map((p) => p.alt),
    5,
  );

  let gainM = 0;
  let lossM = 0;
  let minM = smoothed[0];
  let maxM = smoothed[0];
  for (let i = 1; i < smoothed.length; i++) {
    const delta = smoothed[i] - smoothed[i - 1];
    if (delta > 0) gainM += delta;
    else lossM += -delta;
    if (smoothed[i] < minM) minM = smoothed[i];
    if (smoothed[i] > maxM) maxM = smoothed[i];
  }
  return { gainM, lossM, minM, maxM };
}

function medianSmooth(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    const slice = values.slice(lo, hi).sort((a, b) => a - b);
    return slice[Math.floor(slice.length / 2)];
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 10 passed.

- [ ] **Step 5: Commit**

Commit message:

```
feat(track-metrics): elevationProfile with 5-point median smoothing

Handheld GPS altitude is 10-15m noisy; raw differencing inflates gain
by tens of meters per session. Median filter rejects single-sample
spikes while preserving real elevation changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.4: `paceStats` — speed quantiles

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { paceStats } from "../src/core/track-metrics.js";

describe("paceStats", () => {
  test("empty input returns zeros", () => {
    expect(paceStats([])).toEqual({ avgKmh: 0, p50Kmh: 0, p95Kmh: 0 });
  });

  test("uniform speed: avg/p50/p95 all equal that speed", () => {
    const pings = [10, 10, 10, 10].map((v, i) => ({
      ...makePing(i, 0),
      velocityKmh: v,
    }));
    const stats = paceStats(pings);
    expect(stats.avgKmh).toBe(10);
    expect(stats.p50Kmh).toBe(10);
    expect(stats.p95Kmh).toBe(10);
  });

  test("PCH fixture: p95 reflects the running segments (>=10 km/h)", () => {
    const pings = parsePings(FIXTURE_KML);
    const stats = paceStats(pings);
    expect(stats.p95Kmh).toBeGreaterThan(10);
    expect(stats.avgKmh).toBeGreaterThan(0);
    expect(stats.avgKmh).toBeLessThan(stats.p95Kmh);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement `paceStats`**

Append to `src/core/track-metrics.ts`:

```ts
export interface PaceStats {
  avgKmh: number;
  p50Kmh: number;
  p95Kmh: number;
}

/** Speed quantiles using the per-ping velocityKmh that Garmin already populates. */
export function paceStats(pings: KmlPing[]): PaceStats {
  if (pings.length === 0) return { avgKmh: 0, p50Kmh: 0, p95Kmh: 0 };
  const speeds = pings.map((p) => p.velocityKmh).sort((a, b) => a - b);
  const avg = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  return {
    avgKmh: avg,
    p50Kmh: percentile(speeds, 0.5),
    p95Kmh: percentile(speeds, 0.95),
  };
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 13 passed.

- [ ] **Step 5: Commit**

Commit message:

```
feat(track-metrics): paceStats — avg, p50, p95 speed quantiles

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.5: `routeShape` — out-and-back / loop / point-to-point

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { routeShape } from "../src/core/track-metrics.js";

describe("routeShape", () => {
  test("empty or single-ping returns 'point-to-point'", () => {
    expect(routeShape([])).toBe("point-to-point");
    expect(routeShape([makePing(0, 0)])).toBe("point-to-point");
  });

  test("start and end nearly coincident, midpoint far: 'out-and-back'", () => {
    const pings: KmlPing[] = [
      { ...makePing(0, 0), lat: 0, lon: 0 },
      { ...makePing(1, 0), lat: 0, lon: 0.01 },
      { ...makePing(2, 0), lat: 0, lon: 0.02 },
      { ...makePing(3, 0), lat: 0, lon: 0.01 },
      { ...makePing(4, 0), lat: 0, lon: 0.0001 },
    ];
    const shape = routeShape(pings);
    expect(["out-and-back", "loop"]).toContain(shape);
  });

  test("point-to-point: start and end far apart", () => {
    const pings: KmlPing[] = [
      { ...makePing(0, 0), lat: 0, lon: 0 },
      { ...makePing(1, 0), lat: 0, lon: 0.5 },
      { ...makePing(2, 0), lat: 0, lon: 1.0 },
    ];
    expect(routeShape(pings)).toBe("point-to-point");
  });

  test("PCH fixture is out-and-back (start ~ end, midpoint far)", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(routeShape(pings)).toBe("out-and-back");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 4 new tests fail.

- [ ] **Step 3: Implement `routeShape`**

Append to `src/core/track-metrics.ts`:

```ts
export type RouteShape = "out-and-back" | "loop" | "point-to-point";

/**
 * Heuristic classifier from start/end/midpoint geometry.
 *
 *   start ~ end AND midpoint far from start  -> "out-and-back"
 *   start ~ end (no clear far midpoint)      -> "loop"
 *   start far from end                       -> "point-to-point"
 */
export function routeShape(pings: KmlPing[]): RouteShape {
  if (pings.length < 2) return "point-to-point";
  const start = pings[0];
  const end = pings[pings.length - 1];
  const mid = pings[Math.floor(pings.length / 2)];

  const startEndKm = haversineKm(start.lat, start.lon, end.lat, end.lon);
  const startMidKm = haversineKm(start.lat, start.lon, mid.lat, mid.lon);

  const LOOP_CLOSURE_KM = 0.1;
  const FAR_KM = 1.0;

  if (startEndKm < LOOP_CLOSURE_KM) {
    return startMidKm >= FAR_KM ? "out-and-back" : "loop";
  }
  return "point-to-point";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 17 passed.

- [ ] **Step 5: Commit**

Commit message:

```
feat(track-metrics): routeShape classifier

Heuristic over start/end/midpoint geometry. Thresholds: loop closure at
100m (matches Garmin power-saving stationary distance), 'far' midpoint
at 1km. PCH fixture classifies as 'out-and-back' as expected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.6: `activityHint` — speed-distribution classifier

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { activityHint } from "../src/core/track-metrics.js";

describe("activityHint", () => {
  test("empty input returns 'mixed'", () => {
    expect(activityHint([])).toBe("mixed");
  });

  test("walking pace dominant: 'walk'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 4,
    }));
    expect(activityHint(pings)).toBe("walk");
  });

  test("hiking pace dominant: 'hike'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 7,
    }));
    expect(activityHint(pings)).toBe("hike");
  });

  test("running pace dominant: 'run'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 11,
    }));
    expect(activityHint(pings)).toBe("run");
  });

  test("cycling pace: 'bike'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 22,
    }));
    expect(activityHint(pings)).toBe("bike");
  });

  test("PCH fixture (run + walk mix): 'mixed', 'run', or 'walk'", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(["mixed", "run", "walk"]).toContain(activityHint(pings));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 6 new tests fail.

- [ ] **Step 3: Implement `activityHint`**

Append to `src/core/track-metrics.ts`:

```ts
export type ActivityHint = "walk" | "hike" | "run" | "bike" | "drive" | "mixed";

/**
 * Classify activity by the band that holds the most non-zero pings.
 *
 *   walk:  0-5 km/h
 *   hike:  5-9 km/h
 *   run:   9-15 km/h
 *   bike:  15-35 km/h
 *   drive: 35+ km/h
 *
 * Returns "mixed" if no band gets a clear majority (>40% of moving pings).
 */
export function activityHint(pings: KmlPing[]): ActivityHint {
  if (pings.length === 0) return "mixed";
  const moving = pings.filter((p) => p.velocityKmh > 1);
  if (moving.length === 0) return "mixed";

  const counts: Record<Exclude<ActivityHint, "mixed">, number> = {
    walk: 0,
    hike: 0,
    run: 0,
    bike: 0,
    drive: 0,
  };
  for (const p of moving) {
    if (p.velocityKmh < 5) counts.walk++;
    else if (p.velocityKmh < 9) counts.hike++;
    else if (p.velocityKmh < 15) counts.run++;
    else if (p.velocityKmh < 35) counts.bike++;
    else counts.drive++;
  }

  const sorted = (Object.entries(counts) as Array<[Exclude<ActivityHint, "mixed">, number]>).sort(
    ([, a], [, b]) => b - a,
  );
  const [topName, topCount] = sorted[0];
  if (topCount / moving.length >= 0.4) return topName;
  return "mixed";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 23 passed.

- [ ] **Step 5: Commit**

Commit message:

```
feat(track-metrics): activityHint speed-band classifier

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 2.7: `computeMetrics` — aggregate everything for the LLM input

**Files:**

- Modify: `src/core/track-metrics.ts`
- Modify: `tests/track-metrics.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/track-metrics.test.ts`:

```ts
import { computeMetrics } from "../src/core/track-metrics.js";

describe("computeMetrics", () => {
  test("PCH fixture produces a populated TrackMetrics object", () => {
    const pings = parsePings(FIXTURE_KML);
    const metrics = computeMetrics(pings);

    expect(metrics.pingCount).toBe(14);
    expect(metrics.startedAt).toBe(Date.parse("2026-05-02T15:51:30Z"));
    expect(metrics.closedAt).toBe(Date.parse("2026-05-02T16:24:30Z"));
    expect(metrics.durationSeconds).toBeGreaterThan(1900);
    expect(metrics.durationSeconds).toBeLessThan(2100);
    expect(metrics.distanceKm).toBeGreaterThan(1.0);
    expect(metrics.distanceKm).toBeLessThan(4.0);
    expect(metrics.routeShape).toBe("out-and-back");
    expect(metrics.activityHint).toBeDefined();
    expect(metrics.elevation.maxM).toBeGreaterThan(25);
    expect(metrics.pace.p95Kmh).toBeGreaterThan(0);
  });

  test("empty input returns a zeroed TrackMetrics", () => {
    const m = computeMetrics([]);
    expect(m.pingCount).toBe(0);
    expect(m.distanceKm).toBe(0);
    expect(m.durationSeconds).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement `computeMetrics`**

Append to `src/core/track-metrics.ts`:

```ts
export interface TrackMetrics {
  pingCount: number;
  startedAt: number;
  closedAt: number;
  durationSeconds: number;
  distanceKm: number;
  pace: PaceStats;
  elevation: ElevationProfile;
  routeShape: RouteShape;
  activityHint: ActivityHint;
}

/** Aggregate every metric the narrative pipeline needs into one record. */
export function computeMetrics(pings: KmlPing[]): TrackMetrics {
  if (pings.length === 0) {
    return {
      pingCount: 0,
      startedAt: 0,
      closedAt: 0,
      durationSeconds: 0,
      distanceKm: 0,
      pace: { avgKmh: 0, p50Kmh: 0, p95Kmh: 0 },
      elevation: { gainM: 0, lossM: 0, minM: 0, maxM: 0 },
      routeShape: "point-to-point",
      activityHint: "mixed",
    };
  }
  const startedAt = pings[0].t;
  const closedAt = pings[pings.length - 1].t;
  return {
    pingCount: pings.length,
    startedAt,
    closedAt,
    durationSeconds: Math.round((closedAt - startedAt) / 1000),
    distanceKm: totalDistanceKm(pings),
    pace: paceStats(pings),
    elevation: elevationProfile(pings),
    routeShape: routeShape(pings),
    activityHint: activityHint(pings),
  };
}
```

- [ ] **Step 4: Run tests + full suite**

Run: `pnpm test tests/track-metrics.test.ts`
Expected: 25 passed.

Run: `pnpm test`
Expected: all suites pass.

- [ ] **Step 5: Commit**

Commit message:

```
feat(track-metrics): computeMetrics aggregator

Single function that returns the full TrackMetrics record consumed by
the narrative + journal-frontmatter layers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Cut 3 — End-to-end pipeline (depends on Cuts 1 + 2)

### Task 3.1: `TrackSessionRecord` + `storeTrackRecord` KV writer

**Files:**

- Create: `src/core/tracking.ts`
- Create: `tests/tracking.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tracking.test.ts`:

```ts
import { describe, test, expect, vi, beforeEach } from "vitest";
import { storeTrackRecord, type TrackSessionRecord } from "../src/core/tracking.js";
import { makeTestEnv } from "./helpers/env.js";

describe("storeTrackRecord", () => {
  test("writes the record under track:<imei>:<sessionId>", async () => {
    const env = makeTestEnv();
    const record: TrackSessionRecord = {
      sessionId: "deadbeef",
      imei: "300052030374220",
      startedAt: 1730000000000,
      closedAt: 1730003600000,
      closeReason: "stop",
      pingCount: 14,
      distanceKm: 2.5,
      elevationGainM: 40,
      durationSeconds: 3600,
      journalUrl: "https://brockamer.github.io/trailscribe-journal/2026/05/02/x.html",
      rawKml: "<kml/>",
    };
    await storeTrackRecord(env, record);
    const raw = await env.TS_TRACKS.get("track:300052030374220:deadbeef", "json");
    expect(raw).toEqual(record);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/tracking.test.ts`
Expected: fails with "Cannot find module '../src/core/tracking.js'".

- [ ] **Step 3: Create `src/core/tracking.ts` with `storeTrackRecord`**

Create `src/core/tracking.ts`:

```ts
import type { Env } from "../env.js";
import { putJSON } from "../adapters/storage/kv.js";

const TRACK_RECORD_TTL_SECONDS = 60 * 60 * 24 * 365;

export interface TrackSessionRecord {
  sessionId: string;
  imei: string;
  startedAt: number;
  closedAt: number;
  closeReason: "stop";
  pingCount: number;
  distanceKm: number;
  elevationGainM: number;
  durationSeconds: number;
  journalUrl: string | null;
  rawKml: string;
}

/** Persist a closed track session to TS_TRACKS KV. */
export async function storeTrackRecord(env: Env, record: TrackSessionRecord): Promise<void> {
  const key = `track:${record.imei}:${record.sessionId}`;
  await putJSON(env.TS_TRACKS, key, record, { expirationTtl: TRACK_RECORD_TTL_SECONDS });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/tracking.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

Commit message:

```
feat(tracking): TrackSessionRecord + storeTrackRecord KV writer

First brick of the tracking orchestrator. Subsequent commits add
generateTrackNarrative, publishTrackPost, and handleStopTrack.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.2: `"publish_track"` op name

**Files:**

- Modify: `src/core/idempotency.ts`

- [ ] **Step 1: Add the op name**

Edit `src/core/idempotency.ts`. Find the `OpName` union and append `"publish_track"`:

```ts
export type OpName =
  | "narrative"
  | "publish"
  | "mail"
  | "todo"
  | "reply"
  | "brief"
  | "brief_overflow_email"
  | "ai"
  | "ai_overflow_email"
  | "camp"
  | "camp_overflow_email"
  | "share"
  | "blast"
  | "image"
  | "publish_track";
```

- [ ] **Step 2: Run typecheck and tests**

Run: `pnpm typecheck`
Expected: clean exit.

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Commit**

Commit message:

```
feat(idempotency): register publish_track op name

Allows handleStopTrack to use withCheckpoint to dedupe Garmin webhook
retries — second mc 12 finds a cached publish result and short-circuits
without re-fetching MapShare or re-publishing the journal post.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.3: `generateTrackNarrative` — LLM extension

**Files:**

- Modify: `src/core/narrative.ts`
- Modify: `tests/tracking.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.ts`:

```ts
import { generateTrackNarrative } from "../src/core/narrative.js";
import { chatCompletion } from "../src/adapters/ai/openrouter.js";

vi.mock("../src/adapters/ai/openrouter.js");

describe("generateTrackNarrative", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  test("calls OpenRouter with track system prompt + structured JSON schema", async () => {
    const env = makeTestEnv();
    vi.mocked(chatCompletion).mockResolvedValue({
      id: "x",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              title: "PCH and back",
              haiku: "Sand under wet shoes\nWaves take the line we ran past\nBack uphill, sun high",
              body: "A short out-and-back along PCH and the beach.",
            }),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateTrackNarrative({
      metrics: {
        pingCount: 14,
        startedAt: Date.parse("2026-05-02T15:51:30Z"),
        closedAt: Date.parse("2026-05-02T16:24:30Z"),
        durationSeconds: 1980,
        distanceKm: 2.5,
        pace: { avgKmh: 5, p50Kmh: 4, p95Kmh: 12 },
        elevation: { gainM: 35, lossM: 35, minM: 0, maxM: 35 },
        routeShape: "out-and-back",
        activityHint: "mixed",
      },
      startPlace: "Malibu, CA",
      endPlace: "Malibu, CA",
      env,
    });

    expect(result.title).toBe("PCH and back");
    expect(result.haiku).toContain("\n");
    expect(result.body).toBeDefined();
    const callArgs = vi.mocked(chatCompletion).mock.calls[0][0];
    const sysMsg = callArgs.req.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toContain("tracking session");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/tracking.test.ts`
Expected: test fails with "generateTrackNarrative is not exported".

- [ ] **Step 3: Implement `generateTrackNarrative`**

Edit `src/core/narrative.ts`. Add this import near the top with the other imports:

```ts
import type { TrackMetrics } from "./track-metrics.js";
```

Then append at the end of the file:

```ts
export interface TrackNarrativeInput {
  metrics: TrackMetrics;
  startPlace?: string;
  endPlace?: string;
  midpointPlace?: string;
  weatherSummary?: string;
  env: Env;
}

const TRACK_NARRATIVE_SCHEMA = {
  name: "track_narrative",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 60 },
      haiku: { type: "string", maxLength: 110 },
      body: { type: "string", maxLength: 1200 },
    },
    required: ["title", "haiku", "body"],
    additionalProperties: false,
  },
} as const;

const TrackContentSchema = z.object({
  title: z.string().min(1).max(60),
  haiku: z.string().min(1).max(110),
  body: z.string().min(1).max(1200),
});

const SYSTEM_PROMPT_TRACK = [
  "You write field-journal entries from a backcountry tracking session. Given metrics, start/end places, and weather, produce a polished post.",
  "Always return valid JSON matching the schema. No prose outside the JSON.",
  "Constraints:",
  '- "title": <=60 characters, evocative, anchored to place + activity. No clickbait, no emoji.',
  '- "haiku": exactly three lines separated by newlines, in 5/7/5 syllables, <=110 characters total. Plain English, observational.',
  '- "body": <=1200 characters. Describe the route, place, conditions, and pace. Use long stops as paragraph breaks. Do not invent companions, motivations, or destinations not present in the metrics or place names.',
].join("\n");

export async function generateTrackNarrative(input: TrackNarrativeInput): Promise<NarrativeOutput> {
  const userPrompt = buildTrackPrompt(input);
  const model = input.env.LLM_MODEL || "anthropic/claude-sonnet-4-6";

  const response = await chatCompletion({
    req: {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT_TRACK },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: TRACK_NARRATIVE_SCHEMA },
      temperature: 0.7,
      max_tokens: 1500,
    },
    env: input.env,
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new NarrativeError("LLM returned no content for track narrative");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new NarrativeError(`LLM returned non-JSON: ${content.slice(0, 120)}`, { cause: e });
  }
  const validated = TrackContentSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new NarrativeError(`Track narrative failed schema: ${issues}`);
  }
  return {
    title: validated.data.title,
    haiku: validated.data.haiku,
    body: validated.data.body,
    usage: {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
    },
  };
}

function buildTrackPrompt(input: TrackNarrativeInput): string {
  const m = input.metrics;
  const lines: string[] = [];
  lines.push("Tracking session metrics:");
  lines.push(`- Distance: ${m.distanceKm.toFixed(2)} km`);
  lines.push(`- Duration: ${(m.durationSeconds / 60).toFixed(0)} minutes`);
  lines.push(`- Elevation gain: ${m.elevation.gainM.toFixed(0)} m`);
  lines.push(`- Activity: ${m.activityHint}, route shape: ${m.routeShape}`);
  lines.push(
    `- Average speed: ${m.pace.avgKmh.toFixed(1)} km/h, p95: ${m.pace.p95Kmh.toFixed(1)} km/h`,
  );
  if (input.startPlace) lines.push(`Start: ${input.startPlace}`);
  if (input.endPlace) lines.push(`End: ${input.endPlace}`);
  if (input.midpointPlace) lines.push(`Midpoint: ${input.midpointPlace}`);
  if (input.weatherSummary) lines.push(`Weather: ${input.weatherSummary}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/tracking.test.ts`
Expected: 2 passed.

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 5: Commit**

Commit message:

```
feat(narrative): generateTrackNarrative — LLM track-mode

Third system-prompt variant alongside SYSTEM_PROMPT_WITH_NOTE and
SYSTEM_PROMPT_NO_NOTE. Body cap 1200 chars. Forbids inventing specifics
not present in metrics or place names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.4: `publishTrackPost` — frontmatter + GitHub commit

**Files:**

- Modify: `src/adapters/publish/github-pages.ts`
- Modify: `tests/tracking.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/tracking.test.ts`:

```ts
import { publishTrackPost } from "../src/adapters/publish/github-pages.js";

describe("publishTrackPost", () => {
  test("commits markdown with type:track frontmatter via existing publishPost path", async () => {
    const env = makeTestEnv();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            content: { sha: "abc", path: "_posts/2026-05-02-pch.md", html_url: "x" },
            commit: { sha: "deadbeef" },
          }),
          { status: 200 },
        ),
      );

    const result = await publishTrackPost({
      title: "PCH and back",
      haiku: "a\nb\nc",
      body: "A nice run.",
      metrics: {
        pingCount: 14,
        startedAt: Date.parse("2026-05-02T15:51:30Z"),
        closedAt: Date.parse("2026-05-02T16:24:30Z"),
        durationSeconds: 1980,
        distanceKm: 2.5,
        pace: { avgKmh: 5, p50Kmh: 4, p95Kmh: 12 },
        elevation: { gainM: 35, lossM: 35, minM: 0, maxM: 35 },
        routeShape: "out-and-back",
        activityHint: "mixed",
      },
      endLat: 34.0269,
      endLon: -118.7603,
      endPlace: "Malibu, CA",
      env,
    });

    expect(result.url).toMatch(/trailscribe-journal/);
    const putCall = fetchMock.mock.calls[1];
    const body = JSON.parse((putCall[1]?.body ?? "{}") as string);
    const decoded = atob(body.content);
    expect(decoded).toContain("type: track");
    expect(decoded).toContain("distance_km: 2.5");
    expect(decoded).toContain("route_shape: out-and-back");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/tracking.test.ts`
Expected: fails with "publishTrackPost is not exported".

- [ ] **Step 3: Implement `publishTrackPost`**

In `src/adapters/publish/github-pages.ts`, add this import at the top with the others:

```ts
import type { TrackMetrics } from "../../core/track-metrics.js";
```

Then near the bottom of the file (before `pad2` and `defaultDelay`), add:

```ts
export interface PublishTrackPostArgs {
  title: string;
  haiku: string;
  body: string;
  metrics: TrackMetrics;
  endLat: number;
  endLon: number;
  endPlace?: string;
  weather?: string;
  env: Env;
  delay?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * Track-flavored publish. Same Contents API PUT path as publishPost, but the
 * frontmatter is the track shape (type: track + nested track block) and the
 * dated path uses the session's closedAt timestamp.
 */
export async function publishTrackPost(args: PublishTrackPostArgs): Promise<PublishPostResult> {
  const { title, haiku, body, metrics, endLat, endLon, endPlace, weather, env } = args;
  const now = (args.now ?? (() => new Date(metrics.closedAt)))();
  const delay = args.delay ?? defaultDelay;

  const yyyy = String(now.getUTCFullYear());
  const mm = pad2(now.getUTCMonth() + 1);
  const dd = pad2(now.getUTCDate());

  const baseSlug = slugify(title, now);
  const { path, slug: finalSlug } = await findFreePath(env, env.JOURNAL_POST_PATH_TEMPLATE, {
    yyyy,
    mm,
    dd,
    baseSlug,
  });

  const markdown = renderTrackMarkdown({
    title,
    haiku,
    body,
    metrics,
    endLat,
    endLon,
    endPlace,
    weather,
  });

  const putResp = await putContents(env, path, markdown, title, delay);
  const url = renderUrl(env.JOURNAL_URL_TEMPLATE, { yyyy, mm, dd, slug: finalSlug });
  return { url, path, sha: putResp.commit.sha };
}

function renderTrackMarkdown(a: {
  title: string;
  haiku: string;
  body: string;
  metrics: TrackMetrics;
  endLat: number;
  endLon: number;
  endPlace?: string;
  weather?: string;
}): string {
  const m = a.metrics;
  const lines: string[] = ["---"];
  lines.push(`title: ${quoteYaml(a.title)}`);
  lines.push(`date: ${new Date(m.closedAt).toISOString()}`);
  lines.push(`type: track`);
  lines.push(`track:`);
  lines.push(`  started_at: ${new Date(m.startedAt).toISOString()}`);
  lines.push(`  duration_seconds: ${m.durationSeconds}`);
  lines.push(`  distance_km: ${m.distanceKm.toFixed(2)}`);
  lines.push(`  elevation_gain_m: ${Math.round(m.elevation.gainM)}`);
  lines.push(`  activity_hint: ${m.activityHint}`);
  lines.push(`  route_shape: ${m.routeShape}`);
  lines.push(`  pings: ${m.pingCount}`);
  lines.push(`  close_reason: stop`);
  const place = a.endPlace !== undefined ? `, place: ${quoteYaml(a.endPlace)}` : "";
  lines.push(`location: { lat: ${a.endLat}, lon: ${a.endLon}${place} }`);
  if (a.weather !== undefined) lines.push(`weather: ${quoteYaml(a.weather)}`);
  lines.push(`tags: [trailscribe, track]`);
  lines.push("---");
  lines.push(a.haiku);
  lines.push("");
  lines.push(a.body);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm test tests/tracking.test.ts`
Expected: 3 passed.

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 5: Commit**

Commit message:

```
feat(publish): publishTrackPost — track-shaped journal markdown

Reuses slug derivation, slug-collision handling, and Contents-API
PUT-with-retry machinery. Differs from publishPost only in the
frontmatter renderer (type: track + nested track block) and that the
dated path comes from the session's closedAt rather than now.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.5: `handleStopTrack` orchestrator

**Files:**

- Modify: `src/core/tracking.ts`
- Modify: `tests/tracking.test.ts`

**IMPORTANT — verify upstream API names before implementing:**
Run `grep -n 'export' src/adapters/location/geocode.ts src/adapters/location/weather.ts` to confirm the actual function names. The plan assumes `reverseGeocode(lat, lon, env)` and `fetchWeatherSummary(lat, lon, env)`, but the codebase may use different names. Adjust the imports + calls in this task accordingly.

- [ ] **Step 0: Confirm geocode/weather function names**

Run: `grep -n 'export' src/adapters/location/geocode.ts src/adapters/location/weather.ts`

Note the actual exported function names. Use those in Step 3 instead of `reverseGeocode` / `fetchWeatherSummary` if they differ. The narrative code path doesn't care about the names — only about getting back string place names + a weather summary.

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.ts`:

```ts
import { handleStopTrack } from "../src/core/tracking.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import * as mapshareMod from "../src/adapters/location/mapshare.js";
import * as narrativeMod from "../src/core/narrative.js";
import * as publishMod from "../src/adapters/publish/github-pages.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GarminEvent } from "../src/core/types.js";
import type { TrackSessionRecord } from "../src/core/tracking.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

const FIXTURE_KML_E2E = readFileSync(
  resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml"),
  "utf8",
);

async function sessionIdFor(imei: string, closedAtMs: number): Promise<string> {
  const buf = new TextEncoder().encode(`${imei}:${closedAtMs}`);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("handleStopTrack — end to end", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendReply).mockReset();
    vi.mocked(sendReply).mockResolvedValue({ count: 1 });
  });

  test("fetches KML, generates narrative, publishes, replies, persists record", async () => {
    const env = makeTestEnv();
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "PCH and back",
      haiku: "a\nb\nc",
      body: "Run + beach + return.",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://brockamer.github.io/trailscribe-journal/2026/05/02/pch.html",
      path: "_posts/2026-05-02-pch.md",
      sha: "abc",
    });

    const stopEvent: GarminEvent = {
      imei: "300052030374220",
      messageCode: 12,
      timeStamp: Date.parse("2026-05-02T16:24:30Z"),
    };

    await handleStopTrack(stopEvent, env, "idem-key-1");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
    const replyArgs = vi.mocked(sendReply).mock.calls[0];
    expect(replyArgs[0]).toBe("300052030374220");
    expect(replyArgs[1][0]).toContain("Track posted");
    expect(replyArgs[1][0]).toContain("trailscribe-journal");

    const sessionId = await sessionIdFor("300052030374220", stopEvent.timeStamp);
    const stored = (await env.TS_TRACKS.get(
      `track:300052030374220:${sessionId}`,
      "json",
    )) as TrackSessionRecord;
    expect(stored).not.toBeNull();
    expect(stored.pingCount).toBe(14);
    expect(stored.journalUrl).toBe(
      "https://brockamer.github.io/trailscribe-journal/2026/05/02/pch.html",
    );
  });

  test("empty KML: logs warning, sends 'no breadcrumbs' reply, no publish", async () => {
    const env = makeTestEnv();
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue("<kml/>");
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost");

    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: Date.now() },
      env,
      "idem-key-2",
    );

    expect(publishSpy).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendReply).mock.calls[0][1][0]).toContain("no breadcrumbs");
  });

  test("idempotent on replay: second handleStopTrack call short-circuits", async () => {
    const env = makeTestEnv();
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "x",
      haiku: "a\nb\nc",
      body: "y",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://x",
      path: "p",
      sha: "s",
    });

    const event: GarminEvent = {
      imei: "300052030374220",
      messageCode: 12,
      timeStamp: Date.parse("2026-05-02T16:24:30Z"),
    };

    const { writeRecord } = await import("../src/core/idempotency.js");
    await writeRecord(env, "idem-replay", { status: "received", receivedAt: Date.now() });

    await handleStopTrack(event, env, "idem-replay");
    await handleStopTrack(event, env, "idem-replay");

    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/tracking.test.ts`
Expected: new tests fail with "handleStopTrack is not exported".

- [ ] **Step 3: Implement `handleStopTrack`**

Append to `src/core/tracking.ts` (replacing the geocode/weather imports per Step 0 if names differ):

```ts
import type { GarminEvent } from "./types.js";
import type { TrackMetrics } from "./track-metrics.js";
import { withCheckpoint, sha256Hex } from "./idempotency.js";
import { fetchMapShareKml, parsePings } from "../adapters/location/mapshare.js";
import { computeMetrics } from "./track-metrics.js";
import { generateTrackNarrative } from "./narrative.js";
import { publishTrackPost } from "../adapters/publish/github-pages.js";
import { sendReply } from "../adapters/outbound/garmin-ipc-inbound.js";
import { recordTransaction } from "./ledger.js";
import { log } from "../adapters/logging/worker-logs.js";
// Adjust these two per Step 0 if the actual export names differ:
import { reverseGeocode } from "../adapters/location/geocode.js";
import { fetchWeatherSummary } from "../adapters/location/weather.js";

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Stop Track (mc 12) entry point. Fetches the operator's MapShare KML for the
 * session window, derives metrics, generates an LLM narrative, commits a
 * journal post, persists a record, and replies to the device.
 *
 * Wrapped in withCheckpoint so Garmin webhook retries (or replays) of the
 * same Stop Track event short-circuit on the cached publish result.
 */
export async function handleStopTrack(
  event: GarminEvent,
  env: Env,
  idemKey: string,
): Promise<void> {
  await withCheckpoint(env, idemKey, "publish_track", async () => {
    const closedAt = event.timeStamp;
    const lookbackHours = Number.parseInt(env.TRACK_LOOKBACK_HOURS, 10) || 12;
    const startedAt = closedAt - lookbackHours * MS_PER_HOUR;
    const sessionId = await sha256Hex(`${event.imei}:${closedAt}`);

    const rawKml = await fetchMapShareKml(env, startedAt, closedAt);
    const pings = parsePings(rawKml);

    if (pings.length === 0) {
      log({ event: "track_no_pings", level: "warn", imei: event.imei, idemKey });
      await sendReply(
        event.imei,
        ["Track ended; no breadcrumbs in MapShare for this window."],
        env,
      );
      return { skipped: "no_pings" };
    }

    const metrics = computeMetrics(pings);
    const startPing = pings[0];
    const endPing = pings[pings.length - 1];
    const midPing = pings[Math.floor(pings.length / 2)];

    const [startPlace, endPlace, weather] = await Promise.all([
      reverseGeocode(startPing.lat, startPing.lon, env).catch(() => undefined),
      reverseGeocode(endPing.lat, endPing.lon, env).catch(() => undefined),
      fetchWeatherSummary(midPing.lat, midPing.lon, env).catch(() => undefined),
    ]);

    const narrative = await generateTrackNarrative({
      metrics,
      startPlace: typeof startPlace === "string" ? startPlace : undefined,
      endPlace: typeof endPlace === "string" ? endPlace : undefined,
      weatherSummary: typeof weather === "string" ? weather : undefined,
      env,
    });

    await recordTransaction({
      command: "post",
      usage: narrative.usage,
      env,
    });

    const result = await publishTrackPost({
      title: narrative.title,
      haiku: narrative.haiku,
      body: narrative.body,
      metrics,
      endLat: endPing.lat,
      endLon: endPing.lon,
      endPlace: typeof endPlace === "string" ? endPlace : undefined,
      weather: typeof weather === "string" ? weather : undefined,
      env,
    });

    await storeTrackRecord(env, {
      sessionId,
      imei: event.imei,
      startedAt: metrics.startedAt,
      closedAt: metrics.closedAt,
      closeReason: "stop",
      pingCount: metrics.pingCount,
      distanceKm: metrics.distanceKm,
      elevationGainM: metrics.elevation.gainM,
      durationSeconds: metrics.durationSeconds,
      journalUrl: result.url,
      rawKml,
    });

    await sendReply(event.imei, [formatTrackReply(metrics, result.url)], env);
    return { sessionId, journalUrl: result.url };
  });
}

function formatTrackReply(metrics: TrackMetrics, url: string): string {
  const km = metrics.distanceKm.toFixed(1);
  const gainM = Math.round(metrics.elevation.gainM);
  const minutes = Math.round(metrics.durationSeconds / 60);
  const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}min`;
  return `Track posted: ${km}km, ${gainM}m gain, ${duration}\n${url}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/tracking.test.ts`
Expected: 6 passed.

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 5: Commit**

Commit message:

```
feat(tracking): handleStopTrack orchestrator

Stop Track (mc 12) entry point. withCheckpoint-wrapped:
- fetch MapShare KML for [closedAt - TRACK_LOOKBACK_HOURS, closedAt]
- parse pings, compute metrics, reverse-geocode start/end + fetch weather
- LLM narrative, publish, KV persist, SMS reply
- empty KML degrades to 'no breadcrumbs' SMS, no publish

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.6: Webhook routing — `messageCode === 12` calls `handleStopTrack`

**Files:**

- Modify: `src/app.ts`
- Modify: `tests/app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/app.test.ts`:

```ts
import { handleStopTrack } from "../src/core/tracking.js";

vi.mock("../src/core/tracking.js", () => ({
  handleStopTrack: vi.fn().mockResolvedValue(undefined),
}));

describe("Worker /garmin/ipc — Stop Track routing", () => {
  beforeEach(() => {
    vi.mocked(handleStopTrack).mockReset();
    vi.mocked(handleStopTrack).mockResolvedValue(undefined);
  });

  test("messageCode 12 invokes handleStopTrack", async () => {
    const stopEvent = {
      Version: "4.0",
      Events: [
        {
          imei: "123456789012345",
          messageCode: 12,
          timeStamp: Date.parse("2026-05-02T16:24:30Z"),
          point: { latitude: 0, longitude: 0, altitude: 0, gpsFix: 0, course: 0, speed: 0 },
          status: { autonomous: 0, lowBattery: 0, intervalChange: 0, resetDetected: 0 },
        },
      ],
    };
    const res = await postIpc(stopEvent, { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(handleStopTrack).toHaveBeenCalledTimes(1);
    const args = vi.mocked(handleStopTrack).mock.calls[0];
    expect(args[0].messageCode).toBe(12);
  });

  test("messageCode 10 (Start Track) does NOT invoke handleStopTrack", async () => {
    const startEvent = {
      Version: "4.0",
      Events: [
        {
          imei: "123456789012345",
          messageCode: 10,
          timeStamp: Date.now(),
          point: { latitude: 0, longitude: 0, altitude: 0, gpsFix: 0, course: 0, speed: 0 },
          status: { autonomous: 0, lowBattery: 0, intervalChange: 120, resetDetected: 0 },
        },
      ],
    };
    const res = await postIpc(startEvent, { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(handleStopTrack).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/app.test.ts`
Expected: tests fail (no routing for mc 12 yet).

- [ ] **Step 3: Update `src/app.ts` routing**

Edit `src/app.ts`. Add the import at the top:

```ts
import { handleStopTrack } from "./core/tracking.js";
```

Find the `if (event.messageCode !== 3)` block (around line 118) and modify it:

```ts
if (event.messageCode !== 3) {
  if (event.messageCode === 4) {
    log({ event: "sos_received_ignored", level: "warn", imei: event.imei, key });
  } else if (event.messageCode === 12) {
    try {
      await handleStopTrack(event, env, key);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({
        event: "stop_track_handler_error",
        level: "error",
        imei: event.imei,
        error: msg,
        key,
      });
    }
  } else {
    const isTrack =
      event.messageCode === 0 ||
      event.messageCode === 10 ||
      event.messageCode === 11 ||
      event.messageCode === 12;
    log({
      event: "non_free_text",
      level: "info",
      imei: event.imei,
      messageCode: event.messageCode,
      key,
      ...(isTrack && logTrackPayloads(env) ? { payload: event } : {}),
    });
  }
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/app.test.ts`
Expected: all app tests pass (existing 21 + 2 new).

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all suites pass.

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

Commit message:

```
feat(app): route messageCode 12 to handleStopTrack

Stop Track now triggers the tracking-session-publish pipeline. Other
tracking codes (0, 10, 11) continue to log via the existing non_free_text
path with optional payload capture. Errors from handleStopTrack are
logged at error level but the Worker still returns 200.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

### Task 3.7: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

Run: `git push -u origin <current-branch-name>`

- [ ] **Step 2: Open the PR**

Run gh pr create with title `feat: tracking session artifacts (Mode B — MapShare pull-on-close)` and a body that:

- references the spec at docs/superpowers/specs/2026-05-01-tracking-session-artifacts-design.md (PR #164)
- summarizes the trigger model (mc 12 webhook), data source (MapShare KML), storage (TS_TRACKS KV)
- lists the three cuts and what each delivered
- includes a test plan checklist:
  - [x] all Cut 1 tests pass (mapshare unit tests against real fixture)
  - [x] all Cut 2 tests pass (track-metrics unit tests against real fixture)
  - [x] all Cut 3 tests pass (handleStopTrack integration with mocked LLM/fetch/publish)
  - [x] pnpm typecheck clean, pnpm lint clean, full test suite passes
  - [ ] real-device close-gate (post-merge): deploy to staging, do a brief tracking session, verify a journal post commits with sane metrics, verify the device receives the URL reply

---

## Self-Review

**Spec coverage check:**

- §0 empirical finding: not implemented; informational only.
- §1 goal: covered by full pipeline.
- §2 in-scope: all bullets covered (mc 12 routes, fetch + derive + publish, KV persistence, reply).
- §3 out-of-scope: no tasks added for excluded items.
- §4 IPC + KML data sources: KML covered by Cut 1; IPC mc 12 routing covered in Task 3.6.
- §5.1 Mode B canonical: entire plan is Mode B.
- §5.2 trigger model: Task 3.5 implements.
- §5.3 KV-only storage: Task 3.1 + Task 1.0 cover.
- §5.4 edge cases: empty KML handled in Task 3.5; idempotent replay tested.
- §6.1 webhook ingestion: Task 3.6.
- §6.2 KML adapter: Tasks 1.3-1.5.
- §6.3 metrics: Tasks 2.1-2.7.
- §6.4 narrative: Task 3.3.
- §6.5 journal frontmatter: Task 3.4.
- §6.6 device reply: Task 3.5 (`formatTrackReply`).
- §6.7 idempotency: withCheckpoint in Task 3.5; replay test in 3.5; dup-Stop covered.
- §7 env additions: Task 1.0 (KV) + Task 1.1 (vars + secret).
- §9 test strategy: fixture (Task 1.2), unit tests (Tasks 1.4-1.5, 2.1-2.7), integration (Task 3.5), idempotency (Task 3.5).

**Placeholder scan:** No "TBD"/"TODO"/"similar to" in steps. All code blocks contain real code. All test blocks have full assertions.

**Type consistency check:**

- `KmlPing` defined in Task 1.3, used consistently in 1.4, 2.x, 3.x.
- `TrackMetrics` defined in Task 2.7, imported in narrative.ts (Task 3.3), publishTrackPost (Task 3.4), tracking.ts (Task 3.5).
- `TrackSessionRecord` defined Task 3.1, used in Task 3.5.
- `OpName` extension in Task 3.2 must precede Task 3.5's withCheckpoint use.
- `NarrativeOutput` and `chatCompletion` reused from existing narrative.ts — Task 3.3 uses them as-is.
- Function signatures match across tasks.

**One known fragility:** Task 3.5's tests reference `reverseGeocode` and `fetchWeatherSummary` adapters by name. Task 3.5 Step 0 explicitly calls out verifying the actual export names before implementing. The narrative path doesn't care about names — only that strings come back.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-03-tracking-session-artifacts.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
