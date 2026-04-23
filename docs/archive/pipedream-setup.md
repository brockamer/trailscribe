> **Archived 2026-04-22** — superseded by Workers-first architecture in `docs/architecture.md`.
> Kept for historical reference only. Do not follow these instructions for new deploys.

# Pipedream Setup

Pipedream is the primary deployment target for TrailScribe because it offers generous free credits and built‑in connectors for Gmail and Todoist. This document outlines how to set up TrailScribe on Pipedream with a single workflow.

## 1. Create the workflow

1. Log in to [pipedream.com](https://pipedream.com) and click **New Workflow**.
2. Choose **HTTP / Webhook** as the trigger. Copy the generated URL – this will be used as your Garmin IPC Outbound endpoint.

## 2. Add the Node.js step

1. After the trigger, click **+** and select **Run Node.js code**.
2. Paste the code from `examples/pipedream-steps.md`. This code:
   - Loads your environment configuration using the `loadConfig` helper.
   - Checks for duplicate messages using `msgId`.
   - Parses commands using the grammar module.
   - Dispatches commands to the orchestrator.
   - Sends a reply via Gmail using Pipedream’s integration.
3. Click **Deploy**. When prompted, connect your Gmail and Todoist accounts. Pipedream will ask for OAuth consent; follow the prompts.

## 3. Configure environment variables

1. In the workflow editor, open the **Environment Variables** tab.
2. Add the variables listed in `examples/env.example` (e.g. `OPENAI_API_KEY`, `TODOIST_API_TOKEN`, `GMAIL_SENDER`, `GOOGLE_MAPS_BASE`, `MAPSHARE_BASE`, `APPEND_COST_SUFFIX`, etc.).
3. For cost tracking, set realistic values for `OPENAI_INPUT_COST_PER_1K` and `OPENAI_OUTPUT_COST_PER_1K` (e.g. 0.0015 and 0.0020). Leave `DAILY_TOKEN_BUDGET` at `0` if you don’t want a hard cap.

## 4. Garmin configuration

Follow the steps in `docs/garmin-setup.md` to point your inReach device’s IPC Outbound service to the Pipedream webhook URL. Send a test message (`!ping`) from your device. A reply should arrive via email.

## 5. Low‑cost design tips

- **Consolidate steps.** Keep logic inside the Node step to avoid multiple Pipedream invocations.
- **Exit early.** If the payload has no message or is a duplicate, return immediately to save credits.
- **Short timeouts.** Pipedream charges credits based on execution time. Use `context.callbackWaitsForEmptyEventLoop = false` and exit once you’ve sent the reply.
- **Avoid polling.** All communication from Garmin is push‑based. Do not schedule cron jobs or loops that waste credits.

## 6. Monitoring and logs

Pipedream automatically logs each invocation. Use the **Inspect** tab to view request payloads, replies, and any errors. If you see repeated failures, verify that your environment variables are set correctly and that your Gmail/Todoist connectors are authorised.