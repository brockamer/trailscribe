import type { Env } from "../../env.js";

const RESEND_URL = "https://api.resend.com/emails";
const RETRY_DELAYS_MS = [1000, 4000, 16000] as const;

export interface SendEmailArgs {
  to: string;
  subject: string;
  body: string;
  env: Env;
  /** Injectable sleep helper for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * Typed error from Resend. `errorName`/`message` come from Resend's JSON
 * error body when present (e.g. `{ name: "validation_error", message: "..." }`).
 */
export class ResendError extends Error {
  public readonly status: number;
  public readonly errorName?: string;

  constructor(opts: { status: number; message: string; errorName?: string }) {
    super(opts.message);
    this.name = "ResendError";
    this.status = opts.status;
    this.errorName = opts.errorName;
  }
}

interface ResendErrorBody {
  name?: string;
  message?: string;
}

/**
 * Send a transactional email via Resend.
 *
 * α-MVP: plain-text only (`text` field), no HTML rendering. From-line built
 * from `RESEND_FROM_NAME` + `RESEND_FROM_EMAIL` ("TrailScribe <…>"). 4xx
 * errors surface immediately with the parsed Resend error body. 5xx and
 * network errors retry at 1s/4s/16s (initial + 3 retries = 4 attempts).
 *
 * The free `trailscribe@resend.dev` sender doesn't require DNS — Resend owns
 * that domain. Custom-domain sender is Production-readiness #25.
 */
export async function sendEmail(args: SendEmailArgs): Promise<{ id: string }> {
  const { to, subject, body, env } = args;
  const delay = args.delay ?? defaultDelay;
  const from = `${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text: body }),
  };

  let lastErr: ResendError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }

    let res: Response;
    try {
      res = await fetch(RESEND_URL, init);
    } catch (e) {
      lastErr = new ResendError({
        status: 0,
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { id: string };
      return { id: data.id };
    }

    const errBody = await readErrorBody(res);
    const err = new ResendError({
      status: res.status,
      message: errBody.message ?? `HTTP ${res.status}`,
      errorName: errBody.name,
    });

    if (res.status >= 400 && res.status < 500) {
      throw err;
    }
    lastErr = err;
  }

  throw (
    lastErr ??
    new ResendError({ status: 0, message: "send failed without a captured error" })
  );
}

async function readErrorBody(res: Response): Promise<ResendErrorBody> {
  try {
    return (await res.json()) as ResendErrorBody;
  } catch {
    return {};
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
