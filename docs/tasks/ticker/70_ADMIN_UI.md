# docs/tasks/ticker/70_ADMIN_UI.md

## Task
Build `/admin/ticker` Blaze page.

## UI sections
### Connected clients panel
- Display one rectangle per client, proportional width (scale factor ~ 1/4 true size or computed to fit panel)
- Arrange rectangles in one horizontal row
- Tooltip on hover: show userAgent and shortCode
- Delete/trash button per client (optional v1 control; if implemented, call a method to remove client doc)

### Drag & drop reorder
- Drag rectangles left/right; on drop compute orderedClientIds and call:
  - `ticker.setOrder({ wallId, orderedClientIds })`

### Press-hold highlight
- On pointerdown/mousedown/touchstart on rectangle:
  - call `ticker.highlightClient({ wallId, clientId })`
- On pointerup/touchend/pointercancel/mouseleave:
  - call `ticker.clearHighlight({ wallId })`

### Controls panel
- Speed control (px/s):
  - If you implement, store it in `TickerWalls.speedPxPerSec` via method (add `ticker.setSpeed` if needed)
- "Send random text" button:
  - pulls from `client/pages/stageTestData.js:FAKE_MESSAGES` and injects into queue (method or server helper)
- "Clear queue" button:
  - clears RAM queue (needs a server method)
- "Kill clients" button (optional v1)

### Status panel
- totalWallWidth
- currently playing message
- queue length (server should expose queue length somehow; simplest: Streamer event to admin or a method `ticker.queueStatus()` polled)

## Measurement role (admin)
Admin listens for Streamer `ticker.measure.request`:
- Create Pixi Text with same fontConfig used on ticker clients
- Measure width => textWidthPx
- Call `ticker.startRun({ wallId, runId, text, textWidthPx })`

## Done when
- Admin can reorder clients, highlight a client on hold, and see status updating live.
- Admin performs measurement handshake so playback starts.
