import type { Env } from "../env.js";
import { IDEMPOTENCY_TTL_SECONDS } from "./idempotency.js";

/**
 * Marker for an in-flight, already-paid-for Replicate prediction.
 *
 * Serves two distinct jobs, both introduced by #235:
 *
 * 1. **Resume.** If an invocation dies or is retried before the `image`
 *    checkpoint lands, the next one polls the prediction already bought
 *    instead of buying a second at ~$0.10. Hence the 48h TTL, matching the
 *    idempotency record's — a marker that expired first would let a late
 *    Garmin retry pay twice.
 *
 * 2. **Concurrency lease.** `!postimg` can hold the webhook open for up to
 *    150s while polling, which is longer than Garmin is known to tolerate
 *    (~71s observed) before redelivering. `withCheckpoint` is read-then-write
 *    with no lock, so a redelivery landing mid-poll would run the pipeline
 *    concurrently and could produce two journal posts and two SMS for one
 *    command. `startedAt` lets the webhook drop such a redelivery.
 *
 * The lease is deliberately gated on THIS marker rather than on the
 * idempotency record's `processing` status: that status cannot distinguish
 * "still running" from "died partway", so leasing on it would suppress the
 * legitimate partial-progress replays that P1-16 depends on.
 */
export interface PendingPrediction {
  predictionId: string;
  getUrl: string;
  /** ms epoch when the prediction was created — the lease clock. */
  startedAt: number;
}

/**
 * How long a fresh marker suppresses a redelivery. Must exceed the image poll
 * budget (150s) so a Garmin retry lands inside the lease rather than racing
 * the first invocation.
 */
export const IMAGE_LEASE_MS = 180_000;

const pendingKey = (idemKey: string) => `imgpend:${idemKey}`;

export async function readPendingPrediction(
  env: Env,
  idemKey: string,
): Promise<PendingPrediction | undefined> {
  try {
    const raw = await env.TS_IDEMPOTENCY.get(pendingKey(idemKey));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PendingPrediction).predictionId === "string" &&
      typeof (parsed as PendingPrediction).getUrl === "string"
    ) {
      const p = parsed as PendingPrediction;
      return { ...p, startedAt: typeof p.startedAt === "number" ? p.startedAt : 0 };
    }
  } catch {
    // An unreadable marker is not worth failing the command over; the worst
    // case is one duplicate generation.
  }
  return undefined;
}

export async function writePendingPrediction(
  env: Env,
  idemKey: string,
  value: { predictionId: string; getUrl: string },
): Promise<void> {
  try {
    const record: PendingPrediction = { ...value, startedAt: Date.now() };
    await env.TS_IDEMPOTENCY.put(pendingKey(idemKey), JSON.stringify(record), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  } catch {
    // Best-effort: losing this costs at most one duplicate generation.
  }
}

export async function clearPendingPrediction(env: Env, idemKey: string): Promise<void> {
  try {
    await env.TS_IDEMPOTENCY.delete(pendingKey(idemKey));
  } catch {
    // The TTL will reap it.
  }
}

/** True while an image generation for this key is in flight and un-expired. */
export async function imageGenerationInFlight(env: Env, idemKey: string): Promise<boolean> {
  const pending = await readPendingPrediction(env, idemKey);
  if (pending === undefined) return false;
  return Date.now() - pending.startedAt < IMAGE_LEASE_MS;
}
