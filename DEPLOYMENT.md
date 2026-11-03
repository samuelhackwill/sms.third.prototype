# Deployment — standalone Phone Wall

## Mac Mini: Double-Click Installation

Open `Phone-Wall-sms-ingestor-2.3.0-arm64.pkg` on the Apple Silicon Mac mini and approve the installer once with an administrator password. Then open **Phone Wall Dashboard** in Applications. Existing installations can instead use the GitHub updater after the new source is published. No Git, Node installation, npm commands or operator-key entry is needed on that Mac. The unsigned development package may require approval in System Settings > Privacy & Security; production distribution should use a Developer ID Installer certificate and notarization.

The package bundles an ARM64 Node runtime and locked production dependencies. It creates a non-login `_phonewall` service account and a system LaunchDaemon (`org.museum.phonewall`) which starts before login and restarts after failure. It does not supervise/erase phones or modify the Meteor installation. Existing controller data and operator key survive package upgrades.

On macOS, `/usr/bin/dns-sd -R` registers the **Phone Wall** service (`_phonewall._tcp`) through the system mDNSResponder, with protocol version and the actual selected port. Only macOS owns the hostname/address records; the controller does not publish competing A/AAAA records. Port 3100 is preferred; another free port through 3110 is selected if necessary, without stopping existing services. The phones use the resolved hostname and advertised port, not hardcoded ones. Allow local networking/firewall access if macOS prompts, and ensure the dedicated Wi-Fi permits multicast and communication between clients.

Version 2.0.1 removes the explicit hostname claim from 2.0.0 and ignores legacy `advertisedHost` / `PHONE_WALL_HOSTNAME` settings. Run the new package over the existing installation: it stops the old managed daemon, preserves data/key/port and starts the corrected service. **It does not rename the Mac back.** If macOS previously selected `sms-ingestor-2.local`, Bonjour continues to work with that name. After upgrading, you may restore `sms-ingestor` through System Settings > General > Sharing > Local hostname > Edit, provided no other actual device uses it. If a conflict persists, keep the unique name and investigate the other device; do not repeatedly force a contested name. No IPA rebuild is needed for this fix.

Installed code/runtime: `/Library/Application Support/PhoneWall/app`; persistent SQLite/media: `/Library/Application Support/PhoneWall/data`; configuration: `/Library/Application Support/PhoneWall/config.json`; bounded logs: `/Library/Logs/PhoneWall/server.log`. The local dashboard launcher reads `operator.key` and passes it in a URL fragment which the dashboard immediately removes. **Local users in the Mac's `staff` group are trusted operators**; remote HTTP administration still requires the bearer key. Do not expose the service publicly.

Build the installer on the development Mac with `node scripts/phone-wall/build-macos-installer.mjs`. The output is in `.data/distribution/`. Building needs internet; installation and operation do not. Set `PHONE_WALL_NODE_VERSION` to pin a Node 24 release, `PHONE_WALL_PACKAGE_VERSION` for package upgrades, and optionally `PHONE_WALL_INSTALLER_IDENTITY` to sign. The builder verifies the downloaded runtime checksum against the official release manifest. Test installation, reboot recovery and Bonjour on the actual Mac mini before exhibition; building the package does not prove those hardware checks.

## Updating Without Reinstalling

Installer 2.2.0 adds **Update Phone Wall.app** to Applications and bundles npm for future updates. Open that launcher and approve local administrator access. It downloads the latest committed source from the public `samuelhackwill/sms.third.prototype` repository, branch `phone-wall-runtime-2`, resolved to a specific commit. This is a pull-from-GitHub workflow using a source archive, not a Git working tree; neither Git nor developer tools are required on the Mac mini. It never edits the developer checkout. **Uncommitted/unpushed changes cannot be fetched.** Source without the update-format marker is refused before stopping the service.

The updater validates the source format/runtime, installs locked production dependencies with lifecycle scripts disabled, and smoke-tests a separate temporary controller before stopping the running service. It takes a SQLite backup at `/Library/Application Support/PhoneWall/update-backup/controller.sqlite`, swaps only application code, restarts the daemon, and checks health. The last working code remains at `app.previous`; startup failure restores that code. Data, media, configuration and operator key are outside the swap. Code rollback is not automatic reversal of arbitrary database migrations: review migration compatibility before publishing updates. Update scripts themselves are privileged trusted code; only a local administrator can launch this workflow, never a public/dashboard HTTP request.

Internet is needed only while downloading updates. Interrupted staging leaves the running installation untouched; do not schedule updates during the show. If the updater is forcibly terminated, a stale `update.lock` may require administrator recovery; do not remove a lock while another update is running. The full privileged update/reboot cycle still needs validation on the Mac mini. The system never automatically updates from a mutable branch unattended.

Dashboard launcher icons are also applied by the updated updater. When upgrading from the original 2.2.0 installer, **run Update Phone Wall twice for the first icon change**: the old updater only swaps server files; that first run installs the icon-aware updater, and the second applies the icon to Applications. Later icon updates take one run. The aubergine asset is rendered from macOS Apple Color Emoji using `xcrun swift scripts/phone-wall/build-dashboard-icon.swift scripts/phone-wall/assets/dashboard.icns` on the development Mac; the committed ICNS is used directly on the Mac mini, which needs no Swift/Xcode. The launcher is staged, re-signed and signature-checked before replacing it; Finder/Dock are not forcibly restarted.

Server/dashboard changes and supported JSON/native/web artwork need no phone reinstall. New UIKit behavior, entitlements, OS permissions or native APIs still require a signed IPA. The simplified controls and Send Test Text work with the existing 2.1 runtime. Optional app 2.1.1 (build 4) more explicitly hides the connection form and dismisses its keyboard after pairing; it is not required to try the new dashboard or text action.

## Kissing Wall: Native Update

Update the Mac controller through the GitHub updater after the source is committed/pushed. Archive/export and install **PhoneWall 2.4.2 (build 9)** from `ios/PhoneWall.xcodeproj` once for native independent video playback and connection recovery fixes. Existing pairing/identity is retained by an in-place app update; do not uninstall first. Start using **Control > Kissing Wall**. Settings/media changes after this installation are server-side; no further IPA is needed for trim/fades or new clips. Only the Mac accesses the remote kissing API. Allow initial downloads before disconnecting WAN. Speaker output, codec compatibility and endurance must be checked on the actual iPhone 6s.

Developer smoke (not on the museum Mac): with a booted simulator, a compiled simulator `.app` and ffmpeg installed, run `PHONE_WALL_SIMULATOR_ID=<id> PHONE_WALL_SIM_APP=<path-to-PhoneWall.app> node tools/simulator/kissing-wall-smoke.mjs`. It generates two H.264/AAC fixtures, runs native independent playback against an isolated controller, checks night/resume, cold offline launch via a rendered-video screenshot, server restart and stop. It changes the simulator's app state, never physical phones. Output is under `.data/kissing-wall-smoke/`. `npm test --prefix server/phone-wall` covers source validation, corrupted-cache repair, bounded rotation, 30 clients and authenticated local HTTP delivery; no remote API is required by tests.

## Live iMessages: One-Time Setup on sms-ingestor

1. Update the Mac controller to source version 2.3.0 and install native **PhoneWall 2.3, build 6** over the existing app on each phone. Keep the bundle identifier/team unchanged. This runtime update adds the narrow live-ticker bridge; ordinary artwork edits still need no IPA. Older phones are explicitly flagged rather than entering a failed deployment loop.
2. Log into the macOS account that runs Messages.app, and open **Phone Wall Dashboard**. It installs/restarts the reader LaunchAgent for that user automatically. No Terminal commands are needed. The main display server remains its existing boot-time `_phonewall` LaunchDaemon; it never opens chat.db itself.
3. In **System Settings > Privacy & Security > Full Disk Access**, explicitly authorize `/Library/Application Support/PhoneWall/app/runtime/bin/node` for this Messages reader. Use the file chooser's Go to Folder facility if needed. This is a broad OS permission, not something the installer can silently grant. No TCC database manipulation, SIP changes, supervision or device erasure is performed. Apple's [Full Disk Access guidance](https://developer.apple.com/news/?id=p6zjojqw) describes the need for explicit user consent.
4. Reopen **Phone Wall Dashboard** after granting permission so the reader restarts. Polling and playback start automatically. Wait for **Reader connected; watching new iMessages**, then send a new incoming message from another account/number. Messages sent by the installation's own account are deliberately excluded.

The reader defaults to that user's `~/Library/Messages/chat.db`. `MESSAGES_DB_PATH` is available for development fixtures or an explicitly configured reader environment; no private DB is inspected by the automated tests. First contact with a database records its current highest ROWID and skips existing history. Thereafter its cursor is durable in the controller SQLite DB and advances only in the same transaction as deduplicated queue insertion. Server downtime, paused playback and temporary permission failures do not reset that cursor. Database replacement establishes a new baseline; an unexpected ROWID rollback on the same file is surfaced rather than importing history silently.

Queue playback and the phone wall work without WAN access. Arrival of new iMessages still depends on Messages.app receiving them through its normal Apple/account connectivity; the local reader does not replace that service.

The user agent is `~/Library/LaunchAgents/org.museum.phonewall.messages.plist`; identity is in `~/Library/Application Support/PhoneWallReader/identity.json`; bounded logs are in `~/Library/Logs/PhoneWallReader/server.log`. It starts at user login, not before login. The museum's Messages user must remain logged in for ingestion. The existing wall server can boot and show cached artwork without that login. Reopening the dashboard restarts the reader, including after GitHub source updates. The reader continuously polls the personal database while the Messages user is logged in. Kissing Wall and Barthes mode hold incoming-message playback; queued messages resume afterward.

Source messages are read-only. Plain text and archived attributed bodies are supported through the built-in macOS Foundation decoder in a separate bounded process; outgoing messages, reactions, system notices and attachment-only entries are ignored. Display text is clamped at 100 complete grapheme clusters / 495 UTF-16 code units, with `[...]` when shortened; no surrogate or joined emoji is sliced. No sender address is needed or stored. Decode failure holds the cursor and exposes an error instead of silently losing later messages. The queue stops accepting new batches at 10,000 unfinished messages, leaving source data/cursor untouched until playback frees capacity. Completed records remain in the protected wall database; back up and monitor disk usage, and treat it as private installation data.

For tests: `npm test --prefix server/phone-wall` covers cursor/FIFO behavior with synthetic DBs; `npm run test:live --prefix server/phone-wall` exercises actual browser artwork with a native-bridge stand-in. The optional simulator smoke test below accepts `PHONE_WALL_SMOKE_LIVE=1` to exercise the real native bridge too. Actual Messages account permissions and physical multi-phone delivery still require testing on the installation Mac/phones.

## Developer Local Start

Use Node.js 22.13+; the repository's standalone service does not need Meteor or MongoDB. Provision the chosen Node runtime and npm dependencies before going offline.

```sh
npm ci --prefix server/phone-wall
export PHONE_WALL_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PHONE_WALL_DATA_DIR="$HOME/phone-wall-data"
npm start
```

Open `http://mac-mini.local:3000/admin/phone-wall`. The random operator key is entered only into the dashboard and held in memory. Save it securely outside the repo. `PORT` defaults to 3000, `HOST` to 0.0.0.0. Bonjour advertises `_phonewall._tcp` with the WebSocket path. Set `PHONE_WALL_MDNS=false` to disable discovery, or `PHONE_WALL_NAME` to label this installation. Configure a DHCP reservation/stable server hostname and a dedicated router. There is no required outbound internet connection at runtime.

Run tests with `npm test`; run the optional mock fleet with `npm run simulate`. `PHONE_WALL_URL`, `PHONE_WALL_COUNT` configure the fleet. Its ignored `.data/simulator.json` keeps stable fake identities. Automated tests create isolated temporary SQLite databases; they do not touch installation data. The older manual integration script supports `PHONE_WALL_HTTP` and an operator key but deliberately leaves test records: use it only on a development database.

Browser checks: after installing development dependencies and the Playwright Firefox browser (`npx playwright install firefox` from `server/phone-wall`), run `npm run test:ui --prefix server/phone-wall`. An existing compatible Firefox binary can be supplied through `PHONE_WALL_BROWSER_EXECUTABLE`. CI includes the browser check. Production `npm ci --omit=dev` does not include Playwright.

## Legacy Developer Login Service (Not the Installer)

Edit `scripts/phone-wall/org.museum.phonewall.plist.example`: set absolute repo, Node, SQLite/media and log directory paths and a private operator key. Create the log directory. `run-server.sh` runs the standalone entry point via a log supervisor; MongoDB and Meteor bundles are not used. The log supervisor retains a current 5 MiB file and four rotated files. Do not place production data under a build/output directory.

`build-server.sh` installs the locked standalone dependencies and runs tests using the supplied `NODE_BINARY` and `NPM_BINARY`. No compilation/bundling is needed for Node. Test on the selected deployment runtime before installation.

```sh
bash scripts/phone-wall/install-launchagent.sh /absolute/reviewed.plist
```

The installer refuses placeholders and existing installations, installs a 0600 LaunchAgent, and bootstraps it. Run it only when ready to start the real service. KeepAlive restarts Node after failure; SQLite restores current configuration and devices. This LaunchAgent runs at login. Configure the installation account's login procedure, or use an administrator-reviewed LaunchDaemon with an explicit service user for pre-login startup. A deliberately powered-off Mac may require its power button; software cannot promise power restoration will boot it. Verify actual power-loss behavior with the chosen Mac settings.

Use SQLite's backup mechanism for the controller database; include media files. Do not copy only `controller.sqlite` while ignoring live `-wal` data. Stop the service for a simple consistent file copy, or use the SQLite backup API. Media/history retention is manual to preserve rollback versions. Free disk space is an operator responsibility.

## Incremental legacy migration

`npm run start:legacy` retains the Meteor application and existing Mongo data. The packaged controller prefers port 3100, so Meteor can remain on 3000; keep their ports distinct. No existing artwork or Mongo content is deleted. Legacy artistic routes are not silently ported into the new native renderer; use their code as the reference or adapt a visual into the optional web scene. Do not remove Meteor dependencies until those features have their own replacement tests.

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
