import { describe, test, expect, beforeEach, vi, type Mock } from "vitest";
import {
  createPrediction,
  fetchOutput,
  ImageGenError,
  isTerminalStatus,
} from "../src/adapters/ai/replicate.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let fetchImpl: Mock<typeof fetch>;

beforeEach(() => {
  env = makeTestEnv();
  fetchImpl = vi.fn();
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

function predictionResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageResponse(bytes: ArrayBuffer, mimeType = "image/png"): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": mimeType },
  });
}

describe("ImageGenError — shape", () => {
  test("name, status, and providerResponse are exposed", () => {
    const err = new ImageGenError({ status: 503, message: "x", providerResponse: "service down" });
    expect(err.name).toBe("ImageGenError");
    expect(err.status).toBe(503);
    expect(err.providerResponse).toBe("service down");
  });
});

// ---------------------------------------------------------------------------
// #268 — webhook mode. Create returns at once; Replicate calls back on the
// terminal state and the output is downloaded in a separate step.
// ---------------------------------------------------------------------------

const WEBHOOK = "https://w.test/replicate/callback?key=k1";

describe("createPrediction — webhook mode (#268)", () => {
  test("POSTs input, webhook and the completed filter, with no Prefer header", async () => {
    fetchImpl.mockResolvedValueOnce(predictionResponse({ id: "pred-1", status: "starting" }));
    const r = await createPrediction({
      prompt: "a lake at dusk",
      resolution: "2 MP",
      webhookUrl: WEBHOOK,
      env,
      fetchImpl,
    });
    expect(r).toEqual({ id: "pred-1", status: "starting" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${env.IMAGE_API_KEY}`);
    expect(headers.Prefer).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      input: { prompt: "a lake at dusk", resolution: "2 MP" },
      webhook: WEBHOOK,
      webhook_events_filter: ["completed"],
    });
  });

  test("a 4xx surfaces as ImageGenError with the provider body", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("bad input", { status: 422 }));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toMatchObject({
      name: "ImageGenError",
      status: 422,
      providerResponse: "bad input",
    });
  });

  test("a network error surfaces as ImageGenError status 0", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toMatchObject({
      status: 0,
    });
  });

  test("a response without an id is an error, not a silent deferral", async () => {
    fetchImpl.mockResolvedValueOnce(predictionResponse({ status: "starting" }));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toBeInstanceOf(ImageGenError);
  });

  test("rejects a non-replicate IMAGE_PROVIDER", async () => {
    const other = { ...env, IMAGE_PROVIDER: "other" };
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env: other, fetchImpl }),
    ).rejects.toBeInstanceOf(ImageGenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fetchOutput (#268)", () => {
  test("downloads a string output without an Authorization header", async () => {
    fetchImpl.mockResolvedValueOnce(imageResponse(PNG_BYTES, "image/webp"));
    const r = await fetchOutput(
      { id: "p", output: "https://replicate.delivery/a.webp" },
      env,
      fetchImpl,
    );
    expect(r.mimeType).toBe("image/webp");
    expect(r.bytes.byteLength).toBe(4);
    expect(r.model).toBe(env.IMAGE_MODEL);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(init).toBeUndefined();
  });

  test("Review Focus 3: an array output uses the first URL", async () => {
    fetchImpl.mockResolvedValueOnce(imageResponse(PNG_BYTES));
    await fetchOutput(
      { id: "p", output: ["https://replicate.delivery/1.png", "https://replicate.delivery/2.png"] },
      env,
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://replicate.delivery/1.png");
  });

  test("an empty output is an ImageGenError carrying the prediction id", async () => {
    await expect(fetchOutput({ id: "p9", output: null }, env, fetchImpl)).rejects.toMatchObject({
      predictionId: "p9",
    });
  });

  test("an HTTP error on download is an ImageGenError", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(
      fetchOutput({ id: "p", output: "https://replicate.delivery/a.webp" }, env, fetchImpl),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("isTerminalStatus (#268)", () => {
  test("succeeded, failed, canceled and aborted are terminal; starting and processing are not", () => {
    for (const s of ["succeeded", "failed", "canceled", "aborted"])
      expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["starting", "processing", "something-new"])
      expect(isTerminalStatus(s)).toBe(false);
  });
});
