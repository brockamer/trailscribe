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
export async function storeTrackRecord(
  env: Env,
  record: TrackSessionRecord,
): Promise<void> {
  const key = `track:${record.imei}:${record.sessionId}`;
  await putJSON(env.TS_TRACKS, key, record, {
    expirationTtl: TRACK_RECORD_TTL_SECONDS,
  });
}
