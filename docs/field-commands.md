# Field Commands

TrailScribe is controlled entirely via short commands sent from your Garmin inReach device. Commands always begin with an exclamation mark (`!`) and should be terse enough to fit in a single SMS. Replies are kept to two SMS messages or less (≤320 characters total, per PRD §2).

## Recipient

Send every `!command` to **`trailscribe@tx.trailscribe.net`** (matches `IPC_INBOUND_SENDER` in `wrangler.toml`). Save it once on the device as a contact named `TrailScribe` and pick that contact for every outbound message — Garmin's Portal Connect tenant relays *every* outbound message to TrailScribe's webhook regardless of recipient, but using the right address makes replies thread correctly on the device.

Keep the device's per-message **Include Location** toggle **off** for routine `!command` traffic — the Worker reads GPS from the Garmin Outbound webhook payload, so the device-side share is redundant and pollutes the displayed reply with a Google Maps URL the Mini 3 Plus can't open offline.

## Command summary

| Command | Syntax | Description |
|---|---|---|
| `!ping` | `!ping` | Health check. Replies `pong` to confirm the agent is running. |
| `!help` | `!help` | Shows the command summary on-device. |
| `!cost` | `!cost` | Displays the number of requests, total tokens, and cumulative cost since the start of the current month. |
| `!post` | `!post <note>` | Generates a journal post (title + haiku + body) via OpenRouter and commits it to the GitHub Pages journal repo. Reply links to the live URL. |
| `!postimg` | `!postimg <caption>` | Same as `!post` plus an AI-generated header image. Image-gen via Replicate Flux schnell; markdown + image commit atomically to the journal repo. |
| `!mail` | `!mail (to\|t):<address> [(subj\|s):<subject>] [(body\|b):<body>]` | Sends an email via Resend to `<address>`. Long keys (`to:`/`subj:`/`body:`) and short aliases (`t:`/`s:`/`b:`) are interchangeable and may be mixed in one message. `subj` and `body` are optional — missing subject defaults to `[TrailScribe]`; missing body yields a footer-only email. Location footer added automatically when GPS is available. |
| `!todo` | `!todo <task>` | Creates a Todoist task with `<task>` as the title. Reply includes the public Todoist URL. |
| `!where` | `!where` | Reverse-geocodes the current GPS fix; reply names the place plus a Google Maps link (and a MapShare link if `MAPSHARE_BASE` is configured). |
| `!weather` | `!weather` | Returns the current Open-Meteo conditions for the current GPS fix (e.g. `42°F, 8mph, clear`). |
| `!drop` | `!drop <note>` | Appends a structured FieldLog entry tagged with the current timestamp + GPS. Reply: `Logged: <preview>. (<N> entries)`. |
| `!brief` | `!brief [Nd]` | LLM summary of the last 24 hours of FieldLog entries (or the last `Nd` days). Replies on-device if it fits 320 chars; longer summaries route to email. |
| `!ai` | `!ai <question>` | Open-ended LLM Q&A via OpenRouter. Reply paged to two SMS if it fits; longer answers route to email. |
| `!camp` | `!camp <query>` | LLM-only outdoors-knowledge lookup (camping, water sources, features) prefixed with `(may be outdated)` since there's no real-time web search. Overflow → email. |
| `!share` | `!share to:<addr\|alias> <note>` | One-off enriched email via Resend to a single recipient. `<addr\|alias>` is either a literal email or an alias from the address book (`ADDRESS_BOOK_JSON`). |
| `!blast` | `!blast <note>` | Broadcast enriched email to the address book's `all` group. Per-recipient errors tolerated; reply summarizes successes vs. failures. |

## Notes

- **Case-insensitive.** `!Todo` and `!todo` behave the same; the leading exclamation mark is required.
- **Argument order is fixed.** For `!mail`, only `to:` (or `t:`) is required; if present, `subj:`/`s:` must precede `body:`/`b:`. For `!share`, `to:` is required.
- **Reply budget is sacred (≤320 chars total, two SMS).** Commands that produce longer content (`!post`, `!postimg`, `!brief`, `!ai`, `!camp`) page within the budget where the content fits and otherwise route to email or the journal post; a short device pointer ("see email" / "see journal") goes back to the Mini.
- **Idempotency.** Garmin retries the same Outbound webhook on transient errors (2/4/8/16/32/64/128s, then 12h pauses for up to five days). The agent derives a per-event composite key (`sha256(imei + timeStamp + messageCode + content_hash)` per PRD §5) and short-circuits replays at both the app layer (`withCheckpoint`) and the per-command storage layers (FieldLog `id`, idempotency cache).
- **Daily token budget.** LLM-bearing commands (`!post`, `!postimg`, `!brief`, `!ai`, `!camp`) honor `DAILY_TOKEN_BUDGET=50000`. When exceeded, the command short-circuits with a canned cap message rather than burning more spend.
- **No-GPS-fix path.** Location-dependent commands (`!where`, `!weather`, location enrichment for `!post`/`!mail`/`!share`/`!blast`/`!drop`) accept `undefined` lat/lon and degrade gracefully — typically replying `Need GPS fix — try again outdoors.` rather than guessing.
- **SOS goes through Garmin native, not TrailScribe.** Emergency declarations bypass the Worker entirely and route to IERCC/GEOS.
