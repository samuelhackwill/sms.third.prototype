# Quiz - Ticker Task 40 (MCQ, Methods)

1. Why is `ticker.join` responsible for ensuring a wall document exists?

A) To avoid creating Mongo collections manually  
B) To guarantee later methods always have a wall state to update  
C) To disable reactivity  
D) To force admin login

<details>
<summary>Answer</summary>
B. Creating the wall on first join prevents downstream method failures and keeps wall state initialization deterministic.
</details>

2. Why does `ticker.setOrder` recompute both `xStart` and `totalWallWidth`?

A) Because Mongo requires both fields  
B) So each client knows its viewport slice and the server can compute run duration correctly  
C) To speed up subscriptions only  
D) To generate short codes

<details>
<summary>Answer</summary>
B. `xStart` defines per-client placement in the global wall, while `totalWallWidth` is needed for accurate playback timing.
</details>

3. What is the purpose of `ticker.time()`?

A) It starts a ticker run  
B) It returns server time for lightweight client offset estimation  
C) It clears queue RAM  
D) It updates layoutVersion

<details>
<summary>Answer</summary>
B. It gives clients a server-time reference so they can align animation timelines across screens.
</details>

4. Why does `ticker.startRun` reject when `wall.playing` is already set?

A) To avoid duplicate indexes  
B) To enforce one active run at a time and preserve sequential queue playback  
C) To prevent shortCode collisions  
D) To reduce CPU usage only

<details>
<summary>Answer</summary>
B. The ticker model is single-run-at-a-time; rejecting overlapping starts protects queue order and wall consistency.
</details>

5. Why is `startedAtServerMs` delayed by ~800ms in `ticker.startRun`?

A) To let clients receive and prepare the run before motion starts  
B) To increase message speed  
C) To avoid writing to Mongo  
D) To match browser refresh rate

<details>
<summary>Answer</summary>
A. A small start delay gives distributed clients enough time to receive the run payload and begin in sync.
</details>

6. Why does `estimatedDoneAt` depend on `(totalWallWidth + textWidthPx) / speedPxPerSec`?

A) Because message length is random  
B) Because text must traverse the whole concatenated wall plus its own width before being fully off-screen  
C) Because Mongo stores wall width in milliseconds  
D) Because Pixi requires it

<details>
<summary>Answer</summary>
B. Completion time is physics-based: distance traveled across wall + text length divided by speed.
</details>

7. Why is `maybeStartNext(wallId)` called after a run timeout clears `playing`?

A) To rotate logs  
B) To immediately continue FIFO playback without manual admin action  
C) To refresh subscriptions  
D) To reassign client IDs

<details>
<summary>Answer</summary>
B. It advances the server-side queue automatically, preserving continuous one-by-one playback.
</details>

8. What event is emitted by `maybeStartNext` for the measurement handshake?

A) `ticker.start.request`  
B) `ticker.measure.request`  
C) `ticker.wall.measure`  
D) `stage.raw.spawn`

<details>
<summary>Answer</summary>
B. The server emits `ticker.measure.request` so admin can measure text width and then call `ticker.startRun`.
</details>

9. Why was `ticker.clearHighlight` changed to set `highlightClientId: null` instead of unsetting the field?

A) To keep document shape stable and simplify client checks  
B) To reduce index size  
C) Because `$unset` is deprecated  
D) To force repaint

<details>
<summary>Answer</summary>
A. Using `null` keeps a predictable field contract and makes UI logic (`is highlighted?`) simpler and more consistent.
</details>

10. Why are these methods described as server-authoritative?

A) Because clients cannot subscribe  
B) Because all operational state mutations happen through server methods, not direct client collection writes  
C) Because FlowRouter enforces it  
D) Because Streamer requires it

<details>
<summary>Answer</summary>
B. Server methods centralize validation and state transitions, which keeps behavior controlled and auditable.
</details>
