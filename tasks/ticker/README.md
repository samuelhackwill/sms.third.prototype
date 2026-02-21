# docs/tasks/ticker/00_README.md

## Goal
Implement v1 of the "phone-wall ticker" prototype in a Meteor 3.4 + Blaze app.

Two routes:
- `/ticker` (client/front office) renders a PixiJS banner slice for each screen.
- `/admin/ticker` (admin/back office) visualizes connected clients, supports drag-drop ordering, highlight-on-press, and controls playback speed + queue.

Message ingress is already emitted via Streamer in `rawLog.js`. We extend server logic to:
- queue messages in RAM
- play one-at-a-time
- request text width measurement from admin client
- publish only a single reactive "now playing" record to clients via Mongo.

## Deliverables
Create/modify:
- Collections: `TickerClients`, `TickerWalls`
- Publications/subscriptions
- Meteor methods for joins, layout ordering, highlight, time sync
- Streamer queue + playback orchestrator on server
- Admin UI with rectangle row, drag-drop, highlight-on-hold, controls, queue status
- Ticker client PixiJS renderer using global timeline + per-client xStart
- Text-width measurement handshake (admin measures, sends to server)

## Out of scope
No auth/security, persistence hardening, reconnection resilience, layout changes mid-run, orientation changes, MIDI/OSC. (v1)

## Definition of Done
Acceptance criteria in `90_ACCEPTANCE.md` passes.
