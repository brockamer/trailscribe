import { describe, test, expect, beforeEach, vi, type Mock } from "vitest";
import { generateImage, ImageGenError } from "../src/adapters/ai/replicate.js";
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

describe("generateImage — happy path", () => {
  test("POSTs to the model predictions endpoint with Prefer: wait, then fetches the output URL", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        predictionResponse({
          id: "pred-1",
          status: "succeeded",
          output: ["https://replicate.delivery/foo.png"],
        }),
      )
      .mockResolvedValueOnce(imageResponse(PNG_BYTES, "image/png"));

    const result = await generateImage({
      prompt: "alpine cirque",
      aspectRatio: "16:9",
      env,
      fetchImpl,
    });

    expect(result.bytes.byteLength).toBe(PNG_BYTES.byteLength);
    expect(result.mimeType).toBe("image/png");
    expect(result.model).toBe(env.IMAGE_MODEL);
    expect(result.costUsd).toBeCloseTo(0.003, 4);

    const [predUrl, predInit] = fetchImpl.mock.calls[0];
    expect(predUrl).toBe(
      `https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`,
    );
    const headers = (predInit as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${env.IMAGE_API_KEY}`);
    expect(headers.Prefer).toBe("wait");
    const body = JSON.parse(String((predInit as RequestInit).body));
    expect(body.input.prompt).toBe("alpine cirque");
    expect(body.input.aspect_ratio).toBe("16:9");

    const [imageUrl] = fetchImpl.mock.calls[1];
    expect(imageUrl).toBe("https://replicate.delivery/foo.png");
  });

  test("output as a single URL string (not an array) is supported", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        predictionResponse({
          id: "pred-1",
          status: "succeeded",
          output: "https://replicate.delivery/single.webp",
        }),
      )
      .mockResolvedValueOnce(imageResponse(PNG_BYTES, "image/webp"));

    const result = await generateImage({ prompt: "x", env, fetchImpl });
    expect(result.mimeType).toBe("image/webp");
  });

  test("aspectRatio is omitted from input when not provided", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        predictionResponse({
          id: "pred-1",
          status: "succeeded",
          output: ["https://replicate.delivery/x.png"],
        }),
      )
      .mockResolvedValueOnce(imageResponse(PNG_BYTES));

    await generateImage({ prompt: "x", env, fetchImpl });
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.input.aspect_ratio).toBeUndefined();
  });
});

describe("generateImage — failure paths", () => {
  test("Replicate 4xx surfaces as ImageGenError with provider response", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response("invalid model version", { status: 422 }),
    );
    await expect(generateImage({ prompt: "x", env, fetchImpl })).rejects.toMatchObject({
      name: "ImageGenError",
      status: 422,
    });
  });

  test("prediction returns status=failed → ImageGenError", async () => {
    fetchImpl.mockResolvedValueOnce(
      predictionResponse({
        id: "pred-1",
        status: "failed",
        error: "model crashed",
      }),
    );
    await expect(generateImage({ prompt: "x", env, fetchImpl })).rejects.toThrow(
      /did not succeed/,
    );
  });

  test("prediction succeeded but empty output → ImageGenError", async () => {
    fetchImpl.mockResolvedValueOnce(
      predictionResponse({
        id: "pred-1",
        status: "succeeded",
        output: [],
      }),
    );
    await expect(generateImage({ prompt: "x", env, fetchImpl })).rejects.toThrow(
      /empty or not a URL/,
    );
  });

  test("image fetch failure (HTTP error) → ImageGenError", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        predictionResponse({
          id: "pred-1",
          status: "succeeded",
          output: ["https://replicate.delivery/foo.png"],
        }),
      )
      .mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(generateImage({ prompt: "x", env, fetchImpl })).rejects.toMatchObject({
      name: "ImageGenError",
      status: 404,
    });
  });

  test("network error contacting Replicate → ImageGenError(status=0)", async () => {
    fetchImpl.mockRejectedValueOnce(new TypeError("connection refused"));
    await expect(generateImage({ prompt: "x", env, fetchImpl })).rejects.toMatchObject({
      name: "ImageGenError",
      status: 0,
    });
  });

  test("rejects non-replicate IMAGE_PROVIDER", async () => {
    const badEnv = makeTestEnv({ IMAGE_PROVIDER: "openai" });
    await expect(generateImage({ prompt: "x", env: badEnv, fetchImpl })).rejects.toThrow(
      /unsupported IMAGE_PROVIDER/,
    );
  });
});

describe("ImageGenError — shape", () => {
  test("name, status, and providerResponse are exposed", () => {
    const err = new ImageGenError({ status: 503, message: "x", providerResponse: "service down" });
    expect(err.name).toBe("ImageGenError");
    expect(err.status).toBe(503);
    expect(err.providerResponse).toBe("service down");
  });
});
