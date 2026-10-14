import type { Env } from "./env.js";
import { verifyReplicateWebhook } from "./adapters/ai/replicate-webhook.js";
import { isTerminalStatus, type ReplicatePrediction } from "./adapters/ai/replicate.js";
import { deleteJob, finishInProgress, markFinishStarted, readJob, type Job } from "./core/jobs.js";
import { markFailed, readRecord } from "./core/idempotency.js";
import { deliverCommandResult } from "./core/delivery.js";
import { finishPostImg } from "./core/commands/postimg.js";
import { log } from "./adapters/logging/worker-logs.js";

/**
 * `POST /replicate/callback?key=<idemKey>` (#268, spec §5.2 and §8).
 *
 * Replicate retries the terminal webhook on any 4xx/5xx for about a minute,
 * so the answer is the control: 503 = "try again" (state not visible yet),
 * 200 = "stop" (done, duplicate, or not ours), 401 = bad signature. The
 * finish runs after the 200, inside `waitUntil` (30 s), because Replicate
 * wants an answer within a few seconds and the finish takes about 6 s.
 */
export async function handleReplicateCallback(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  opts: { now?: () => number } = {},
): Promise<Response> {
  const now = opts.now ?? Date.now;
  const rawBody = await request.text();

  const verdict = await verifyReplicateWebhook(request.headers, rawBody, env, { now });
  if (!verdict.ok) {
    log({ event: "replicate_signature_failed", level: "warn", reason: verdict.reason });
    return verdict.reason === "secret_unavailable"
      ? new Response("retry", { status: 503 })
      : new Response("unauthorized", { status: 401 });
  }

  const key = new URL(request.url).searchParams.get("key");
  const prediction = parsePrediction(rawBody);
  log({
    event: "replicate_signature_ok",
    level: "info",
    key,
    predictionId: prediction?.id ?? null,
  });
  log({
    event: "replicate_callback",
    level: "info",
    key,
    predictionId: prediction?.id ?? null,
    status: prediction?.status ?? null,
    predictTime: prediction?.metrics?.predict_time ?? null,
    rawBodySample: rawBody.slice(0, 2048),
  });

  if (key === null || key.length === 0) return ignored("no_key", key);
  if (prediction === undefined) return ignored("bad_body", key);
  if (!isTerminalStatus(prediction.status)) return ignored("not_terminal", key);

  const record = await readRecord(env, key);
  if (record?.status === "completed" || record?.status === "failed") {
    log({ event: "replicate_callback_duplicate", level: "info", key, predictionId: prediction.id });
    return new Response("ok", { status: 200 });
  }

  const job = await readJob(env, key);
  if (job === undefined) {
    log({
      event: "replicate_callback_job_missing",
      level: "warn",
      key,
      predictionId: prediction.id,
    });
    return new Response("retry", { status: 503 });
  }
  if (job.predictionId !== prediction.id) {
    return ignored("prediction_mismatch", key, {
      predictionId: prediction.id,
      jobPredictionId: job.predictionId,
    });
  }
  if (finishInProgress(job, now())) {
    log({
      event: "replicate_callback_duplicate",
      level: "info",
      key,
      predictionId: prediction.id,
      concurrent: true,
    });
    return new Response("ok", { status: 200 });
  }

  await markFinishStarted(env, key, job, now());
  ctx.waitUntil(runFinish(env, key, job, prediction));
  return new Response("ok", { status: 200 });
}

/**
 * Finish, reply, and leave the job deleted and the record terminal. The job
 * delete always runs; the `failed` mark is best-effort, so a KV outage cannot
 * reject the `waitUntil` promise.
 */
async function runFinish(
  env: Env,
  key: string,
  job: Job,
  prediction: ReplicatePrediction,
): Promise<void> {
  const started = Date.now();
  try {
    const result = await finishPostImg({ env, idemKey: key, job, prediction });
    const sent = await deliverCommandResult(env, key, job.imei, result);
    if (!sent) await markFailed(env, key, "reply: IPC Inbound send failed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "postimg_finish_error", level: "error", key, imei: job.imei, error: msg });
    await markFailedBestEffort(env, key, `finish: ${msg}`);
  } finally {
    await deleteJob(env, key);
    log({
      event: "postimg_finish_ms",
      level: "info",
      key,
      imei: job.imei,
      ms: Date.now() - started,
    });
  }
}

/**
 * `markFailed` that never throws. It runs in the catch path, where a second KV
 * failure must not reject the `waitUntil` promise or skip the job delete. The
 * record then stays `processing` with its job deleted, so a later Replicate
 * retry gets 503 `replicate_callback_job_missing` until Replicate stops
 * retrying; only the operator's resend recovers it.
 */
async function markFailedBestEffort(env: Env, key: string, error: string): Promise<void> {
  try {
    await markFailed(env, key, error);
  } catch (err) {
    log({
      event: "postimg_finish_mark_failed_error",
      level: "warn",
      key,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function parsePrediction(raw: string): ReplicatePrediction | undefined {
  try {
    const p = JSON.parse(raw) as Partial<ReplicatePrediction>;
    if (p && typeof p.id === "string" && typeof p.status === "string")
      return p as ReplicatePrediction;
  } catch {
    // not JSON
  }
  return undefined;
}

/** Reasons that mean a signed callback broke the contract with Replicate: logged at warn. */
const CONTRACT_BREAK_REASONS = new Set(["no_key", "bad_body"]);

function ignored(
  reason: string,
  key: string | null,
  extra: Record<string, unknown> = {},
): Response {
  log({
    event: "replicate_callback_ignored",
    level: CONTRACT_BREAK_REASONS.has(reason) ? "warn" : "info",
    reason,
    key,
    ...extra,
  });
  return new Response("ok", { status: 200 });
}
