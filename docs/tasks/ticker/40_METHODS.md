# docs/tasks/ticker/40_METHODS.md

## Task
Implement server-authoritative Meteor methods.

## Methods (server)
### ticker.join({ wallId, clientId, shortCode, width, height, dpr, userAgent })
- Upsert TickerClients[clientId]
- Set lastSeenAt = now
- Ensure TickerWalls[wallId] exists with defaults:
  - layoutVersion=1
  - speedPxPerSec default (choose e.g. 120)
  - totalWallWidth=0
  - playing=null

### ticker.updateSize({ wallId, clientId, width, height })
- Update width/height and lastSeenAt

### ticker.heartbeat({ wallId, clientId })
- Update lastSeenAt only

### ticker.setOrder({ wallId, orderedClientIds })
- For each clientId in ordered list:
  - orderIndex = index
- Recompute xStart:
  - xStart[0]=0
  - xStart[i] = xStart[i-1] + width(prev)
- Compute totalWallWidth = sum(width)
- Update wall.totalWallWidth
- wall.layoutVersion += 1

### ticker.highlightClient({ wallId, clientId })
- wall.highlightClientId = clientId

### ticker.clearHighlight({ wallId })
- wall.highlightClientId = null

### ticker.time()
- returns Date.now() (server ms)

### ticker.startRun({ wallId, runId, text, textWidthPx })
- Validate:
  - wall.playing must be null
  - runId must match last requested (optional v1; can skip)
- Read wall speed and totalWallWidth + layoutVersion
- startedAtServerMs = Date.now() + 800
- estimatedDoneAt = startedAt + ((totalWallWidth + textWidthPx)/speed)*1000
- Set wall.playing to payload with *AtStart fields*
- Schedule timeout to clear playing, then call maybeStartNext(wallId)

## Notes
- Admin-only enforcement is out-of-scope; you can leave methods open for v1.
- Keep arguments validated minimally (types + presence) to avoid crashes.

## Done when
Client join/update/order/highlight/time/startRun all work end-to-end.
