> **Archived 2026-04-22** — superseded by Workers-first architecture in `docs/architecture.md`.
> Kept for historical reference only. Do not follow these instructions for new deploys.

# Self‑hosting on Proxmox with n8n

If you prefer to keep everything under your control, you can run TrailScribe on a Proxmox server using a Docker VM. The simplest approach is to deploy [n8n](https://n8n.io/), an open‑source workflow automation tool, and recreate the Pipedream workflow.

## 1. Set up the Proxmox VM

1. On your Proxmox host, create a new VM (Debian or Ubuntu minimal recommended).
2. Install Docker and Docker Compose:

   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose
   sudo usermod -aG docker $USER
   ```
   Log out and back in to apply the group change.

3. Clone the TrailScribe repository onto the VM or upload the `n8n-docker-compose.yml` file.

## 2. Deploy n8n

1. Use the provided `docker-compose.yml` from `examples/n8n-docker-compose.yml`:

   ```bash
   docker-compose -f examples/n8n-docker-compose.yml up -d
   ```

2. Once running, navigate to `http://<vm-ip>:5678` in your browser. Log in using the credentials defined in the compose file (`admin` / `strongpassword`).

## 3. Create the workflow in n8n

1. Add a **Webhook** node as the trigger. Set the path (e.g. `/trailscribe`) and method `POST`. This node exposes a URL (`http://<vm-ip>:5678/webhook/trailscribe`) that you will configure in Garmin Portal Connect.
2. Add a **Function** node. Use JavaScript to replicate the parsing and orchestrator logic. You can copy the code from `examples/pipedream-steps.md` and adapt it to n8n’s syntax:

   ```js
   const { parseCommand } = require('../src/agent/grammar');
   const { orchestrate } = require('../src/agent/orchestrator');
   const { isDuplicate, markProcessed } = require('../src/runtime/idempotency');
   const { Ledger } = require('../src/runtime/ledger');
   const { loadConfig } = require('../src/config/env');
   const { sendEmail } = require('../src/tools/emailGmail');

   const payload = $json;
   const config = loadConfig();
   const ledger = new Ledger(config);
   if (payload.msgId && isDuplicate(payload.msgId)) {
     return { status: 'duplicate' };
   }
   if (payload.msgId) markProcessed(payload.msgId);
   const parsed = parseCommand((payload.message || '').trim());
   if (!parsed) {
     await sendEmail({ to: payload.sender || config.GMAIL_SENDER, subject: 'TrailScribe Reply', body: 'Unknown command.', config });
     return { status: 'unknown' };
   }
   const result = await orchestrate(parsed, { lat: payload.latitude, lon: payload.longitude, config, ledger });
   await sendEmail({ to: payload.sender || config.GMAIL_SENDER, subject: 'TrailScribe Reply', body: result.body, config });
   return { status: 'ok', body: result.body };
   ```

3. Add **Gmail** and **Todoist** nodes if you prefer to use n8n’s built‑in integrations instead of the stubbed `sendEmail`/`addTask` functions. You can map the outputs of the Function node to these nodes’ inputs.
4. Set environment variables for the workflow by editing the `docker-compose.yml` or passing them directly in the function code (e.g. `process.env.OPENAI_API_KEY`).
5. Save and activate the workflow.

## 4. Configure Garmin

Point your IPC Outbound webhook to `http://<vm-ip>:5678/webhook/trailscribe`. Send a `!ping` message to test. Replies should arrive via email or, if you implement IPC Inbound, via the device’s messaging interface.

## 5. Tips for self‑hosting

- **Back up your n8n data.** The Docker Compose file stores data in a named volume (`n8n-data`). Back up this volume to avoid losing your workflows.
- **Secure the instance.** Enable HTTPS (via a reverse proxy like Traefik or Nginx), update `N8N_BASIC_AUTH_PASSWORD`, and restrict inbound firewall rules.
- **Scale cautiously.** n8n uses Node.js under the hood. If you expect high throughput, consider increasing CPU/memory on the VM or breaking out the webhook handler into a dedicated Node service.