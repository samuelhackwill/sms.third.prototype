# docs/tasks/ticker/10_REPO_STRUCTURE.md

## Task
Add a minimal feature module under `/imports/api/ticker/` and UI under `/imports/ui/pages/`.

## Expected paths
- `/imports/api/ticker/collections.js`
- `/imports/api/ticker/publications.js` (server)
- `/imports/api/ticker/methods.js` (server + stubs on client)
- `/imports/api/ticker/queue.js` (server)
- `/imports/api/ticker/streamerBridge.js` (server, listens to rawLog streamer events)
- `/imports/ui/pages/ticker/ticker.html|js|css`
- `/imports/ui/pages/adminTicker/adminTicker.html|js|css`

## Routing
Using `ostrio:flow-router`:
- `/ticker` -> `TickerPage`
- `/admin/ticker` -> `AdminTickerPage`

## Notes
Keep imports explicit, no global namespace.
