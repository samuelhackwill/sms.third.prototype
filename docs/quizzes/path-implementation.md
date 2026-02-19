# Quiz - Path Implementation

1. What was the main problem with building runtime write paths from `process.cwd()` in a Meteor app?

<details>
<summary>Answer</summary>
It ties writes to the .local bundle location, which is not a stable writable runtime storage location in production.
</details>


2. Why is `private/` not a valid target for runtime writes in Meteor?

<details>
<summary>Answer</summary>
`private/` is bundled for read-only access through Meteor `Assets`; it is not intended for mutable runtime storage.
</details>

3. What is the currently supported configuration order for the data directory?

<details>
<summary>Answer</summary>
`METEOR_DATA_DIR` first, then `Meteor.settings.dataDir`, then fallback to `~/.sms-third-prototype-data`.
</details>

4. Which helper centralizes data-path generation in the current implementation?

<details>
<summary>Answer</summary>
`dataPath(...parts)` from `imports/server/filePaths.js`.
</details>

5. How does the code ensure the data directory exists before writing files?

<details>
<summary>Answer</summary>
`ensureDataDir()` creates it with `mkdirSync(..., { recursive: true })`, and `dataPath(...)` always calls it.
</details>

6. Where are RAW hot log files now resolved from?

<details>
<summary>Answer</summary>
From the external data directory via `dataPath('raw', 'hot-osx_messages_app.ndjson')` and `dataPath('raw', 'hot-sim_router.ndjson')`.
</details>

7. Why is logging the resolved data dir at startup useful?

<details>
<summary>Answer</summary>
It gives operators immediate visibility into the exact runtime storage path, making path mistakes easier to detect.
</details>

8. What should be avoided for runtime persistence in this project?

<details>
<summary>Answer</summary>
Writing mutable data inside app source-tree/build-convention directories (`public/`, `private/`, repo-relative paths).
</details>
