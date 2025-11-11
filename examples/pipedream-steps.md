# Pipedream Workflow Setup

This example shows how to deploy TrailScribe on the **Pipedream** free tier using a single workflow with two steps: an HTTP trigger and a Node.js step that handles the command, executes the agent, and sends a reply via Gmail. Keeping the logic in a single Node step reduces credits consumed by Pipedream.

## Step‑by‑step

1. **Create a new workflow** in your Pipedream dashboard.
2. **Add an HTTP trigger**. Copy the public URL – this will be used as your Garmin IPC *Outbound* webhook URL.
3. **Add a Node.js step** immediately after the trigger. Paste the following code. It parses the incoming message, runs the command orchestrator, and sends the reply via Gmail:

```js
import { loadConfig } from 'trailscribe/dist/config/env';
import { parseCommand } from 'trailscribe/dist/agent/grammar';
import { orchestrate } from 'trailscribe/dist/agent/orchestrator';
import { isDuplicate, markProcessed } from 'trailscribe/dist/runtime/idempotency';
import { Ledger } from 'trailscribe/dist/runtime/ledger';
import { sendEmail } from 'trailscribe/dist/tools/emailGmail';

export default async function handler(event, steps) {
  const payload = event.body || {};
  // Only process messages containing text
  if (typeof payload.message !== 'string') {
    return { status: 'ignored' };
  }
  const config = loadConfig();
  const ledger = new Ledger(config);
  const msgId = payload.msgId;
  if (msgId && isDuplicate(msgId)) {
    return { status: 'duplicate' };
  }
  if (msgId) markProcessed(msgId);
  const parsed = parseCommand(payload.message.trim());
  if (!parsed) {
    await sendEmail({
      to: payload.sender || config.GMAIL_SENDER,
      subject: 'TrailScribe Reply',
      body: 'Unknown command. Send !help for a list of commands.',
      config,
    });
    return { status: 'unknown' };
  }
  const result = await orchestrate(parsed, {
    lat: payload.latitude,
    lon: payload.longitude,
    config,
    ledger,
  });
  await sendEmail({
    to: payload.sender || config.GMAIL_SENDER,
    subject: 'TrailScribe Reply',
    body: result.body,
    config,
  });
  return { status: 'ok', body: result.body };
}
```

4. **Connect Gmail** to the workflow. In the code above, `sendEmail` calls Pipedream’s built‑in Gmail connector. Ensure you've added the Gmail integration to your account and authorised it. Map `to`, `subject` and `body` fields as shown.
5. **Set environment variables** in the workflow’s *Environment* tab. Copy them from your `.env` file (see `examples/env.example`).
6. **Save** the workflow. Garmin will POST events to the HTTP trigger URL. The Node step will handle them and send replies via Gmail.

## Low‑credit design tips

- **Single Node step:** Consolidate parsing, orchestration and email sending into one step to avoid multiple Node executions.
- **Short timeouts:** Pipedream charges credits per execution time. Use conservative timeouts (e.g. 30 seconds) and exit early if the payload lacks a command.
- **No polling:** All events come via the HTTP trigger; avoid polling external services.
- **Early exits:** If `msgId` has already been processed, return immediately.