# Garmin IPC Setup

TrailScribe relies on Garmin’s inReach **IPC Outbound** and **IPC Inbound** services to receive messages from your device and send replies. This guide walks you through configuring both services.

## 1. Portal Connect access

1. Sign in to [explore.garmin.com](https://explore.garmin.com) with your enterprise or professional account.
2. Navigate to **Portal Connect** (sometimes called “inReach Portal Connect”). You may need administrative privileges to access this section.

## 2. IPC Outbound (webhook)

1. In Portal Connect, locate the **IPC Outbound** section and choose **Add Endpoint**.
2. Enter the **Webhook URL** provided by your Pipedream workflow, n8n webhook, or Cloudflare Worker.
3. Select **Event Schema V3 or V4**. Schema V4 includes media attachments; Schema V3 includes only text. TrailScribe uses only the `msgId`, `message`/`freeText`, `latitude` and `longitude` fields from the event. An example event in the documentation shows these fields inside the `point` object and `freeText` message【570752019469997†L679-L706】.
4. Save the endpoint. Garmin will begin sending HTTP POST requests to your webhook whenever your device sends a message.

### Test the webhook

Send a message from your device containing `!ping`. You should see a response from TrailScribe (“pong”) arrive via email or inReach. If you receive duplicates, ensure idempotency is working and that the message ID is being recorded.

## 3. IPC Inbound (replies)

1. In Portal Connect, open the **IPC Inbound API** section. Garmin exposes multiple endpoints (e.g. `/SendMessage`, `/Binary`, `/Media`) for sending messages back to the device【445103924098990†L204-L213】. For simple text replies TrailScribe uses `/SendMessage`.
2. Generate API credentials (client ID/secret) for your application. Store them in your environment variables or secret manager.
3. Configure your reply logic to call `/SendMessage` with the device’s IMEI and your response text. If you choose to use email instead of IPC Inbound, ensure that your inReach device is configured to receive emails from your Gmail account.

## 4. MapShare link

TrailScribe appends your [MapShare](https://share.garmin.com) link to every message when coordinates are present. To enable this:

1. Enable MapShare in your inReach account and set a public MapShare ID.
2. Set the environment variable `MAPSHARE_BASE` to `https://share.garmin.com/<your_mapshare_id>`.
3. When TrailScribe sends a reply with coordinates, recipients can click the MapShare link to view your current position on Garmin’s map.

## 5. Security considerations

- **Authentication:** Garmin sends a shared secret with each webhook request (optional). Configure this in Portal Connect and verify the secret in your webhook code.
- **Encryption:** IPC Outbound supports encrypted payloads. TrailScribe does not currently decrypt encrypted messages. Select the plaintext schema or implement decryption if required.
- **Rate limits:** Garmin may retry delivery if your server returns an error. TrailScribe’s idempotency logic uses `msgId` to ignore duplicates.