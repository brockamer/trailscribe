# Cloudflare Workers + KV Deployment (Minimal)

This example shows how to deploy TrailScribe on the **Cloudflare Workers** free tier with a KV namespace for the cost ledger. Cloudflare Workers are ideal for lightweight webhooks because they run on the edge and have generous free limits.

## Setup

1. **Install Wrangler** if you haven't already:

```bash
npm install -g wrangler
```

2. **Create a new Worker project** in an empty directory:

```bash
wrangler init trailscribe-worker --no-git
cd trailscribe-worker
```

3. **Add a KV namespace** in your `wrangler.toml`:

```toml
kv_namespaces = [
  { binding = "LEDGER_KV", id = "<kv-namespace-id>" }
]

[vars]
OPENAI_API_KEY = "${OPENAI_API_KEY}"
TODOIST_API_TOKEN = "${TODOIST_API_TOKEN}"
POSTHAVEN_TO = "${POSTHAVEN_TO}"
GMAIL_SENDER = "${GMAIL_SENDER}"
GOOGLE_MAPS_BASE = "${GOOGLE_MAPS_BASE}"
MAPSHARE_BASE = "${MAPSHARE_BASE}"
APPEND_COST_SUFFIX = "${APPEND_COST_SUFFIX}"
OPENAI_INPUT_COST_PER_1K = "${OPENAI_INPUT_COST_PER_1K}"
OPENAI_OUTPUT_COST_PER_1K = "${OPENAI_OUTPUT_COST_PER_1K}"
LEDGER_BACKEND = "kv"
```

Replace `<kv-namespace-id>` with the ID of a KV namespace you create via the Cloudflare dashboard.

4. **Write your Worker code** in `src/index.ts`. Use the same parsing and orchestrator logic as the Pipedream example, but replace the in‑memory ledger with one that reads/writes to `LEDGER_KV`. Below is a minimal example:

```ts
import { parseCommand } from './trailscribe/src/agent/grammar';
import { orchestrate } from './trailscribe/src/agent/orchestrator';
import { loadConfig } from './trailscribe/src/config/env';
import { Ledger } from './trailscribe/src/runtime/ledger';
import { sendEmail } from './trailscribe/src/tools/emailGmail';

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    const payload = await request.json();
    const config = loadConfig();
    // Use KV-based ledger
    const ledger = new Ledger(config);
    const parsed = parseCommand((payload.message || '').trim());
    if (!parsed) {
      await sendEmail({ to: payload.sender || env.GMAIL_SENDER, subject: 'TrailScribe Reply', body: 'Unknown command.', config });
      return new Response('ok');
    }
    const result = await orchestrate(parsed, { lat: payload.latitude, lon: payload.longitude, config, ledger });
    await sendEmail({ to: payload.sender || env.GMAIL_SENDER, subject: 'TrailScribe Reply', body: result.body, config });
    return new Response('ok');
  },
};
```

5. **Deploy** the Worker:

```bash
wrangler deploy
```

6. **Configure Garmin** to POST to the Worker’s URL. Garmin will deliver webhooks to your Worker, which will process the commands and reply via email.

**Note:** Cloudflare Workers have a 10 ms CPU time limit on the free tier. Keep your handlers lightweight and consider using the Pipedream or self‑hosted options for more complex logic.