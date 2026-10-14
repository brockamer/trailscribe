import type { CommandResult, OrchestrateResult, ParsedCommand } from "../types.js";
import type { Env } from "../../env.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeatherDetail } from "../../adapters/location/weather.js";
import { generateNarrative } from "../narrative.js";
import {
  createPrediction,
  fetchOutput,
  ImageGenError,
  type ReplicatePrediction,
} from "../../adapters/ai/replicate.js";
import { buildImagePrompt } from "../imageprompt.js";
import { type CivilTimeInfo, localTimeOfDay } from "../localtime.js";
import { publishPost, publishPostWithImage } from "../../adapters/publish/github-pages.js";
import { recordTransaction, recordImageTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, ESTIMATED_POST_TOKENS, checkBudget } from "../budget.js";
import { writeJob, type PostImgJob } from "../jobs.js";
import { log } from "../../adapters/logging/worker-logs.js";

type PostImgCommand = Extract<ParsedCommand, { type: "postimg" }>;

/**
 * `!postimg <caption>` pipeline (plan P2-18, split in two by #268). Mirrors
 * `!post` with an image-gen step before the journal commit, run as two halves
 * so Garmin gets its answer in seconds instead of waiting on Replicate:
 *
 *   `startPostImg`, in the Garmin request:
 *     1. refusals (no signal) and the text budget gate
 *     2. enrich (geocode + weather, GPS-conditional)
 *     3. narrative LLM (checkpointed as 'narrative') and text ledger
 *     4. create the Replicate prediction with a completion webhook, then write
 *        the job record once; any failure here publishes text-only now
 *
 *   `finishPostImg`, in the Replicate callback:
 *     5. download the image; a failed prediction or download drops to text-only
 *     6. image ledger (checkpointed as 'ledger_image')
 *     7. one atomic commit of markdown + image (checkpointed as 'publish'), via
 *        GitHub's GraphQL `createCommitOnBranch`, so an interrupted run cannot
 *        leave a post pointing at a missing image
 *     8. context append; the caller sends the reply
 */

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
