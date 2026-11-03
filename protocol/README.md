# Phone Wall JSON protocol v1

Transport: native `URLSessionWebSocketTask` ↔ Fastify/`ws`, `/phone-wall/ws`. No DDP or streamer is involved. Bonjour advertises `_phonewall._tcp` with `path=/phone-wall/ws`, `v=1`. Browser WebSocket origins are rejected; the web dashboard uses authenticated same-origin HTTP.

Envelope: `{v:1,type,messageId,payload}`. Server messages also contain `wallId:main`, `revision`, `serverTimeMs`. Client messages are bounded to 64 KiB; runtime 2.0 accepts server snapshots up to 256 KiB to carry active/pending release manifests. Maximum installation config is 48 KiB and artwork definition 32 KiB. Unknown versions/types get an explicit error and close code 1008. Initial handshake, per-socket message rate, socket count and device count are bounded.

1. `client.hello`: persistent deviceId, random secret token, new bootSessionId, appVersion and capabilities. First registration is pending with a random pairing code; existing IDs require the original secret.
2. `server.welcome`: paired, pairingCode, heartbeatSeconds. Native clients explicitly send `state.request` on welcome. Approved clients always receive a full `state.snapshot`.
3. `state.snapshot`: complete current config, installationId, revision, scene, mode, layout, groups, geometry and any effective device/preview override. Older revisions within the same installation are ignored; a new installation ID allows a new authority's revision range. No patch/event replay is required.
4. `client.heartbeat`: battery, charging, thermal category, foreground, scene, last revision, media state, free disk estimate, uptime. Interval 12 seconds; server pings every 15 seconds and expires missed liveness at 45 seconds. Native reconnect uses capped exponential backoff/jitter and network-path notifications.
5. `time.request`: `{sent:clientEpochMs}`. `time.response` echoes sent and request ID with server envelope timestamp. Several samples favor the lowest RTT; absolute animation position uses `startAtServerMs`, speed and clock offset. Socket/server restart never resets the stored start timestamp.
6. `client.ack` / `client.error`: bounded result/error code and optional commandId. Diagnostic events expire after seven days.

## Commands and state controls

Operator `POST /phone-wall/api` with `action:command`, `name`, optional deviceId / deviceIds / group. Names: `reloadState`, `restartScene`, `blackout`, `resume`, `clearCache`. Legacy aliases reload-state/purge-expired-media and query-diagnostics remain supported.

Blackout/resume/restartScene modify persistent desired state and distribute snapshots. Selected targets receive versioned per-device overrides. Entire-wall controls reset those overrides. Native reloadState asks for a new snapshot. clearCache clears the local cache and requests state/refetch. Transient commands carry commandId and native clients keep the last 100 completed IDs to acknowledge duplicates. Persistent mutations accept operationId, recorded transactionally with the configuration; retry the same operation ID for a lost response. Exactly-once execution of arbitrary native side effects across crashes is not claimed.

## HTTP

- `GET /health`: liveness, no secrets.
- `GET /phone-wall/api`: operator state, history and health, never credential hashes.
- `POST /phone-wall/api`: pair, configure, rollback, scene, mode, layout, schedule, preview, identify, sync, command. Configure/rollback require expectedRevision. Atomic configure accepts the entire document. Groups are `name:[deviceIds]`; slots are explicit deviceId/slotIndex/geometry entries. Schedule uses IANA timezone/startMinute/endMinute; manual mode changes disable scheduling.
- `POST /phone-wall/media`: raw JPEG/PNG/MP4 or trusted experimental JavaScript, SHA-256 versioning, 200 MiB streaming budget.
- `GET /phone-wall/media/{hash}`: operator or paired-device bearer authentication, HTTP file delivery/ranges.
- `/experiment/{hash}`, `/art/{hash}.js`, `/art/pixi.js`: public-on-LAN experiment shell/code/local Pixi; trusted operator upload only. No secrets in these documents.

Timed legacy preview selects explicit IDs, a group or all paired slots. Runtime 2.0 artwork uses the staged release protocol below instead of direct scene switching.

## Artwork releases (runtime 2.0 / scene schema 1)

Hello includes runtimeVersion and capabilities.sceneSchemaVersions. `release.create` validates a declarative definition and captures layout + asset manifest into an immutable SHA-256 release. `release.deploy` selects IDs/group, timeoutMs/delayMs and optional operationId; it persists the deployment and distributes full snapshots. `release.cancel` cancels only uncommitted preparation. Promoting and rolling back deploy the same selected immutable release to a new cohort.

Snapshot `artwork` contains active and pending descriptors, each with deploymentId, releaseId, phase, startAtServerMs, deadlineMs and complete release manifest. Devices preload/validate and send `artwork.status` containing the matching deploymentId/releaseId and ready, displayed or error, plus a bounded code. Only all-ready + connected targets cause scheduled activation. The same timestamp persists across reconnect/server restart. Stale deployment acknowledgments are ignored. Preparation errors/timeouts preserve previous assignments. Scheduled clients may activate locally across disconnection if they already received commit; clients missing commit retain last-good content and rejoin on reconnect. Post-commit failure is explicit and may leave a degraded cohort requiring rollback; this protocol does not promise physical atomicity under partitions.

`GET /phone-wall/scene-schema` serves the versioned language. Definitions include artworkId/artworkVersion, canvas, transition, declarative elements, optional parameters and declared resources. Runtime version, schema version, artist version, release hash and rollout ID are distinct. See ../RUNTIME.md for SDK and deployment policy.

One operator key, one wall and one server process are deliberate scope limits. Dedicated trusted LAN or authenticated private remote access is required; use TLS on shared networks. Bonjour provides location, not cryptographic server identity.
