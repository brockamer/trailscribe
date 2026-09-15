import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeatherDetail } from "../../adapters/location/weather.js";
import { generateNarrative } from "../narrative.js";
import { generateImage, ImageGenError } from "../../adapters/ai/replicate.js";
import { buildImagePrompt } from "../imageprompt.js";
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
    }
  }

  let narrative: Awaited<ReturnType<typeof generateNarrative>>;
  try {
    narrative = await withCheckpoint(env, idemKey, "narrative", () =>
      generateNarrative({
        note: cmd.caption,
        lat,
        lon,
        placeName,
        weather,
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

  const solar =
    ctx.timeStamp !== undefined && lon !== undefined
      ? approximateLocalTime(ctx.timeStamp, lon)
      : undefined;

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
    localTime: solar?.text,
    isNight: solar?.isNight,
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

  const baseReply = `Posted: ${narrative.title} · ${publishResult.url}`;
  const body = imageCommitted ? baseReply : `${baseReply} (no image — retry !postimg)`;
  return { body };
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

/**
 * Mean solar time from longitude — a zero-dependency approximation of local
 * time of day, used only to ground the image prompt's lighting.
 *
 * Deliberately NOT civil time: there is no timezone database in this Worker
 * and adding one would need PRD justification. Mean solar time ignores
 * political timezone boundaries and DST, so it can differ from the clock on
 * the operator's wrist by an hour or more. That is acceptable for its only
 * purpose — telling an image model roughly where the sun is.
 */
export function approximateLocalTime(
  timeStampMs: number,
  lon: number,
): { text: string; isNight: boolean } {
  const d = new Date(timeStampMs + (lon / 15) * 3_600_000);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const band =
    hh < 5
      ? "night"
      : hh < 8
        ? "early morning"
        : hh < 11
          ? "morning"
          : hh < 14
            ? "midday"
            : hh < 17
              ? "afternoon"
              : hh < 20
                ? "evening"
                : "night";
  return {
    text: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} — ${band}`,
    isNight: band === "night",
  };
}
