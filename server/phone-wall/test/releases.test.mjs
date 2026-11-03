import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createController } from "../app.mjs";
import { SimulatedClient } from "../simulated-client.mjs";
import { validateDefinition, animationValue } from "../scenes.mjs";

export function sample(version = "1") {
  return {
    sceneSchemaVersion: 1,
    artworkId: "museum-scene",
    artworkVersion: version,
    canvas: { width: 1875, height: 4002 },
    background: "#102b28",
    transition: { type: "fade", durationMs: 300 },
    elements: [
      {
        id: "message",
        type: "text",
        frame: { x: 20, y: 20, width: 1000, height: 300 },
        text: "Artwork without a new IPA",
        fontSize: 48,
        color: "#ffffff",
        animation: {
          property: "x",
          from: 20,
          to: 500,
          durationMs: 2000,
          delayMs: 0,
          repeat: true,
          easing: "linear",
        },
      },
    ],
  };
}
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}
test("scene contract rejects incompatible schemas, unsafe paths and invalid animations", () => {
  assert.equal(validateDefinition(sample()).sceneSchemaVersion, 1);
  for (const change of [
    (s) => (s.sceneSchemaVersion = 2),
    (s) => (s.elements[0].animation.durationMs = 0),
    (s) => (s.elements[0].frame.width = -1),
    (s) => s.elements.push({ ...s.elements[0] }),
  ]) {
    const s = sample();
    change(s);
    assert.throws(() => validateDefinition(s));
  }
  assert.equal(animationValue(sample().elements[0].animation, 1000), 260);
});
test("immutable staged release: all-ready barrier, shared activation, failure, rollback and restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "phone-wall-release-")),
    key = "release-test-00000000000000000000000000000";
  let server = await createController({ dataDir: dir, adminToken: key });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const port = server.app.server.address().port;
  const clients = Array.from(
    { length: 30 },
    () => new SimulatedClient(`ws://127.0.0.1:${port}/phone-wall/ws`),
  );
  t.after(async () => {
    clients.forEach((c) => c.stop());
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  });
  clients.forEach((c) => c.connect());
  await until(() => clients.every((c) => c.welcome));
  const api = async (p) => {
    const r = await server.app.inject({
      method: "POST",
      url: "/phone-wall/api",
      headers: { authorization: `Bearer ${key}` },
      payload: p,
    });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const config = server.store.current();
  config.mode = "exhibition";
  config.layout.slots = clients.map((c, i) => ({
    deviceId: c.identity.deviceId,
    slotIndex: i,
    geometry: {
      x: (i % 5) * 375,
      y: Math.floor(i / 5) * 667,
      width: 375,
      height: 667,
    },
  }));
  await api({ action: "configure", config, expectedRevision: config.revision });
  const { release } = await api({
    action: "release.create",
    definition: sample(),
  });
  assert.equal(
    (await api({ action: "release.create", definition: sample() })).release.id,
    release.id,
  );
  const first = clients[0].identity.deviceId;
  let { deployment } = await api({
    action: "release.deploy",
    releaseId: release.id,
    deviceIds: [first],
    delayMs: 1000,
    operationId: "stage-one-retry-0001",
  });
  const retried = await api({
    action: "release.deploy",
    releaseId: release.id,
    deviceIds: [first],
    delayMs: 1000,
    operationId: "stage-one-retry-0001",
  });
  assert.equal(retried.deployment.id, deployment.id);
  await until(() => clients[0].activeArtwork?.deploymentId === deployment.id);
  await until(
    () => server.releases.deployment(deployment.id).phase === "active",
  );
  assert.ok(clients.slice(1).every((c) => !c.activeArtwork));
  const prior = clients[0].activeArtwork;
  clients[29].autoPrepare = false;
  ({ deployment } = await api({
    action: "release.deploy",
    releaseId: release.id,
    delayMs: 1000,
    timeoutMs: 10000,
  }));
  await until(
    () =>
      Object.values(server.releases.deployment(deployment.id).targets).filter(
        (t) => t.status === "ready",
      ).length === 29,
  );
  assert.equal(server.releases.deployment(deployment.id).phase, "preparing");
  assert.equal(clients[0].activeArtwork.deploymentId, prior.deploymentId);
  clients[29].autoPrepare = true;
  clients[29].ws.terminate();
  await until(() => clients[29].connections >= 2);
  await until(() =>
    clients.every((c) => c.activeArtwork?.deploymentId === deployment.id),
  );
  assert.equal(
    new Set(clients.map((c) => c.activeArtwork.startAtServerMs)).size,
    1,
  );
  const previousStarts = clients.map((c) => c.activeArtwork.startAtServerMs);
  const next = (
    await api({ action: "release.create", definition: sample("2") })
  ).release;
  clients[1].autoPrepare = false;
  const failed = (
    await api({
      action: "release.deploy",
      releaseId: next.id,
      deviceIds: [first, clients[1].identity.deviceId],
      timeoutMs: 1000,
      delayMs: 1000,
    })
  ).deployment;
  await until(() => server.releases.deployment(failed.id).phase === "failed");
  assert.equal(clients[0].activeArtwork.releaseId, release.id);
  assert.equal(server.releases.snapshot(first).pending, null);
  const connections = clients.map((c) => c.connections);
  await server.app.close();
  server = await createController({ dataDir: dir, adminToken: key });
  await server.app.listen({ host: "127.0.0.1", port });
  await until(() => clients.every((c, i) => c.connections > connections[i]));
  await until(() =>
    clients.every(
      (c, i) => c.activeArtwork.startAtServerMs === previousStarts[i],
    ),
  );
  clients[1].autoPrepare = true;
  const promoted = (
    await api({
      action: "release.deploy",
      releaseId: next.id,
      deviceIds: [first],
      delayMs: 1000,
    })
  ).deployment;
  await until(() => clients[0].activeArtwork.deploymentId === promoted.id);
  const rollback = (
    await api({
      action: "release.deploy",
      releaseId: release.id,
      deviceIds: [first],
      delayMs: 1000,
    })
  ).deployment;
  await until(() => clients[0].activeArtwork.deploymentId === rollback.id);
  assert.equal(clients[0].activeArtwork.releaseId, release.id);
});
