# SMS / iMessage Love-Correspondence System — Project Spec (v0)

## 1. Goal
A show/installation system that ingests audience messages (SMS/iMessage), archives them, and drives three displays:
1) **Stage “bullet chat”** (live, low-latency)
2) **Lobby wall of phones** (offline-capable browsing/cycling)
3) **Multi-phone ticker** (offline-capable synchronized scrolling text)

Primary runtime is **offline-first**. Internet is optional and used mainly for backups.

---

## 2. Source of truth + backups
- **Canonical source of truth:** **Mac mini local database** (MongoDB used by Meteor).
- **Off-site backup:** **MongoDB Atlas** receives periodic exports/snapshots (post-show/daily when internet exists).

---

## 3. Mac mini stack (core node)
### 3.1 Meteor app (single server)
Runs on the Mac mini and contains:

#### A) Scraper #1: Messages.app (prototype path)
- **Purpose:** ingest inbound iMessage/SMS visible in macOS Messages.
- **Implementation:** Node-side “tailer” that reads from local Messages SQLite DB (`chat.db`) or a prototype scraper.
- **Output:** append-only raw log.

#### B) Scraper #2: 4G router SMS API (redundancy path)
- **Purpose:** ingest inbound SMS from a 4G router/modem with an HTTP endpoint (existing server-side JS function).
- **Output:** append-only raw log.

**Phone-number policy**
- Scraper #1 and #2 correspond to two different phone numbers.
- Only **one number is used at a time** (scraper #2 is fallback).
- Still recommended: keep **idempotent insert** logic (safe against operator mistakes or weird duplicates).

### 3.2 Ingestion pipeline (v0)
**Hot path** is intentionally minimal to reduce latency and avoid data loss:
1) Scraper receives message
2) Immediately writes one record to **RAW append-only log**
3) (Later) “log-to-db” step imports log records into Mongo collections

**RAW log format**
- NDJSON file(s)
- One record per received message; never edited or deleted.
- log rotation to avoid file becoming huge.

### 3.3 Optional content checks (future)
- Profanity filter / denylist

---

## 4. Mac mini UI routes
### 4.1 Back office (admin)
Functions:
- View all messages (raw + imported)
- Export RAW log → Mongo (either automatic or a large explicit button)
- Moderation actions:
  - delete / hide
  - flag
  - set “priority” / “featured” for lobby wall or ticker

### 4.2 Front office (stage)
**Bullet chat display**:

- Fullscreen renderer targeting consistent **60 FPS**.
- Implementation recommendation: **PixiJS/WebGL canvas**.
- Consumes a “live feed” publication/endpoint from Meteor and animates messages right→left.

---

## 5. Raspberry Pi nodes (offline micro-nets)
Two Raspberry Pi-based sub-systems, each with:
- A **sync daemon** to fetch updates from the Mac mini when network is available
- A **local web server** to serve phones over local Wi‑Fi and run without internet

### 5.1 Lobby wall node (RPi + router + phones)
- Router creates a captive/local Wi‑Fi network for wall phones.
- RPi serves a local web app: phones load `http://wall.local` (or static IP).
- RPi stores a **local dataset** pulled from Mac mini.

**Local dataset format on RPi**

- Prefer **NDJSON files** on the Pi (simpler than running Mongo on the Pi).
- Web server provides:
  - `GET /playlist` (random/curated set)
  - `GET /message/:id`
  - `GET /health`
- Client caching (Service Worker + cached playlists) so phones keep running through brief outages.

### 5.2 Ticker node (RPi + group of phones)
- Same pattern as lobby wall:
  - Sync daemon pulls a curated text set for the ticker
  - Local web app renders synchronized right→left scroll across multiple phones

**Ticker sync**
- Preferred: the ticker phones join a **self-contained micro-network** and receive timing/offset from the controller (RPi/router).
- Each phone renders its viewport slice based on a shared scroll clock to prevent drift.

---

## 6. Sync model between Mac mini and RPi nodes
### 6.1 When
- During setup (same LAN) and optionally after each show/day.
- No dependency on venue internet.

### 6.2 What
- RPi pulls full “export bundles” from Mac mini

### 6.3 How (recommended)
Avoid direct Mongo replication across the LAN. Use **explicit export/import**:
- Mac mini exports:
  - `messages.ndjson` 
  - `meta.json` (schema_version, created_at, counts, last_message_time)
- RPi daemon downloads bundle over HTTP and swaps dataset.

This keeps the RPi independent from Mongo internals and is easier to debug on tour.

---

## 8. Backup policy (Atlas)
- After each show/day: export a delta bundle + keep on **two rotating small USB Keys**
- When internet is available: upload bundles (or dumps) to **MongoDB Atlas** for off-site redundancy

---

## 9. Data model (minimal)
Each message record should include:
- `id` (UUID)
- `source` (`messages_app` | `router_sms`)
- `phoneNumberId` (`primary` | `fallback`)
- `toPhoneNumber` (number)
- `receivedAt` (timestamp)
- `ingestedAt` (timestamp)
- `sender` (handle/number)
- `body` (text)
- `status` (e.g. `raw`, `imported`, `approved`, `hidden`, `flagged`)
- `priority` (optional)
- `showId` / `venueId` (optional grouping)

---

## 10. Implementation priorities (v0)
1) Scraper #1 and #2 write & rotate RAW NDJSON logs reliably
2) Back office: “Import RAW → Mongo” + basic moderation
3) Stage front office: PixiJS bullet messages at 60 FPS
4) RPi lobby wall: bundle import + web cycling UI + caching
5) RPi ticker: synchronized scroll across phones
6) Atlas + USB backups and restore drill
