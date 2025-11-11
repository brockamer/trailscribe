import { Config } from '../config/env';

/**
 * Send an email via Gmail. In production this would use the Gmail API
 * or a Pipedream connector. This stub simply logs the email to the
 * console. When running on Pipedream, you would use the Gmail
 * integration provided by Pipedream to send an email.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  config: Config;
}): Promise<void> {
  const { to, subject, body } = opts;
  console.log(`[Gmail] to:${to} subj:${subject} body:${body}`);
  // TODO: implement actual Gmail API call or Pipedream action.
}