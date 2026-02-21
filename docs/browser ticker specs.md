# Phone Ticker (Simulation → Production) — v1 Specs (Meteor / Blaze / PixiJS)

## 0. Context / Intent
We are extending the existing Meteor app (the one that already ingests messages and emits Streamer events via `rawLog.js`).

Goal: prototype a “phone-wall ticker” on a single computer using **N browser windows** (≈10) as stand-ins for phones. Later, the same front-office route will run on real phones on a LAN.

Core idea: render **one continuous scrolling banner** across multiple independent screens by using a **global timeline** and **per-screen xStart slicing**.

---

## 1. Scope

### In scope (v1)
- Add two routes:
  - `/admin/ticker` (admin back office)
  - `/ticker` (client/front office)
- Clients connecting to `/ticker`:
  - generate a session-scoped `clientId` and shortCode
  - report window size to server (debounced)
  - receive layout assignment (xStart) from admin
  - render ticker text via PixiJS, clipped to their viewport
  - show blocking highlight overlay when requested by admin (red border + big code for 5 seconds)
- Admin UI at `/admin/ticker`:
  - displays a dynamic list of connected clients as proportional rectangles (1/4th of the true pixel size)
  - drag & drop to reorder clients left-to-right (single horizontal row), which dynamically asigns order
  - click a rectangle to “identify” that client (highlight overlay on the client), show on mousedown, hide on mouseup
  - show useragent and code on mouseover (show as tooltip)
  - manage ticker speed (global px/s)
  - show live text traversing the screens as it's happening (monitor)
  - show live queue status
  - clear queue button
- Message flow:
  - new incoming message events (already emitted by `rawLog.js` through Streamer) are **queued**
  - ticker plays messages **one-by-one**
  - next message starts only after the current message has fully exited the last screen

### Explicitly out of scope (v1)
- Production hardening: auth, security, persistence, reconnection resilience
- Layout changes during an active ticker run
- Orientation changes / resizes in production (assumed stable)
- MIDI/OSC control
- Content packs / USB import
- Message looping / repeating / marquee loops

---

## 2. Assumptions / Constraints
- Runs only on LAN.
- meteor 3.4 + blaze.js
- routing by ostrio:flowrouter
- Prototype uses **sessionStorage** only (no persistence across browser restarts).
- “Phones won’t move” in production; no resizing/orientation changes expected.
- Single admin; no authentication for now.
- We use **CSS pixels** for all layout math.

---

## 3. High-level Architecture

### Key concepts
- **Client** = one `/ticker` instance (one browser window or one phone)
- **Wall** = the concatenation of client widths in assigned order
- **World coordinates** = a single horizontal axis spanning the wall width
- **xStart** per client = sum of widths of all clients to its left

### Synchronization model
- **Global timeline**:
  - All clients receive the same `startAtServerMs` and `speedPxPerSec`.
  - Each client computes the same `scrollX(t) = (serverNow - startAtServerMs) * speed`.
  - Each client renders `text.x = initialTextX - scrollX - xStart`.
- **Lightweight time sync**:
  - Clients estimate server time using a simple “ping server time” method.
  - We do not over-engineer drift handling for v1.

---

## 4. Routes / UI

### `/ticker` (Front office client)
- Full-viewport Pixi canvas
- Connect/register with server and report:
  - `clientId`, `shortCode`
  - `width`, `height` (CSS px)
  - optional: `devicePixelRatio`, `userAgent` (for admin hints)
- Displays:
  - Normal: black background (or neutral), no UI
  - Highlight overlay (blocking): big shortCode + red border

### `/admin/ticker` (Admin back office)
- “Connected clients” panel:
  - One rectangle per connected client
  - Rectangle widths are scaled proportionally (visualization)
  - Rectangles arranged in a single horizontal row
  - Drag & drop reorders left-to-right
  - Clicking a rectangle triggers highlight on that client
  - trash single client (top right corner)
- Controls panel:
  - Speed (px/s)
  - send random text button (sends random string from client/pages/stageTestData.js:FAKE_MESSAGES)
  - clear cue
  - kill clients
- Status panel:
  - Current wall width (sum of widths)
  - Current playing message (if any)
  - Queue length

---

## 5. Identity / Storage (Prototype)

### Client ID
- On first load of `/ticker`:
  - generate `clientId` via `crypto.randomUUID()`
  - store in `sessionStorage.clientId`
- Generate `shortCode` derived from `clientId`:
  - Example: base32/hex hash → take 5 chars (e.g. `AB3K7`)
  - shortCode used for display in admin and in highlight overlay

Note: In prototype mode, **sessionStorage ensures each window has its own ID** (unlike localStorage which is shared across windows of same origin).

## 6. Server-side State (Mongo-backed “ephemeral operational state” + Streamer queue)

We use Mongo collections to get Blaze/Meteor reactivity for **layout + runtime state**.
Queueing is **NOT** stored in Mongo in v1: it is handled as **server concern** via **Meteor Streamer + server RAM**.

### Collections

All collections live under `/imports/api/ticker/` and are imported on both client/server.

#### `TickerClients` (one doc per connected client)

`_id = clientId` (string)

Fields:
- `_id: string` (clientId)
- `shortCode: string`
- `width: number` (CSS px)
- `height: number` (CSS px)
- `dpr?: number`
- `userAgent?: string`
- `lastSeenAt: Date`
- `orderIndex?: number` (int; lower = more left)
- `xStart?: number` (derived; CSS px)
- `wallId: string` (for now constant `'default'`)

#### `TickerWalls` (single doc per wall = reactive “runtime + layout”)

`_id = wallId` (string), default `'default'`

Layout + global settings:
- `_id: string`
- `layoutVersion: number`
- `totalWallWidth: number`
- `speedPxPerSec: number` (global setting)

Highlight (admin → single client):
- `highlightClientId?: string`
- `highlightUntil?: Date`

**Currently playing run (the only ticker data phones need):**
- `playing?: null | {`
  - `runId: string`
  - `text: string`
  - `startedAtServerMs: number` (scheduled start)
  - `speedPxPerSec: number`
  - `textWidthPx: number` (measured by admin client)
  - `totalWallWidthAtStart: number`
  - `layoutVersionAtStart: number`
  - `estimatedDoneAt: Date`
  - `}`

### Queue (NOT in Mongo)
Queue is server RAM + admin-only UI state:
- `TickerQueueRAM[wallId]`: FIFO array of `{ id, text, receivedAt }`
- `CurrentlyPlayingRAM[wallId]`: mirrors `TickerWalls.playing` 

### Cleanup policy (v1)

Server periodically deletes:
- clients whose `lastSeenAt < now - 10080s`

(Queue cleanup is automatic because it’s in RAM; on server restart it resets.)

---

## 7. Publications / Subscriptions (reactive UI)

### Publications (server)

- `ticker.wall(wallId)` → publishes the single `TickerWalls` doc
- `ticker.client.self(wallId, clientId)` → publishes **only** that client’s `TickerClients` doc
- `ticker.clients(wallId)` → publishes all `TickerClients` for the wall (**admin only**)

### Subscriptions (client)

- `/admin/ticker` subscribes to:
  - `ticker.wall(wallId)`
  - `ticker.clients(wallId)` (all clients for rectangles)

- `/ticker` subscribes to **minimum only**:
  - `ticker.wall(wallId)` (gets `playing`, `totalWallWidth`, highlight, speed, layoutVersion)
  - `ticker.client.self(wallId, clientId)` (gets `xStart`, own width/height, shortCode)

---

## 8. Methods + Streamer Events (server-authoritative writes)

Clients do not write to collections directly.

### `ticker.join({ wallId, clientId, shortCode, width, height, dpr, userAgent })`
- Upsert `TickerClients[_id=clientId]`
- Set `lastSeenAt = now`
- If no `TickerWalls[wallId]`, create it with defaults:
  - `layoutVersion=1`, `speedPxPerSec=<default>`, `totalWallWidth=0`, `playing=null`

### `ticker.updateSize({ wallId, clientId, width, height })`
- Debounced client-side
- Update width/height + `lastSeenAt`

### `ticker.heartbeat({ wallId, clientId })`
- Update `lastSeenAt` 

### `ticker.setOrder({ wallId, orderedClientIds })` (admin only in practice)
- Assign `orderIndex` based on array order
- Recompute `xStart` for all clients in that order:
  - `xStart[0]=0`
  - `xStart[i]=xStart[i-1] + width(prev)`
- Update `TickerWalls.totalWallWidth`
- Increment `TickerWalls.layoutVersion`

### `ticker.highlightClient({ wallId, clientId })`
- Update `TickerWalls.highlightClientId=clientId`

### `ticker.clearHighlight({ wallId })`

- clears any highlighted client

---

### Queue + playback (event-based, backoffice concern)

We use Streamer for message ingress and for admin/debug visibility. Phones do **not** consume these events.

#### Ingress from `rawLog.js` (existing)
- Server listens to existing Streamer event (make a copy of streamer.emit in `rawLog.js`)
- On each message:
  - push `{id,text,receivedAt}` into `TickerQueueRAM[wallId]` (which lives on the server)
  - call `maybeStartNext(wallId)` (server)

#### `maybeStartNext(wallId)` (server internal)
- If `TickerWalls.playing` is non-null → do nothing
- Else pop oldest from `TickerQueueRAM[wallId]`
- If none → do nothing
- Else request text measurement from admin UI (see below)

#### Text measurement handshake (admin UI provides `textWidthPx`)
Because server can’t measure Pixi text width reliably, the admin client measures and replies.

Flow:
1) Server emits Streamer event (admin-only):
   - `ticker.measure.request` with `{ wallId, runId, text, fontConfig, totalWallWidth, speedPxPerSec }`
2) `/admin/ticker` receives it, measures `textWidthPx` (Pixi Text with the same font settings), then calls:
   - `ticker.startRun({ wallId, runId, text, textWidthPx })`

### `ticker.startRun({ wallId, runId, text, textWidthPx })` (admin-triggered, server validates)
Server:
- Reads current wall doc for:
  - `speedPxPerSec`, `totalWallWidth`, `layoutVersion`
- Computes:
  - `startedAtServerMs = Date.now() + 800`
  - `estimatedDoneAt = startedAt + ((totalWallWidth + textWidthPx)/speedPxPerSec)*1000`
- Updates `TickerWalls.playing = { ... }` with:
  - `runId, text, startedAtServerMs, speedPxPerSec, textWidthPx, totalWallWidthAtStart, layoutVersionAtStart, estimatedDoneAt`
- Schedules a timeout to clear `playing`:
  - at `estimatedDoneAt`: set `TickerWalls.playing = null`, then call `maybeStartNext(wallId)`

> Source of truth for phones is *only* `TickerWalls.playing`.

---

## 9. Admin layout logic (Blaze.js-driven via Mongo)

### Rectangles
Admin UI queries `TickerClients` sorted by `orderIndex` (or by `lastSeenAt` if unassigned).
Rectangles are scaled by:
- `scale = panelWidth / totalWallWidth` (computed in UI)
- `rectWidth = client.width * scale`

### Drag & drop reorder
On drop:
- produce `orderedClientIds`
- call `ticker.setOrder({ wallId, orderedClientIds })`
- use or replicate minimal drag library ux

### Click identify
- On press (mousedown/touchstart) on a rectangle:
  - call `ticker.highlightClient({ wallId, clientId })`

  On release (mouseup/touchend/pointercancel/mouseleave):
  - call `ticker.clearHighlight({ wallId })`

### Measuring text width (admin-only)
Admin listens for `ticker.measure.request`, measures in Pixi, then calls `ticker.startRun(...)`.

---

## 10. Client Highlight behavior (reactive via `TickerWalls`)

Client subscribes to `TickerWalls`.
If:
- `wall.highlightClientId === clientId`
Then:
- show blocking overlay
  - big shortCode
  - red border

Only one active highlight at a time because wall stores a single `highlightClientId`.

---

## 11. Ticker Playback Model (reactive via `TickerWalls.playing`)

- The “current run” is `TickerWalls.playing` (for this wall).
- Client computes:
  - `startAtServerMs = wall.playing.startedAtServerMs`
  - `speedPxPerSec = wall.playing.speedPxPerSec`
  - `totalWallWidth = wall.playing.totalWallWidthAtStart` (v1 assumes stable)
  - `xStart` from `TickerClients[clientId].xStart`
  - `text = wall.playing.text`

When `wall.playing` becomes `null`, client renders nothing (idle).

---

## 12. PixiJS Rendering (Global Timeline Slice)

Each client renders only its slice:

- Create Pixi app sized to window.
- Create a container `world`.
- Add `PIXI.Text` with the playing message.
- Apply a mask rectangle covering the viewport.

Per frame (when `wall.playing` exists):
- `serverNowMs = Date.now() + offsetMs` (from time sync)
- `tSec = max(0, (serverNowMs - startAtServerMs) / 1000)`
- `scrollX = tSec * speedPxPerSec`
- `textWorldX = totalWallWidth - scrollX`
- `text.x = textWorldX - xStart`

No looping.

---

## 13. Time Sync (lightweight, method-based)

Method:
- `Meteor.methods({ 'ticker.time'() { return Date.now(); } })`

Client periodically:
- measures RTT
- estimates offset
- uses offset in render loop

No heavy smoothing required for v1.

---

## 14. Message source integration (`rawLog.js`)

Existing pipeline emits Streamer events when messages arrive.
v1 approach:
- Server listens to that existing event and:
  - pushes into `TickerQueueRAM['default']`
  - triggers `maybeStartNext('default')`

Everything else:
- Layout + “currently playing” are Mongo-reactive (`TickerClients`, `TickerWalls`)
- Queue is event-based + RAM + admin-only measurement loop

---

## 15. Acceptance Criteria (v1)

1. Open 10 `/ticker` windows (simulation).
2. `/admin/ticker` shows 10 rectangles with proportional widths, reactive.
3. Drag & drop reorders them; `xStart` updates; wall width updates.
4. Clicking a rectangle highlights the corresponding client (blocking overlay + big code).
5. Incoming messages enqueue automatically from `rawLog.js` source (server RAM queue).
6. Messages play sequentially; each message appears continuous across window boundaries.
7. Phones subscribe only to:
   - `ticker.wall`
   - `ticker.client.self`
   (no queue subscription)
8. No loops; each message runs once and finishes after it exits the last screen (server timeout based on wall width + measured text width).

