# docs/tasks/ticker/20_COLLECTIONS.md

## Task
Create Mongo collections for reactive operational state:
- `TickerClients` (one doc per connected `/ticker` client)
- `TickerWalls` (one doc per wall, default wallId = "default")

Collections live in `/imports/api/ticker/collections.js` and are imported both client+server.

## Schema (informal)
### TickerClients
`_id = clientId` (string)
Fields:
- _id: string
- shortCode: string
- width: number (CSS px)
- height: number (CSS px)
- dpr?: number
- userAgent?: string
- lastSeenAt: Date
- orderIndex?: number
- xStart?: number
- wallId: string (default "default")

### TickerWalls
`_id = wallId` (string), default "default"
Fields:
- _id: string
- layoutVersion: number
- totalWallWidth: number
- speedPxPerSec: number

Highlight:
- highlightClientId?: string
- highlightUntil?: Date (optional v1, can skip if not used)

Currently playing:
- playing?: null | {
    runId: string
    text: string
    startedAtServerMs: number
    speedPxPerSec: number
    textWidthPx: number
    totalWallWidthAtStart: number
    layoutVersionAtStart: number
    estimatedDoneAt: Date
  }

## Requirements
- No client-side direct writes. Server methods only.
- Use CSS pixels for all math.
- Create default wall doc on first join if missing.

## Done when
Collections exist and can be queried reactively from Blaze.
