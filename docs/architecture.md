# Architecture Overview

TrailScribe is a satellite‑controlled agent that connects your Garmin inReach device to a suite of modern cloud services. The system receives **IPC Outbound** webhooks from Garmin, parses the incoming message, invokes the appropriate tool (OpenAI, Gmail, Todoist, etc.), tracks token usage, and replies back via Garmin IPC Inbound or email.

## High‑level flow

1. **Garmin IPC Outbound** sends an HTTP POST to your webhook URL whenever a message is sent from your inReach device. The payload conforms to Garmin’s Event schema. Each event contains metadata such as `msgId`, `freeText`, `timeStamp`, `point` (latitude/longitude), battery status, and destination addresses【570752019469997†L679-L706】.
2. Your webhook server (deployed on Pipedream, n8n, or a self‑hosted Node server) receives the POST, verifies it hasn’t been processed before (idempotency), and extracts the message text.
3. **Grammar parser** interprets the message. Commands begin with `!` and support a range of actions such as `!todo`, `!mail`, `!drop`, `!post`, `!ai`, `!brief`, etc.
4. The **Orchestrator** dispatches the command to the appropriate tool module. For example, it might call Todoist’s API to create a task, send an email via Gmail, or use OpenAI’s API to answer a question. It also calls the **Context** module to compute nearest location and weather summaries when a position is available.
5. After processing, the Orchestrator composes a concise reply (≤ 2 SMS messages), appends Google Maps and MapShare links when coordinates are present, and updates the **Ledger** with token counts and costs. The Ledger stores monthly usage statistics and implements the `!cost` command.
6. **Reply helper** sends the response back to the device via Garmin IPC Inbound. On Pipedream and self‑hosted setups, replies are delivered via Gmail to the device’s email address as a fallback.

## Modules

- **src/http/router.ts** – Express app that receives Garmin webhooks, handles deduplication, parses commands, runs the orchestrator, and sends replies.
- **src/agent/grammar.ts** – Parses SMS‑style commands (`!ping`, `!todo`, `!mail`, etc.) into structured objects.
- **src/agent/orchestrator.ts** – Implements command dispatch, integrates tools, updates the ledger, and truncates replies to two SMS messages.
- **src/tools** – Individual adapters for Gmail, Todoist, Posthaven, optional web search, and link construction (Google Maps and MapShare).
- **src/runtime/idempotency.ts** – Keeps track of processed `msgId` values to prevent duplicate processing.
- **src/runtime/ledger.ts** – Tracks requests, token usage, and costs within monthly cycles; implements the `!cost` command.
- **src/runtime/context.ts** – Returns a short description of the nearest place and weather given latitude/longitude (stubbed; integrate your own geocoding and weather APIs).
- **src/config/env.ts** – Validates and loads environment variables using `zod`.

## Data formats

Garmin’s IPC Outbound messages follow an Event schema with a `Version` and an array of `Events`. Each `Event` includes fields like `imei` (device ID), `messageCode`, `freeText`, `timeStamp`, `addresses`, and `point` with `latitude`, `longitude`, `altitude`, `course` and `speed`【570752019469997†L679-L706】. Additional fields exist for media events (mediaId, mediaBytes, mediaType) in schema V4【570752019469997†L520-L545】. TrailScribe only requires the `msgId`, `message/freeText`, `latitude` and `longitude` for its operations.

Replies are short strings (≤ 320 characters) and may include map links. When location is present, the reply helper appends a Google Maps link (`https://www.google.com/maps/search/?api=1&query=lat,lon`) and your MapShare link (`https://share.garmin.com/...`) to the message.

## Deployment options

- **Pipedream (primary)** – Use an HTTP trigger and a single Node.js step to handle the webhook. Pipedream’s built‑in Gmail and Todoist connectors send emails and create tasks. See `examples/pipedream-steps.md` for paste‑ready code and tips.
- **Self‑hosted on Proxmox → Docker VM** – Deploy n8n using the provided `docker-compose.yml`. Create a webhook trigger in n8n, then add Gmail/Todoist nodes and a custom function node for parsing and orchestrating commands. See `docs/selfhost-n8n-proxmox.md` for details.
- **Cloudflare Workers + KV** – A minimal option that runs the agent on Cloudflare’s edge. Cost ledger is stored in a KV namespace. See `examples/workers-minimal.md`.

## Cost tracking

The ledger reads the number of input and output tokens for each request and multiplies them by configurable per‑1K token rates. It resets monthly and returns a summary with the `!cost` command. By appending the running total to every reply (configurable via `APPEND_COST_SUFFIX`), you always know your usage and expenses.