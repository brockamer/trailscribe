import type { Env } from "../../env.js";

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
 * Thin HTTP wrapper around the OpenRouter chat-completions endpoint.
 *
 * Reads `env.LLM_BASE_URL` (default `https://openrouter.ai/api/v1`) and
 * `env.LLM_API_KEY`. If `env.LLM_PROVIDER_HEADERS_JSON` parses as an object,
 * its keys are merged in — used for OpenRouter's `HTTP-Referer` + `X-Title`
 * analytics headers.
 *
 * Stub in Phase 0 — real implementation in P1-05.
 */
export async function chatCompletion(
  _req: ChatCompletionRequest,
  _env: Env,
): Promise<ChatCompletionResponse> {
  throw new Error("chatCompletion: not implemented in Phase 0 — P1-05 target");
}
