# Quiz - Ticker Task 70 (MCQ, Admin UI)

1. Why does `/admin/ticker` subscribe to both `ticker.wall` and `ticker.clients`?

A) To avoid using Meteor methods  
B) To observe wall runtime state and all connected clients for operations  
C) Because `ticker.wall` contains no fields  
D) To disable reactivity

<details>
<summary>Answer</summary>
B. Admin needs both shared wall state (speed/playing/width) and the full client list to manage layout and controls.
</details>

2. Why are client rectangles scaled proportionally in the admin panel?

A) To match CSS framework constraints  
B) To visually represent relative screen widths/heights and wall composition  
C) To improve Mongo query speed  
D) To avoid drag-and-drop

<details>
<summary>Answer</summary>
B. Proportional scaling helps the operator reason about how the ticker spans across heterogeneous screens.
</details>

3. Why does drag-and-drop eventually call `ticker.setOrder({ orderedClientIds })`?

A) To re-render Blaze templates  
B) To persist canonical order and recompute `xStart` server-side  
C) To generate short codes  
D) To clear queue RAM

<details>
<summary>Answer</summary>
B. The server is authoritative for layout state, so order updates must flow through a method that recomputes placement.
</details>

4. Why is highlight implemented as press-hold (`pointerdown` then clear on release/cancel/leave)?

A) To avoid loading Pixi  
B) To provide temporary identification without requiring extra toggle state management  
C) To bypass subscriptions  
D) To rotate wall IDs

<details>
<summary>Answer</summary>
B. Press-hold gives fast operator feedback and auto-clears when interaction ends, reducing accidental persistent highlights.
</details>

5. Which method is called when pressing a client rectangle?

A) `ticker.setOrder`  
B) `ticker.highlightClient`  
C) `ticker.startRun`  
D) `ticker.enqueueText`

<details>
<summary>Answer</summary>
B. Pointer-down on a client card calls `ticker.highlightClient` with the selected client ID.
</details>

6. Why did highlight appear “broken” before the fix?

A) The admin events were not firing  
B) The method didn’t exist  
C) `/ticker` had no UI bound to `wall.highlightClientId`  
D) The queue was empty

<details>
<summary>Answer</summary>
C. Server state changed correctly, but there was no client-side overlay reacting to that state.
</details>

7. What was added on `/ticker` to make highlight visible?

A) A server publication  
B) A reactive helper checking `wall.highlightClientId === clientId` and a blocking overlay  
C) A new queue method  
D) A static CSS file

<details>
<summary>Answer</summary>
B. The page now derives highlight state reactively from the wall doc and renders an explicit overlay.
</details>

8. Why does admin listen to `ticker.measure.request`?

A) To generate client IDs  
B) To measure text width client-side and complete the `ticker.startRun` handshake  
C) To clear highlights  
D) To subscribe to queue RAM directly

<details>
<summary>Answer</summary>
B. Server can’t reliably measure Pixi text width; admin measures and returns `textWidthPx` via method call.
</details>

9. Which method turns a measurement result into an active run?

A) `ticker.setSpeed`  
B) `ticker.time`  
C) `ticker.startRun`  
D) `ticker.queueStatus`

<details>
<summary>Answer</summary>
C. `ticker.startRun` validates inputs and writes `wall.playing` with scheduling metadata.
</details>

10. Why is queue status fetched via method polling in this stage?

A) Because Mongo cannot store numbers  
B) Queue lives in server RAM, so a method is the simplest read interface for admin UI  
C) To replace publications entirely  
D) To avoid using Streamer

<details>
<summary>Answer</summary>
B. Since queue is not persisted in Mongo for v1, polling a method is a pragmatic way to expose status.
</details>

11. Which method sends a manual random text into the ticker queue?

A) `ticker.startRun`  
B) `ticker.enqueueText`  
C) `ticker.join`  
D) `ticker.clearQueue`

<details>
<summary>Answer</summary>
B. Admin control uses `ticker.enqueueText` (with a random item from `FAKE_MESSAGES`) to inject test content.
</details>

12. Why is `ticker.setSpeed` handled server-side rather than direct client collection updates?

A) To keep write authority centralized and validated  
B) Because Blaze forbids client writes  
C) To skip subscriptions  
D) To avoid wall documents

<details>
<summary>Answer</summary>
A. Server methods enforce authoritative mutation and guard invalid values.
</details>

13. What is the role of `ticker.removeClient` in admin UI?

A) It deletes queue entries  
B) It removes one client doc and triggers layout recomputation  
C) It clears highlights globally  
D) It starts a run immediately

<details>
<summary>Answer</summary>
B. Removing a client updates wall topology, so layout is recomputed after deletion.
</details>

14. Why can `ticker.killClients` be useful in v1 operations?

A) It reindexes Mongo automatically  
B) It quickly resets wall client state when testing or recovering from stale sessions  
C) It accelerates Pixi rendering  
D) It enables auth

<details>
<summary>Answer</summary>
B. It is a practical operator reset control for simulation-heavy workflows.
</details>

15. Why is keeping these controls in methods (not ad-hoc client logic) strategically important?

A) It shortens HTML templates  
B) It makes behavior auditable, reusable, and consistent across admin actions  
C) It removes need for subscriptions  
D) It prevents drag events

<details>
<summary>Answer</summary>
B. Method-based control keeps state transitions explicit and maintainable as the ticker system grows.
</details>
