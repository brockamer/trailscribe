import type { Env } from "../env.js";
import { getJSON, putJSON } from "../adapters/storage/kv.js";
import { log } from "../adapters/logging/worker-logs.js";

const DAILY_TTL_SECONDS = 60 * 60 * 24 * 8;

export interface LedgerUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface LedgerEntry {
  command: string;
  usage: LedgerUsage;
  env: Env;
}

export interface LedgerSnapshot {
  period: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  usd_cost: number;
  by_command: Record<string, { requests: number; usd_cost: number }>;
  last_update_ms: number;
  /**
   * Image-gen aggregates (P2-17). Optional for backwards compat with
   * snapshots written before P2-17 deployed — readers default to 0 via `?? 0`.
   * `recordImageTransaction` updates only these fields; existing text
   * accounting (`requests`, `usd_cost`, `by_command`) is untouched.
   */
  image_requests?: number;
  image_usd_cost?: number;
}

/** Image-gen ledger entry — usdCost is provider-quoted, no token math. */
export interface ImageLedgerEntry {
  command: string;
  usdCost: number;
  env: Env;
}

/**
 * Record one command transaction. Writes both the monthly and the daily KV
 * rollups under `ledger:<YYYY-MM>` and `ledger:<YYYY-MM-DD>`.
 *
 * Read-modify-write per key. KV is eventually consistent, so concurrent
 * writers can lose updates; at α volume (single-operator, < 1 msg/sec) this
 * doesn't happen in practice. Phase 3 migrates to D1 for transactional
 * updates. The monthly write is the source of truth for `!cost`; the daily
 * write is best-effort and feeds the budget gate (P1-14) — daily-write
 * failures are logged but do not throw.
 */
export async function recordTransaction(entry: LedgerEntry): Promise<{ usd_cost: number }> {
  const usd_cost = computeCost(entry.usage, entry.env);
  const now = Date.now();
  const yyyymm = formatMonth(now);
  const yyyymmdd = formatDay(now);

  await applyToRollup(entry.env, `ledger:${yyyymm}`, yyyymm, entry, usd_cost, now);
  try {
    await applyToRollup(entry.env, `ledger:${yyyymmdd}`, yyyymmdd, entry, usd_cost, now, {
      expirationTtl: DAILY_TTL_SECONDS,
    });
  } catch (e) {
    log({
      event: "ledger_daily_write_failed",
      level: "warn",
      period: yyyymmdd,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return { usd_cost };
}

/**
 * Record one image-gen transaction (P2-17). Writes to the same monthly +
 * daily ledger keys but updates only the image aggregates, leaving text
 * fields alone so existing `!cost` semantics are unaffected. P2-18's `!cost`
 * formatter consumes both axes for the breakout reply.
 */
export async function recordImageTransaction(
  entry: ImageLedgerEntry,
): Promise<{ usd_cost: number }> {
  const usd_cost = entry.usdCost;
  const now = Date.now();
  const yyyymm = formatMonth(now);
  const yyyymmdd = formatDay(now);

  await applyImageToRollup(entry.env, `ledger:${yyyymm}`, yyyymm, usd_cost, now);
  try {
    await applyImageToRollup(entry.env, `ledger:${yyyymmdd}`, yyyymmdd, usd_cost, now, {
      expirationTtl: DAILY_TTL_SECONDS,
    });
  } catch (e) {
    log({
      event: "ledger_daily_write_failed",
      level: "warn",
      period: yyyymmdd,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return { usd_cost };
}

export async function monthlyTotals(env: Env, yyyymm?: string): Promise<LedgerSnapshot> {
  const period = yyyymm ?? formatMonth(Date.now());
  return readRollup(env, `ledger:${period}`, period);
}

export async function dailyTotals(env: Env, yyyymmdd?: string): Promise<LedgerSnapshot> {
  const period = yyyymmdd ?? formatDay(Date.now());
  return readRollup(env, `ledger:${period}`, period);
}

async function applyToRollup(
  env: Env,
  key: string,
  period: string,
  entry: LedgerEntry,
  usd_cost: number,
  now: number,
  opts?: { expirationTtl?: number },
): Promise<void> {
  const existing = await getJSON<LedgerSnapshot>(env.TS_LEDGER, key);
  const updated = mergeEntry(existing ?? emptySnapshot(period), entry, usd_cost, now);
  await putJSON(env.TS_LEDGER, key, updated, opts);
}

async function applyImageToRollup(
  env: Env,
  key: string,
  period: string,
  usd_cost: number,
  now: number,
  opts?: { expirationTtl?: number },
): Promise<void> {
  const existing = await getJSON<LedgerSnapshot>(env.TS_LEDGER, key);
  const base = existing ?? emptySnapshot(period);
  const updated: LedgerSnapshot = {
    ...base,
    image_requests: (base.image_requests ?? 0) + 1,
    image_usd_cost: (base.image_usd_cost ?? 0) + usd_cost,
    last_update_ms: now,
  };
  await putJSON(env.TS_LEDGER, key, updated, opts);
}

async function readRollup(env: Env, key: string, period: string): Promise<LedgerSnapshot> {
  const existing = await getJSON<LedgerSnapshot>(env.TS_LEDGER, key);
  return existing ?? emptySnapshot(period);
}

function mergeEntry(
  snap: LedgerSnapshot,
  entry: LedgerEntry,
  usd_cost: number,
  now: number,
): LedgerSnapshot {
  const byCmd = { ...snap.by_command };
  const cur = byCmd[entry.command] ?? { requests: 0, usd_cost: 0 };
  byCmd[entry.command] = {
    requests: cur.requests + 1,
    usd_cost: cur.usd_cost + usd_cost,
  };
  return {
    period: snap.period,
    requests: snap.requests + 1,
    prompt_tokens: snap.prompt_tokens + entry.usage.prompt_tokens,
    completion_tokens: snap.completion_tokens + entry.usage.completion_tokens,
    usd_cost: snap.usd_cost + usd_cost,
    by_command: byCmd,
    last_update_ms: now,
    // Preserve image aggregates across text writes (P2-17 backwards compat).
    image_requests: snap.image_requests,
    image_usd_cost: snap.image_usd_cost,
  };
}

function emptySnapshot(period: string): LedgerSnapshot {
  return {
    period,
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    usd_cost: 0,
    by_command: {},
    last_update_ms: 0,
  };
}

function computeCost(usage: LedgerUsage, env: Env): number {
  const inPer1k = Number.parseFloat(env.LLM_INPUT_COST_PER_1K) || 0;
  const outPer1k = Number.parseFloat(env.LLM_OUTPUT_COST_PER_1K) || 0;
  return (inPer1k * usage.prompt_tokens) / 1000 + (outPer1k * usage.completion_tokens) / 1000;
}

function formatMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
