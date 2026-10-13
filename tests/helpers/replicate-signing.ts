import { createHmac } from "node:crypto";
import { WEBHOOK_SECRET_CACHE_KEY } from "../../src/adapters/ai/replicate-webhook.js";
import type { Env } from "../../src/env.js";

/** Standard Webhooks reference test secret (libraries/javascript/src/webhook.test.ts). */
export const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

/**
 * Sign a body the way Replicate does (Standard Webhooks v1): HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the Base64-decoded part after `whsec_`.
 * Uses node `crypto`, deliberately independent of the WebCrypto code under test.
 */
export function signReplicateBody(
  body: string,
  opts: { secret?: string; id?: string; timestampSec?: number } = {},
): Record<string, string> {
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  const id = opts.id ?? "msg_test_0001";
  const ts = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  };
}

/** Put a signing secret in the cache so verification needs no network. */
export async function seedWebhookSecret(
  env: Env,
  secret = TEST_WEBHOOK_SECRET,
  fetchedAt = Date.now(),
): Promise<void> {
  await env.TS_CACHE.put(WEBHOOK_SECRET_CACHE_KEY, JSON.stringify({ key: secret, fetchedAt }));
}
