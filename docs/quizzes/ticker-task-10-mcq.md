# Quiz - Ticker Task 10 (MCQ)

1. Which folder now contains the ticker feature backend module?

A) `server/ticker/`  
B) `imports/api/ticker/`  
C) `imports/server/ticker/`  
D) `client/ticker/`

<details>
<summary>Answer</summary>
B
</details>

2. Which file defines `TickerClients` and `TickerWalls`?

A) `imports/api/ticker/methods.js`  
B) `imports/api/ticker/publications.js`  
C) `imports/api/ticker/collections.js`  
D) `imports/api/ticker/queue.js`

<details>
<summary>Answer</summary>
C
</details>

3. Which route now renders `TickerPage`?

A) `/stage`  
B) `/ticker`  
C) `/admin/ticker`  
D) `/ticker/admin`

<details>
<summary>Answer</summary>
B
</details>

4. Which route now renders `AdminTickerPage`?

A) `/admin/stage`  
B) `/ticker/admin`  
C) `/admin/ticker`  
D) `/ticker`

<details>
<summary>Answer</summary>
C
</details>

5. Where is ticker queue RAM logic implemented?

A) `imports/api/ticker/publications.js`  
B) `imports/api/ticker/collections.js`  
C) `imports/api/ticker/queue.js`  
D) `imports/server/rawLog.js`

<details>
<summary>Answer</summary>
C
</details>

6. What does `imports/api/ticker/streamerBridge.js` do in this stage?

A) Measures Pixi text width  
B) Listens to `stage.raw.spawn` and enqueues ticker messages  
C) Publishes ticker collections  
D) Renders admin rectangles

<details>
<summary>Answer</summary>
B
</details>

7. Which Streamer event is consumed by the ticker bridge?

A) `ticker.measure.request`  
B) `ticker.raw.spawn`  
C) `stage.raw.spawn`  
D) `rawlog.new`

<details>
<summary>Answer</summary>
C
</details>

8. In `ticker/methods.js`, why was `findOne` replaced?

A) It was too slow  
B) It is not available in the current server usage pattern; async API is required  
C) It was deprecated only on client  
D) It returns wrong documents

<details>
<summary>Answer</summary>
B
</details>

9. Which method is now used instead of `findOne`?

A) `findFirstAsync`  
B) `fetchOneAsync`  
C) `findOneAsync`  
D) `getOneAsync`

<details>
<summary>Answer</summary>
C
</details>

10. Which additional async conversion was applied in ticker methods?

A) `publish` -> `publishAsync`  
B) `find` -> `findAsync`  
C) `insert/update/upsert/fetch` -> async variants  
D) `Meteor.call` -> `Meteor.callAsync` only

<details>
<summary>Answer</summary>
C
</details>

11. Which file wires ticker server modules at startup?

A) `client/routes.js`  
B) `imports/startup/server/index.js`  
C) `imports/startup/client/index.js`  
D) `imports/api/ticker/publications.js`

<details>
<summary>Answer</summary>
B
</details>

12. Which file is responsible for route registration in this app structure?

A) `imports/startup/client/index.js`  
B) `client/main.js`  
C) `client/routes.js`  
D) `imports/ui/App.js`

<details>
<summary>Answer</summary>
C
</details>

13. What styling approach is now used for ticker/adminTicker pages?

A) Separate CSS modules only  
B) Inline style attributes only  
C) Tailwind utility classes in templates  
D) Styled-components

<details>
<summary>Answer</summary>
C
</details>

14. What happened to `imports/ui/pages/ticker/ticker.css` and `imports/ui/pages/adminTicker/adminTicker.css`?

A) Kept and imported conditionally  
B) Merged into one global CSS file  
C) Deleted after moving styles to Tailwind classes  
D) Moved to `client/main.css`

<details>
<summary>Answer</summary>
C
</details>

15. Which subscriptions are initialized in `AdminTickerPage` right now?

A) `ticker.wall` and `ticker.clients`  
B) `ticker.client.self` only  
C) `messages.latest` and `ticker.wall`  
D) None yet

<details>
<summary>Answer</summary>
A
</details>
