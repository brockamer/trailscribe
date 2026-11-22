# Garmin event fixtures

## Recorded events

`recorded-v4-ping-satellite.json` is a complete V4 webhook captured from production
on 2026-11-04 for [#284](https://github.com/brockamer/trailscribe/issues/284).
The operator sent `!ping` with Bluetooth off and confirmed receipt of `pong`.
The event reports `transportMode: "Satellite"`.

The complete 409-byte request fit within `ipc_received.rawBodySample`, so the
fixture comes from the live Worker log rather than a reconstructed payload.
IMEI, recipient address, coordinates, altitude, course, and speed are replaced
with synthetic values. The event timestamp, field layout, and other values are
preserved. These redacted position values are not observations from the device.

The Worker received the webhook at 18:19:34.006 UTC and logged `reply_sent` at
18:19:35.446 UTC (1.440 seconds later). A mailbox-check event (`messageCode: 20`)
arrived at 18:29:48.677 UTC. The operator later confirmed that `pong` arrived
after a manual message check outdoors. Both sky visibility and the manual check
changed, so this run does not isolate their effects. The exact device receive
time was not recorded.

This baseline does not establish the long-text or media behavior required by
#284. No application code or configuration was changed to capture it.

`recorded-v4-media-id-only-satellite.json` is a complete 373-byte webhook logged
at 19:57:40.958 UTC on 2026-11-04 during the same probe session. It carries
`messageCode: 1`, `transportMode: "Satellite"`, and a `mediaId`, with empty
`freeText` and no `mediaBytes`, `mediaType`, or transcription. The ID did not match
the earlier small-image upload's returned ID, so its meaning and relationship to
the probe are unconfirmed. This is not a captured phone-originated photo or voice
note. The Worker logged its media metadata and dropped it as non-free-text.

The complete webhook fit within `ipc_received.rawBodySample`. IMEI, recipient
addresses, media ID, coordinates, altitude, course, and speed are synthetic;
timestamp, schema, and other values are preserved. The tracked Outbound 2.0.10
guide labels message code 1 as reserved; retain the observed value.

The live results table for text and media sends is on
[#284](https://github.com/brockamer/trailscribe/issues/284#issuecomment-6639362208).

## Specification examples

`v4-media-audio.json` and `free-text-internet-multi-imei.json` were built from the
IPC specification for #282. They are not recorded device probes. The audio bytes
in the specification example are truncated and do not form a playable clip.
