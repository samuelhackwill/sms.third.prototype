# docs/tasks/ticker/30_PUBLICATIONS_SUBSCRIPTIONS.md

## Task
Implement publications and matching subscriptions.

## Publications (server)
- `ticker.wall(wallId)` -> publishes the single `TickerWalls` doc
- `ticker.client.self(wallId, clientId)` -> publishes only that client doc
- `ticker.clients(wallId)` -> publishes all clients for that wall (admin)

## Subscriptions (client)
### /admin/ticker
- `ticker.wall("default")`
- `ticker.clients("default")`

### /ticker
- `ticker.wall("default")`
- `ticker.client.self("default", clientId)`

## Constraints
- `/ticker` must not subscribe to full client list.
- Publish only necessary fields; but OK to keep it simple for v1.

## Done when
- Admin sees all clients and wall doc reactively.
- Each ticker client sees only its own client doc + wall doc.
