# Off‑grid Runbook

TrailScribe enables remote field operations with minimal connectivity. This runbook summarizes best practices for using the agent when you’re off‑grid.

## Preparation

1. **Charge your devices**. Ensure your Garmin inReach and any backup batteries are fully charged before departing.
2. **Sync contacts**. Confirm that your inReach device has the email address of TrailScribe’s reply channel (e.g. your Gmail address) in its contact list so it can receive responses.
3. **Update environment variables**. Before going off‑grid, verify that your API keys (OpenAI, Todoist, Posthaven) have sufficient quotas and that the `DAILY_TOKEN_BUDGET` is set appropriately.

## Using commands

– **Keep messages short.** Satellite messaging is expensive and slow. Commands should fit in one SMS and responses in two. Avoid asking very broad AI questions when bandwidth is limited.

– **Check status with `!ping` and `!cost`.** Use `!ping` to verify that the agent is online and `!cost` to monitor your monthly usage budget.

– **Drop field notes with `!drop`.** Whenever you encounter something noteworthy (wildlife, water sources, hazards), log it with `!drop note`. The agent timestamps the entry and records your coordinates for later review.

– **Share your location.** Use `!share to:email@example.com On summit` to send your position to a trusted contact. The reply includes both Google Maps and MapShare links so they can see exactly where you are without revealing raw coordinates.

– **Get a brief.** At the end of each day, send `!brief` to receive a five‑line summary of your actions (tasks added, emails sent, posts created, field notes).

## Troubleshooting

– **No reply received?** Garmin may retry message delivery multiple times. The agent ignores duplicates using the `msgId`. If you don’t receive a reply after a few minutes, send `!ping` to confirm connectivity.

– **“Unknown command” reply.** Double‑check the syntax and spacing. Commands are case‑insensitive but require the correct order of arguments.

– **Running out of tokens.** If you exceed your daily or monthly token budget, the agent will still process commands but replies may not include AI results. Adjust `DAILY_TOKEN_BUDGET` when you regain internet access.

## Safety notes

TrailScribe is **not** integrated with SOS or emergency services. Always use your inReach device’s native SOS feature in an emergency. Do not rely on the agent for life‑critical communications.