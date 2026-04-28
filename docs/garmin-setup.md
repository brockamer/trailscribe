# Garmin IPC Setup

Configure Garmin's Portal Connect so your inReach Professional device can
send messages to TrailScribe (IPC Outbound) and receive replies (IPC Inbound).

> **Prerequisite: inReach Professional or Enterprise tier.** IPC Outbound and
> IPC Inbound are Professional-tier features. Consumer inReach plans do not
> expose these APIs. If you do not have Professional, the architecture in
> `docs/architecture.md` cannot run as-is.

Authoritative references:
- [`../materials/Garmin IPC Outbound.txt`](../materials/Garmin%20IPC%20Outbound.txt) — v2.0.8
- [`../materials/Garmin IPC Inbound.txt`](../materials/Garmin%20IPC%20Inbound.txt) — v3.1.1

> **Project-owned Garmin Pro tenant.** TrailScribe's Garmin Professional
> tenant is provisioned under the project-owner email
> (`trailscribeapp@gmail.com`), not any contributor's personal inReach
> account. Device user provisioning, Portal Connect config, API keys, and
> billing all live on that tenant. Any legacy Pro tenant on a personal
> email is being migrated to consumer tier — tracked in issue #14.

## 1. Portal Connect access

1. Sign in to [explore.garmin.com](https://explore.garmin.com) with your
   Professional / Enterprise account.
2. Navigate to **Admin Controls → Portal Connect**. Toggle **Inbound
   Settings** on if it is not already.

## 2. Look up your IMEI

Your inReach's 15-digit IMEI is printed on the device (Menu → About →
Device Info) and is also shown in the Portal Connect device list. Add it to
the `IMEI_ALLOWLIST` secret for each environment (comma-separated if you
have multiple devices).

## 3. IPC Outbound (device → TrailScribe)

1. **Portal Connect → IPC Outbound → Add Endpoint.**
2. **URL:** `https://<your-worker>.workers.dev/garmin/ipc`
   (staging + production Workers are separate endpoints — wire each
   environment against the right URL).
3. **Event Schema:** **V2**. V3 adds `transportMode` and V4 adds media; both
   are fine (the Worker tolerates extra fields) but V2 is smallest and matches
   what TrailScribe is tested against.
4. **Authorization:** **Static Token**. Paste the value of
   `GARMIN_INBOUND_TOKEN` (generate via `openssl rand -hex 32`; see
   [`setup-cloudflare.md`](setup-cloudflare.md) §2).
   - Garmin sends this as a raw token in the `X-Outbound-Auth-Token`
     header (not the standard `Authorization: Bearer` form — verified
     empirically against the live Garmin gateway, 2026-04-25). TrailScribe
     verifies it before any side-effect work.
5. **Save.** Send `!ping` from the device to validate — watch `wrangler tail`.

### What the Worker does with the POST

Per event in the envelope:
1. Verify `X-Outbound-Auth-Token: <token>` (Garmin's custom header, not standard `Authorization`).
2. Validate the V2 envelope shape.
3. Confirm `imei` is in the allowlist.
4. Compute composite idempotency key: `sha256(imei : timeStamp : messageCode : sha256(freeText))`.
5. Short-circuit if the key is already present in `TS_IDEMPOTENCY`.
6. Write `{ status: "received", receivedAt }` with 48h TTL.
7. Dispatch to orchestrator (Phase 1) — currently a stub in Phase 0.
8. **Always return 200 OK** — any non-200 triggers Garmin's retry cascade
   (2/4/8/16/32/64/128s for up to 12h; 12h pauses × 5d then service
   suspension). App-level errors are surfaced via IPC Inbound reply, not
   via webhook status.

### Retry / failure behavior (Garmin side)

- Initial retries at 2, 4, 8, 16, 32, 64, 128 seconds on non-200.
- After 12 hours of continuous failure, Garmin pauses delivery for 12h and
  emails the customer contact.
- 5× pause cycles = 5 days of failure → IPC suspension; must contact Garmin
  Support to resume.
- Messages older than 5 days in the queue are dropped.

## 3a. Device-side conventions for the operator

These two device settings were surfaced during the production turn-on and are
worth pinning before the first real `!command` from the field.

**Save TrailScribe as a contact.** Add a contact entry on the inReach (Garmin
Explore app → Contacts → New) named `TrailScribe` with email
`trailscribe@tx.trailscribe.net`. Pick that contact as the recipient for every
outbound `!command`. Mechanically, Portal Connect IPC Outbound forwards
*every* device message to TrailScribe's webhook regardless of the chosen
recipient — but the address still matters because IPC Inbound replies show up
on-device as a thread keyed off the original "To". Sending to the right
address keeps replies visible in one thread.

**Keep "Include Location" off for routine commands.** The per-message
*Include Location* toggle on the Mini 3 Plus, when on, attaches a Google Maps
URL to the displayed reply (cosmetic, device-side; the webhook payload is
unchanged). The URL is unusable on the offline device and wastes display real
estate. Commands that need a GPS fix (`!post`, `!mail`, `!todo`, future
`!where` / `!weather`) read it from the Garmin Outbound `point` field on the
webhook side — the device-side share is redundant.

## 4. IPC Inbound (TrailScribe → device)

1. **Portal Connect → Admin Controls → Portal Connect → Inbound Settings →
   Generate API Key.** Copy the key; this is your `GARMIN_IPC_INBOUND_API_KEY`
   secret. You can have up to 3 active keys simultaneously — useful for
   rotation.
2. **Note the Inbound URL** shown on the Inbound Settings page. Looks like
   `https://<tenant>.inreachapp.com` or `https://enterprise.inreach.garmin.com`.
   Strip the protocol prefix if necessary and store the full base (including
   `/api`) as `GARMIN_IPC_INBOUND_BASE_URL`. E.g.:
   `https://ipcinbound.inreachapp.com/api`
3. TrailScribe POSTs replies to `{base}/Messaging/Message` with
   `X-API-Key: <key>` and a JSON body per the Inbound v3.1.1 contract.

### Critical constraints (from Inbound spec)

- **Message body: 160 characters MAX** per message (Iridium limit; 422
  `InvalidMessageError` on overage). TrailScribe pages longer replies into
  two messages with `(1/2)` / `(2/2)` prefixes.
- **Timestamp:** `"/Date(<ms-since-epoch>)/"` format; cannot be in the
  future; cannot be before 2011-01-01.
- **Response:** 200 OK with `{ "count": N }`. Errors: 401 (key missing), 403
  (key wrong), 422 (well-formed but semantically invalid — check `Code` and
  `Description`), 429 (rate-limited; respect `Retry-After`), 500.
- Each outbound message incurs a small Iridium charge — keep replies terse.

## 5. MapShare (optional)

If you want MapShare links appended to position-bearing replies:

1. Enable MapShare in your inReach account and set a public MapShare ID.
2. Set `MAPSHARE_BASE` var in `wrangler.toml` (and per-env override) to
   `https://share.garmin.com/<your_mapshare_id>`.

If `MAPSHARE_BASE` is empty, the link builder returns empty string and no
MapShare URL is appended.

## 6. Security checklist

- **Bearer token** is sufficient auth for α-MVP; rotate yearly.
- **IMEI allowlist** is defense-in-depth: even with the correct bearer, we
  silently drop events from unregistered IMEIs.
- **IPC Inbound API key** rotation: up to 3 active keys. Generate new →
  update Wrangler Secret → confirm traffic → delete old key.
- **SOS is not touched by TrailScribe.** Emergency declarations go through
  Garmin native + IERCC/GEOS and bypass our Worker entirely.
- **Encrypted messaging (schema V4 encrypted variants):** not handled by
  TrailScribe — configure plaintext schema in Portal Connect.

## 7. Test checklist

After setup, with the staging worker deployed:

- [ ] Send `!ping` from device → reply `pong` arrives within ~30s (Iridium
      latency).
- [ ] `wrangler tail --env staging` shows `event_received` with your IMEI
      and the decoded `freeText`.
- [ ] Re-send the same `!ping` (if Garmin retries, you'll see this
      naturally) → log shows `idempotent_replay`.
- [ ] Intentionally misconfigure the static token at Garmin side and send
      again → log shows `auth_fail` and no KV write.

Only after all four checks pass should you point the production environment
at Garmin.
