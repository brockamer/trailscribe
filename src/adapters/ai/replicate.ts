import type { Env } from "../../env.js";

/**
 * Replicate predictions API response (subset we consume). The full schema is
 * documented at https://replicate.com/docs/reference/http#predictions.create.
 */
interface ReplicatePrediction {
  id: string;
  /**
   * `starting` and `processing` are NON-terminal — Replicate is telling us to
   * poll, not reporting a failure. `aborted` was missing here until #235; it
   * means the run was cancelled before it started (and is not billed).
   */
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled" | "aborted";
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
}

/** Statuses after which the prediction will never change again. */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "aborted"]);

/** Total wall-clock budget for create + poll. See generateImage() docs. */
const DEFAULT_POLL_BUDGET_MS = 240_000;
const POLL_INITIAL_MS = 1_500;
const POLL_MAX_MS = 6_000;
const POLL_BACKOFF = 1.4;

export interface GenerateImageArgs {
  prompt: string;
  /** Aspect ratio passed to model `input.aspect_ratio` when supported. */
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  /** Output resolution for per-megapixel-priced models (e.g. flux-2-max). */
  resolution?: "1 MP" | "2 MP" | "4 MP";
  env: Env;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Total wall-clock budget for create + poll. Default 240s. */
  pollBudgetMs?: number;
  /** Override the poll delay for tests (default: real `setTimeout`). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Override the clock for tests (default: `Date.now`). */
  nowImpl?: () => number;
  /**
   * Fired once, immediately after the prediction is created and before any
   * waiting. Lets the caller persist the id so a retried invocation can
   * `resume` the same prediction instead of paying for a second one.
   */
  onPredictionCreated?: (predictionId: string, getUrl: string) => void | Promise<void>;
  /** Poll an existing prediction instead of creating a new one. */
  resume?: { predictionId: string; getUrl: string };
}

export interface GenerateImageResult {
  bytes: ArrayBuffer;
  mimeType: string;
  model: string;
  costUsd: number;
}

/**
 * Typed error from the image-gen provider. `status` is the HTTP status (0 for
 * non-HTTP failures); `providerResponse` carries the raw body for diagnostics
 * via the orchestrator's structured log.
 */
export class ImageGenError extends Error {
  public readonly status: number;
  public readonly providerResponse?: string;
  /** True when we gave up waiting, as opposed to the provider reporting failure. */
  public readonly timedOut: boolean;
  /** Set once a prediction exists, so an orphaned run is findable on Replicate. */
  public readonly predictionId?: string;

  constructor(opts: {
    status: number;
    message: string;
    providerResponse?: string;
    timedOut?: boolean;
    predictionId?: string;
  }) {
    super(opts.message);
    this.name = "ImageGenError";
    this.status = opts.status;
    this.providerResponse = opts.providerResponse;
    this.timedOut = opts.timedOut ?? false;
    this.predictionId = opts.predictionId;
  }
}

/**
 * Generate one image via the configured provider (Replicate `flux-2-max` at
 * 2 MP, ~$0.10/image against the $0.20/image budget in PRD §6). Selected in
 * #235 by generating real images rather than comparing vendor descriptions:
 * the previous `flux-schnell` produced cartoons, and the model the docs most
 * recommended for realism rendered the caption as literal lettered signage.
 *
 * POLL-MODE (#235). `Prefer: wait=60` is a best-effort sync window, not a
 * guarantee. When it expires Replicate answers HTTP 200 with a NON-TERMINAL
 * status (`starting`/`processing`), `output: null`, `error: null`, and a
 * `urls.get` — an invitation to poll, not a failure. This adapter previously
 * threw on any status but `succeeded`, so on 2026-09-13 a prediction that was
 * merely queued was reported to the operator as a failed image.
 *
 * Measured 2026-09-14: the queue, not inference, is what blows the window.
 * Two flux-schnell runs returned `processing` at 63.9s and 62.6s with only
 * 5.1s and 16.5s of actual inference. A faster model is therefore NOT a fix —
 * any model can sit queued — which is why poll-mode is unconditional here.
 *
 * Waiting is bounded by `pollBudgetMs` (default 240s). Because a Garmin
 * webhook timeout would retry into a second paid generation, callers should
 * persist the prediction id via `onPredictionCreated` and hand it back as
 * `resume` so a retry polls the run already paid for.
 *
 * Returns the image bytes + cost; throws `ImageGenError` on terminal provider
 * failure, on an exhausted poll budget (`timedOut: true`), or on an output
 * fetch failure. Caller (`!postimg`) catches and falls back to text-only.
 */
export async function generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
  const { prompt, aspectRatio, resolution, env } = args;
  const httpFetch = args.fetchImpl ?? fetch;
  const now = args.nowImpl ?? (() => Date.now());
  const sleep = args.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (args.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS);

  if (env.IMAGE_PROVIDER !== "replicate") {
    throw new ImageGenError({
      status: 0,
      message: `unsupported IMAGE_PROVIDER: ${env.IMAGE_PROVIDER}`,
    });
  }

  let prediction: ReplicatePrediction;
  let getUrl: string | undefined;

  if (args.resume !== undefined) {
    // A prior invocation already paid for this prediction; never create a second.
    getUrl = args.resume.getUrl;
    prediction = await fetchPrediction(httpFetch, getUrl, env, args.resume.predictionId);
  } else {
    const url = `https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`;
    const input: Record<string, unknown> = { prompt };
    if (aspectRatio !== undefined) input.aspect_ratio = aspectRatio;
    if (resolution !== undefined) input.resolution = resolution;

    let res: Response;
    try {
      res = await httpFetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.IMAGE_API_KEY}`,
          "Content-Type": "application/json",
          // Best-effort sync window; Replicate caps this at 60s and then
          // returns 200 with a non-terminal status. That is the poll signal.
          Prefer: "wait=60",
        },
        body: JSON.stringify({ input }),
      });
    } catch (e) {
      throw new ImageGenError({
        status: 0,
        message: `network error contacting Replicate: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    if (!res.ok) {
      const body = await safeText(res);
      throw new ImageGenError({
        status: res.status,
        message: `Replicate prediction failed: HTTP ${res.status}`,
        providerResponse: body,
      });
    }

    prediction = (await res.json()) as ReplicatePrediction;
    getUrl = prediction.urls?.get;
    if (getUrl !== undefined) {
      await args.onPredictionCreated?.(prediction.id, getUrl);
    }
  }

  // Poll until terminal or budget exhausted. An unrecognised future status is
  // treated as non-terminal — keep waiting, bounded by the same deadline,
  // rather than misreporting it as a failure the way #235 did.
  let interval = POLL_INITIAL_MS;
  while (!TERMINAL_STATUSES.has(prediction.status)) {
    if (now() >= deadline) {
      throw new ImageGenError({
        status: 0,
        message: `Replicate prediction still ${prediction.status} when the poll budget expired`,
        providerResponse: JSON.stringify(prediction),
        timedOut: true,
        predictionId: prediction.id,
      });
    }
    if (getUrl === undefined) {
      throw new ImageGenError({
        status: 0,
        message: `Replicate returned non-terminal status ${prediction.status} with no urls.get to poll`,
        providerResponse: JSON.stringify(prediction),
        predictionId: prediction.id,
      });
    }
    await sleep(interval);
    interval = Math.min(interval * POLL_BACKOFF, POLL_MAX_MS);
    prediction = await fetchPrediction(httpFetch, getUrl, env, prediction.id);
  }

  if (prediction.status !== "succeeded") {
    throw new ImageGenError({
      status: 0,
      message: `Replicate prediction did not succeed: status=${prediction.status}${prediction.error ? `, error=${prediction.error}` : ""}`,
      providerResponse: JSON.stringify(prediction),
      predictionId: prediction.id,
    });
  }

  const outputUrl = pickOutputUrl(prediction.output);
  if (outputUrl === undefined) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate output is empty or not a URL",
      providerResponse: JSON.stringify(prediction),
      predictionId: prediction.id,
    });
  }

  let imageRes: Response;
  try {
    // NOTE: no Authorization header. The delivery URL is pre-signed object
    // storage and rejects a bearer token with 400 Missing x-amz-content-sha256.
    imageRes = await httpFetch(outputUrl);
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error fetching generated image: ${e instanceof Error ? e.message : String(e)}`,
      predictionId: prediction.id,
    });
  }
  if (!imageRes.ok) {
    throw new ImageGenError({
      status: imageRes.status,
      message: `Failed to fetch generated image bytes: HTTP ${imageRes.status}`,
      predictionId: prediction.id,
    });
  }

  const bytes = await imageRes.arrayBuffer();
  const mimeType = imageRes.headers.get("content-type") ?? "image/webp";
  const costUsd = Number.parseFloat(env.IMAGE_COST_PER_CALL_USD) || 0;

  return { bytes, mimeType, model: env.IMAGE_MODEL, costUsd };
}

/** GET one prediction. Bearer auth; deliberately no `Prefer` header. */
async function fetchPrediction(
  httpFetch: typeof fetch,
  getUrl: string,
  env: Env,
  predictionId: string,
): Promise<ReplicatePrediction> {
  let res: Response;
  try {
    res = await httpFetch(getUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    });
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error polling Replicate: ${e instanceof Error ? e.message : String(e)}`,
      predictionId,
    });
  }
  if (!res.ok) {
    throw new ImageGenError({
      status: res.status,
      message: `Replicate poll failed: HTTP ${res.status}`,
      providerResponse: await safeText(res),
      predictionId,
    });
  }
  return (await res.json()) as ReplicatePrediction;
}

function pickOutputUrl(output: string | string[] | null | undefined): string | undefined {
  if (!output) return undefined;
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0 && typeof output[0] === "string") {
    return output[0];
  }
  return undefined;
}

async function safeText(res: Response): Promise<string | undefined> {
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}
