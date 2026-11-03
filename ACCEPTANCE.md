# Acceptance — architecture update, 2026-11-03

Status: standalone Node/Fastify/SQLite implementation. This replaces the native-installation Meteor backend, while legacy artistic routes/data remain available separately. No physical supervision, erasure, signing or production service installation was performed.

## Automated / local checks

- PASS: protocol parsing/size/revision, low-RTT estimator, capped retry delay, health aging, timezone/DST/overnight scheduling.
- PASS: 30 paired simulated clients connect simultaneously and receive live configuration/artwork changes.
- PASS: actual separate Node process is killed with SIGKILL and restarted with the same SQLite directory; all 30 clients reconnect with original slot, revision and timeline start, without client restarts.
- PASS: independent socket interruption restores full state and the shared absolute-time position function.
- PASS: SQLite atomic commit, duplicate operation receipt, stale edit rejection, invalid-layout rollback, history rollback with monotonically increasing revision.
- PASS: selected-device blackout/resume, group-scoped preview, automatic preview expiry and unaffected non-target phones.
- PASS: authenticated media upload/download with byte comparison; unauthenticated access rejected; local experiment shell and bundled Pixi delivery.
- PASS: ten Node tests, including schema rejection, immutable releases, one-phone staging, the 30-target readiness barrier, common activation timestamps, failure/timeout preservation, rollback and restart. Test services use loopback and no required WAN resources. This does not physically disconnect the museum WAN.
- PASS: browser smoke on desktop/mobile viewports: operator login, 30 virtual canvases, publish scene, Start/Night, atomic JSON edits, named groups, no JavaScript errors.
- PASS: repeatable `test:ui` suite blocks all non-local browser requests, loads bundled Pixi and executes uploaded artwork after HTML body creation. The native simulator visibly renders the hosted web scene with UTF-8 text and acknowledges web-ready.
- PASS: native simulator app remains running through a standalone Node service restart, reconnects and reloads the same hosted scene/timeline, acknowledged after restart without manual refresh or app relaunch.
- PASS: iOS simulator and unsigned device Release builds with Bonjour/WKWebView integration, minimum target 15.0. Native simulator handshake, pairing and full snapshot against Fastify. Signing/install on hardware remain separate.
- PASS: isolated standalone dependency audit reports zero vulnerabilities with locked patched glob/minimatch overrides. The legacy Meteor dependency audit is not repaired or hidden by this result.
- PASS: runtime 2.0 native simulator prepared and displayed a declarative text/animation release with ready/displayed acknowledgments. After stopping the server, a cold app launch visibly restored that artwork from Application Support.
- PASS: a cached WebView release, including exact Pixi build and script, prepared/activated successfully and rendered on a cold launch with the server stopped.
- PASS: a deliberately throwing web script triggered three WebView recreations, explicit preparation failure and retention of the previous active release; no app restart was used for that recovery.
- PASS: browser workflow builds immutable releases from controls, stages them, displays per-target results and executes actual web artwork in a selected virtual-phone iframe with non-local requests blocked.

## Still physical / operational qualification

Dashboard/update 2.2.0 (2026-11-03): PASS all 22 Node tests, including schema-v1 staggered row text, online-only preparation, offline counts, source-format checks and code-swap rollback on health/backup failure without changing installation data. PASS browser tests: default Control tab, hidden Advanced tools, hidden authenticated login, Start/Stop Pairing, Send Test Text, and preserved advanced workflows. PASS unsigned native simulator build with explicit paired-form/keyboard dismissal. NOT TESTED: administrator-authorized GitHub update/install/reboot cycle on the Mac mini or text motion on physical phones. The updater requires committed/pushed source and intentionally rejects older source without its compatibility marker.

Runtime 2.1 update (2026-11-03): PASS all 16 Node tests, including 30-client tap-order pairing, duplicate taps (including after completion), partial stop, reconnect, session expiry, and row-major geometry. PASS dashboard start/stop pairing in the browser smoke suite. PASS unsigned iOS simulator compilation of the native red/green interface, ten-second handshake deadline and retrying discovery. PASS build of the standalone Mac mini installer 2.1.0. NOT TESTED: physical multi-phone taps or whether these connection fixes resolve the reported museum-phone hangs; confirm Local Network permissions and router policy on each device. No new signed IPA export or installation was performed by the agent for this update.

- NOT TESTED: Ad Hoc signing/export/install on registered iPhone 6s 15.8.x, profile expiry monitoring, local-network permission behavior and Bonjour on the museum router.
- NOT TESTED: Single App Mode reboot/autolaunch, USB escape, terminated-app recovery and lock/passcode behavior after device restart.
- NOT TESTED: two-device visual skew <100 ms, native/WebKit memory/thermal behavior under final artwork, video playback endurance, 12-hour/24–48-hour 30-phone run.
- NOT TESTED: actual Mac power restoration, chosen login/LaunchDaemon policy, router reboot, sustained WAN outage and staff usability on installation hardware.

## Remaining limits

Existing artistic Meteor modes are preserved, not automatically translated into native scenes. Virtual native text/shape/ticker rendering is approximate; image/video codec fidelity is not emulated, and concurrent actual web previews are capped at four. Native video seeks into elapsed time but is not frame locked. Preparation barriers and shared activation timestamps do not guarantee all-or-nothing physical display under arbitrary device failures or partitions; per-device displayed/error acknowledgments are required to assess success. Automatic server media/history pruning, multi-controller consensus, a role platform, transactional native side effects and remote app relaunch/power-on are not provided. See RUNTIME.md for the precise configuration/IPA boundary and failure policy.

Proposed hardware success: zero per-phone interventions, zero unexpected app exits, all available devices rejoin within 90 seconds of restored service, no sustained serious/critical thermal state, no battery decline while charging, and adjacent ticker skew below 100 ms for 95% of measured samples. Record actual results before declaring unattended museum readiness.
