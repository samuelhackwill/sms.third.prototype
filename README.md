## Native Phone Wall (Fastify / SQLite)

See [Architecture](ARCHITECTURE.md), [Deployment](DEPLOYMENT.md), [Staff Guide](OPERATIONS.md), [Troubleshooting](TROUBLESHOOTING.md), [Protocol](protocol/README.md) and [Acceptance](ACCEPTANCE.md). The operator route is `/admin/phone-wall`; the iOS project is `ios/PhoneWall.xcodeproj`. Hardware qualification is still required.

The [runtime 2.0 artwork contract](RUNTIME.md) documents declarative scenes, cached offline rendering, staged prepare/activate publication, WebView recovery, rollback and the boundary between artwork updates and IPA updates.

The default dashboard is now **Control**: Pair / Position and Send Test Text. Existing functionality remains in **Advanced**. Mac installer 2.2.0 includes **Update Phone Wall.app**, a pull-from-GitHub updater for committed server/UI changes without reinstalling packages; see [Updating](DEPLOYMENT.md#updating-without-reinstalling). Current 2.1 phone apps already support the staggered text scene; native artwork changes within schema v1 and web visuals need no IPA redeployment.

For the **Mac mini**, use the double-click Apple Silicon installer described in [Deployment](DEPLOYMENT.md#mac-mini-double-click-installation), then open **Phone Wall Dashboard** in Applications. It bundles Node and runs a boot-time daemon; no Terminal commands are needed on the installation Mac. macOS Bonjour advertises the Phone Wall service using the Mac's current hostname and selected port, without claiming a hostname separately.

The following commands are for **development**, not museum operation:

1. Install Node.js 22.13+.
2. Install the standalone locked dependencies:
   ```bash
   npm ci --prefix server/phone-wall
   ```
3. Set a private operator key and persistent directory, then start:
   ```bash
   export PHONE_WALL_ADMIN_TOKEN="$(openssl rand -hex 32)"
   export PHONE_WALL_DATA_DIR="$HOME/phone-wall-data"
   npm start
   ```

Run `npm test` for protocol, 30-device fleet and real-process restart tests. `npm run simulate` starts 30 persistent mocked clients. The native service requires no MongoDB, Meteor or WAN connection.

## Legacy Meteor Artwork

`npm run start:legacy` preserves the existing browser artwork, queues, curation, message ingestion and APNs experiments. Install root dependencies with the Meteor toolchain for that separate application. Use a different port when running beside the native controller. No legacy DB content is deleted.

## Legacy Runtime Data

data is written to .data/

## Data model (T-010)

- Canonical collection: `Messages` in `imports/api/messages/messages.js`.
- Indexed fields: unique `id`, plus `receivedAt`, `status`, and `source`.
