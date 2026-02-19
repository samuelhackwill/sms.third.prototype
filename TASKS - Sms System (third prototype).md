# TASKS.md — Sms System (third prototype)

This file turns the project spec into small, PR-sized implementation tasks for a **Meteor + Blaze** repo.
Focus: **simplicity, operability, and offline-first**. No formal test suite; use **code reviews + quizzes**.

---

## Conventions

### Definition of Done (every task)
- Runs locally (Mac mini/dev machine).
- Has a short doc snippet added to `README.md` or `docs/ops.md`.
- Ends with a Codex **code review** request on the PR.
- Adds a quiz: `docs/quizzes/<task-id>.md` with 5–10 questions using `<details>` answers.

### Target repo structure
- `imports/api/…` collections + methods
- `imports/startup/server/…` server boot + jobs
- `imports/startup/client/…` routes + UI boot
- `imports/ui/…` Blaze templates
- `private/…` sample config, fixture bundles
- `scripts/…` backup/export scripts
- `docs/…` operational docs + quizzes

---

## 0) Repo + GitHub bootstrap

### T-000 — Initialize Git repo and Meteor app skeleton
**Goal:** Create the Meteor app and commit a clean baseline.

**Steps**

- `meteor create sms-third-prototype`
- Keep Blaze; remove unused boilerplate.
- Add `.gitignore` (Meteor/Node artifacts).
- Add `README.md` with “run locally” instructions.
- Add tailwind and tailwind config files

**Acceptance**

- `meteor npm install` and `meteor` runs.
- Baseline commit: `chore: initial Meteor app`.

**Quiz**

- `docs/quizzes/T-000.md`

---

### T-001 — Create GitHub repo + minimal PR workflow
**Goal:** Remote repo and a basic PR process.

**Steps**

- Create public GitHub repo called "sms.third.prototype", push `main`.
- Add `.github/pull_request_template.md` with:
  - summary
  - how to test manually
  - checklist (docs/quiz/review)
- Require PR to merge into `main`.

**Acceptance**
- PR template appears on new PRs.

**Quiz**
- `docs/quizzes/T-001.md`

---

## 1) Core data model + collections

### T-010 — Define canonical message collection
**Goal:** Canonical message record in local Mongo.

**Implement**
- Collection: `Messages`
- Fields (minimum):
  - `id` (UUID)
  - `source` (`messages_app` | `router_sms`)
  - `phoneNumberId` (`primary` | `fallback`)
  - `receivedAt`
  - `sender`
  - `body`
  - `status` (`raw` | `imported` | `approved` | `hidden` | `flagged`)
  - `priority` (optional int)
  - `showId` / `venueId` (optional)
- Indexes:
  - `id` unique
  - `receivedAt`, `status`, `source`

**Acceptance**
- Can insert and query from server console.
- Unique index prevents duplicates by `id`.

**Quiz**
- `docs/quizzes/T-010.md`

---

### T-011 — Define ingestion checkpoints collection
**Goal:** Track import position for raw logs.

**Implement**
- Collection: `IngestCheckpoints`
- Fields: `source`, `logFile`, `byteOffset`, `updatedAt`

**Acceptance**
- Checkpoint can be written/read and updated.

**Quiz**
- `docs/quizzes/T-011.md`

---

## 2) RAW log writing (two scrapers)

### T-020 — Implement RAW log writer utility
**Goal:** Append NDJSON records safely and predictably.

**Implement**
- `imports/server/rawLog.js`:
  - `appendRawRecord({ source, phoneNumberId, receivedAt, sender, body, meta })`
  - Writes to: `data/raw/<YYYY-MM-DD>_<source>.ndjson`
  - Ensures directory exists
  - Adds `schema_version` and `ingestedAt`

**Acceptance**
- Each call appends one JSON line.
- New day => new file.

**Quiz**
- `docs/quizzes/T-020.md`

---

### T-021 — Scraper #2: 4G router poller → RAW log
**Goal:** Use existing router code to write raw records.

**Implement**
- `imports/startup/server/jobs/routerPoller.js`
- Interval configurable via settings/env.
- “Active phone” toggle: only run when `activeSource=router_sms`.

**Acceptance**
- With mocked response/dev mode, produces NDJSON lines.
- Can be enabled/disabled via config.

**Quiz**
- `docs/quizzes/T-021.md`

---

### T-022 — Scraper #1: Messages.app prototype poller → RAW log
**Goal:** Prototype ingestion by reading new entries from Messages storage.

**Implement**
- `imports/startup/server/jobs/messagesPoller.js`
- Poll every 100–300ms (configurable).
- Read “new since last” (rowid/date) and append to raw log.
- Read-only; never writes to Messages DB.

**Acceptance**
- With sample DB or dev mode, produces NDJSON lines.
- Doesn’t block Meteor (async IO).

**Quiz**
- `docs/quizzes/T-022.md`

---

## 3) Import worker: RAW log → Mongo

### T-030 — Importer worker (manual trigger)
**Goal:** Import new raw lines into `Messages` idempotently.

**Implement**
- Meteor method: `admin.importRaw({ source, date })`
- Reads file from `byteOffset` checkpoint
- Parses NDJSON line-by-line
- Produces canonical record
- Upserts into Mongo
- Updates checkpoint and returns counts/errors

**Acceptance**
- Re-running import doesn’t duplicate messages.
- Import reports how many lines were processed/inserted/updated.

**Quiz**
- `docs/quizzes/T-030.md`

---

### T-031 — Optional auto-import toggle
**Goal:** Periodic import loop when enabled.

**Implement**
- Config `autoImport=true` and `autoImportIntervalMs`
- If enabled, import current day file for active source

**Acceptance**
- Turning off disables loop (restart acceptable for v0).

**Quiz**
- `docs/quizzes/T-031.md`

---

## 4) Back office (Blaze)

### T-040 — Admin route + minimal access gate
**Goal:** `/admin` route that isn’t public.

**Implement**
- Simple shared password gate (env) OR Meteor Accounts.
- Admin shell page: nav + status panel.

**Acceptance**
- Admin requires auth.
- Shows “scrapers running”, last import time, last raw line time.

**Quiz**
- `docs/quizzes/T-040.md`

---

### T-041 — Admin message list + filters
**Goal:** Browse + filter messages.

**Implement**
- Table with pagination.
- Filters: `status`, `source`, date range, text search.
- Show counts and last received time.

**Acceptance**
- Works with thousands of messages.
- Filters update results.

**Quiz**
- `docs/quizzes/T-041.md`

---

### T-042 — Moderation actions
**Goal:** Curate safely via status/priority.

**Implement**
- Buttons: Approve / Hide / Flag
- Inline `priority` edit
- Soft-delete only (no hard delete)

**Acceptance**
- Actions update UI immediately.

**Quiz**
- `docs/quizzes/T-042.md`

---

### T-043 — “Import now” button + progress output
**Goal:** Manual operator control for importing raw logs.

**Implement**
- Big button calls `admin.importRaw`
- Shows last run, counts, errors

**Acceptance**
- One click imports and updates status panel.

**Quiz**
- `docs/quizzes/T-043.md`

---

## 5) Stage front office: bullet chat

### T-050 — Stage route + PixiJS renderer skeleton
**Goal:** `/stage` fullscreen bullet renderer with fake messages.

**Implement**
- PixiJS canvas, black background
- Lanes, speeds, cleanup of off-screen bullets

**Acceptance**
- Smooth with ~50+ concurrent bullets on target machine.

**Quiz**
- `docs/quizzes/T-050.md`

---

### T-051 — Stage live feed integration
**Goal:** Render live messages from DB.

**Implement**
- Publication/endpoint for “latest messages”
- Config: show `approved` only vs show all imported
- Stage client subscribes and spawns bullets

**Acceptance**
- New imported message appears within ~1s (pipeline-dependent).

**Quiz**
- `docs/quizzes/T-051.md`

---

## 6) Export bundles + offline distribution

### T-060 — Bundle exporter on Mac mini
**Goal:** Export `messages.ndjson` + `meta.json` bundles.

**Implement**
- Server method or CLI script:
  - Full snapshot
  - Delta since timestamp / marker
- Output: `exports/<bundle_id>/messages.ndjson` + `meta.json`

**Acceptance**
- `meta.json` includes: `schema_version`, `created_at`, `counts`, `last_message_time`, `bundle_id`
- Export doesn’t block server badly (chunked stream).

**Quiz**
- `docs/quizzes/T-060.md`

---

### T-061 — Backup procedure to Atlas (manual, minimal)
**Goal:** Document + implement the simplest backup step.

**Implement**
- `scripts/backup/backup_to_atlas.md` with exact steps
- Optional helper script placeholder

**Acceptance**
- A human can follow the doc and perform a backup.

**Quiz**
- `docs/quizzes/T-061.md`

---

## 7) RPi wall node (Pi + router + phones)

### T-070 — RPi wall bundle fetch daemon
**Goal:** Pi pulls bundles from Mac mini when connected.

**Implement**
- `rpi/wall/sync.js`
- Config: Mac mini base URL, polling interval
- Stores under `rpi/wall/data/current/`

**Acceptance**
- Fetches bundle and updates “current” symlink/folder.

**Quiz**
- `docs/quizzes/T-070.md`

---

### T-071 — RPi wall server endpoints
**Goal:** Serve local wall API + static UI.

**Implement**
- Node server (Express acceptable):
  - `GET /playlist?mode=random&limit=50`
  - `GET /message/:id`
  - `GET /health`
- Reads from `current/messages.ndjson` (or SQLite if you choose later)

**Acceptance**
- Endpoints respond reliably on LAN.
- `/health` returns bundle id, counts, last sync time.

**Quiz**
- `docs/quizzes/T-071.md`

---

### T-072 — Wall phone web UI
**Goal:** Autoplay cycling UI.

**Implement**
- Static page served by Pi.
- Fetch playlist, then fetch messages, then loop display.
- Recovery: retry and reload on errors.

**Acceptance**
- Runs unattended for hours.

**Quiz**
- `docs/quizzes/T-072.md`

---

### T-073 — Wall caching (Service Worker)
**Goal:** Survive brief Pi/router outages.

**Implement**
- Cache app shell via Service Worker
- Cache last playlist + some messages via IndexedDB/localStorage

**Acceptance**
- If Pi restarts, phones keep showing cached content temporarily.

**Quiz**
- `docs/quizzes/T-073.md`

---

## 8) RPi ticker node (minimal v0)

### T-080 — Ticker data sync + server
**Goal:** Same pattern as wall, ticker dataset.

**Implement**
- `rpi/ticker/sync.js`
- `rpi/ticker/server.js` providing a scroll clock/feed endpoint

**Acceptance**
- Phones can load ticker UI from Pi.

**Quiz**
- `docs/quizzes/T-080.md`

---

### T-081 — Ticker UI synchronized across phones
**Goal:** Continuity across N phones.

**Implement**
- Each phone configured with `deviceIndex` + `deviceCount`
- Server provides shared `scrollX`/clock
- Phone renders its viewport slice

**Acceptance**
- No obvious drift over minutes.
- Simple config screen for index.

**Quiz**
- `docs/quizzes/T-081.md`

---

## 9) Operational hardening

### T-090 — Configuration system
**Goal:** Centralize settings.

**Implement**
- One config JSON + env overrides:
  - active source (`messages_app` vs `router_sms`)
  - polling intervals
  - raw log paths
  - bundle export paths

**Acceptance**
- Switch active source without code changes.

**Quiz**
- `docs/quizzes/T-090.md`

---

### T-091 — Logging + operator dashboard
**Goal:** Diagnose issues quickly during a show.

**Implement**
- Consistent log prefixes per subsystem
- Admin status panel shows:
  - last router poll
  - last messages poll
  - last raw log append time
  - last import time and counts

**Acceptance**
- Operator can determine “why nothing is showing” quickly.

**Quiz**
- `docs/quizzes/T-091.md`

---

## Parallelization guide (practical)
Run these tracks in parallel to avoid merge conflicts:

- **Track A (ingestion):** T-020, T-021, T-022
- **Track B (import/admin):** T-030, T-040, T-041
- **Track C (stage):** T-050, T-051
- **Track D (RPi wall):** T-070, T-071, T-072
- **Track E (export/backups):** T-060, T-061

Avoid parallelizing tasks that heavily overlap the same files (e.g. all admin tasks at once) unless you plan to rebase/merge carefully.
EOF