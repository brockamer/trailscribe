import type { Env } from "../env.js";
import { getJSON, putJSON } from "../adapters/storage/kv.js";
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
import { reverseGeocode } from "../adapters/location/geocode.js";
import { currentWeather } from "../adapters/location/weather.js";
import { kmToMi, mToFt } from "./units.js";

const TRACK_RECORD_TTL_SECONDS = 60 * 60 * 24 * 365;
const TRACK_START_TTL_SECONDS = 60 * 60 * 24;

interface TrackStartRecord {
  startedAt: number;
}

const trackStartKey = (imei: string): string => `track_start:${imei}`;

/**
 * Record an open tracking session's start timestamp (from a Garmin mc 10
 * "Start Track" event). The companion mc 12 "Stop Track" handler reads this
 * to set the MapShare KML query's `d1` lower bound, so each closed session
 * pulls only its own breadcrumbs instead of an ambiguous lookback window.
 *
 * 24h TTL covers any reasonable session length while ensuring stale starts
 * (e.g. battery died mid-session, never sent mc 12) don't bleed into the
 * next session.
 */
export async function recordSessionStart(
  env: Env,
  imei: string,
  startedAt: number,
): Promise<void> {
  await putJSON(env.TS_TRACKS, trackStartKey(imei), { startedAt }, {
    expirationTtl: TRACK_START_TTL_SECONDS,
  });
}

/** Read the current open-session start timestamp for an IMEI, or null. */
export async function readSessionStart(
  env: Env,
  imei: string,
): Promise<TrackStartRecord | null> {
  return getJSON<TrackStartRecord>(env.TS_TRACKS, trackStartKey(imei));
}

/**
 * Delete the open-session start record after a successful Stop Track flow.
 * Idempotent — KV.delete is a no-op on missing keys.
 */
export async function clearSessionStart(env: Env, imei: string): Promise<void> {
  await env.TS_TRACKS.delete(trackStartKey(imei));
}

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
export async function storeTrackRecord(
  env: Env,
  record: TrackSessionRecord,
): Promise<void> {
  const key = `track:${record.imei}:${record.sessionId}`;
  await putJSON(env.TS_TRACKS, key, record, {
    expirationTtl: TRACK_RECORD_TTL_SECONDS,
  });
}

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
  // Outer `publish_track` checkpoint owns the all-or-nothing publish lifecycle
  // (publish + store + reply) per spec §6.1. Inner `track_narrative` checkpoint
  // (added per #172) bounds LLM cost on deterministic-failure retries: after a
  // successful narrative call, a downstream publish/reply failure won't burn
  // another Sonnet call when Garmin retries the webhook (2/4/8/16/32/64/128s
  // then 12h × 5d). Mirrors the per-op pattern in commands/post.ts.
  await withCheckpoint(env, idemKey, "publish_track", async () => {
    const closedAt = event.timeStamp;
    // The session window is bounded by a recorded mc 10 (Start Track) only.
    // Lookback fallback was removed — it produced wrong narratives by pulling
    // unrelated breadcrumbs (e.g. a 100km drive earlier in the day) when a
    // Stop arrived without a preceding Start (operator pressed Stop twice,
    // device emitted Stop on its own, or Iridium delivered Stop before Start).
    const startRecord = await readSessionStart(env, event.imei);
    if (!startRecord) {
      log({
        event: "track_stop_no_active_session",
        level: "warn",
        imei: event.imei,
        idemKey,
        closedAt,
      });
      await sendReply(
        event.imei,
        ["Track ended; no active session was recorded — nothing to publish."],
        env,
      );
      return { skipped: "no_active_session" };
    }
    const startedAt = startRecord.startedAt;
    log({
      event: "track_session_window",
      level: "info",
      imei: event.imei,
      startedAt,
      closedAt,
    });
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

    // Single-ping session: there is no segment to summarise. Distance is
    // mathematically zero (Haversine needs two points), duration collapses
    // (startedAt == closedAt from the one ping's timestamp), and `paceStats`
    // would return the single ping's velocity as the avg / p50 / p95 — all
    // technically true, but enough to drive an LLM toward a "session"
    // narrative built around a single moment. We refuse to publish.
    //
    // Root cause is upstream: Mini 3 Plus auto-extends the tracking interval
    // when it detects no motion (we've observed mc=11 events with
    // status.intervalChange=14400, i.e. 4-hour interval), so a short session
    // can leave MapShare with one ingested breadcrumb (or zero) by the time
    // mc 12 arrives.
    if (pings.length === 1) {
      log({
        event: "track_too_brief",
        level: "warn",
        imei: event.imei,
        idemKey,
        pingCount: 1,
      });
      await sendReply(
        event.imei,
        ["Track too brief — 1 breadcrumb. Try longer or move sooner after Start."],
        env,
      );
      return { skipped: "too_brief" };
    }

    const metrics = computeMetrics(pings);
    const startPing = pings[0];
    const endPing = pings[pings.length - 1];
    const midPing = pings[Math.floor(pings.length / 2)];

    const [startSettled, endSettled, weatherSettled] = await Promise.allSettled([
      reverseGeocode(startPing.lat, startPing.lon, env),
      reverseGeocode(endPing.lat, endPing.lon, env),
      currentWeather(midPing.lat, midPing.lon, env),
    ]);

    const startPlace = startSettled.status === "fulfilled" ? startSettled.value : undefined;
    const endPlace = endSettled.status === "fulfilled" ? endSettled.value : undefined;
    const weather = weatherSettled.status === "fulfilled" ? weatherSettled.value : undefined;

    if (startSettled.status === "rejected") {
      log({ event: "track_enrichment_failed", level: "warn", kind: "geocode_start", imei: event.imei, error: String(startSettled.reason) });
    }
    if (endSettled.status === "rejected") {
      log({ event: "track_enrichment_failed", level: "warn", kind: "geocode_end", imei: event.imei, error: String(endSettled.reason) });
    }
    if (weatherSettled.status === "rejected") {
      log({ event: "track_enrichment_failed", level: "warn", kind: "weather", imei: event.imei, error: String(weatherSettled.reason) });
    }

    const narrative = await withCheckpoint(env, idemKey, "track_narrative", () =>
      generateTrackNarrative({
        metrics,
        startPlace: typeof startPlace === "string" ? startPlace : undefined,
        endPlace: typeof endPlace === "string" ? endPlace : undefined,
        weatherSummary: typeof weather === "string" ? weather : undefined,
        env,
      }),
    );

    await recordTransaction({
      command: "track",
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
      startPlace: typeof startPlace === "string" ? startPlace : undefined,
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
    // Clear the start marker so the next Stop Track without a fresh mc 10
    // falls back to the lookback heuristic rather than re-using this session.
    await clearSessionStart(env, event.imei);
    return { sessionId, journalUrl: result.url };
  });
}

function formatTrackReply(metrics: TrackMetrics, url: string): string {
  const mi = kmToMi(metrics.distanceKm).toFixed(1);
  const gainFt = Math.round(mToFt(metrics.elevation.gainM));
  const minutes = Math.round(metrics.durationSeconds / 60);
  const duration =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h${minutes % 60}m`
      : `${minutes}min`;
  return `Track posted: ${mi}mi, ${gainFt}ft gain, ${duration}\n${url}`;
}
