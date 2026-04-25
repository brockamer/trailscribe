import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

const MAX_MESSAGE_CHARS = 160;
const RETRY_DELAYS_MS = [1000, 4000, 16000] as const;

/**
 * Typed error surfaced from `sendReply`. `code`/`description` come from
 * Garmin's JSON error body when present (per IPC Inbound v3.1.1 §JSON Error
 * Object). `code`/`description` may be undefined for transport-layer failures
 * (network errors, malformed responses).
 *
 * `status: 0` is a sentinel for "no HTTP request was made" — used for input
 * validation failures (empty messages, message too long) and network errors
 * before any response was received.
 */
export class IpcInboundError extends Error {
  public readonly status: number;
  public readonly code?: number;
  public readonly description?: string;

  constructor(opts: { status: number; message: string; code?: number; description?: string }) {
    super(opts.message);
    this.name = "IpcInboundError";
    this.status = opts.status;
    this.code = opts.code;
    this.description = opts.description;
  }
}

interface SendReplyOpts {
  /**
   * Sleep helper, injectable for tests. Defaults to a real `setTimeout` Promise.
   */
  delay?: (ms: number) => Promise<void>;
}

interface IpcMessageBody {
  Messages: Array<{
    Recipients: string[];
    Sender: string;
    Timestamp: string;
    Message: string;
  }>;
}

interface IpcErrorBody {
  Code?: number;
  Description?: string;
  Message?: string;
}

/**
 * Send a reply to an inReach device via Garmin IPC Inbound.
 *
 * Wire format (per `materials/Garmin IPC Inbound.txt` §POST /Message):
 *   POST {GARMIN_IPC_INBOUND_BASE_URL}/api/Messaging/Message
 *   Headers: X-API-Key, Content-Type: application/json
 *   Body: { Messages: [{ Recipients, Sender, Timestamp: "/Date(ms)/", Message }] }
 *
 * One HTTP request per message in the input array (Garmin's API supports
 * batching but per-message requests give simpler delivery IDs and per-message
 * retry semantics). Each message must be ≤160 chars (Iridium hard cap).
 *
 * Retry policy: 5xx, 429, and network errors retry at 1s/4s/16s delays
 * (initial attempt + up to 3 retries = 4 total per message). 401/403/422
 * surface immediately as typed `IpcInboundError`.
 */
export async function sendReply(
  imei: string,
  messages: string[],
  env: Env,
  opts: SendReplyOpts = {},
): Promise<{ count: number }> {
  if (messages.length === 0) {
    throw new IpcInboundError({
      status: 0,
      message: "sendReply requires at least one message",
    });
  }
  for (const m of messages) {
    if (m.length > MAX_MESSAGE_CHARS) {
      throw new IpcInboundError({
        status: 0,
        message: `Message length ${m.length} exceeds 160-char Iridium cap (caller bug — page-split before calling sendReply)`,
      });
    }
  }

  const delay = opts.delay ?? defaultDelay;
  const url = `${env.GARMIN_IPC_INBOUND_BASE_URL}/api/Messaging/Message`;

  let count = 0;
  for (const message of messages) {
    await sendOne(url, imei, message, env, delay);
    count += 1;
  }
  return { count };
}

async function sendOne(
  url: string,
  imei: string,
  message: string,
  env: Env,
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  const body: IpcMessageBody = {
    Messages: [
      {
        Recipients: [imei],
        Sender: env.IPC_INBOUND_SENDER,
        Timestamp: `/Date(${Date.now()})/`,
        Message: message,
      },
    ],
  };
  const init: RequestInit = {
    method: "POST",
    headers: {
      "X-API-Key": env.GARMIN_IPC_INBOUND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };

  let lastErr: IpcInboundError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = new IpcInboundError({
        status: 0,
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (res.ok) return;

    const errBody = await readErrorBody(res);
    const err = new IpcInboundError({
      status: res.status,
      message: errBody.Message ?? `HTTP ${res.status}`,
      code: errBody.Code,
      description: errBody.Description,
    });

    if (res.status === 401 || res.status === 403) {
      log({
        event: "auth_fail_outbound",
        level: "error",
        status: res.status,
        code: errBody.Code ?? null,
      });
      throw err;
    }
    if (res.status === 422) {
      throw err;
    }

    lastErr = err;
  }

  log({
    event: "reply_delivery_failed",
    level: "error",
    imei,
    status: lastErr?.status ?? null,
    code: lastErr?.code ?? null,
    description: lastErr?.description ?? null,
  });
  throw (
    lastErr ??
    new IpcInboundError({ status: 0, message: "reply delivery failed without a captured error" })
  );
}

async function readErrorBody(res: Response): Promise<IpcErrorBody> {
  try {
    return (await res.json()) as IpcErrorBody;
  } catch {
    return {};
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
