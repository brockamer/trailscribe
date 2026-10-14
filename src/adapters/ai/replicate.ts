import type { Env } from "../../env.js";

/**
 * Replicate predictions API response (subset we consume). The full schema is
 * documented at https://replicate.com/docs/reference/http#predictions.create.
 */
export interface ReplicatePrediction {
  id: string;
  /**
   * Known values: `starting | processing | succeeded | failed | canceled |
   * aborted`. `starting` and `processing` are NON-terminal: the prediction is
   * still running and the completion webhook (filter `completed`) has not
   * fired yet. `aborted` means the run was cancelled before it started (and is
   * not billed). Typed `string` since #268: a callback body is external input
   * and Replicate may add statuses, so `isTerminalStatus` decides, not the type.
   */
  status: string;
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string; cancel?: string };
  metrics?: { predict_time?: number };
}

/** Statuses after which the prediction will never change again. */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled", "aborted"]);

/**
 * Typed error from the image-gen provider. `status` is the HTTP status (0 for
 * non-HTTP failures); `providerResponse` carries the raw body for diagnostics
 * via the orchestrator's structured log.
 */
export class ImageGenError extends Error {
  public readonly status: number;
  public readonly providerResponse?: string;
  /** Set once a prediction exists, so an orphaned run is findable on Replicate. */
  public readonly predictionId?: string;

  constructor(opts: {
    status: number;
    message: string;
    providerResponse?: string;
    predictionId?: string;
  }) {
    super(opts.message);
    this.name = "ImageGenError";
    this.status = opts.status;
    this.providerResponse = opts.providerResponse;
    this.predictionId = opts.predictionId;
  }
}

/**
 * Create a prediction that reports back by webhook (#268, spec §5.1).
 *
 * No `Prefer: wait` header: with it Replicate holds this request open for up
 * to 60 s, which is the delay this design removes. `webhook_events_filter:
 * ["completed"]` makes Replicate call back once, on the terminal state.
 */
export async function createPrediction(args: {
  prompt: string;
  resolution?: "1 MP" | "2 MP" | "4 MP";
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  webhookUrl: string;
  env: Env;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; status: string }> {
  const { env } = args;
  const httpFetch = args.fetchImpl ?? fetch;
  if (env.IMAGE_PROVIDER !== "replicate") {
    throw new ImageGenError({
      status: 0,
      message: `unsupported IMAGE_PROVIDER: ${env.IMAGE_PROVIDER}`,
    });
  }
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (args.aspectRatio !== undefined) input.aspect_ratio = args.aspectRatio;
  if (args.resolution !== undefined) input.resolution = args.resolution;

  let res: Response;
  try {
    res = await httpFetch(`https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.IMAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        webhook: args.webhookUrl,
        webhook_events_filter: ["completed"],
      }),
    });
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error contacting Replicate: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!res.ok) {
    throw new ImageGenError({
      status: res.status,
      message: `Replicate prediction failed: HTTP ${res.status}`,
      providerResponse: await safeText(res),
    });
  }
  const body = (await res.json()) as Partial<ReplicatePrediction>;
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate create response has no prediction id",
      providerResponse: JSON.stringify(body),
    });
  }
  return { id: body.id, status: typeof body.status === "string" ? body.status : "unknown" };
}

/**
 * Download a finished prediction's image (#268). No Authorization header: the
 * delivery URL is pre-signed object storage and rejects a bearer token.
 */
export async function fetchOutput(
  prediction: Pick<ReplicatePrediction, "id" | "output">,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: ArrayBuffer; mimeType: string; model: string; costUsd: number }> {
  const outputUrl = pickOutputUrl(prediction.output);
  if (outputUrl === undefined) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate output is empty or not a URL",
      predictionId: prediction.id,
    });
  }
  let res: Response;
  try {
    res = await fetchImpl(outputUrl);
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error fetching generated image: ${e instanceof Error ? e.message : String(e)}`,
      predictionId: prediction.id,
    });
  }
  if (!res.ok) {
    throw new ImageGenError({
      status: res.status,
      message: `Failed to fetch generated image bytes: HTTP ${res.status}`,
      predictionId: prediction.id,
    });
  }
  return {
    bytes: await res.arrayBuffer(),
    mimeType: res.headers.get("content-type") ?? "image/webp",
    model: env.IMAGE_MODEL,
    costUsd: Number.parseFloat(env.IMAGE_COST_PER_CALL_USD) || 0,
  };
}

/** True for a status after which a prediction never changes again. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
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
