import type { Env } from "../env.js";
import type { ParsedCommand } from "./types.js";
import { getJSON, putJSON } from "../adapters/storage/kv.js";

const CONTEXT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_EVENTS = 5;

/**
 * Per-event record stored in the rolling context window. Lat/lon optional —
 * events arriving with no GPS fix omit them per the P1-01 guard.
 */
export interface ContextEvent {
  timestamp: number;
  lat?: number;
  lon?: number;
  command_type: ParsedCommand["type"];
  free_text: string;
}

/**
 * Append an event to the per-IMEI rolling cache. Drops the oldest entry once
 * the window exceeds 5 events. KV TTL of 30 days is reset on every append, so
 * an active device's history stays fresh while a long-quiet device naturally
 * expires.
 *
 * Read-modify-write per call. Same eventually-consistent caveat as the ledger
 * (P1-11): concurrent writers can lose updates, but at α volume (single
 * operator, < 1 msg/sec) this doesn't happen in practice.
 */
export async function appendEvent(imei: string, event: ContextEvent, env: Env): Promise<void> {
  const key = `ctx:${imei}`;
  const existing = (await getJSON<ContextEvent[]>(env.TS_CONTEXT, key)) ?? [];
  const next = [...existing, event].slice(-MAX_EVENTS);
  await putJSON(env.TS_CONTEXT, key, next, { expirationTtl: CONTEXT_TTL_SECONDS });
}

/**
 * Return the most-recent up-to-5 events for `imei`, newest-first. Cold IMEIs
 * (never stored) return `[]` — callers don't write null-checks.
 */
export async function recentEvents(imei: string, env: Env): Promise<ContextEvent[]> {
  const key = `ctx:${imei}`;
  const stored = (await getJSON<ContextEvent[]>(env.TS_CONTEXT, key)) ?? [];
  return [...stored].reverse();
}
