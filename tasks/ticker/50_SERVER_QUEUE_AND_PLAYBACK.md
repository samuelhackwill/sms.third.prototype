# docs/tasks/ticker/50_SERVER_QUEUE_AND_PLAYBACK.md

## Task
Implement server RAM queue + playback orchestrator.

## State (server RAM)
- `TickerQueueRAM[wallId]`: FIFO array of `{ id, text, receivedAt }`
- `CurrentlyPlayingRAM[wallId]`: optional mirror of wall.playing

## Core function
### maybeStartNext(wallId)
- If wall.playing != null: return
- Pop oldest message from queue; if none: return
- Create runId (uuid)
- Emit Streamer event `ticker.measure.request` to admin with:
  - wallId, runId, text, fontConfig, totalWallWidth, speedPxPerSec
- Do NOT set wall.playing yet (needs textWidthPx handshake)

## On run end
- When server scheduled timeout fires:
  - set wall.playing = null
  - call maybeStartNext(wallId)

## Cleanup policy (v1)
- Periodic cleanup job:
  - remove clients with lastSeenAt < now - 10080s
  - optional: if removed clients were ordered, admin will reorder manually

## Done when
- Messages enqueue and play sequentially.
- Next message starts only after current message exits final screen (server timeout based on width + measured text).
