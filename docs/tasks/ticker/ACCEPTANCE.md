# docs/tasks/ticker/90_ACCEPTANCE.md

## Acceptance Criteria (v1)
1. Open ~10 `/ticker` windows on one machine.
2. `/admin/ticker` shows the same number of rectangles, sized proportionally to each window width.
3. Drag & drop reorder updates:
   - clients orderIndex
   - xStart values
   - wall totalWallWidth
4. Press-hold highlight:
   - pressing a rectangle highlights the corresponding `/ticker` window (red border + big shortCode)
   - releasing removes highlight immediately
5. Ingress + queue:
   - when a new message arrives via existing `rawLog.js` Streamer pipeline, it is queued in server RAM.
6. Playback:
   - messages play sequentially (one-at-a-time)
   - next message starts only after previous fully exits the last screen
7. Visual continuity:
   - the text appears as one continuous banner across window boundaries (no per-window desync obvious to the eye)
8. Client subscriptions:
   - `/ticker` subscribes only to `ticker.wall` + `ticker.client.self` (not full client list)
9. Idle state:
   - when `wall.playing` becomes null, `/ticker` renders nothing (or blank background).

## Test script (manual)
- Start Meteor app
- Open admin in one tab
- Open 10 ticker windows, resize them unevenly
- Reorder in admin; verify continuity using a long message
- Trigger highlight on a few
- Inject 3 messages quickly; verify queuing + sequential playback
