import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeather } from "../../adapters/location/weather.js";
import { generateNarrative } from "../narrative.js";
import { generateImage, ImageGenError } from "../../adapters/ai/replicate.js";
import { buildImagePrompt } from "../imageprompt.js";
import { publishPost, publishPostWithImage } from "../../adapters/publish/github-pages.js";
import { recordTransaction, recordImageTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, ESTIMATED_POST_TOKENS, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";

type PostImgCommand = Extract<ParsedCommand, { type: "postimg" }>;

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

  const budget = await checkBudget(env, ESTIMATED_POST_TOKENS);
  if (!budget.allowed) {
    log({ event: "postimg_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  const hasGps = lat !== undefined && lon !== undefined;
  let placeName: string | undefined;
  let weather: string | undefined;
  if (hasGps) {
    const [placeR, wxR] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeather(lat, lon, env),
    ]);
    if (placeR.status === "fulfilled") placeName = placeR.value;
    if (wxR.status === "fulfilled") weather = wxR.value;
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

  const imagePrompt = buildImagePrompt({
    caption: cmd.caption,
    place: placeName,
    lat,
    lon,
    weather,
  });

  const imageResult: ImageOpResult = await withCheckpoint(env, idemKey, "image", async () => {
    try {
      const r = await generateImage({ prompt: imagePrompt, env });
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
        providerResponse: err instanceof ImageGenError ? err.providerResponse : undefined,
      });
      return { ok: false as const, error: msg };
    }
  });

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

  // Ledger. Text spend always recorded; image spend only on success.
  try {
    await recordTransaction({
      command: "postimg",
      usage: narrative.usage,
      env,
    });
  } catch (err) {
    log({
      event: "postimg_ledger_text_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (imageResult.ok && imagePayload !== undefined) {
    try {
      await recordImageTransaction({
        command: "postimg",
        usdCost: imagePayload.costUsd,
        env,
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

  try {
    await appendEvent(
      imei,
      {
        timestamp: Date.now(),
        lat,
        lon,
        command_type: "postimg",
        free_text: cmd.caption,
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
  const body = imageCommitted ? baseReply : `${baseReply} (image gen failed; text-only)`;
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
