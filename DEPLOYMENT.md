# Deployment — standalone Phone Wall

## Mac mini: Git checkout and Node daemon

The controller runs at boot as the `_phonewall` LaunchDaemon and serves the browser dashboard at `http://127.0.0.1:3100/admin/phone-wall` (use the port in `/Library/Application Support/PhoneWall/config.json` if different). The authenticated `/phone-wall/api` is also available to a future native controller iPhone app on the local network. The dashboard is plain static HTML/CSS/JavaScript served by Node; there is no Mac app or frontend build.

For the existing installation, run `sudo /usr/local/bin/node scripts/phone-wall/headless-setup.mjs` once from this checkout. It creates `/Library/Application Support/PhoneWall/source` as a dedicated Git checkout, installs production Node dependencies, points the controller and Messages reader at that source, and removes the five-minute updater daemon. It retains SQLite data, media, pairing, operator key and the Messages reader's Full Disk Access-authorized Node binary.

Run `sudo /usr/local/bin/node scripts/phone-wall/install-pull-helper.mjs ingestor` once to install the root-owned pull helper. Thereafter deploy a pushed change from the Mac mini without `sudo`:

```sh
/usr/local/bin/node '/Library/Application Support/PhoneWall/bin/request-pull.mjs'
```

This fetches `phone-wall-runtime-2`, fast-forwards the deployment checkout, installs dependencies only if its lockfile changed, restarts the controller and checks `/health`. It restarts the Messages reader too. A failed start restores the previous commit and restarts the previous controller. GitHub pushes alone do not reach the private Mac; the pull command is the deployment trigger. There is no polling, GitHub Actions build, package, or `.app` launcher. The helper accepts only a pull request marker from the logged-in Mac user; its code and the deployment checkout are root-owned. The controller itself runs as `_phonewall`.

The controller and dashboard work before login. The Messages reader runs under the logged-in Messages user, so that account must be logged in for iMessage ingestion. Logs remain in `/Library/Logs/PhoneWall/server.log` and `~/Library/Logs/PhoneWallReader/server.log`. A pull briefly restarts phone WebSockets; message queue data remains in SQLite. Native iPhone code updates still require a signed IPA installation.

### Change the operator passphrase

The default operator credential is a random 64-character key. You may replace it with a memorable passphrase of 32–128 printable ASCII characters without spaces. Use several unrelated words joined by hyphens. On the Mac mini, edit `/Library/Application Support/PhoneWall/operator.key` as administrator so the file contains only the new passphrase and a final newline, then restart the controller with `sudo launchctl kickstart -k system/org.museum.phonewall`. Keep the existing `_phonewall:staff` ownership and `640` permissions. The previous credential stops working after the restart. In the control iPhone app, open Connection, replace the saved key and tap Save; the new value remains in the iPhone Keychain. Browser dashboard tabs must also sign in again.

The controller restores Exhibition mode at every boot, even after a Night mode shutdown. To enable the remote's clean shutdown button, install the exact-command sudoers rule once as administrator: `sudo /usr/local/bin/node scripts/phone-wall/install-shutdown-permission.mjs`. The rule grants `_phonewall` only `/sbin/shutdown -h now`. The authenticated remote action is accepted only through a local proxy such as the configured private Tailscale HTTPS Serve endpoint. It puts connected phones in Night mode, waits eight seconds, then asks macOS to shut down. The Mac mini model `Macmini9,1` must be turned on with its physical power button after reconnecting power; its power-failure restart setting does not cover a deliberate shutdown.

## Kissing Wall: Native Update

Push the Mac controller source to `phone-wall-runtime-2`, then run the pull-and-restart command above. Archive/export and install **PhoneWall 2.4.3 (build 10)** from `ios/PhoneWall.xcodeproj` once for native independent video playback and connection recovery fixes. Existing pairing/identity is retained by an in-place app update; do not uninstall first. Start using **Control > Kissing Wall**. Settings/media changes after this installation are server-side; no further IPA is needed for trim/fades or new clips. Only the Mac accesses the remote kissing API. Allow initial downloads before disconnecting WAN. Speaker output, codec compatibility and endurance must be checked on the actual iPhone 6s.

Developer smoke (not on the museum Mac): with a booted simulator, a compiled simulator `.app` and ffmpeg installed, run `PHONE_WALL_SIMULATOR_ID=<id> PHONE_WALL_SIM_APP=<path-to-PhoneWall.app> node tools/simulator/kissing-wall-smoke.mjs`. It generates two H.264/AAC fixtures, runs native independent playback against an isolated controller, checks night/resume, cold offline launch via a rendered-video screenshot, server restart and stop. It changes the simulator's app state, never physical phones. Output is under `.data/kissing-wall-smoke/`. `npm test --prefix server/phone-wall` covers source validation, corrupted-cache repair, bounded rotation, 30 clients and authenticated local HTTP delivery; no remote API is required by tests.

## Live iMessages: One-Time Setup on sms-ingestor

1. Update the Mac controller to source version 2.3.0 and install native **PhoneWall 2.3, build 6** over the existing app on each phone. Keep the bundle identifier/team unchanged. This runtime update adds the narrow live-ticker bridge; ordinary artwork edits still need no IPA. Older phones are explicitly flagged rather than entering a failed deployment loop.
2. Log into the macOS account that runs Messages.app and run `node scripts/phone-wall/install-messages-agent.mjs` once from the checkout as that user. This installs/restarts the reader LaunchAgent. The main display server remains its existing boot-time `_phonewall` LaunchDaemon; it never opens chat.db itself.
3. In **System Settings > Privacy & Security > Full Disk Access**, explicitly authorize `/Library/Application Support/PhoneWall/app/runtime/bin/node` for this Messages reader. Use the file chooser's Go to Folder facility if needed. This is a broad OS permission, not something the installer can silently grant. No TCC database manipulation, SIP changes, supervision or device erasure is performed. Apple's [Full Disk Access guidance](https://developer.apple.com/news/?id=p6zjojqw) describes the need for explicit user consent.
4. Run the same reader-install command again after granting permission. Polling and playback start automatically. Wait for **Reader connected; watching new iMessages**, then send a new incoming message from another account/number. Messages sent by the installation's own account are deliberately excluded.

The reader defaults to that user's `~/Library/Messages/chat.db`. `MESSAGES_DB_PATH` is available for development fixtures or an explicitly configured reader environment; no private DB is inspected by the automated tests. First contact with a database records its current highest ROWID and skips existing history. Thereafter its cursor is durable in the controller SQLite DB and advances only in the same transaction as deduplicated queue insertion. Server downtime, paused playback and temporary permission failures do not reset that cursor. Database replacement establishes a new baseline; an unexpected ROWID rollback on the same file is surfaced rather than importing history silently.

Queue playback and the phone wall work without WAN access. Arrival of new iMessages still depends on Messages.app receiving them through its normal Apple/account connectivity; the local reader does not replace that service.

The user agent is `~/Library/LaunchAgents/org.museum.phonewall.messages.plist`; identity is in `~/Library/Application Support/PhoneWallReader/identity.json`; bounded logs are in `~/Library/Logs/PhoneWallReader/server.log`. It starts at user login, not before login. The museum's Messages user must remain logged in for ingestion. The existing wall server can boot and show cached artwork without that login. The pull-and-restart command restarts the reader after source updates. The reader continuously polls the personal database while the Messages user is logged in. Kissing Wall and Barthes mode hold incoming-message playback; queued messages resume afterward.

Source messages are read-only. Plain text and archived attributed bodies are supported through the built-in macOS Foundation decoder in a separate bounded process; outgoing messages, reactions, system notices and attachment-only entries are ignored. Display text is clamped at 100 complete grapheme clusters / 495 UTF-16 code units, with `[...]` when shortened; no surrogate or joined emoji is sliced. No sender address is needed or stored. Decode failure holds the cursor and exposes an error instead of silently losing later messages. The queue stops accepting new batches at 10,000 unfinished messages, leaving source data/cursor untouched until playback frees capacity. Completed records remain in the protected wall database; back up and monitor disk usage, and treat it as private installation data.

For tests: `npm test --prefix server/phone-wall` covers cursor/FIFO behavior with synthetic DBs; `npm run test:live --prefix server/phone-wall` exercises actual browser artwork with a native-bridge stand-in. The optional simulator smoke test below accepts `PHONE_WALL_SMOKE_LIVE=1` to exercise the real native bridge too. Actual Messages account permissions and physical multi-phone delivery still require testing on the installation Mac/phones.

## Developer local start

Install dependencies with `npm ci --prefix server/phone-wall`, set `PHONE_WALL_ADMIN_TOKEN` and `PHONE_WALL_DATA_DIR`, then run `npm start --prefix server/phone-wall`. This local mode uses port 3000 by default. The Mac mini uses the managed Node daemon above.

## Incremental legacy migration

`npm run start:legacy` retains the Meteor application and existing Mongo data. The Node controller prefers port 3100, so Meteor can remain on 3000; keep their ports distinct. No existing artwork or Mongo content is deleted. Legacy artistic routes are not silently ported into the new native renderer; use their code as the reference or adapt a visual into the optional web scene. Do not remove Meteor dependencies until those features have their own replacement tests.

For already paired native devices, export a private JSON bundle from the old server/database:

```json
{"state":{},"devices":[],"assets":[],"schedule":null}
```

`state` is the old `phoneWallState/main` document; `devices` are full `phoneWallDevices` documents including `_id`, `tokenHash`, `pairingCode`, `paired`, slotIndex and geometry. Assets are `phoneWallMediaAssets` records (`_id` SHA-256, MIME and bytes). Use ordinary JSON dates, not Mongo Extended JSON date objects. The old public admin response omits token hashes and is insufficient for identity migration. Treat the export as sensitive; do not commit it.

```sh
PHONE_WALL_DATA_DIR=/new/persistent-directory LEGACY_MEDIA_DIR=/old/phone-wall-media \
  node server/phone-wall/import-legacy.mjs /private/export.json
```

The importer requires an unused destination, validates layout and media checksums, copies media, imports hashes and commits SQLite metadata transactionally. Source data is unchanged. Revisions advance beyond the export. Use this before pointing phones at the new service. A new empty database instead requires re-pairing; the native installation ID prevents old cached revision numbers from blocking that workflow.

## iOS / Apple Configurator

Native app **2.2, build 5** changes the render loop from a 30 fps to a 60 fps request and moves native scene elements through Core Animation layer positions. Fonts, viewport layout and ticker measurement are cached; rows that cannot intersect a phone are not allocated as labels. Clock-based motion is evaluated for the display link's upcoming presentation time. Native UILabel/NSString shaping retains system color-emoji fallback. One new signed IPA is required for these native improvements; install over the existing app with the same bundle ID/team to retain identity. The server's editable message/speed controls work with previous scene-v1 runtimes too. A requested rate is not a guaranteed physical delivery rate, particularly under power/thermal constraints.

Optional native smoke test: build the unsigned simulator app, boot a dedicated simulator, then run `PHONE_WALL_SIMULATOR_ID=<simulator-uuid> PHONE_WALL_SIM_APP=/path/to/PhoneWall.app node tools/simulator/native-render-smoke.mjs`. It uses a temporary loopback controller, updates that simulator's app cache, renders static and moving emoji scenes, checks the reported 60 fps target, and saves screenshots/callback observations under `.data/native-render-smoke/`. It does not touch installation DBs or physical phones. Only newer simulator runtimes are installed on the development host; verify glyph availability and sustained performance separately on iOS 15.8 hardware.

App 2.1 (build 3) adds native tap-to-position pairing and connection recovery fixes. Archive/export this update with the existing bundle identifier and signing setup and install it over the previous app to preserve identity. Install controller 2.1.0 as well. Earlier IPAs still support manual pairing by code but cannot show the red/green tap interface. This is a native runtime feature update, not an artwork update. Make sure Local Network access is enabled on every phone; denied permissions cannot be bypassed by the app.

In the dashboard, **Start Pairing Mode** turns connected phones red. Tap in physical reading order, top-left to bottom-right. Server acknowledgments turn each assigned phone green with its row/column. **Stop Pairing** retains a partial layout; filling the configured matrix stops automatically. Each tap replaces that destination slot, while positions not touched remain intact. Layout edits are blocked while pairing is active. Sessions expire after ten minutes and stop after controller restart; committed slot assignments remain in SQLite.

Runtime 2.0 is the one-time native upgrade introducing the long-lived scene interpreter, offline artwork bundles and staged publication. Existing 1.x apps cannot join release deployments; the dashboard/API reports an upgrade requirement. Install 2.0 while preserving Application Support identity, then use the workflow in RUNTIME.md. Subsequent supported text/media/layout/animation/web-code changes require no IPA update. Profile/certificate expiry still requires normal Apple maintenance.

Open `ios/PhoneWall.xcodeproj`, choose your bundle identifier and paid Apple team. Target remains iOS 15.0. The native app discovers the LAN controller automatically, with saved/default `ws://sms-ingestor.local:3100/phone-wall/ws` fallback. Existing apps can discover the new service without rebuilding if Bonjour works; the corrected default fallback applies to the next IPA build. Grant local-network permission. On networks with several controllers, use isolation or disable Bonjour advertisement and enter the desired fallback.

Register all UDIDs, create an Ad Hoc profile containing them, install signing identities locally and prepare ExportOptions.plist using the installed Xcode Organizer. Export method names vary with Xcode; use its generated options. Then run `APPLE_TEAM_ID=... EXPORT_OPTIONS_PLIST=/absolute/options.plist bash scripts/phone-wall/export-ipa.sh`. No Apple credentials are stored in the repository. Record certificate/profile expiry, devices, bundle ID and build number; renew well before expiry. Direct Xcode debugger support for iOS 15 depends on the toolchain. Configurator installation of the exported IPA remains the alternative.

Test one physical iPhone 6s 15.8.x before batching. Supervision may erase devices and requires explicit approval; no script supervises or erases. Back up the supervision identity. Configure Wi-Fi, install the IPA, grant permissions, pair to a slot, and manually enable Single App Mode. Test reboot/autolaunch on that exact build/device. Keep USB access and the supervision identity to exit Single App Mode in Configurator.

Identity/secret are atomically stored in protected Application Support and excluded from backup. Updates preserve them; deleting/reinstalling the app or erasing it requires re-pairing. Storage unavailable before first unlock retries rather than creating a replacement identity. Verify the lock/passcode policy on the installed phones. A terminated app cannot relaunch itself; the foreground socket is not a background execution guarantee.

Optional remote access must use a secure private tunnel to the Mac. Never forward the admin/API to the public internet. No WAN access is needed for show operation; all media, dashboard assets and PixiJS are local.
