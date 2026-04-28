import type { Env } from "../../env.js";

/**
 * Replicate predictions API response (subset we consume). The full schema is
 * documented at https://replicate.com/docs/reference/http#predictions.create.
 */
interface ReplicatePrediction {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
}

export interface GenerateImageArgs {
  prompt: string;
  /** Aspect ratio passed to model `input.aspect_ratio` when supported. */
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  env: Env;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
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

  constructor(opts: { status: number; message: string; providerResponse?: string }) {
    super(opts.message);
    this.name = "ImageGenError";
    this.status = opts.status;
    this.providerResponse = opts.providerResponse;
  }
}

/**
 * Generate one image via the configured provider (Replicate Flux schnell for
 * the first cut — locked by P2-17 to keep `!postimg` under the PRD §7 $0.05
 * ceiling without a premium-class exception).
 *
 * Uses Replicate's `Prefer: wait` header for synchronous predictions — Flux
 * schnell completes well under Workers' subrequest budget. If a future model
 * needs longer than `wait` allows, this adapter must move to poll-mode and
 * the orchestrator's `withCheckpoint` window has to lengthen accordingly.
 *
 * Returns the image bytes + cost; throws `ImageGenError` on any failure mode
 * (HTTP error, non-succeeded prediction, output URL fetch failure). Caller
 * (`!postimg` handler in P2-18) catches and falls back to text-only `!post`.
 */
export async function generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
  const { prompt, aspectRatio, env } = args;
  const httpFetch = args.fetchImpl ?? fetch;

  if (env.IMAGE_PROVIDER !== "replicate") {
    throw new ImageGenError({
      status: 0,
      message: `unsupported IMAGE_PROVIDER: ${env.IMAGE_PROVIDER}`,
    });
  }

  // Replicate's "predictions by model" endpoint resolves the latest version
  // automatically — operator doesn't need to pin a version hash for first-cut.
  const url = `https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`;
  const input: Record<string, unknown> = { prompt };
  if (aspectRatio !== undefined) input.aspect_ratio = aspectRatio;

  let res: Response;
  try {
    res = await httpFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.IMAGE_API_KEY}`,
        "Content-Type": "application/json",
        Prefer: "wait",
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

  const prediction = (await res.json()) as ReplicatePrediction;
  if (prediction.status !== "succeeded") {
    throw new ImageGenError({
      status: 0,
      message: `Replicate prediction did not succeed: status=${prediction.status}${prediction.error ? `, error=${prediction.error}` : ""}`,
      providerResponse: JSON.stringify(prediction),
    });
  }

  const outputUrl = pickOutputUrl(prediction.output);
  if (outputUrl === undefined) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate output is empty or not a URL",
      providerResponse: JSON.stringify(prediction),
    });
  }

  let imageRes: Response;
  try {
    imageRes = await httpFetch(outputUrl);
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error fetching generated image: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!imageRes.ok) {
    throw new ImageGenError({
      status: imageRes.status,
      message: `Failed to fetch generated image bytes: HTTP ${imageRes.status}`,
    });
  }

  const bytes = await imageRes.arrayBuffer();
  const mimeType = imageRes.headers.get("content-type") ?? "image/webp";
  const costUsd = Number.parseFloat(env.IMAGE_COST_PER_CALL_USD) || 0;

  return { bytes, mimeType, model: env.IMAGE_MODEL, costUsd };
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
