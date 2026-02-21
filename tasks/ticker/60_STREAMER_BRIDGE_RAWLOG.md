# docs/tasks/ticker/60_STREAMER_BRIDGE_RAWLOG.md

## Task
Listen to existing Streamer event(s) emitted by `rawLog.js` and enqueue for ticker.

## Requirements
- Identify the Streamer channel/event name already emitted by rawLog pipeline.
- On each incoming message:
  - push `{ id, text, receivedAt }` into `TickerQueueRAM["default"]`
  - call maybeStartNext("default")

## Notes
- Keep this bridge isolated in `/imports/api/ticker/streamerBridge.js`.
- If multiple message types exist, filter to only what should appear on ticker.

## Done when
Sending/receiving a message from the existing pipeline results in a queued ticker run.
