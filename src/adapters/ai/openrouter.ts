import type { Env } from "../../env.js";

const RETRY_DELAYS_MS = [1000, 4000, 16000] as const;

/**
 * Raw chat-completion request shape (OpenAI-compatible — OpenRouter accepts
 * the same JSON envelope and forwards to whichever model `LLM_MODEL` selects).
 *
 * Narrative-specific types live in `src/core/narrative.ts` (P1-05); this
 * adapter knows nothing about narratives, only about the wire format.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  response_format?: { type: "json_schema"; json_schema: unknown };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Typed error from the LLM endpoint. `status` is the HTTP status (0 for
 * network / non-HTTP errors).
 */
export class LLMError extends Error {
  public readonly status: number;

  constructor(opts: { status: number; message: string }) {
    super(opts.message);
    this.name = "LLMError";
    this.status = opts.status;
  }
}

export interface ChatCompletionArgs {
  req: ChatCompletionRequest;
  env: Env;
  /** Injectable sleep helper for tests; defaults to setTimeout. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * HTTPS POST to `${LLM_BASE_URL}/chat/completions` with bearer auth.
 *
 * Merges `LLM_PROVIDER_HEADERS_JSON` (if set) onto the request — OpenRouter
 * uses `HTTP-Referer` + `X-Title` for analytics. 4xx surfaces immediately
 * (caller's prompt or auth is broken; retry won't help). 5xx + network errors
 * retry at 1s/4s/16s (initial + 3 retries = 4 attempts).
 */
export async function chatCompletion(args: ChatCompletionArgs): Promise<ChatCompletionResponse> {
  const { req, env } = args;
  const delay = args.delay ?? defaultDelay;
  const url = `${stripTrailingSlash(env.LLM_BASE_URL)}/chat/completions`;
  const headers = buildHeaders(env);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  };

  let lastErr: LLMError | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_DELAYS_MS[attempt - 1]);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      lastErr = new LLMError({
        status: 0,
        message: `network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as ChatCompletionResponse;
      return data;
    }

    const message = await readErrorMessage(res);
    const err = new LLMError({
      status: res.status,
      message: `HTTP ${res.status}: ${message}`,
    });

    // 4xx is a caller bug (bad model name, bad schema, auth failure) — surface
    // immediately. 5xx and network errors are transient → retry.
    if (res.status >= 400 && res.status < 500) {
      throw err;
    }
    lastErr = err;
  }

  throw lastErr ?? new LLMError({ status: 0, message: "chatCompletion failed without a captured error" });
}

function buildHeaders(env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.LLM_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (env.LLM_PROVIDER_HEADERS_JSON.length > 0) {
    try {
      const extra = JSON.parse(env.LLM_PROVIDER_HEADERS_JSON) as Record<string, unknown>;
      for (const [k, v] of Object.entries(extra)) {
        if (typeof v === "string") headers[k] = v;
      }
    } catch {
      // Ignore malformed JSON — env validation accepts the empty string but
      // not all callers will keep it well-formed; better to send the request
      // without analytics headers than to fail.
    }
  }
  return headers;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
