# Long-lived artwork runtime (2.0)

The iOS application is an interpreter and recovery host. Artwork is an immutable versioned document plus content-addressed assets. Updating artwork does not change the IPA.

## Version boundaries

- `runtimeVersion`: the installed native interpreter, currently `2.0`; also reported separately from app build/version.
- `sceneSchemaVersion`: the declarative document language, currently `1`.
- `artworkId` / `artworkVersion`: the artist's stable name and immutable version label. Reusing that pair with changed content/layout is rejected.
- `releaseId`: SHA-256 of definition, exact layout, asset manifest and runtime requirements. Promoting a release does not modify it.
- `deploymentId`: a particular rollout of a release to explicit devices, with one shared activation timestamp and per-device status.
- Installation configuration `revision` / `layoutRevision` remain separate from those artwork versions.

The formal schema is [scene-v1.schema.json](protocol/scene-v1.schema.json), also served at `/phone-wall/scene-schema`; a runnable native scene is in [artwork-scene.json](protocol/fixtures/artwork-scene.json). Both server and native runtime validate scenes. Future compatible runtimes may declare support for schema 1; incompatible runtimes are rejected before rollout.

## Edit → preview → publish → rollback

1. Adjust the Scene Controls and choose **Build Release from Controls**, or edit the declarative JSON and choose **Create Immutable Release**. Change the artwork version label for each edited release. Scene Controls generate a new version automatically.
2. **Preview Draft Virtually** tests the native declarative layout/animation locally, without touching phones. **Use Scene Controls** transfers quick edits into the JSON draft. Installation layout edits are captured in the next immutable release.
3. Select a single paired phone, set Target to Selected phones and choose **Prepare + Publish Target**. Watch its readiness and displayed acknowledgment.
4. Choose a named group or several selected phones and prepare the same selected release. After inspection, **Promote Same Release to Entire Wall** stages it on every paired phone. No native deployment is involved.
5. Roll back by selecting an earlier immutable release and choosing **Rollback Target to Selected Release**. Rollback uses the same preparation/readiness/activation safeguards rather than forcing an immediate content switch.

The virtual wall displays 30 slots by default and interprets declarative text/rect/ticker transforms and timing. Image/video placeholders identify media versions; native codec/GPU fidelity is not emulated. Enable actual web previews for selected virtual phones to run the uploaded JavaScript/Pixi code; four concurrent iframe previews are allowed to avoid exhausting desktop WebGL contexts. Use real phones for final media/performance checks.

## Publication protocol and failure policy

`release.create` stores an immutable definition/layout/manifest. `release.deploy` selects device IDs or a named group, a preparation timeout (default 60 seconds, maximum 120 seconds), and an activation lead time (default 3 seconds). An optional operationId makes retried deployment requests idempotent.

During `preparing`, phones retain the currently visible artwork, verify/download all asset hashes, construct hidden renderers, decode images, wait for video readiness and load local web bundles. They send `artwork.status` with deploymentId, releaseId and `ready` or `error`. A failure or preparation timeout aborts the uncommitted rollout; the old assignment remains active. No absent phone is silently excluded.

Only when every target is ready and connected does the server persist `scheduled` with one `startAtServerMs`. Native clients activate from their synchronized clock and send `displayed` after committing the local last-good record. A late/reconnected client receives the full desired release/timestamp and rejoins the current timeline. Scheduled activation continues locally across a socket outage if the commit was already received.

This is coordinated application activation, not an impossible guarantee against arbitrary device failures or network partitions. A phone that loses connectivity before receiving commit retains the old artwork; a renderer that fails after commit falls back and reports an error. The dashboard's per-device acknowledgments, not merely the deployment's `active` phase, establish rollout success. Inspect failures and roll back the cohort if needed. Actual cross-screen skew and video synchronization require hardware tests; no frame-perfect playback is claimed.

`ready` means the renderer passed preparation. `displayed` means the runtime activated its timeline; it is not optical proof of a physical LCD frame. Node restart retains releases, pending/active assignments, deadlines and activation times. Commands `restartScene` stage the same active release with a new common timestamp; choose targets sharing one release. Identify temporarily overlays a test pattern and then returns to artwork.

## Native lifecycle and offline behavior

`ConnectionManager.swift` owns sockets/discovery retry. `ArtworkModels.swift` owns schema decoding/validation. `ArtworkLibrary.swift` owns bundle preparation and atomic last-good records. `DeclarativeSceneView.swift` owns native elements. `ArtworkRuntime.swift` owns prepare/activate/fallback. `SceneWebSurface.swift` owns WebKit recovery. `StableWallController.swift` coordinates lifecycle, modes and diagnostics.

Disconnecting no longer clears the screen. The active artwork continues from the local clock. Application Support stores verified media and local WebView bundles (HTML, the exact Pixi build, script and declared resources). The current and previous successful releases are pinned against eviction; preparation also pins its candidate. Last-good metadata advances only after successful activation. A cold launch without the server can restore the last-good scene, or its previous good scene if the latest is unusable. Night/blackout configuration is retained.

Cache budget is 512 MiB; one release's declared assets are limited to 200 MiB. Preparation fails explicitly if retaining current, previous and candidate would exceed budget. It does not evict the working artwork to make room. Prefer small assets and stage groups to preload over constrained Wi-Fi. Clear Cache removes unused assets, preserving last-good pins. There is no WAN dependency.

WebKit process termination, JavaScript errors and missed foreground heartbeats trigger recreation from the cached bundle. A still image is retained behind the replacement view where available. Recovery is bounded to three attempts per minute; exhausted recovery reports an error and restores previous artwork. Failed deployment IDs are quarantined to avoid a repeated failing assignment loop. Publish a corrected release or explicitly deploy again to retry. Native code cannot forcibly reboot iOS or promise recovery from every OS-level failure.

## Declarative capabilities

Elements: text, rectangle, ticker, image, muted looping video and experimental web. Frames are wall-logical coordinates; each phone clips/maps its assigned geometry. Colors, opacity, rotation, font size, text and ticker speed are editable. Animation targets x, y, opacity or rotation, with absolute-time duration/delay, linear/easeInOut easing and optional repeat. Transitions are cut or fade. Native video seeks into the elapsed timeline when activated but is not frame locked across devices.

Resources and code are hash-versioned. The runtime enforces resource/decode/renderer budgets for old A9 hardware. Unsupported or excessive scenes fail preparation while the previous art remains visible.

## Experimental Web/Pixi SDK

Upload trusted JavaScript, use its hash as a `web` element's asset, and declare any additional `{name,hash}` resources. The manifest automatically includes the exact local Pixi build. Never load CDN resources or fetch the controller API from artwork. There is no privileged native JS bridge, no runtime admin token in page context, and no remote shell.

`window.PHONE_WALL` provides definition, parameters, device geometry, clipped viewport, synchronized clock offset, start time and playing state. Use `PhoneWall.onFrame((elapsedSeconds,state)=>...)` so rendering follows the shared timeline and pauses appropriately. For Pixi, stop its independent ticker and render inside that callback. Use `PhoneWall.asset('texture.png')` for declared local resources. Async initialization can set `parameters.manualReady=true` and call `PhoneWall.ready()` when textures/setup are ready; otherwise successful page load is the default readiness signal. Keep preparation code bounded.

Example:

```js
const app = new PIXI.Application({ resizeTo: window, backgroundColor: 0x102b28 });
document.body.appendChild(app.view);
app.ticker.stop();
const dot = new PIXI.Graphics().beginFill(0xec6a3b).drawCircle(0, 0, 30).endFill();
app.stage.addChild(dot);
PhoneWall.onFrame((elapsed, state) => {
  dot.x = (elapsed * state.parameters.speed) % state.canvas.width - state.viewport.x;
  dot.y = 150 - state.viewport.y;
  app.render();
});
```

## What requires a new IPA?

**No IPA:** text/media/code revisions; colors, speed, timing, transforms, supported animation/easing/transition settings; declared web resources; layouts; groups; schedules; previews, promotion and rollback; new JavaScript/Pixi visual behaviors within existing WebKit APIs/budgets.

**New IPA:** a new native element/API, unsupported scene schema, new native transition/easing implementation, native networking/security/storage changes, entitlements or permissions, codec capabilities not available in the installed runtime/OS, or fixes to the native interpreter itself. Signing-profile renewal remains an Apple deployment task regardless of how rarely artwork needs an IPA.

One initial upgrade to runtime 2.0 is needed for existing 1.x phone apps. Subsequent artistic iteration within this contract does not require reinstalling the phones.
