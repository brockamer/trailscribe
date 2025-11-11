import { Config } from '../config/env';

/**
 * Perform a simple web search. This placeholder returns a static
 * message. In production you could integrate with a search API or
 * leverage an LLM to answer open questions. Keep results short and
 * avoid excessive calls to external APIs to conserve credits.
 */
export async function searchWeb(opts: {
  query: string;
  config: Config;
}): Promise<string> {
  const { query } = opts;
  console.log(`[WebSearch] query: ${query}`);
  // TODO: integrate with a real search API or LLM
  return `No results for '${query}' (stub).`;
}