import type { GarminEvent } from "./types.js";

/**
 * Idempotency key derivation (PRD §5).
 *
 * Garmin's IPC Outbound schema has no `msgId`; we derive a composite key from
 * fields the device never duplicates within the retry window:
 *
 *   key = sha256( imei || ":" || timeStamp || ":" || messageCode || ":" || sha256(freeText||payload||"") )
 *
 * TTL on the KV entry is 48h — covers Garmin's fast-retry window (128s plateau)
 * and typical user manual retries with room to spare.
 */
export async function idempotencyKey(event: GarminEvent): Promise<string> {
  const content = event.freeText ?? event.payload ?? "";
  const contentHash = await sha256Hex(content);
  return sha256Hex(`${event.imei}:${event.timeStamp}:${event.messageCode}:${contentHash}`);
}

/** TTL (seconds) on idempotency KV entries — PRD §5. */
export const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 48;

/** Hex-encoded SHA-256 via Web Crypto (available in Workers + Node 20+). */
export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Message-lifecycle record stored under `idem:<key>` (PRD §5).
 * Phase 0 writes `status: "received"`; Phase 1 adds op-level checkpoints.
 */
export interface IdempotencyRecord {
  status: "received" | "processing" | "completed" | "failed";
  receivedAt: number;
  completedAt?: number;
  completedOps?: string[];
  error?: string;
}
