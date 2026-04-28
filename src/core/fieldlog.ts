import type { Env } from "../env.js";
import { getJSON, putJSON } from "../adapters/storage/kv.js";

const FIELDLOG_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_ENTRIES = 100;

/**
 * One journal entry in the per-IMEI FieldLog. Written by `!drop` (P2-05);
 * read + aggregated by `!brief` (P2-06). `source` is reserved so `!post`
 * (or `!postimg`) titles can optionally fold into `!brief` later without a
 * schema migration.
 */
export interface FieldLogEntry {
  id: string;
  ts: number;
  lat?: number;
  lon?: number;
  note: string;
  source: "drop" | "post";
}

export interface GetEntriesOptions {
  /** Lower bound (inclusive) on `ts` in ms-epoch. */
  since?: number;
  /** Cap the result to the most-recent `limit` entries within the window. */
  limit?: number;
}

/**
 * Append an entry to the per-IMEI FieldLog under `fieldlog:<imei>`.
 *
 * Bounded at MAX_ENTRIES with FIFO eviction (oldest dropped first), so a
 * long-running operator never blows past KV's per-key size limit.
 *
 * Idempotency: if an entry with the same `id` already exists, the call is a
 * no-op. This matches the orchestrator's event-level idempotency key so
 * Garmin retry storms (P1-13 `withCheckpoint` is the primary guard; this is
 * defense-in-depth at the storage layer) do not produce duplicate journal
 * entries.
 *
 * Read-modify-write per call. KV is eventually consistent; same caveat as
 * context.ts and the ledger — at α volume (single operator, < 1 msg/sec) this
 * doesn't bite. Phase 3 (#99) migrates to D1 for transactional updates.
 */
export async function appendEntry(env: Env, imei: string, entry: FieldLogEntry): Promise<void> {
  const key = `fieldlog:${imei}`;
  const existing = (await getJSON<FieldLogEntry[]>(env.TS_CONTEXT, key)) ?? [];

  if (existing.some((e) => e.id === entry.id)) {
    return;
  }

  const next = [...existing, entry].slice(-MAX_ENTRIES);
  await putJSON(env.TS_CONTEXT, key, next, { expirationTtl: FIELDLOG_TTL_SECONDS });
}

/**
 * Return entries for `imei` in chronological order (oldest first).
 *
 * `since` filters by `ts >= since`; `limit` caps to the most-recent N entries
 * within that window (still returned oldest-first). A cold IMEI returns `[]`.
 */
export async function getEntries(
  env: Env,
  imei: string,
  opts: GetEntriesOptions = {},
): Promise<FieldLogEntry[]> {
  const key = `fieldlog:${imei}`;
  const stored = (await getJSON<FieldLogEntry[]>(env.TS_CONTEXT, key)) ?? [];

  let filtered = stored;
  if (opts.since !== undefined) {
    filtered = filtered.filter((e) => e.ts >= opts.since!);
  }
  if (opts.limit !== undefined && filtered.length > opts.limit) {
    filtered = filtered.slice(-opts.limit);
  }
  return filtered;
}
