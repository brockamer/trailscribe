import type { Env } from "../env.js";
import { IDEMPOTENCY_TTL_SECONDS } from "./idempotency.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Job record for work that finishes in a provider callback (#268, spec §6).
 *
 * Written ONCE, after the provider job exists, so every record carries a paid
 * `predictionId`. Cloudflare KV allows one write per second per key; a write
 * before and another after the create call would collide, and a record with
 * no `predictionId` could not be matched by the callback or act as a lease.
 *
 * **Lease (replaces the 180 s window of the old in-flight image marker).** While a
 * record exists, a Garmin re-delivery of the same event is skipped at any age:
 * the record means a picture is paid for, and a second one must never be
 * bought. The old lease needed a time window because `!postimg` held Garmin's
 * request open past its ~71 s re-delivery point while polling; now Garmin has
 * its answer in ~10 s, the poll is gone, and the only remaining question is
 * "is a paid job outstanding?". A job whose callback is lost stays outstanding
 * until the 48 h TTL; the operator resends (decision 4 in the spec).
 */

export interface PostImgJob {
  kind: "postimg";
  imei: string;
  /** ms epoch when the record was written. */
  createdAt: number;
  predictionId: string;
  /** ms epoch; set by the callback just before the finish runs. */
  finishStartedAt?: number;
  caption?: string;
  narrative: { title: string; haiku: string; body: string };
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
}

/** Union of job kinds; `!postvid` (#246) adds a member. */
export type Job = PostImgJob;

/** A second callback inside this window after a finish started is a duplicate. */
export const FINISH_LEASE_MS = 120_000;

const jobKey = (idemKey: string) => `job:${idemKey}`;

/** Write the job record. Throws on KV failure; the caller falls back to text-only. */
export async function writeJob(env: Env, idemKey: string, job: Job): Promise<void> {
  await env.TS_IDEMPOTENCY.put(jobKey(idemKey), JSON.stringify(job), {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
}

/** Read the job record. A corrupt or incomplete record reads as absent. */
export async function readJob(env: Env, idemKey: string): Promise<Job | undefined> {
  let raw: string | null;
  try {
    raw = await env.TS_IDEMPOTENCY.get(jobKey(idemKey));
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<PostImgJob>;
    if (
      p.kind === "postimg" &&
      typeof p.imei === "string" &&
      typeof p.predictionId === "string" &&
      typeof p.createdAt === "number" &&
      typeof p.narrative?.title === "string" &&
      typeof p.narrative?.body === "string"
    ) {
      return p as PostImgJob;
    }
  } catch {
    // fall through
  }
  log({ event: "job_record_unreadable", level: "warn", key: idemKey });
  return undefined;
}

/** Delete the job record. Best-effort: the TTL reaps a leftover. */
export async function deleteJob(env: Env, idemKey: string): Promise<void> {
  try {
    await env.TS_IDEMPOTENCY.delete(jobKey(idemKey));
  } catch {
    // TTL reaps it.
  }
}

/**
 * Record that a finish has started. Best-effort: on a prediction that failed
 * within a second this write can hit the per-key rate limit, and the
 * checkpoints still stop a sequential duplicate.
 */
export async function markFinishStarted(
  env: Env,
  idemKey: string,
  job: Job,
  now: number = Date.now(),
): Promise<void> {
  try {
    await writeJob(env, idemKey, { ...job, finishStartedAt: now });
  } catch (e) {
    log({
      event: "job_finish_mark_failed",
      level: "warn",
      key: idemKey,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** True when another callback started a finish less than `FINISH_LEASE_MS` ago. */
export function finishInProgress(job: Job, now: number = Date.now()): boolean {
  return job.finishStartedAt !== undefined && now - job.finishStartedAt < FINISH_LEASE_MS;
}

/** True while a paid job is outstanding for this event: skip a Garmin re-delivery. */
export async function jobBlocksRedelivery(env: Env, idemKey: string): Promise<boolean> {
  return (await readJob(env, idemKey)) !== undefined;
}
