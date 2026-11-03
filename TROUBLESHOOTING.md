# Troubleshooting

**Controller fails to start:** verify `PHONE_WALL_ADMIN_TOKEN` is 32+ characters, Node is at least 22.13, and `npm ci --prefix server/phone-wall` completed. Check persistent directory permissions, free disk and port conflicts. Meteor and MongoDB are not needed for the standalone service.

**Mac restarted but service absent:** a LaunchAgent starts at user login. Check installation-account login and `launchctl print gui/$(id -u)/org.museum.phonewall`. Check the bounded server logs. Pre-login operation needs the reviewed LaunchDaemon setup, not an assumption about automatic login/power restoration.

**Discovery fails:** confirm dedicated Wi-Fi, local-network permission, multicast/mDNS availability and only the intended installation on that LAN. The service advertises `_phonewall._tcp`. Configure the stable fallback URL when multicast is blocked. Router client isolation may block both Bonjour and ordinary traffic. Discovery does not require internet.

**One phone connects but others wait:** enable Local Network permission for PhoneWall on each phone and confirm all phones use the installation Wi-Fi. App 2.1 bounds the connection handshake to ten seconds, retries Bonjour resolution, and lets discovery replace a stale in-flight fallback. The setup label shows the hostname actually being contacted; after welcome the address field shows the resolved endpoint. Pairing chips explicitly label ONLINE/OFFLINE: saved unpaired records are not evidence of live connections. Reinstall the updated IPA over the old one without deleting the app to preserve identity. If access is denied or Wi-Fi isolates clients, code retries cannot fix that network policy.

**Mac changes its name to sms-ingestor-2.local:** install controller package 2.0.1 or newer. Version 2.0.0 incorrectly published host address records independently of macOS. The corrected version registers only a service using system Bonjour, retains data and does not require an IPA update. The suffix may remain until you edit the local hostname in System Settings > General > Sharing. Automatic discovery works with the suffix; do not force the original name if another real machine uses it.

**401 / pairing lost:** operator key and device secret serve different roles. Import full credential hashes before switching an existing wall. A deleted/reinstalled app obtains a new identity and needs pairing. Never copy a phone's identity file to another phone. An unreadable identity file fails closed; recover it with installer assistance.

**Phone becomes dark:** runtime 2.0 should keep the last good artwork during connection loss. Check night/blackout mode, whether a good release has ever activated, identity/storage availability and per-deployment errors. Restore server/Wi-Fi and let backoff retry; reconnect requests a complete snapshot. Do not reinstall the app to fix a transient outage, since reinstalling removes cached identity/artwork.

**Stale edit rejected:** reload current JSON or merge your intended changes; configuration edits require expectedRevision. Rollback creates a new revision. A preview temporarily overrides base artwork for its target and expires automatically. Resume clears persistent targeted overrides; global mode controls clear all temporary previews.

**Scene does not change on one group:** check selected target scope, IDs/groups in configuration and pending pairing. Native renderer kinds are fixed in the IPA; use supported scene parameters or the experimental web renderer for rapid visual changes. New native APIs/codecs require a client update.

**Media preparation fails:** inspect the target's deployment error: missing/invalid asset, checksum, renderer timeout or cache budget. The working release stays visible. Current and previous assets are pinned; Clear Cache removes unused assets rather than destroying last-good content. Prefer modest resolutions and compatible muted H.264 MP4 on A9 devices. Total declared assets per release are limited to 200 MiB; current + previous + candidate must fit the 512 MiB cache budget. Stage groups to preload over constrained Wi-Fi.

**Experimental visual fails:** inspect the release's script/version and PixiJS API use. Declare all resources, avoid CDN/fetch dependencies, and use PhoneWall.onFrame for timeline rendering. For async setup use manualReady + PhoneWall.ready(). WebKit errors/termination/missed heartbeats recreate the cached view up to three times per minute; exhausted recovery reports failure and falls back. A failed deployment is quarantined to avoid repeated crashes; deploy a corrected release or explicitly deploy again. Native runtime fixes still require an IPA.

**Ticker seams:** verify geometry including bezel gaps, mounted orientation, clock samples and Wi-Fi latency. Use the shared-time bar and measure actual adjacent-screen skew. Frame-perfect sync is not guaranteed.

**IPA does not install / app terminated:** verify registered UDID, signing identity, profile/certificate expiry and bundle ID. Use Configurator if debugger deployment is unsupported. Follow the tested Single App Mode USB recovery workflow; an ordinary app cannot turn on or reboot an iPhone.
