import type { Env } from "../../env.js";

/**
 * Send a reply message to an inReach device via Garmin IPC Inbound
 * (POST {base}/api/Messaging/Message; auth via X-API-Key header).
 *
 * Stub in Phase 0 — real implementation in Phase 1 (P1-XX).
 * Per PRD §4: message body ≤160 chars; paging to a second message for content
 * that exceeds one SMS; retry 1s/4s/16s on 5xx then give up.
 */
export async function sendReply(_imei: string, _message: string, _env: Env): Promise<void> {
  throw new Error("sendReply: not implemented in Phase 0 — Phase 1 target");
}
