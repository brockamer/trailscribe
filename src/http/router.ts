import express, { Request, Response } from 'express';

import { parseCommand } from '../agent/grammar';
import { orchestrate } from '../agent/orchestrator';
import { isDuplicate, markProcessed } from '../runtime/idempotency';
import { sendReply } from './reply';
import { loadConfig } from '../config/env';
import { Ledger } from '../runtime/ledger';

/**
 * Type definition for the Garmin IPC outbound payload. Garmin sends a JSON
 * object with a message, identifiers and optional location. We declare only
 * the fields we use here.
 */
interface GarminOutboundPayload {
  /** Unique message identifier provided by Garmin */
  msgId?: string;
  /** Text of the message sent from the device */
  message: string;
  /** Sender name or device identifier */
  sender?: string;
  /** Latitude coordinate if the device included location */
  latitude?: number;
  /** Longitude coordinate if the device included location */
  longitude?: number;
  /** Additional arbitrary properties */
  [key: string]: unknown;
}

/**
 * Create and return an Express app. The app exposes a single POST endpoint
 * that receives Garmin IPC outbound webhooks, parses the command, runs the
 * agent orchestrator, and sends a response back to Garmin or via email.
 */
export function createApp() {
  const app = express();
  app.use(express.json());

  // Load configuration and instantiate a ledger. The ledger is shared
  // across requests to maintain cost tracking.
  const config = loadConfig();
  const ledger = new Ledger(config);

  app.post('/', async (req: Request, res: Response) => {
    const payload = req.body as GarminOutboundPayload;
    // Validate required fields.
    if (!payload || typeof payload.message !== 'string') {
      // Not a message event; ignore quietly.
      return res.status(200).send('ignored');
    }
    const msgId = payload.msgId;
    if (msgId) {
      if (isDuplicate(msgId)) {
        return res.status(200).send('duplicate');
      }
      markProcessed(msgId);
    }
    const parsed = parseCommand(payload.message.trim());
    if (!parsed) {
      // Unknown command; respond with help prompt.
      const body = 'Unknown command. Send !help for a list of commands.';
      await sendReply({
        to: payload.sender ?? config.GMAIL_SENDER ?? '',
        body,
        lat: payload.latitude,
        lon: payload.longitude,
        config,
      });
      return res.status(200).send('ok');
    }
    try {
      const result = await orchestrate(parsed, {
        lat: payload.latitude,
        lon: payload.longitude,
        config,
        ledger,
      });
      await sendReply({
        to: payload.sender ?? config.GMAIL_SENDER ?? '',
        body: result.body,
        lat: result.lat,
        lon: result.lon,
        config,
      });
    } catch (err) {
      console.error(err);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      await sendReply({
        to: payload.sender ?? config.GMAIL_SENDER ?? '',
        body: `Error: ${errMsg}`,
        lat: payload.latitude,
        lon: payload.longitude,
        config,
      });
    }
    return res.status(200).send('ok');
  });
  return app;
}

// If this module is executed directly, start the server. This makes
// development easy with `pnpm dev`.
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`Trailscribe server listening on port ${port}`);
  });
}