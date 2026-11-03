# Deployment — standalone Phone Wall

## Local start

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

## Mac mini startup

Edit `scripts/phone-wall/org.museum.phonewall.plist.example`: set absolute repo, Node, SQLite/media and log directory paths and a private operator key. Create the log directory. `run-server.sh` runs the standalone entry point via a log supervisor; MongoDB and Meteor bundles are not used. The log supervisor retains a current 5 MiB file and four rotated files. Do not place production data under a build/output directory.

`build-server.sh` installs the locked standalone dependencies and runs tests using the supplied `NODE_BINARY` and `NPM_BINARY`. No compilation/bundling is needed for Node. Test on the selected deployment runtime before installation.

```sh
bash scripts/phone-wall/install-launchagent.sh /absolute/reviewed.plist
```

The installer refuses placeholders and existing installations, installs a 0600 LaunchAgent, and bootstraps it. Run it only when ready to start the real service. KeepAlive restarts Node after failure; SQLite restores current configuration and devices. This LaunchAgent runs at login. Configure the installation account's login procedure, or use an administrator-reviewed LaunchDaemon with an explicit service user for pre-login startup. A deliberately powered-off Mac may require its power button; software cannot promise power restoration will boot it. Verify actual power-loss behavior with the chosen Mac settings.

Use SQLite's backup mechanism for the controller database; include media files. Do not copy only `controller.sqlite` while ignoring live `-wal` data. Stop the service for a simple consistent file copy, or use the SQLite backup API. Media/history retention is manual to preserve rollback versions. Free disk space is an operator responsibility.

## Incremental legacy migration

`npm run start:legacy` retains the Meteor application and existing Mongo data. Run it on another port (`meteor --port 3100`) when testing alongside the new controller. No existing artwork or Mongo content is deleted. Legacy artistic routes are not silently ported into the new native renderer; use their code as the reference or adapt a visual into the optional web scene. Do not remove Meteor dependencies until those features have their own replacement tests.

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

Runtime 2.0 is the one-time native upgrade introducing the long-lived scene interpreter, offline artwork bundles and staged publication. Existing 1.x apps cannot join release deployments; the dashboard/API reports an upgrade requirement. Install 2.0 while preserving Application Support identity, then use the workflow in RUNTIME.md. Subsequent supported text/media/layout/animation/web-code changes require no IPA update. Profile/certificate expiry still requires normal Apple maintenance.

Open `ios/PhoneWall.xcodeproj`, choose your bundle identifier and paid Apple team. Target remains iOS 15.0. The native app discovers the LAN controller automatically, with saved/default `ws://mac-mini.local:3000/phone-wall/ws` fallback. Grant local-network permission. On networks with several controllers, use isolation or disable Bonjour advertisement and enter the desired fallback.

Register all UDIDs, create an Ad Hoc profile containing them, install signing identities locally and prepare ExportOptions.plist using the installed Xcode Organizer. Export method names vary with Xcode; use its generated options. Then run `APPLE_TEAM_ID=... EXPORT_OPTIONS_PLIST=/absolute/options.plist bash scripts/phone-wall/export-ipa.sh`. No Apple credentials are stored in the repository. Record certificate/profile expiry, devices, bundle ID and build number; renew well before expiry. Direct Xcode debugger support for iOS 15 depends on the toolchain. Configurator installation of the exported IPA remains the alternative.

Test one physical iPhone 6s 15.8.x before batching. Supervision may erase devices and requires explicit approval; no script supervises or erases. Back up the supervision identity. Configure Wi-Fi, install the IPA, grant permissions, pair to a slot, and manually enable Single App Mode. Test reboot/autolaunch on that exact build/device. Keep USB access and the supervision identity to exit Single App Mode in Configurator.

Identity/secret are atomically stored in protected Application Support and excluded from backup. Updates preserve them; deleting/reinstalling the app or erasing it requires re-pairing. Storage unavailable before first unlock retries rather than creating a replacement identity. Verify the lock/passcode policy on the installed phones. A terminated app cannot relaunch itself; the foreground socket is not a background execution guarantee.

Optional remote access must use a secure private tunnel to the Mac. Never forward the admin/API to the public internet. No WAN access is needed for show operation; all media, dashboard assets and PixiJS are local.
