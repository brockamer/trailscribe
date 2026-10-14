import type { Env } from "../../env.js";
import { sendReply } from "./garmin-ipc-inbound.js";

/** A media attachment for IPC Inbound `/api/Messaging/Media` (#285). */
export interface OutboundMedia {
  mimeType: string;
  bytes: ArrayBuffer;
}

/**
 * Deliver text pages, and later media, to the device (#268 media seam).
 * Pages go to `sendReply` (`/api/Messaging/Message`). The media branch is
 * deliberately unimplemented until the media design (#285) settles encoding.
 */
export async function deliver(
  imei: string,
  payload: { pages: string[]; media?: OutboundMedia },
  env: Env,
): Promise<{ count: number }> {
  if (payload.media !== undefined) {
    // A plain Error on purpose: 16 test files mock garmin-ipc-inbound.js as
    // `{ sendReply }`, so importing IpcInboundError here would read a missing
    // mock export.
    throw new Error("media delivery is not implemented (#285)");
  }
  return sendReply(imei, payload.pages, env);
}
