import type { Env } from "../../env.js";

export interface PublishPostArgs {
  title: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  env: Env;
}

export interface PublishPostResult {
  url: string;
}

/**
 * Publish a journal entry by committing a markdown file to the journal repo
 * via GitHub Contents API.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function publishPost(_args: PublishPostArgs): Promise<PublishPostResult> {
  throw new Error("publishPost: not implemented in Phase 0 — Phase 1 target");
}
