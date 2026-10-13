import type { CommandResult, OrchestrateResult, ParsedCommand } from "../types.js";
import type { Env } from "../../env.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeatherDetail } from "../../adapters/location/weather.js";
import { generateNarrative } from "../narrative.js";
import {
  createPrediction,
  fetchOutput,
  generateImage,
  ImageGenError,
  type ReplicatePrediction,
} from "../../adapters/ai/replicate.js";
import { buildImagePrompt } from "../imageprompt.js";
import { type CivilTimeInfo, localTimeOfDay } from "../localtime.js";
import { publishPost, publishPostWithImage } from "../../adapters/publish/github-pages.js";
import { recordTransaction, recordImageTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import {
  readPendingPrediction,
  writePendingPrediction,
  clearPendingPrediction,
} from "../image-pending.js";
import { BUDGET_REJECTION_MESSAGE, ESTIMATED_POST_TOKENS, checkBudget } from "../budget.js";
import { writeJob, type PostImgJob } from "../jobs.js";
import { log } from "../../adapters/logging/worker-logs.js";

type PostImgCommand = Extract<ParsedCommand, { type: "postimg" }>;

/**
 * Wall-clock budget for image generation, including Replicate's own 60s
 * `Prefer: wait` window.
 *
 * Sized from measurement, not from how long the operator is willing to wait:
 * ~60s of observed Replicate queueing plus flux-2-max's ~38s inference is
 * ~100s worst case, so 150s covers it with margin. It is deliberately shorter
 * than the webhook lease in `app.ts` (180s), because this request is held open
 * while it runs and every second past Garmin's tolerance is a second in which
 * a retry could race it.
 */
const IMAGE_POLL_BUDGET_MS = 150_000;

/**
 * `!postimg <caption>` pipeline (plan P2-18). Mirrors `!post` with an
 * image-gen step inserted before the journal commit. The markdown post and
 * the binary image are committed *atomically* via GitHub's GraphQL
 * `createCommitOnBranch` mutation so an interrupted run cannot leave a
 * markdown post pointing at a missing image.
 *
 * Pipeline:
 *   1. budget gate (text LLM)
 *   2. enrich (geocode + weather, GPS-conditional)
 *   3. narrative LLM (checkpointed as 'narrative')
 *   4. image-gen (checkpointed as 'image'; failure → text-only fallback)
 *   5. atomic commit markdown + image (checkpointed as 'publish')
 *   6. ledger (text + image, recorded separately so existing `!cost`
 *      semantics stay intact and the breakout reply lights up)
 *   7. context append + reply
 */
export async function handlePostImg(
  cmd: PostImgCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  // Bare `!postimg` with no fix has no signal at all: no caption to describe
  // and no place/weather to ground a scene. Refuse before any LLM or image
  // spend rather than buying a picture of nothing (#150). A captioned
  // `!postimg` still works fixless — the caption carries it.
  const hasCaption = cmd.caption !== undefined && cmd.caption.trim().length > 0;
  if (!hasCaption && (lat === undefined || lon === undefined)) {
    log({ event: "postimg_no_signal", level: "info", imei });
    return { body: "Need GPS fix or a caption — try again outdoors." };
  }

  const budget = await checkBudget(env, ESTIMATED_POST_TOKENS);
  if (!budget.allowed) {
    log({ event: "postimg_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  const hasGps = lat !== undefined && lon !== undefined;
  let placeName: string | undefined;
  let weather: string | undefined;
  let civil: CivilTimeInfo | undefined;
  let weatherCode: number | undefined;
  if (hasGps) {
    const [placeR, wxR] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeatherDetail(lat, lon, env),
    ]);
    if (placeR.status === "fulfilled") placeName = placeR.value;
    if (wxR.status === "fulfilled") {
      weather = wxR.value.text;
      weatherCode = wxR.value.code;
      civil = wxR.value.civil;
    }
  }

  // One time-of-day derivation feeding both the narrative and the image prompt,
  // so the text and the picture agree on the hour (#240).
  const localTime =
    ctx.timeStamp !== undefined && lon !== undefined
      ? localTimeOfDay(ctx.timeStamp, lon, civil)
      : undefined;

  let narrative: Awaited<ReturnType<typeof generateNarrative>>;
  try {
    narrative = await withCheckpoint(env, idemKey, "narrative", () =>
      generateNarrative({
        note: cmd.caption,
        lat,
        lon,
        placeName,
        weather,
        localTime: localTime?.text,
        isNight: localTime?.isNight,
        clockKnown: localTime?.clockKnown,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "narrative", err, imei);
  }

  // Image-gen step. Failure here drops to text-only fallback so we don't
  // lose the operator's caption — the journal entry still lands, just
  // without an illustration.
  //
  // Bytes are stored as base64 in the checkpoint so withCheckpoint's JSON
  // round-trip survives. On replay we decode back to ArrayBuffer; since the
  // downstream publish step is also checkpointed we'd usually short-circuit
  // before re-using bytes, but we keep them recoverable for safety.
  type ImageOpResult =
    | { ok: true; bytesB64: string; mimeType: string; costUsd: number; model: string }
    | { ok: false; error: string };

  // Bare `!postimg` (#150): the narrative just written from telemetry becomes
  // the image's subject, so the picture and the post describe one moment.
  const narrativeSubject = hasCaption
    ? undefined
    : [narrative.title, narrative.body].filter((x) => x && x.trim().length > 0).join(": ");

  const imagePrompt = buildImagePrompt({
    caption: cmd.caption,
    narrativeSubject,
    place: placeName,
    weatherCode,
    altitudeM: ctx.altitude,
    localTime: localTime?.text,
    isNight: localTime?.isNight,
  });

  // If the metadata-only narrative produced nothing usable there is no subject
  // to draw, so skip image-gen rather than spend on it. Mirrors post.ts's #124
  // bare-!post fallback, which synthesizes a minimal title for the text post.
  const haveSubject = hasCaption || (narrativeSubject ?? "").trim().length > 0;

  const imageResult: ImageOpResult = !haveSubject
    ? { ok: false as const, error: "no caption and empty telemetry narrative — skipped image-gen" }
    : await withCheckpoint(env, idemKey, "image", async () => {
        // A prediction created by an earlier invocation of this same idempotency
        // key is already paid for. Resume polling it rather than buying another
        // (#235) — at flux-2-max prices a duplicate is real money, and Garmin
        // retries the webhook on timeout.
        const pending = await readPendingPrediction(env, idemKey);
        try {
          const r = await generateImage({
            prompt: imagePrompt,
            env,
            resolution: "2 MP",
            pollBudgetMs: IMAGE_POLL_BUDGET_MS,
            resume: pending,
            onPredictionCreated: (predictionId, getUrl) =>
              writePendingPrediction(env, idemKey, { predictionId, getUrl }),
          });

          return {
            ok: true as const,
            bytesB64: arrayBufferToBase64(r.bytes),
            mimeType: r.mimeType,
            costUsd: r.costUsd,
            model: r.model,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log({
            event: "image_gen_failed",
            level: "error",
            imei,
            error: msg,
            timedOut: err instanceof ImageGenError ? err.timedOut : undefined,
            predictionId: err instanceof ImageGenError ? err.predictionId : undefined,
            providerResponse: err instanceof ImageGenError ? err.providerResponse : undefined,
          });
          // A timeout is not a verdict — the prediction is very likely still
          // running, and is already paid for. Throwing here means withCheckpoint
          // never persists it, so a later redelivery re-enters and `resume`s the
          // same prediction instead of inheriting a cached "failed" forever.
          // Terminal provider failures still checkpoint, since retrying them is
          // just spend.
          if (err instanceof ImageGenError && err.timedOut) throw err;
          return { ok: false as const, error: msg };
        }
      }).catch((err: unknown) => {
        // Text-only fallback for the un-checkpointed timeout path: the operator
        // still gets their journal entry now, and a retry can still recover the
        // image.
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false as const, error: msg };
      });

  // Only now is the `image` checkpoint durable, so the marker is safe to drop.
  // Clearing it inside the checkpointed fn (as first written) left a window in
  // which a crash between generation and the KV write lost the pointer to a
  // prediction we had already paid for.
  if (imageResult.ok) await clearPendingPrediction(env, idemKey);

  let imagePayload:
    | { bytes: ArrayBuffer; mimeType: string; costUsd: number; model: string }
    | undefined;
  if (imageResult.ok) {
    imagePayload = {
      bytes: base64ToArrayBuffer(imageResult.bytesB64),
      mimeType: imageResult.mimeType,
      costUsd: imageResult.costUsd,
      model: imageResult.model,
    };
  }

  // Ledger, text half. Recorded BEFORE the publish attempt (#213): the
  // narrative LLM call has already been billed by the provider, so deferring
  // this until after a publish that may fail loses the record of real spend
  // and lets `!cost` under-report. `tracking.ts` already does it in this
  // order; this brings postimg into line.
  try {
    await withCheckpoint(env, idemKey, "ledger_text", async () => {
      await recordTransaction({ command: "postimg", usage: narrative.usage, env });
      return null;
    });
  } catch (err) {
    log({
      event: "postimg_ledger_text_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Ledger, image half. Same reasoning: the image is paid for on success
  // regardless of whether the journal commit lands.
  if (imageResult.ok && imagePayload !== undefined) {
    try {
      await withCheckpoint(env, idemKey, "ledger_image", async () => {
        await recordImageTransaction({ command: "postimg", usdCost: imagePayload.costUsd, env });
        return null;
      });
    } catch (err) {
      log({
        event: "postimg_ledger_image_failed",
        level: "warn",
        imei,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let publishResult: { url: string; path: string; sha: string };
  let imageCommitted = false;
  try {
    if (imageResult.ok && imagePayload !== undefined) {
      publishResult = await withCheckpoint(env, idemKey, "publish", () =>
        publishPostWithImage({
          title: narrative.title,
          haiku: narrative.haiku,
          body: narrative.body,
          lat,
          lon,
          placeName,
          weather,
          env,
          image: {
            bytes: imagePayload!.bytes,
            mimeType: imagePayload!.mimeType,
            pathTemplate: env.JOURNAL_IMAGE_PATH_TEMPLATE,
          },
        }),
      );
      imageCommitted = true;
    } else {
      // Image-gen failed OR this is a replay where we lost the bytes; either
      // way, fall back to a plain text-only commit so the operator's caption
      // still lands. (On a clean replay, the publish op's withCheckpoint
      // would already have a cached value either way.)
      publishResult = await withCheckpoint(env, idemKey, "publish", () =>
        publishPost({
          title: narrative.title,
          haiku: narrative.haiku,
          body: narrative.body,
          lat,
          lon,
          placeName,
          weather,
          env,
        }),
      );
    }
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err, imei);
  }

  try {
    await appendEvent(
      imei,
      {
        timestamp: Date.now(),
        lat,
        lon,
        command_type: "postimg",
        free_text: cmd.caption ?? "",
      },
      env,
    );
  } catch (err) {
    log({
      event: "postimg_context_append_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const baseReply = `Posted: ${narrative.title}`;
  const body = imageCommitted ? baseReply : `${baseReply} (no image — retry !postimg)`;
  return { body, journalUrl: publishResult.url };
}

const FALLBACK_SUFFIX = " (no image — retry !postimg)";

/**
 * `!postimg` first half (#268, spec §5.1). Runs in the Garmin request:
 * refusals, enrichment, narrative, text ledger, then a prediction created with
 * a completion webhook and ONE job-record write. Returns `{ deferred: true }`
 * so the webhook answers Garmin without a reply; `finishPostImg` sends it.
 * Any failure before the job is safely recorded publishes text-only now, so
 * this request never ends in silence.
 */
export async function startPostImg(
  cmd: PostImgCommand,
  ctx: OrchestratorContext,
): Promise<OrchestrateResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  const hasCaption = cmd.caption !== undefined && cmd.caption.trim().length > 0;
  if (!hasCaption && (lat === undefined || lon === undefined)) {
    log({ event: "postimg_no_signal", level: "info", imei });
    return { body: "Need GPS fix or a caption — try again outdoors." };
  }

  const budget = await checkBudget(env, ESTIMATED_POST_TOKENS);
  if (!budget.allowed) {
    log({ event: "postimg_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  let placeName: string | undefined;
  let weather: string | undefined;
  let civil: CivilTimeInfo | undefined;
  let weatherCode: number | undefined;
  if (lat !== undefined && lon !== undefined) {
    const [placeR, wxR] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeatherDetail(lat, lon, env),
    ]);
    if (placeR.status === "fulfilled") placeName = placeR.value;
    if (wxR.status === "fulfilled") {
      weather = wxR.value.text;
      weatherCode = wxR.value.code;
      civil = wxR.value.civil;
    }
  }

  const localTime =
    ctx.timeStamp !== undefined && lon !== undefined
      ? localTimeOfDay(ctx.timeStamp, lon, civil)
      : undefined;

  let narrative: Awaited<ReturnType<typeof generateNarrative>>;
  try {
    narrative = await withCheckpoint(env, idemKey, "narrative", () =>
      generateNarrative({
        note: cmd.caption,
        lat,
        lon,
        placeName,
        weather,
        localTime: localTime?.text,
        isNight: localTime?.isNight,
        clockKnown: localTime?.clockKnown,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "narrative", err, imei);
  }

  // Text ledger before anything that can fail (#213 reasoning).
  try {
    await withCheckpoint(env, idemKey, "ledger_text", async () => {
      await recordTransaction({ command: "postimg", usage: narrative.usage, env });
      return null;
    });
  } catch (err) {
    log({ event: "postimg_ledger_text_failed", level: "warn", imei, error: errMsg(err) });
  }

  const job: Omit<PostImgJob, "predictionId" | "createdAt"> = {
    kind: "postimg",
    imei,
    caption: cmd.caption,
    narrative: { title: narrative.title, haiku: narrative.haiku, body: narrative.body },
    lat,
    lon,
    placeName,
    weather,
  };
  const textOnly = () => publishTextOnly(env, idemKey, job);

  const narrativeSubject = hasCaption
    ? undefined
    : [narrative.title, narrative.body].filter((x) => x && x.trim().length > 0).join(": ");
  if (!hasCaption && (narrativeSubject ?? "").trim().length === 0) return textOnly();
  if (ctx.origin === undefined) {
    log({ event: "postimg_no_origin", level: "error", imei, key: idemKey });
    return textOnly();
  }

  const imagePrompt = buildImagePrompt({
    caption: cmd.caption,
    narrativeSubject,
    place: placeName,
    weatherCode,
    altitudeM: ctx.altitude,
    localTime: localTime?.text,
    isNight: localTime?.isNight,
  });

  let predictionId: string;
  try {
    const created = await createPrediction({
      prompt: imagePrompt,
      resolution: "2 MP",
      webhookUrl: `${ctx.origin}/replicate/callback?key=${encodeURIComponent(idemKey)}`,
      env,
    });
    predictionId = created.id;
  } catch (err) {
    log({
      event: "image_gen_failed",
      level: "error",
      imei,
      stage: "create",
      error: errMsg(err),
      providerResponse: err instanceof ImageGenError ? err.providerResponse : undefined,
    });
    return textOnly();
  }

  try {
    await writeJob(env, idemKey, { ...job, predictionId, createdAt: Date.now() });
  } catch (err) {
    // The prediction is paid for but its callback could not find the job.
    // Publish text-only now; the callback later sees a completed record.
    log({
      event: "postimg_job_write_failed",
      level: "error",
      imei,
      key: idemKey,
      predictionId,
      error: errMsg(err),
    });
    return textOnly();
  }

  log({ event: "postimg_deferred", level: "info", imei, key: idemKey, predictionId });
  return { deferred: true };
}

/**
 * `!postimg` second half (#268, spec §5.2). Runs in the Replicate callback:
 * download the image (or fall back to text-only), image ledger, one commit,
 * context append. Returns the reply body for `deliverCommandResult`.
 */
export async function finishPostImg(args: {
  env: Env;
  idemKey: string;
  job: PostImgJob;
  prediction: Pick<ReplicatePrediction, "id" | "status" | "output" | "error">;
}): Promise<CommandResult> {
  const { env, idemKey, job, prediction } = args;

  let image: Awaited<ReturnType<typeof fetchOutput>> | undefined;
  if (prediction.status === "succeeded") {
    try {
      image = await fetchOutput(prediction, env);
    } catch (err) {
      log({
        event: "image_gen_failed",
        level: "error",
        imei: job.imei,
        stage: "download",
        predictionId: prediction.id,
        error: errMsg(err),
      });
    }
  } else {
    log({
      event: "image_gen_failed",
      level: "error",
      imei: job.imei,
      stage: "render",
      predictionId: prediction.id,
      status: prediction.status,
      error: prediction.error ?? undefined,
    });
  }

  if (image === undefined) return publishTextOnly(env, idemKey, job);

  const paid = image;
  try {
    await withCheckpoint(env, idemKey, "ledger_image", async () => {
      await recordImageTransaction({ command: "postimg", usdCost: paid.costUsd, env });
      return null;
    });
  } catch (err) {
    log({
      event: "postimg_ledger_image_failed",
      level: "warn",
      imei: job.imei,
      error: errMsg(err),
    });
  }

  let published: { url: string };
  try {
    published = await withCheckpoint(env, idemKey, "publish", () =>
      publishPostWithImage({
        title: job.narrative.title,
        haiku: job.narrative.haiku,
        body: job.narrative.body,
        lat: job.lat,
        lon: job.lon,
        placeName: job.placeName,
        weather: job.weather,
        env,
        image: {
          bytes: paid.bytes,
          mimeType: paid.mimeType,
          pathTemplate: env.JOURNAL_IMAGE_PATH_TEMPLATE,
        },
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err, job.imei);
  }
  await appendPostImgContext(env, job);
  return { body: `Posted: ${job.narrative.title}`, journalUrl: published.url };
}

/** Text-only commit plus the fallback reply; shared by both halves. */
async function publishTextOnly(
  env: Env,
  idemKey: string,
  job: Omit<PostImgJob, "predictionId" | "createdAt">,
): Promise<CommandResult> {
  let published: { url: string };
  try {
    published = await withCheckpoint(env, idemKey, "publish", () =>
      publishPost({
        title: job.narrative.title,
        haiku: job.narrative.haiku,
        body: job.narrative.body,
        lat: job.lat,
        lon: job.lon,
        placeName: job.placeName,
        weather: job.weather,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err, job.imei);
  }
  await appendPostImgContext(env, job);
  return { body: `Posted: ${job.narrative.title}${FALLBACK_SUFFIX}`, journalUrl: published.url };
}

async function appendPostImgContext(
  env: Env,
  job: Pick<PostImgJob, "imei" | "lat" | "lon" | "caption">,
): Promise<void> {
  try {
    await appendEvent(
      job.imei,
      {
        timestamp: Date.now(),
        lat: job.lat,
        lon: job.lon,
        command_type: "postimg",
        free_text: job.caption ?? "",
      },
      env,
    );
  } catch (err) {
    log({
      event: "postimg_context_append_failed",
      level: "warn",
      imei: job.imei,
      error: errMsg(err),
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function failPipeline(
  env: OrchestratorContext["env"],
  idemKey: string,
  step: string,
  err: unknown,
  imei: string,
): Promise<CommandResult> {
  const msg = err instanceof Error ? err.message : String(err);
  log({ event: `postimg_${step}_failed`, level: "error", imei, error: msg });
  await markFailed(env, idemKey, `${step}: ${msg}`);
  return { body: `Error: ${msg.slice(0, 80)}` };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
