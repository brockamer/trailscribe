import { Config } from '../config/env';

/**
 * Create a blog post via Posthaven's email interface. The environment
 * variable POSTHAVEN_TO must be set to the unique email address for
 * your Posthaven account. This stub logs the post details. When
 * deployed on Pipedream, you would call the Gmail connector to send
 * an email to Posthaven.
 */
export async function createPost(opts: {
  title: string;
  body: string;
  config: Config;
}): Promise<void> {
  const { title, body } = opts;
  console.log(`[Posthaven] title:${title} body:${body}`);
  // TODO: send an email to POSTHAVEN_TO with the given title/body
}