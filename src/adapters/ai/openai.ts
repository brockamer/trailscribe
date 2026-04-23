import type { Env } from "../../env.js";

export interface NarrativeInput {
  note: string;
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
  env: Env;
}

export interface NarrativeOutput {
  title: string;
  haiku: string;
  body: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/**
 * Call OpenAI (model per env.OPENAI_MODEL, default gpt-5-mini) in JSON mode
 * and return a structured narrative plus real token usage for the ledger.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function generateNarrative(_input: NarrativeInput): Promise<NarrativeOutput> {
  throw new Error("generateNarrative: not implemented in Phase 0 — Phase 1 target");
}
