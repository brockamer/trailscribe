import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

/**
 * Replicate webhook signature verification (#268, spec §7).
 *
 * Replicate signs callbacks per Standard Webhooks v1: headers `webhook-id`,
 * `webhook-timestamp` (seconds) and `webhook-signature` (space-separated
 * `v1,<base64>` entries); HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`
 * keyed with the Base64-DECODED part of the `whsec_…` secret. Replicate's own
 * page does not say "decoded"; the Standard Webhooks reference library does,
 * and the staging check on #268 is to confirm it against a real callback.
 *
 * The secret is fetched with the existing `IMAGE_API_KEY` from
 * `GET /v1/webhooks/default/secret` and cached in `TS_CACHE` with no TTL. A
 * mismatch against a copy older than 10 minutes re-fetches once (rotation);
 * the age gate caps forged requests at one fetch per 10 minutes.
 */

export const WEBHOOK_SECRET_CACHE_KEY = "replicate:webhook-secret";
const SECRET_URL = "https://api.replicate.com/v1/webhooks/default/secret";
const TOLERANCE_SECONDS = 300;
const REFETCH_AFTER_MS = 10 * 60 * 1000;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "stale_timestamp" | "mismatch" | "secret_unavailable" };

interface CachedSecret {
  key: string;
  fetchedAt: number;
}

/**
 * Verify a Replicate callback. `rawBody` must be the exact request text.
 * Never logs the secret or the signature.
 */
export async function verifyReplicateWebhook(
  headers: Headers,
  rawBody: string,
  env: Env,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Date.now;
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing_header" };

  const tsSec = Number(ts);
  if (!Number.isFinite(tsSec) || Math.abs(now() / 1000 - tsSec) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const candidates = sigHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap((entry) => {
      const comma = entry.indexOf(",");
      if (comma < 0) return [];
      return entry.slice(0, comma) === "v1" ? [entry.slice(comma + 1)] : [];
    });
  if (candidates.length === 0) return { ok: false, reason: "mismatch" };

  const signed = `${id}.${ts}.${rawBody}`;

  let secret = await readCachedSecret(env);
  if (secret === undefined) {
    secret = await fetchAndCacheSecret(env, now, opts.fetchImpl);
    if (secret === undefined) return { ok: false, reason: "secret_unavailable" };
  }
  if (await matches(secret.key, signed, candidates)) return { ok: true };
  if (now() - secret.fetchedAt < REFETCH_AFTER_MS) return { ok: false, reason: "mismatch" };

  const fresh = await fetchAndCacheSecret(env, now, opts.fetchImpl);
  if (fresh === undefined) return { ok: false, reason: "secret_unavailable" };
  return (await matches(fresh.key, signed, candidates))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

async function matches(secret: string, signed: string, candidates: string[]): Promise<boolean> {
  let expected: string;
  try {
    const keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
    // WebCrypto rejects a zero-length HMAC key; a secret of exactly "whsec_" is a mismatch.
    if (keyBytes.length === 0) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
    expected = bytesToBase64(new Uint8Array(mac));
  } catch {
    // A secret that is not valid Base64, or that WebCrypto refuses, cannot match.
    return false;
  }
  return candidates.some((c) => constantTimeEqual(c, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readCachedSecret(env: Env): Promise<CachedSecret | undefined> {
  try {
    const raw = await env.TS_CACHE.get(WEBHOOK_SECRET_CACHE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedSecret>;
    if (typeof parsed.key === "string" && typeof parsed.fetchedAt === "number") {
      return { key: parsed.key, fetchedAt: parsed.fetchedAt };
    }
  } catch {
    // Corrupt cache entry: treat as a miss and re-fetch.
  }
  return undefined;
}

async function fetchAndCacheSecret(
  env: Env,
  now: () => number,
  fetchImpl: typeof fetch = fetch,
): Promise<CachedSecret | undefined> {
  let res: Response;
  try {
    res = await fetchImpl(SECRET_URL, {
      headers: { Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    });
  } catch (e) {
    // A fetch rejection carries no response body, so its message is safe to log.
    log({
      event: "replicate_secret_fetch_failed",
      level: "warn",
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
  if (!res.ok) {
    log({ event: "replicate_secret_fetch_failed", level: "warn", status: res.status });
    return undefined;
  }
  let key: unknown;
  try {
    key = ((await res.json()) as { key?: unknown }).key;
  } catch {
    // Never log the parse error: V8 quotes the input, which may hold the secret.
    log({
      event: "replicate_secret_fetch_failed",
      level: "warn",
      status: res.status,
      error: "invalid JSON",
    });
    return undefined;
  }
  if (typeof key !== "string" || key.length === 0) {
    log({
      event: "replicate_secret_fetch_failed",
      level: "warn",
      status: 200,
      error: "no key field",
    });
    return undefined;
  }
  const secret: CachedSecret = { key, fetchedAt: now() };
  try {
    await env.TS_CACHE.put(WEBHOOK_SECRET_CACHE_KEY, JSON.stringify(secret));
  } catch {
    // A failed cache write (e.g. the one-write-per-second limit) must not fail
    // verification; the next callback re-fetches.
  }
  return secret;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
