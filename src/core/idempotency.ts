import { z } from "zod";
import type { Env } from "../env.js";
import type { GarminEvent } from "./types.js";
import { getJSON, putJSON } from "../adapters/storage/kv.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Idempotency key derivation (PRD §5).
 *
 * Garmin's IPC Outbound schema has no `msgId`; we derive a composite key from
 * fields the device never duplicates within the retry window:
 *
 *   key = sha256( imei || ":" || timeStamp || ":" || messageCode || ":" || sha256(freeText||payload||"") )
 *
 * TTL on the KV entry is 48h — covers Garmin's fast-retry window (128s plateau)
 * and typical user manual retries with room to spare.
 */
export async function idempotencyKey(event: GarminEvent): Promise<string> {
  const content = event.freeText ?? event.payload ?? "";
  const contentHash = await sha256Hex(content);
  return sha256Hex(`${event.imei}:${event.timeStamp}:${event.messageCode}:${contentHash}`);
}

/** TTL (seconds) on idempotency KV entries — PRD §5. */
export const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 48;

/** Hex-encoded SHA-256 via Web Crypto (available in Workers + Node 20+). */
export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Op names recognized by `withCheckpoint`. Locked to the α-MVP side-effecting
 * steps so a typo doesn't silently create a new bucket. Add to this union as
 * new ops appear (e.g. P3 `!camp`).
 */
export type OpName = "narrative" | "publish" | "mail" | "todo" | "reply";

/**
 * Message-lifecycle record stored under `idem:<key>` (PRD §5).
 *
 *   received   — webhook accepted, before any side effects.
 *   processing — at least one op started; intermediate state during a single
 *                request lifecycle. Phase 0/1 don't write this directly; it's
 *                reserved for replay scenarios where the worker died mid-flight.
 *   completed  — terminal success. Replay short-circuits with no side effects.
 *   failed     — terminal failure. Replay re-runs missing ops via withCheckpoint.
 */
export const IdempotencyRecordSchema = z.object({
  status: z.enum(["received", "processing", "completed", "failed"]),
  receivedAt: z.number(),
  completedOps: z.array(z.string()).optional(),
  opResults: z.record(z.unknown()).optional(),
  completedAt: z.number().optional(),
  failedAt: z.number().optional(),
  error: z.string().optional(),
});

export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

const kvKeyOf = (idemKey: string) => `idem:${idemKey}`;

/**
 * Read and zod-validate the record at `idem:<idemKey>`. Returns null if absent
 * or if the stored shape fails validation (logged as `warn`). Treating shape
 * drift as "absent" lets the next write reset the record cleanly — worst case
 * one transaction's ops re-run after a deploy that changes the schema.
 */
export async function readRecord(env: Env, idemKey: string): Promise<IdempotencyRecord | null> {
  const raw = await getJSON<unknown>(env.TS_IDEMPOTENCY, kvKeyOf(idemKey));
  if (raw === null) return null;
  const parsed = IdempotencyRecordSchema.safeParse(raw);
  if (!parsed.success) {
    log({
      event: "idempotency_record_invalid",
      level: "warn",
      key: idemKey,
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return null;
  }
  return parsed.data;
}

/** Write a record back to KV with the standard 48h TTL. */
export async function writeRecord(
  env: Env,
  idemKey: string,
  record: IdempotencyRecord,
): Promise<void> {
  await putJSON(env.TS_IDEMPOTENCY, kvKeyOf(idemKey), record, {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
}

/**
 * Wrap a side-effecting op so it runs at most once per idempotency key.
 *
 * On first call: invoke `fn`, JSON-serializability-test the result, append
 * `opName` to `completedOps`, store the result in `opResults[opName]`, write
 * back, return the result.
 *
 * On replay: if `opName` is already in `completedOps`, return the cached
 * result without invoking `fn`. The cached value is the same object shape `fn`
 * originally returned (after a JSON round-trip — see plain-language note).
 *
 * If `fn` throws, the record is NOT updated — the next replay will retry the op.
 *
 * **Plain-language note.** Cloudflare KV stores strings; we JSON-stringify on
 * write and JSON.parse on read. So a cached `Date` comes back as an ISO string,
 * a `Map` comes back as `{}`, and circular refs throw on stringify. The
 * serializability check (`JSON.stringify` + `JSON.parse` round-trip) makes a
 * non-serializable return value a hard error at the *first* call, instead of a
 * silent corruption discovered during a 3am replay storm.
 */
export async function withCheckpoint<T>(
  env: Env,
  idemKey: string,
  opName: OpName,
  fn: () => Promise<T>,
): Promise<T> {
  const record = await readRecord(env, idemKey);

  if (record && record.completedOps?.includes(opName)) {
    return record.opResults?.[opName] as T;
  }

  const result = await fn();

  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `withCheckpoint: op "${opName}" returned non-JSON-serializable value (${msg}). ` +
        `Cloudflare KV cannot store circular refs, BigInts, or functions; ` +
        `narrow the return type before checkpointing.`,
      { cause: err },
    );
  }
  if (serialized === undefined) {
    throw new Error(
      `withCheckpoint: op "${opName}" returned undefined or a value that JSON.stringify ` +
        `dropped (e.g. function, symbol). Return null for "no result" instead.`,
    );
  }
  // Round-trip so the in-memory value matches what a future replay will see.
  const roundTripped = JSON.parse(serialized) as T;

  const base: IdempotencyRecord = record ?? {
    status: "processing",
    receivedAt: Date.now(),
  };
  const next: IdempotencyRecord = {
    ...base,
    status: base.status === "completed" ? "completed" : "processing",
    completedOps: [...(base.completedOps ?? []), opName],
    opResults: { ...(base.opResults ?? {}), [opName]: roundTripped },
  };
  await writeRecord(env, idemKey, next);

  return roundTripped;
}

/** Mark the record as terminally failed. Idempotent — safe to call repeatedly. */
export async function markFailed(env: Env, idemKey: string, error: string): Promise<void> {
  const existing = await readRecord(env, idemKey);
  const next: IdempotencyRecord = {
    status: "failed",
    receivedAt: existing?.receivedAt ?? Date.now(),
    completedOps: existing?.completedOps,
    opResults: existing?.opResults,
    failedAt: Date.now(),
    error,
  };
  await writeRecord(env, idemKey, next);
}

/** Mark the record as terminally completed. */
export async function markCompleted(env: Env, idemKey: string): Promise<void> {
  const existing = await readRecord(env, idemKey);
  const next: IdempotencyRecord = {
    status: "completed",
    receivedAt: existing?.receivedAt ?? Date.now(),
    completedOps: existing?.completedOps,
    opResults: existing?.opResults,
    completedAt: Date.now(),
  };
  await writeRecord(env, idemKey, next);
}
