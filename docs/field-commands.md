# Field Commands

TrailScribe is controlled entirely via short commands sent from your Garmin inReach device. Commands always begin with an exclamation mark (`!`) and should be terse enough to fit in a single SMS. Replies are kept to two SMS messages or less.

## Command summary

| Command | Syntax | Description |
|---|---|---|
| `!ping` | `!ping` | Health check. Replies `pong` to confirm the agent is running. |
| `!where` | `!where` | Returns a short description of your current coordinates and a brief weather summary. Always includes both a Google Maps link and your MapShare link. |
| `!ai` | `!ai <question>` | Sends `<question>` to OpenAI and returns a concise answer. Subject to your daily token budget and 60 s timebox. |
| `!todo` | `!todo <task>` | Adds `<task>` as a new item in your Todoist account. |
| `!mail` | `!mail to:<address> subj:<subject> body:<body>` | Sends an email via Gmail to `<address>` with the given subject and body. Coordinates are automatically removed from the body and replaced with map links. |
| `!drop` | `!drop <note>` | Records `<note>` along with the current date/time and coordinates in a FieldLog (e.g. a spreadsheet or JSON file). Useful for journaling trail observations. |
| `!camp` | `!camp <query>` | Performs a lightweight web search for trail or campsite information related to `<query>` and returns a short summary. |
| `!post` | `!post "Title" body:<text>` | Creates a blog post on Posthaven with the given title and text. The post is also saved as `posts/Title.md` in the repo. |
| `!blast` | `!blast <note>` | Broadcasts `<note>` to a predefined group of contacts (friends/family). |
| `!share` | `!share to:<email> <note>` | Sends `<note>` and your current location to a one‑off recipient via email. |
| `!brief` | `!brief` | Returns a five‑line summary of your activities over the last 24 hours (entries, tasks, messages). |
| `!cost` | `!cost` | Displays the number of requests, total tokens, and cumulative cost since the start of the current month. |
| `!help` | `!help` | Shows this command summary. |

## Notes

- Commands are **case‑insensitive** (`!Todo` and `!todo` behave the same).
- Arguments must follow exactly the order shown above. For example, in `!mail` the `to:`, `subj:` and `body:` segments are mandatory and space‑separated.
- When including a title in `!post`, wrap it in double quotes. The body follows after `body:` and may contain spaces.
- Coordinates are automatically removed from outgoing emails. Instead, both Google Maps and MapShare links are appended to the message so recipients can view your position without exposing raw lat/lon numbers.
- The agent enforces idempotency. If Garmin retries the same message (e.g. due to network errors), duplicates are ignored.