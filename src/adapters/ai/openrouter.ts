import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

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
    /** The provider's own stop reason, e.g. Anthropic `refusal` behind `content_filter`. */
    native_finish_reason?: string | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /**
     * USD that OpenRouter charged for this call (#162). Sent on every
     * non-streaming response without a request flag (probed 2026-10-04).
     * Optional because a direct-provider `LLM_BASE_URL` does not send it;
     * the ledger then falls back to the `LLM_*_COST_PER_1K` estimate.
     */
    cost?: number;
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
  /** Names the caller in the `llm_finish_reason` log line (e.g. `brief`, `narrative_post`). */
  label?: string;
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
 *
 * A 200 with `finish_reason: content_filter` and no content is retried once
 * (#270): the provider's safety classifier stops about 1 in 20 identical,
 * benign requests (measured 2026-10-04, `native_finish_reason: refusal`), so
 * the same request usually succeeds next time. The returned `usage` adds both
 * attempts, because the filtered one is billed; `cost` is added only when both
 * attempts carry one, so a partial figure never reaches the ledger. A second filtered answer is
 * returned as-is for the caller to report. Every finish other than `stop`
 * logs one `llm_finish_reason` warn line.
 */
export async function chatCompletion(args: ChatCompletionArgs): Promise<ChatCompletionResponse> {
  const first = await postWithRetry(args);
  logFinish(args, first, 1);
  if (!isEmptyFilter(first)) return first;

  const second = await postWithRetry(args);
  logFinish(args, second, 2);
  return { ...second, usage: addUsage(first.usage, second.usage) };
}

function isEmptyFilter(res: ChatCompletionResponse): boolean {
  const choice = res.choices[0];
  return choice?.finish_reason === "content_filter" && !choice.message?.content;
}

function logFinish(args: ChatCompletionArgs, res: ChatCompletionResponse, attempt: 1 | 2): void {
  const choice = res.choices[0];
  if (!choice || choice.finish_reason === "stop") return;
  log({
    event: "llm_finish_reason",
    level: "warn",
    label: args.label ?? null,
    model: args.req.model,
    finish_reason: choice.finish_reason,
    native_finish_reason: choice.native_finish_reason ?? null,
    max_tokens: args.req.max_tokens ?? null,
    completion_tokens: res.usage?.completion_tokens ?? null,
    attempt,
  });
}

function addUsage(
  a: ChatCompletionResponse["usage"],
  b: ChatCompletionResponse["usage"],
): ChatCompletionResponse["usage"] {
  const sum = {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
  if (a.cost === undefined || b.cost === undefined) return sum;
  return { ...sum, cost: a.cost + b.cost };
}

/** One logical request: the HTTP attempt loop with 5xx/network retries. */
async function postWithRetry(args: ChatCompletionArgs): Promise<ChatCompletionResponse> {
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

  throw (
    lastErr ??
    new LLMError({ status: 0, message: "chatCompletion failed without a captured error" })
  );
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
