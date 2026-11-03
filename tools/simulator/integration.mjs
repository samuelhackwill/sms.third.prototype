import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import WebSocket from "ws";
import { envelope } from "../../protocol/core.mjs";
const base = process.env.PHONE_WALL_HTTP ?? "http://127.0.0.1:3000";
const key = process.env.PHONE_WALL_ADMIN_TOKEN;
assert.ok(key, "Set PHONE_WALL_ADMIN_TOKEN");
async function admin(payload) {
  const r = await fetch(base + "/phone-wall/api", {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data;
}
assert.equal((await fetch(base + "/phone-wall/api")).status, 401);
const ws = new WebSocket(base.replace(/^http/, "ws") + "/phone-wall/ws");
const received = [];
let failure;
const identity = {
  deviceId: randomUUID(),
  token: randomBytes(32).toString("hex"),
};
ws.on("message", (raw) => received.push(JSON.parse(raw)));
ws.on("error", (e) => {
  failure = e;
});
async function wait(type, predicate = () => true) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const m = received.find((m) => m.type === type && predicate(m));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout: " + type);
}
try {
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(
    JSON.stringify(
      envelope("client.hello", {
        ...identity,
        bootSessionId: randomUUID(),
        capabilities: {},
        appVersion: "integration",
      }),
    ),
  );
  const welcome = await wait("server.welcome");
  assert.equal(welcome.payload.paired, false);
  const data = await admin();
  const used = new Set(
    data.devices.filter((d) => d.paired).map((d) => d.slotIndex),
  );
  const slot = Array.from({ length: 30 }, (_, i) => i).find(
    (i) => !used.has(i),
  );
  assert.notEqual(slot, undefined, "Need a free test slot");
  await admin({
    action: "pair",
    code: welcome.payload.pairingCode,
    slotIndex: slot,
    geometry: { x: slot * 375, y: 0, width: 375, height: 667 },
  });
  await wait("state.snapshot");
  await admin({ action: "mode", mode: "night" });
  const night = await wait("state.snapshot", (m) => m.payload.mode === "night");
  ws.send(
    JSON.stringify(
      envelope("client.heartbeat", { battery: 0.8, charging: true }),
    ),
  );
  ws.send(JSON.stringify(envelope("time.request", { sent: Date.now() })));
  await wait("time.response");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
    "base64",
  );
  const uploaded = await fetch(base + "/phone-wall/media", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "image/png" },
    body: png,
  });
  assert.equal(uploaded.status, 201);
  const asset = await uploaded.json();
  assert.equal(asset.hash, createHash("sha256").update(png).digest("hex"));
  const downloaded = await fetch(base + asset.url, {
    headers: { Authorization: `Bearer ${identity.token}` },
  });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await fetch(base + asset.url)).status, 401);
  await admin({
    action: "command",
    deviceId: identity.deviceId,
    name: "query-diagnostics",
    commandId: "integration-command-1",
  });
  await wait("command", (m) => m.payload.commandId === "integration-command-1");
  await admin({ action: "mode", mode: data.state.mode });
  assert.ok(night.revision >= 1);
  async function reconnect(token, expectedType) {
    const next = new WebSocket(base.replace(/^http/, "ws") + "/phone-wall/ws");
    try {
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          next.terminate();
          reject(new Error("reconnect timeout"));
        }, 10000);
        next.on("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        next.on("open", () =>
          next.send(
            JSON.stringify(
              envelope("client.hello", {
                ...identity,
                token,
                bootSessionId: randomUUID(),
                capabilities: {},
                appVersion: "integration",
              }),
            ),
          ),
        );
        next.on("message", (raw) => {
          const m = JSON.parse(raw);
          if (m.type === expectedType) {
            clearTimeout(timeout);
            resolve(m);
          }
        });
      });
    } finally {
      next.close();
    }
  }
  const recovered = await reconnect(identity.token, "state.snapshot");
  assert.equal(recovered.payload.device.slotIndex, slot);
  const denied = await reconnect(
    "wrong-secret-000000000000000000000000000",
    "server.error",
  );
  assert.equal(denied.payload.code, "unauthorized-device");
  console.log(
    "PASS: unauthorized access rejected; registration, pairing, snapshots, night mode, concurrent heartbeat/time, hashed media upload/authenticated download, targeted command delivery",
  );
  console.log(
    "PASS: reconnect restores slot/full state; wrong device secret rejected",
  );
} finally {
  ws.close();
}
