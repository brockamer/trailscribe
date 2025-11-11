import { sendEmail } from '../tools/emailGmail';
import { buildGoogleMapsLink, buildMapShareLink } from '../tools/links';
import { Config } from '../config/env';

/**
 * Reply helper for Garmin IPC inbound (or fallback email/SMS).
 *
 * In this project we assume Garmin IPC inbound is handled by another
 * service capable of sending a message back to the originating device.
 * When running on Pipedream or self‑hosted, this helper simply formats
 * the message and delegates to the appropriate transport. When no
 * Garmin inbound channel is available, it falls back to sending an
 * email to the configured sender address.
 */
export async function sendReply(opts: {
  to: string;
  body: string;
  lat?: number;
  lon?: number;
  config: Config;
}): Promise<void> {
  const { to, body, lat, lon, config } = opts;
  let finalBody = body;

  // Append map links when coordinates are present.
  if (typeof lat === 'number' && typeof lon === 'number') {
    const googleMaps = buildGoogleMapsLink(lat, lon, config);
    const mapShare = buildMapShareLink(lat, lon, config);
    finalBody += `\n\n${googleMaps} | ${mapShare}`;
  }

  // In a production implementation, this would call the Garmin IPC
  // Inbound API or a messaging service to send the reply. Since this
  // scaffold runs on infrastructure where Garmin inbound is not
  // available, we send an email as a demonstration fallback. Note
  // that Garmin devices can receive emails (if configured) and the
  // user can choose to forward these messages to their inReach account.
  await sendEmail({
    to,
    subject: 'TrailScribe Reply',
    body: finalBody,
    config,
  });
}