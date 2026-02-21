# Quiz - Ticker Task 30 (MCQ, Publications & Subscriptions)

1. Why is `ticker.wall(wallId)` published as a single wall document rather than embedding wall data in every client document?

A) To avoid needing Mongo indexes  
B) To keep one authoritative reactive runtime state per wall  
C) Because Meteor cannot publish arrays  
D) To prevent Blaze from re-rendering

<details>
<summary>Answer</summary>
B. The wall document is the single source of truth for shared wall-level state (layout/version/speed/playing), so publishing it once keeps state consistent and reactive for all clients.
</details>

2. Why does `/ticker` subscribe to `ticker.client.self` instead of `ticker.clients`?

A) Because sorting is unavailable on client  
B) To reduce data exposure and payload size to only what that screen needs  
C) Because `ticker.clients` crashes on mobile  
D) To disable reactivity

<details>
<summary>Answer</summary>
B. A ticker screen only needs its own assignment (like `xStart`) and the wall state, so subscribing to all clients would leak unnecessary data and increase bandwidth.
</details>

3. Why is `ticker.clients` still needed on `/admin/ticker`?

A) Admin needs global visibility across all connected clients for layout and operations  
B) Admin uses a different database  
C) Admin can’t read `ticker.wall`  
D) `ticker.client.self` is server-only

<details>
<summary>Answer</summary>
A. The admin interface must see the entire client set to monitor, reorder, and control the ticker wall.
</details>

4. Why do publications guard missing arguments with `this.ready()`?

A) To speed up Mongo writes  
B) To fail safely and avoid publishing ambiguous/broad datasets  
C) To auto-create documents  
D) To bypass authorization

<details>
<summary>Answer</summary>
B. Returning `this.ready()` on invalid input prevents accidental over-publication and keeps publication behavior explicit.
</details>

5. Why does `ticker.client.self(wallId, clientId)` filter by both `_id` and `wallId`?

A) It is required by Mongo syntax  
B) It ensures the client doc belongs to the intended wall context  
C) It makes indexes optional  
D) It disables oplog

<details>
<summary>Answer</summary>
B. Matching both fields prevents cross-wall data mix-ups and enforces the wall-scoped model.
</details>

6. Why was a reactive wall JSON block added to `/admin/ticker` during this stage?

A) To replace production UI permanently  
B) To verify publication/subscription reactivity before full controls are built  
C) To store queue state  
D) To test Tailwind animations

<details>
<summary>Answer</summary>
B. It is a lightweight observability aid: if wall updates are visible live, publication/subscription wiring is confirmed.
</details>

7. Why show a reactive client list and count in `/admin/ticker` now?

A) To satisfy drag-and-drop requirements already  
B) To confirm `ticker.clients` publishes all client docs correctly in real time  
C) To reduce server memory  
D) To test Pixi text width

<details>
<summary>Answer</summary>
B. The list and count provide immediate proof that admin receives full client-state updates as intended.
</details>

8. Why was a self-info overlay (`shortCode`, `wallId`, `xStart`) added on `/ticker`?

A) For final production UX  
B) To validate that each ticker screen receives only its own reactive client doc  
C) To avoid calling methods  
D) To measure FPS

<details>
<summary>Answer</summary>
B. The overlay is a verification tool showing that self-scoped subscription data arrives and updates correctly.
</details>

9. Why is it important that `/ticker` does not subscribe to full client lists in v1?

A) It breaks FlowRouter  
B) It violates least-privilege data design and scales poorly  
C) It disables Meteor methods  
D) It prevents heartbeat updates

<details>
<summary>Answer</summary>
B. Limiting each ticker client to minimal required data improves privacy boundaries and reduces unnecessary reactive load.
</details>

10. Which publication is designed for admin-only operational visibility?

A) `ticker.wall`  
B) `ticker.client.self`  
C) `ticker.clients`  
D) `ticker.time`

<details>
<summary>Answer</summary>
C. `ticker.clients` intentionally exposes wall-wide client state for admin workflows.
</details>

11. Which subscription pair is correct for `/ticker`?

A) `ticker.clients` + `ticker.wall`  
B) `ticker.wall` + `ticker.client.self`  
C) `ticker.client.self` only  
D) `ticker.wall` only

<details>
<summary>Answer</summary>
B. A ticker screen needs shared wall state and its own client assignment, but not other clients’ records.
</details>

12. Which subscription pair is correct for `/admin/ticker`?

A) `ticker.wall` + `ticker.clients`  
B) `ticker.wall` + `ticker.client.self`  
C) `ticker.clients` only  
D) No subscriptions yet

<details>
<summary>Answer</summary>
A. Admin must observe both wall-level runtime state and the complete client population.
</details>

13. Why keep publication field sets “simple for v1” while still splitting publication endpoints?

A) Because field projections are impossible in Meteor  
B) Because endpoint-level separation already enforces major data boundaries with low complexity  
C) Because projections increase security risk  
D) Because Blaze cannot render partial fields

<details>
<summary>Answer</summary>
B. Even without aggressive field trimming, separate publications by audience/use-case provide a clean and practical first security/performance boundary.
</details>

14. Why does this task focus on reactive read paths before advanced admin features?

A) Reactive data plumbing is the foundation; controls are easier once reads are trusted  
B) Mongo requires it before indexes  
C) Pixi cannot run without it  
D) FlowRouter mandates this order

<details>
<summary>Answer</summary>
A. Reliable reactive reads are prerequisite infrastructure: once state propagation is correct, higher-level UI logic can be added safely.
</details>

15. What is the main architectural reason to keep publications explicit (`ticker.wall`, `ticker.client.self`, `ticker.clients`) instead of one generic publication?

A) To make method names shorter  
B) To separate responsibilities and keep client data access intention-revealing  
C) To avoid using subscriptions altogether  
D) To force synchronous rendering

<details>
<summary>Answer</summary>
B. Explicit publications encode intent per consumer (screen vs admin), which improves maintainability, reviewability, and data-discipline over time.
</details>
