/**
 * Idempotency helpers. Garmin webhooks may deliver the same message
 * multiple times. To avoid repeated processing we keep an in‑memory
 * set of processed message IDs. In a distributed environment this
 * data should be stored in a shared cache or database (e.g. Pipedream
 * Data Store or Cloudflare KV).
 */

const processedMessages = new Set<string>();

/**
 * Check if a message has already been processed. Returns true when
 * the given ID is found in the processed set.
 */
export function isDuplicate(id: string): boolean {
  return processedMessages.has(id);
}

/**
 * Mark a message as processed by adding its ID to the set.
 */
export function markProcessed(id: string): void {
  processedMessages.add(id);
}