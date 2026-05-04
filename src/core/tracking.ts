import type { Env } from "../env.js";
import { putJSON } from "../adapters/storage/kv.js";
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

const TRACK_RECORD_TTL_SECONDS = 60 * 60 * 24 * 365;
const MS_PER_HOUR = 60 * 60 * 1000;

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
  // Single coarse checkpoint per spec §6.1 — trades partial-failure granularity
  // (we re-run the LLM if anything after publishTrackPost fails) for simpler
  // reasoning about publish_track being all-or-nothing. See commands/post.ts for
  // the per-op pattern used by !post; the divergence is intentional, not drift.
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
    return { sessionId, journalUrl: result.url };
  });
}

function formatTrackReply(metrics: TrackMetrics, url: string): string {
  const km = metrics.distanceKm.toFixed(1);
  const gainM = Math.round(metrics.elevation.gainM);
  const minutes = Math.round(metrics.durationSeconds / 60);
  const duration =
    minutes >= 60
      ? `${Math.floor(minutes / 60)}h${minutes % 60}m`
      : `${minutes}min`;
  return `Track posted: ${km}km, ${gainM}m gain, ${duration}\n${url}`;
}
