import Fastify from "fastify";
import staticFiles from "@fastify/static";
import { WebSocketServer } from "ws";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { Store, hash, equal } from "./store.mjs";
import { validateScene } from "./config.mjs";
import { Releases } from "./releases.mjs";
import { PairingSession } from './pairing.mjs';
import { testTextDefinition } from './test-text.mjs';
import { LiveTicker } from './live-ticker.mjs';
import { KissingWall } from './kissing-wall.mjs';
import { releaseHash } from './scenes.mjs';
import {
  envelope,
  decode,
  validId,
  scheduledMode,
} from "../../protocol/core.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const commands = [
  "reloadState",
  "restartScene",
  "blackout",
  "resume",
  "clearCache",
  "query-diagnostics",
  "reload-state",
  "purge-expired-media",
];
export async function createController({
  dataDir,
  adminToken,
  logger = false,
  kissingOptions = {},
} = {}) {
  if (typeof adminToken !== "string" || adminToken.length < 32)
    throw new Error(
      "PHONE_WALL_ADMIN_TOKEN must contain at least 32 characters",
    );
  dataDir = resolve(dataDir ?? join(root, "../../.data/phone-wall"));
  const mediaDir = join(dataDir, "media");
  await mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const store = new Store(join(dataDir, "controller.sqlite"));
  const pixi = await readFile(
    join(root, "node_modules/pixi.js/dist/pixi.min.js"),
  );
  const pixiHash = createHash("sha256").update(pixi).digest("hex");
  await writeFile(join(mediaDir, pixiHash), pixi, { mode: 0o600 });
  store.db
    .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?)")
    .run(pixiHash, "text/javascript", pixi.length);
  const testTextScript=await readFile(join(root,'public/artwork/test-text.js'));
  const testTextHash=createHash('sha256').update(testTextScript).digest('hex');
  await writeFile(join(mediaDir,testTextHash),testTextScript,{mode:0o600});
  store.db.prepare('INSERT OR IGNORE INTO assets VALUES(?,?,?)').run(testTextHash,'text/javascript',testTextScript.length);
  const releases = new Releases(store, pixiHash);
  const ticker=new LiveTicker(store);
  const app = Fastify({
    logger,
    bodyLimit: 65536,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
  });
  const sessions = new Map();
  const kissing=new KissingWall(store,mediaDir,{...kissingOptions,onChange:()=>broadcast()});
  await kissing.initialize();
  const liveAttempts=new Map();
  const pairing=new PairingSession(store);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const send = (ws, type, payload, revision = 0, id) => {
    if (ws.readyState === 1)
      ws.send(JSON.stringify(envelope(type, payload, revision, id)));
  };
  const snapshot = (id) => {
    const ws = sessions.get(id),
      state = store.snapshot(id);
    if (ws && state)
      send(
        ws,
        "state.snapshot",
        { ...state, artwork: releases.snapshot(id), kissing:kissing.snapshot(id) },
        state.revision,
      );
  };
  const broadcast = () => {
    for (const id of sessions.keys()) snapshot(id);
  };
  const pairingState=(id)=>{const ws=sessions.get(id);if(ws)send(ws,'pairing.state',pairing.status(id));};
  const broadcastPairing=()=>{for(const id of sessions.keys())pairingState(id);};
  const tickerBroadcast=()=>{for(const [id,ws] of sessions)send(ws,'ticker.snapshot',ticker.snapshot(id));};
  const pauseTicker=()=>{ticker.pause();tickerBroadcast();};
  function tickerTick(){
    const state=store.current(),allowed=state.mode==='exhibition'&&!pairing.status().active;
    if(ticker.enabled&&allowed&&state.layout.slots.length){
      const definition=testTextDefinition(state.layout,{asset:testTextHash});
      definition.artworkId='live-ticker';definition.parameters={...definition.parameters,live:true};
      definition.artworkVersion=releaseHash({parameters:definition.parameters,elements:definition.elements,canvas:definition.canvas,layout:state.layout});
      for(const id of state.layout.slots.map(slot=>slot.deviceId)){
        if(!sessions.has(id)||store.device(id)?.capabilities?.liveTicker!==1)continue;
        const art=releases.snapshot(id);
        if(art.pending)continue;
        const attempt=liveAttempts.get(id);
        if(attempt?.layoutRevision===state.layoutRevision&&(attempt.failed||['failed','cancelled'].includes(releases.deployment(attempt.id).phase)))continue;
        if(art.active?.release.definition.artworkId==='live-ticker'&&art.active.release.definition.artworkVersion===definition.artworkVersion)continue;
        try{
          const release=releases.create(definition),deployment=releases.deploy(release.id,[id],{delayMs:1000});
          liveAttempts.set(id,{id:deployment.id,layoutRevision:state.layoutRevision});snapshot(id);
        }catch{liveAttempts.set(id,{failed:true,layoutRevision:state.layoutRevision});store.updateDevice(id,{lastError:'live-ticker-prepare-failed'});}
      }
    }
    const ready=new Set([...sessions.keys()].filter(id=>{
      const art=releases.snapshot(id),status=store.device(id)?.artworkStatus;
      return store.device(id)?.capabilities?.liveTicker===1&&store.snapshot(id)?.mode==='exhibition'&&!art.pending&&art.active?.release.definition.artworkId==='live-ticker'&&status?.releaseId===art.active.releaseId&&status.status==='displayed';
    }));
    if(ticker.tick(ready,allowed))tickerBroadcast();
  }
  const bearer = (req) =>
    req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const operator = (req) => equal(bearer(req), adminToken);
  const authorize = async (req, reply) => {
    if (!operator(req)) return reply.code(401).send({ error: "unauthorized" });
    if (
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      return reply.code(403).send({ error: "origin" });
  };
  app.setErrorHandler((error, req, reply) =>
    reply
      .code(error.statusCode >= 400 ? error.statusCode : 400)
      .send({ error: error.message }),
  );
  await app.register(staticFiles, {
    root: join(root, "public"),
    prefix: "/console/",
  });
  app.get("/", async (req, reply) => reply.redirect("/admin/phone-wall"));
  app.get("/admin/phone-wall", async (req, reply) =>
    reply.sendFile("index.html"),
  );
  app.get("/health", async () => ({ ok: true, protocol: 1 }));
  app.get("/phone-wall/scene-schema", async (req, reply) =>
    reply
      .type("application/schema+json")
      .send(
        await readFile(
          join(root, "../../protocol/scene-v1.schema.json"),
          "utf8",
        ),
      ),
  );
  app.get("/phone-wall/api", { preHandler: authorize }, async () => {
    const state = store.current();
    return {
      state,
      pairing:pairing.status(),
      kissing:{...kissing.status(),upgradeRequired:state.layout.slots.filter(slot=>sessions.has(slot.deviceId)&&store.device(slot.deviceId)?.capabilities?.kissingWall!==1).map(slot=>slot.deviceId)},
      ticker:{...ticker.status(),upgradeRequired:state.layout.slots.filter(slot=>sessions.has(slot.deviceId)&&store.device(slot.deviceId)?.capabilities?.liveTicker!==1).map(slot=>slot.deviceId)},
      serverTimeMs: Date.now(),
      history: store.history(),
      artwork: releases.list(),
      devices: store.devices().map((d) => {
        const { tokenHash, ...safe } = d;
        const slot = state.layout.slots.find((s) => s.deviceId === d._id);
        const display = slot ? store.snapshot(d._id) : null;
        return {
          ...safe,
          paired: !!slot,
          slotIndex: slot?.slotIndex,
          geometry: slot?.geometry,
          connected: sessions.has(d._id),
          display: display
            ? {
                scene: display.scene,
                mode: display.mode,
                previewUntil: display.previewUntil,
                pairing: pairing.status(d._id),
                kissing:kissing.snapshot(d._id),
                artwork: releases.snapshot(d._id),
              }
            : null,
        };
      }),
    };
  });
  app.get('/phone-wall/reader/:sourceId',{preHandler:authorize},async(req)=>{
    const id=req.params.sourceId;if(!validId(id))throw new Error('invalid-reader-id');
    if(!ticker.source(id))ticker.reader(id);
    else store.db.prepare('UPDATE ticker_sources SET last_seen=? WHERE id=?').run(Date.now(),id);
    return {enabled:ticker.enabled,cursor:ticker.source(id)};
  });
  app.post('/phone-wall/reader/:sourceId',{preHandler:authorize},async(req)=>{
    const id=req.params.sourceId;if(!validId(id))throw new Error('invalid-reader-id');
    if(req.body?.action==='status'){
      const code=req.body.code;if(typeof code!=='string'||!/^[-a-z]{1,80}$/.test(code))throw new Error('invalid-reader-status');
      ticker.reader(id,code,code==='paused'?null:code);return {ok:true};
    }
    if(req.body?.action!=='batch'||!ticker.enabled)throw new Error('reader-disabled');
    return ticker.ingest({...req.body,sourceId:id});
  });
  function targets(input) {
    const state = store.current();
    const ids = input.deviceId
      ? [input.deviceId]
      : input.group
        ? state.groups[input.group]
        : (input.deviceIds ?? state.layout.slots.map((s) => s.deviceId));
    if (
      !Array.isArray(ids) ||
      ids.length > 100 ||
      ids.some((id) => !validId(id) || !store.device(id))
    )
      throw new Error("invalid-targets");
    return [...new Set(ids)];
  }
  function assetScene(scene) {
    validateScene(scene);
    if (scene.hash && !store.asset(scene.hash))
      throw new Error("unknown-media");
    return scene;
  }
  app.post("/phone-wall/api", { preHandler: authorize }, async (req) => {
    const input = req.body ?? {},
      previous = store.current();
    const operationId = input.operationId;
    if (operationId && !validId(operationId))
      throw new Error("invalid-operation-id");
    const expected = input.expectedRevision ?? previous.revision;
    if (
      ["configure", "rollback"].includes(input.action) &&
      !Number.isInteger(input.expectedRevision)
    )
      throw new Error("expected-revision-required");
    let state = structuredClone(previous);
    if(['kissing.start','kissing.settings','kissing.stop'].includes(input.action)){
      if(input.settings?.enabled!==undefined)throw new Error('use-kissing-start-or-stop');
      if(input.action!=='kissing.stop'&&pairing.status().active)throw new Error('stop-pairing-before-kissing-wall');
      if(input.action==='kissing.start'){
        if(!state.layout.slots.length)throw new Error('pair-phones-before-kissing-wall');
        if(state.layout.slots.some(slot=>sessions.has(slot.deviceId)&&store.device(slot.deviceId)?.capabilities?.kissingWall!==1))throw new Error('phone-app-2.4-required-for-kissing-wall');
      }
      kissing.configure({...input.settings,...(input.action==='kissing.start'?{enabled:true}:input.action==='kissing.stop'?{enabled:false}:{})});
      if(input.action==='kissing.start'){
        pauseTicker();store.commit({...state,mode:'exhibition',schedule:null,overrides:{}},previous.revision);
        store.db.prepare('DELETE FROM previews').run();
      }
      broadcast();kissing.tick();return {ok:true};
    }
    if(input.action==='live.start'){
      if(pairing.status().active)throw new Error('stop-pairing-before-live-messages');
      if(state.layout.slots.some(slot=>sessions.has(slot.deviceId)&&store.device(slot.deviceId)?.capabilities?.liveTicker!==1))throw new Error('phone-app-2.3-required-for-live-messages');
      kissing.configure({enabled:false});liveAttempts.clear();ticker.start();store.commit({...state,mode:'exhibition',schedule:null,overrides:{}},previous.revision);broadcast();tickerTick();return {ok:true};
    }
    if(input.action==='live.pause'){pauseTicker();return {ok:true};}
    if(['test.text','release.deploy','rollback','scene','preview','identify'].includes(input.action))pauseTicker();
    if(kissing.settings.enabled&&['test.text','release.deploy','rollback','scene','preview'].includes(input.action)){kissing.configure({enabled:false});broadcast();}
    if(input.action==='pairing.start'||input.action==='pairing.stop') {
      const result=input.action==='pairing.start'?pairing.start():pairing.stop();
      broadcast();broadcastPairing();
      return {ok:true,pairing:result};
    }
    if(pairing.status().active&&['pair','layout','configure','rollback'].includes(input.action))throw new Error('stop-pairing-before-editing-layout');
    if(input.action==='test.text') {
      if(pairing.status().active)throw new Error('stop-pairing-before-sending-test-text');
      const ids=state.layout.slots.map(slot=>slot.deviceId).filter(id=>sessions.has(id));
      if(!ids.length)throw new Error('no-paired-phones-online');
      const speed=input.speed??state.testTextSpeed??240;
      const text=input.text??state.testText??'Bla bla bla';
      const release=releases.create(testTextDefinition(state.layout,{speed,text,asset:testTextHash}));
      const deployment=releases.deploy(release.id,ids,{delayMs:1500});
      store.commit({...state,testTextSpeed:speed,testText:text,mode:'exhibition',schedule:null,overrides:{}},previous.revision);
      store.db.prepare('DELETE FROM previews').run();
      broadcast();broadcastPairing();
      return {ok:true,deployment,online:ids.length,offline:state.layout.slots.length-ids.length};
    }
    if (input.action === "release.create")
      return { release: releases.create(input.definition, input.layout) };
    if (input.action === "release.deploy") {
      const deployment = releases.deploy(input.releaseId, targets(input), {
        delayMs: input.delayMs,
        timeoutMs: input.timeoutMs,
        operationId,
      });
      Object.keys(deployment.targets).forEach(snapshot);
      return { deployment };
    }
    if (input.action === "release.cancel") {
      releases.cancel(input.deploymentId);
      broadcast();
      return { ok: true };
    }
    if (input.action === "pair") {
      const d = store.devices().find((d) => d.pairingCode === input.code);
      if (!d) throw new Error("invalid-pairing");
      state.layout.slots = state.layout.slots.filter(
        (s) => s.deviceId !== d._id,
      );
      state.layout.slots.push({
        deviceId: d._id,
        slotIndex: input.slotIndex,
        geometry: input.geometry,
      });
      state.layoutRevision++;
    } else if (input.action === "configure") {
      state = {
        ...structuredClone(input.config),
        installationId: previous.installationId,
      };
    } else if (input.action === "rollback") {
      state = store.revision(input.revision);
      state.layoutRevision = previous.layoutRevision + 1;
    } else if (input.action === "mode") {
      state.mode = input.mode;
      state.schedule = null;
      state.overrides = {};
    } else if (input.action === "scene") {
      state.scene = assetScene({
        id: randomBytes(8).toString("hex"),
        kind: input.kind,
        text: input.text ?? "",
        speed: input.speed ?? 100,
        startAtServerMs: Date.now() + 1500,
        ...(input.hash ? { hash: input.hash } : {}),
        ...(input.color ? { color: input.color } : {}),
        ...(input.fontSize ? { fontSize: input.fontSize } : {}),
      });
      state.overrides = {};
    } else if (input.action === "schedule") {
      scheduledMode(input.schedule);
      state.schedule = input.schedule;
    } else if (input.action === "layout") {
      state.layout = {
        ...state.layout,
        rows: input.rows,
        columns: input.columns,
        gap: input.gap,
      };
      state.layoutRevision++;
    } else if (input.action === "preview" || input.action === "identify") {
      const ids = targets(input);
      const scene =
        input.action === "identify"
          ? {
              id: "identify",
              kind: "test",
              text: "PHONE WALL",
              speed: 100,
              startAtServerMs: Date.now(),
            }
          : assetScene(input.scene);
      const duration = input.durationMs ?? 15000;
      if (!Number.isInteger(duration) || duration < 1000 || duration > 3600000)
        throw new Error("invalid-preview-duration");
      store.preview(ids, { scene, mode: "exhibition" }, duration);
      ids.forEach(snapshot);
      return { ok: true };
    } else if (input.action === "sync") {
      broadcast();
      return { ok: true };
    } else if (input.action === "command") {
      if (!commands.includes(input.name)) throw new Error("invalid-command");
      const ids = targets(input),
        name = input.name;
      if (name === "restartScene") {
        const active = ids.map((id) => releases.snapshot(id).active);
        if (active.some(Boolean)) {
          if (
            active.some((a) => !a) ||
            new Set(active.map((a) => a.releaseId)).size !== 1
          )
            throw new Error("restart-targets-must-share-release");
          const deployment = releases.deploy(active[0].releaseId, ids, {
            operationId,
          });
          ids.forEach(snapshot);
          return { deployment };
        }
      }
      if (["blackout", "resume", "restartScene"].includes(name)) {
        const all = !input.deviceId && !input.deviceIds && !input.group;
        if (all) {
          state.overrides = {};
          state.schedule = null;
          if (name === "restartScene")
            state.scene.startAtServerMs = Date.now() + 1500;
          else state.mode = name === "blackout" ? "blackout" : "exhibition";
        } else {
          state.overrides ??= {};
          for (const id of ids) {
            if (name === "resume") delete state.overrides[id];
            else {
              const current = store.snapshot(id);
              if (!current) throw new Error("device-not-paired");
              state.overrides[id] =
                name === "blackout"
                  ? { mode: "blackout" }
                  : {
                      scene: {
                        ...current.scene,
                        startAtServerMs: Date.now() + 1500,
                      },
                    };
            }
          }
        }
      } else {
        const commandId = input.commandId ?? randomBytes(16).toString("hex");
        if (!validId(commandId)) throw new Error("invalid-command-id");
        for (const id of ids) {
          const ws = sessions.get(id);
          if (!ws) continue;
          const alias = name === "reloadState" ? "reload-state" : name;
          send(
            ws,
            "command",
            { name: alias, commandId },
            state.revision,
            commandId,
          );
        }
        return {
          ok: true,
          commandId,
          online: ids.filter((id) => sessions.has(id)).length,
        };
      }
    } else throw new Error("invalid-action");
    assetScene(state.scene);
    for (const patch of Object.values(state.overrides ?? {}))
      if (patch.scene) assetScene(patch.scene);
    for (const slot of state.layout.slots)
      if (!store.device(slot.deviceId))
        throw new Error("unknown-layout-device");
    const updated = store.commit(state, expected, operationId);
    if (input.action === "command")
      for (const id of targets(input))
        store.db.prepare("DELETE FROM previews WHERE device_id=?").run(id);
    else if (["mode", "scene", "rollback", "configure"].includes(input.action))
      store.db.prepare("DELETE FROM previews").run();
    broadcast();
    broadcastPairing();
    return { ok: true, revision: updated.revision };
  });
  app.addContentTypeParser(
    /^(image\/(png|jpeg)|video\/mp4|text\/javascript)(;.*)?$/,
    (req, payload, done) => done(null, payload),
  );
  app.post(
    "/phone-wall/media",
    { preHandler: authorize, bodyLimit: 200 * 1024 * 1024 },
    async (req, reply) => {
      const mime = req.headers["content-type"]?.split(";")[0];
      if (
        !["image/png", "image/jpeg", "video/mp4", "text/javascript"].includes(
          mime,
        )
      )
        throw new Error("unsupported-media");
      const temporary = join(
          mediaDir,
          `incoming-${randomBytes(16).toString("hex")}`,
        ),
        digest = createHash("sha256");
      let bytes = 0;
      try {
        await pipeline(
          req.body,
          new Transform({
            transform(chunk, encoding, cb) {
              bytes += chunk.length;
              if (bytes > 200 * 1024 * 1024) cb(new Error("media-too-large"));
              else {
                digest.update(chunk);
                cb(null, chunk);
              }
            },
          }),
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        const checksum = digest.digest("hex");
        await rename(temporary, join(mediaDir, checksum));
        store.db
          .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?)")
          .run(checksum, mime, bytes);
        return reply.code(201).send({
          hash: checksum,
          mime,
          bytes,
          url: `/phone-wall/media/${checksum}`,
        });
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
  );
  app.get("/phone-wall/media/:hash", async (req, reply) => {
    const asset = store.asset(req.params.hash);
    const token = bearer(req),
      device = store.devices().find((d) => equal(d.tokenHash, hash(token)));
    if (!operator(req) && (!device || !store.snapshot(device._id)))
      return reply.code(401).send({ error: "unauthorized" });
    if (!asset) return reply.code(404).send({ error: "not-found" });
    return reply.type(asset.mime).sendFile(asset.hash, mediaDir);
  });
  app.get("/art/pixi.js", async (req, reply) =>
    reply
      .type("text/javascript")
      .send(
        createReadStream(join(root, "node_modules/pixi.js/dist/pixi.min.js")),
      ),
  );
  app.get("/art/:hash.js", async (req, reply) => {
    const asset = store.asset(req.params.hash);
    if (asset?.mime !== "text/javascript") return reply.code(404).send();
    return reply
      .type("text/javascript")
      .send(createReadStream(join(mediaDir, asset.hash)));
  });
  app.get("/experiment/:hash", async (req, reply) => {
    const asset = store.asset(req.params.hash);
    if (asset?.mime !== "text/javascript") return reply.code(404).send();
    return reply
      .type("text/html")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:; worker-src 'none'; frame-ancestors 'self'",
      )
      .send(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:black;overflow:hidden}</style></head><body><script src="/console/web-runtime.js"></script><script src="/art/pixi.js"></script><script src="/art/${asset.hash}.js"></script></body></html>`,
      );
  });
  app.get("/artwork-preview/:releaseId/:name", async (req, reply) => {
    const release = releases.release(req.params.releaseId),
      element = release.definition.elements.find((e) => e.type === "web");
    if (!element) return reply.code(404).send();
    if (req.params.name === "index.html")
      return reply
        .type("text/html")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data: blob:; media-src 'self'; frame-ancestors 'self'",
        )
        .send(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:black;overflow:hidden}</style></head><body><script src="/console/web-runtime.js"></script><script src="/art/${release.pixiHash}.js"></script><script src="/art/${element.asset}.js"></script></body></html>`,
        );
    const resource = release.definition.resources?.find(
      (r) => r.name === req.params.name,
    );
    if (!resource) return reply.code(404).send();
    const asset = store.asset(resource.hash);
    return reply
      .type(asset.mime)
      .send(createReadStream(join(mediaDir, asset.hash)));
  });
  app.server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] !== "/phone-wall/ws" || req.headers.origin) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws,req));
  });
  wss.on("connection", (ws,req) => {
    if (wss.clients.size > 100) {
      ws.close(1013);
      return;
    }
    let device = null,
      alive = Date.now(),
      count = 0,
      windowAt = Date.now();
    const created = Date.now();
    const timer = setInterval(() => {
      if (
        (!device && Date.now() - created > 10000) ||
        Date.now() - alive > 45000
      )
        ws.terminate();
      else ws.ping();
    }, 15000);
    ws.on("pong", () => {
      alive = Date.now();
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(timer);
      if (device && sessions.get(device._id) === ws)
        sessions.delete(device._id);
    });
    ws.on("message", (raw) => {
      try {
        if (Date.now() - windowAt > 60000) {
          windowAt = Date.now();
          count = 0;
        }
        if (++count > 120) throw new Error("rate-limit");
        const m = decode(raw.toString()),
          p = m.payload;
        if (!device) {
          if (
            m.type !== "client.hello" ||
            !validId(p.deviceId) ||
            !validId(p.bootSessionId) ||
            typeof p.token !== "string" ||
            p.token.length < 32 ||
            p.token.length > 128
          )
            throw new Error("invalid-hello");
          device = store.register(p);
          sessions.get(device._id)?.close();
          sessions.set(device._id, ws);
          liveAttempts.delete(device._id);
          send(ws, "server.welcome", {
            paired: !!store.snapshot(device._id),
            pairingCode: device.pairingCode,
            heartbeatSeconds: 12,
          });
          snapshot(device._id);
          pairingState(device._id);
          send(ws,'ticker.snapshot',ticker.snapshot(device._id));
        } else if (m.type === "time.request")
          send(ws, "time.response", { sent: p.sent }, 0, m.messageId);
        else if (m.type === "state.request") {snapshot(device._id);pairingState(device._id);send(ws,'ticker.snapshot',ticker.snapshot(device._id));}
        else if(m.type==='kissing.status'){
          if(device.capabilities?.kissingWall!==1||!store.snapshot(device._id))throw new Error('unauthorized-kissing-status');
          if(!['stopped','loading','playing','ended','waiting-for-clips','prefetch-error','error'].includes(p.status))throw new Error('invalid-kissing-status');
          const status={status:p.status,at:Date.now(),hash:/^[a-f0-9]{64}$/.test(p.hash??'')?p.hash:null,code:typeof p.code==='string'?p.code.slice(0,100):null,audio:p.audio===true};
          store.updateDevice(device._id,{kissingStatus:status,...(p.status==='error'?{lastError:status.code}:{})});
        }
        else if(['ticker.ready','ticker.done'].includes(m.type)){
          if(device.capabilities?.liveTicker!==1||!store.snapshot(device._id))throw new Error('unauthorized-ticker');
          if(ticker.acknowledge(device._id,{...p,type:m.type}))tickerBroadcast();
        }
        else if(m.type==='pairing.tap') {
          try {pairing.tap(device._id,p.sessionId);broadcast();broadcastPairing();}
          catch(error){send(ws,'pairing.state',{...pairing.status(device._id),error:error.message});}
        }
        else if (m.type === "client.heartbeat") {
          alive = Date.now();
          const telemetry = {
            battery:
              Number.isFinite(p.battery) && p.battery >= -1 && p.battery <= 1
                ? p.battery
                : -1,
            charging: p.charging === true,
            foreground: p.foreground === true,
            thermalState: [0, 1, 2, 3].includes(p.thermalState)
              ? p.thermalState
              : 0,
            currentSceneId: String(p.currentSceneId ?? "").slice(0, 100),
            lastRevision: Number(p.lastRevision) || 0,
            uptime: Number(p.uptime) || 0,
            freeDisk: Number(p.freeDisk) || 0,
            mediaState: String(p.mediaState ?? "").slice(0, 40),
            displayLinkFps:Number.isFinite(p.displayLinkFps)&&p.displayLinkFps>=0&&p.displayLinkFps<=120?p.displayLinkFps:-1,
            targetFps:Number.isFinite(p.targetFps)&&p.targetFps>=1&&p.targetFps<=120?p.targetFps:null,
          };
          store.updateDevice(device._id, {
            telemetry,
            lastSeenAt: new Date().toISOString(),
          });
        } else if (m.type === "artwork.status") {
          releases.acknowledge(device._id, p);
          if (p.status === "error") broadcast();
        } else if (["client.ack", "client.error"].includes(m.type)) {
          const entry = {
            result: String(p.code ?? p.result ?? "").slice(0, 200),
            commandId: String(p.commandId ?? "").slice(0, 128),
            at: new Date().toISOString(),
          };
          store.event(device._id, entry);
          store.updateDevice(
            device._id,
            m.type === "client.error"
              ? { lastError: entry.result }
              : { lastAck: entry },
          );
        } else throw new Error("unsupported-message");
      } catch (error) {
        send(ws, "server.error", { code: error.message });
        ws.close(1008, "protocol-error");
      }
    });
  });
  const releaseTimer = setInterval(() => {
    try {
      for (const id of releases.tick(sessions)) snapshot(id);
      tickerTick();
    } catch {
      app.log.error("artwork-deployment-tick-failed");
    }
  }, 100);
  const tick = setInterval(() => {
    try {
      if(pairing.expire())broadcastPairing();
      const expired = store.db
        .prepare("SELECT device_id FROM previews WHERE expires<=?")
        .all(Date.now());
      store.prune();
      expired.forEach((row) => snapshot(row.device_id));
      const state = store.current();
      kissing.tick();
      if (state.schedule) {
        const mode = scheduledMode(state.schedule);
        if (state.mode !== mode) {
          store.commit({ ...state, mode }, state.revision);
          broadcast();
        }
      }
    } catch {
      app.log.error("schedule-or-preview-tick-failed");
    }
  }, 1000);
  app.addHook("preClose", async () => {
    clearInterval(tick);
    clearInterval(releaseTimer);
    await kissing.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  app.addHook("onClose", async () => {
    store.close();
  });
  return { app, store, sessions, releases, ticker, kissing };
}
