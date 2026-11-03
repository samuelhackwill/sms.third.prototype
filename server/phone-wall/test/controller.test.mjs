import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createController } from "../app.mjs";
import { SimulatedClient } from "../simulated-client.mjs";
import { timelinePosition } from "../config.mjs";

const key = "automated-test-operator-key-000000000000000000";
async function until(fn) {
  const limit = Date.now() + 12000;
  while (Date.now() < limit) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition timed out");
}
test("30 phones: atomic artwork, groups, rollback, media, reconnect and persisted timeline without WAN", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "phone-wall-suite-"));
  let server = await createController({ dataDir: dir, adminToken: key });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const port = server.app.server.address().port;
  const endpoint = `ws://127.0.0.1:${port}/phone-wall/ws`;
  const clients = Array.from(
    { length: 30 },
    () => new SimulatedClient(endpoint),
  );
  t.after(async () => {
    clients.forEach((c) => c.stop());
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const request = async (input) => {
    const r = await server.app.inject({
      method: input ? "POST" : "GET",
      url: "/phone-wall/api",
      headers: { authorization: `Bearer ${key}` },
      ...(input ? { payload: input } : {}),
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  assert.equal((await server.app.inject("/phone-wall/api")).statusCode, 401);
  clients.forEach((c) => c.connect());
  await until(() => clients.every((c) => c.welcome));
  assert.equal(server.sessions.size, 30);
  let state = (await request()).state;
  state.layout.slots = clients.map((c, index) => ({
    deviceId: c.identity.deviceId,
    slotIndex: index,
    geometry: {
      x: (index % 5) * 375,
      y: Math.floor(index / 5) * 667,
      width: 375,
      height: 667,
    },
  }));
  state.groups = { top: clients.slice(0, 5).map((c) => c.identity.deviceId) };
  state.mode = "exhibition";
  state.scene = {
    id: "live-art",
    kind: "ticker",
    text: "Live, without an IPA",
    speed: 140,
    fontSize: 48,
    color: "#ffffff",
    startAtServerMs: Date.now() - 5000,
  };
  const saved = await request({
    action: "configure",
    config: state,
    expectedRevision: state.revision,
    operationId: "configure-once-0001",
  });
  await until(() => clients.every((c) => c.state?.revision === saved.revision));
  assert.equal(clients[29].state.device.slotIndex, 29);
  const stale = await server.app.inject({
    method: "POST",
    url: "/phone-wall/api",
    headers: { authorization: `Bearer ${key}` },
    payload: {
      action: "configure",
      config: state,
      expectedRevision: state.revision,
    },
  });
  assert.equal(stale.statusCode, 400);
  assert.equal(stale.json().error, "revision-conflict");
  await request({
    action: "configure",
    config: state,
    expectedRevision: state.revision,
    operationId: "configure-once-0001",
  });
  assert.equal(server.store.current().revision, saved.revision);
  const invalid = structuredClone(server.store.current());
  invalid.layout.slots[1].slotIndex = 0;
  assert.throws(() => server.store.commit(invalid, saved.revision));
  assert.equal(server.store.current().revision, saved.revision);
  await request({
    action: "preview",
    group: "top",
    scene: { ...state.scene, id: "preview-group", text: "Top five" },
    durationMs: 1000,
  });
  await until(() =>
    clients.slice(0, 5).every((c) => c.state?.scene.id === "preview-group"),
  );
  assert.equal(clients[5].state.scene.id, "live-art");
  await until(() => clients.every((c) => c.state.scene.id === "live-art"));
  await request({
    action: "command",
    deviceIds: [clients[2].identity.deviceId],
    name: "blackout",
  });
  await until(() => clients[2].state.mode === "blackout");
  assert.equal(clients[3].state.mode, "exhibition");
  await request({
    action: "command",
    deviceIds: [clients[2].identity.deviceId],
    name: "resume",
  });
  await until(() => clients[2].state.mode === "exhibition");
  const baseline = server.store.current();
  const blob = Buffer.from([0, 1, 2, 3, 4]);
  const uploaded = await server.app.inject({
    method: "POST",
    url: "/phone-wall/media",
    headers: { authorization: `Bearer ${key}`, "content-type": "image/png" },
    payload: blob,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const media = uploaded.json();
  const download = await server.app.inject({
    url: media.url,
    headers: { authorization: `Bearer ${clients[0].identity.token}` },
  });
  assert.deepEqual(download.rawPayload, blob);
  assert.equal((await server.app.inject(media.url)).statusCode, 401);
  const script = await server.app.inject({
    method: "POST",
    url: "/phone-wall/media",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "text/javascript",
    },
    payload: 'document.body.dataset.test="local";',
  });
  assert.equal(script.statusCode, 201);
  assert.equal(
    (await server.app.inject(`/experiment/${script.json().hash}`)).statusCode,
    200,
  );
  assert.equal((await server.app.inject("/art/pixi.js")).statusCode, 200);
  const started = baseline.scene.startAtServerMs;
  clients[0].ws.terminate();
  await until(() => clients[0].connections >= 2);
  await until(() => clients[0].state.scene.startAtServerMs === started);
  const reconnects = clients.map((c) => c.connections);
  await server.app.close();
  server = await createController({ dataDir: dir, adminToken: key });
  await server.app.listen({ host: "127.0.0.1", port });
  await until(() =>
    clients.every(
      (c, i) =>
        c.connections > reconnects[i] && c.state.revision === baseline.revision,
    ),
  );
  for (const c of clients) {
    assert.equal(c.state.scene.startAtServerMs, started);
    assert.equal(c.state.device.deviceId, c.identity.deviceId);
  }
  const now = Date.now();
  assert.equal(
    timelinePosition(clients[0].state.scene, 1875, 800, now),
    timelinePosition(clients[29].state.scene, 1875, 800, now),
  );
  await request({ action: "scene", kind: "solid", text: "", color: "#dd5533" });
  await until(() => clients.every((c) => c.state.scene.kind === "solid"));
  await request({
    action: "rollback",
    revision: baseline.revision,
    expectedRevision: server.store.current().revision,
  });
  await until(() => clients.every((c) => c.state.scene.id === "live-art"));
  assert.ok(server.store.current().revision > baseline.revision);
});
