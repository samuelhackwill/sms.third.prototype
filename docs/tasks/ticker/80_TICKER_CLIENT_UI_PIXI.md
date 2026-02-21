# docs/tasks/ticker/80_TICKER_CLIENT_UI_PIXI.md

## Task
Build `/ticker` Blaze page that renders PixiJS banner slice.

## Client identity (session-scoped)
On first load:
- clientId = crypto.randomUUID()
- store in sessionStorage.clientId
- shortCode derived from clientId:
  - e.g. hash/hex -> take 5 chars (AB3K7)

## On startup
- Determine wallId = "default"
- Read window.innerWidth/innerHeight in CSS px
- Meteor.call `ticker.join({ wallId, clientId, shortCode, width, height, dpr, userAgent })`
- Subscribe to:
  - ticker.wall(wallId)
  - ticker.client.self(wallId, clientId)

## Resizing
- Debounced resize handler:
  - call ticker.updateSize({ wallId, clientId, width, height })
- Prototype assumes stable sizes; still implement debounce.

## Highlight overlay (blocking)
Reactive:
- if wall.highlightClientId === clientId:
  - show overlay: red border + big shortCode centered
  - block interactions (pointer-events)

## Pixi rendering
- Full-viewport Pixi Application
- Create a world container and a mask the size of viewport.
- When wall.playing is null: clear/hide text.
- When wall.playing exists:
  - Use: text, startedAtServerMs, speedPxPerSec, totalWallWidthAtStart
  - Get xStart from own client doc
  - Per frame:
    - serverNowMs = Date.now() + offsetMs
    - tSec = max(0, (serverNowMs - startedAtServerMs)/1000)
    - scrollX = tSec * speedPxPerSec
    - textWorldX = totalWallWidthAtStart - scrollX
    - text.x = textWorldX - xStart
  - No looping.

## Done when
- With multiple windows ordered in admin, the banner appears continuous across boundaries.
