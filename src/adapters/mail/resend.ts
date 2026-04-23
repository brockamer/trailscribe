import type { Env } from "../../env.js";

export interface SendEmailArgs {
  to: string;
  subject: string;
  body: string;
  env: Env;
}

/**
 * Send a transactional email via Resend.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function sendEmail(_args: SendEmailArgs): Promise<void> {
  throw new Error("sendEmail: not implemented in Phase 0 — Phase 1 target");
}
