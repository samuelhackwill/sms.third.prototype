# docs/tasks/ticker/85_TIME_SYNC.md

## Task
Implement lightweight server time sync used by `/ticker` clients.

## Server
Method `ticker.time()` returns `Date.now()`.

## Client
Maintain `offsetMs` estimate:
- periodically (e.g. every 5s):
  - t0 = Date.now()
  - call ticker.time()
  - t1 = Date.now()
  - rtt = t1 - t0
  - estimate serverNowAtT1 ≈ serverTime + rtt/2
  - offsetMs = serverNowAtT1 - t1
- Use `offsetMs` in render loop.

## Done when
- Two clients started at different local times still align reasonably (v1 tolerance).
