import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";
import { SimulatedClient } from "../simulated-client.mjs";

const key = "process-restart-test-00000000000000000000000";
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("timeout");
}
test("actual Node process restart restores SQLite state and reconnects 30 clients", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "phone-wall-process-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((r) => reservation.close(r));
  let child;
  const clients = [];
  const start = () => {
    child = spawn(
      process.execPath,
      [new URL("../index.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          PHONE_WALL_MDNS: "false",
          PHONE_WALL_DATA_DIR: directory,
          PHONE_WALL_ADMIN_TOKEN: key,
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        },
        stdio: "ignore",
      },
    );
  };
  const stop = async (signal = "SIGTERM") => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill(signal);
      await exited;
    }
  };
  t.after(async () => {
    clients.forEach((c) => c.stop());
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  start();
  const base = `http://127.0.0.1:${port}`;
  await until(async () => {
    try {
      return (await fetch(base + "/health")).ok;
    } catch {
      return false;
    }
  });
  for (let n = 0; n < 30; n++) {
    const c = new SimulatedClient(
      base.replace("http", "ws") + "/phone-wall/ws",
    );
    clients.push(c);
    c.connect();
  }
  await until(() => clients.every((c) => c.welcome));
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  const data = await (
    await fetch(base + "/phone-wall/api", { headers })
  ).json();
  const config = data.state;
  config.mode = "exhibition";
  config.scene = {
    id: "process-timeline",
    kind: "ticker",
    text: "Same timeline after restart",
    speed: 150,
    startAtServerMs: Date.now() - 12000,
  };
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
  const response = await fetch(base + "/phone-wall/api", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "configure",
      config,
      expectedRevision: config.revision,
    }),
  });
  assert.equal(response.status, 200);
  await until(() =>
    clients.every((c) => c.state?.scene.id === "process-timeline"),
  );
  const revision = clients[0].state.revision,
    startAt = clients[0].state.scene.startAtServerMs,
    connections = clients.map((c) => c.connections);
  await stop("SIGKILL");
  start();
  await until(() =>
    clients.every(
      (c, i) =>
        c.connections > connections[i] && c.state?.revision === revision,
    ),
  );
  assert.ok(clients.every((c) => c.state.scene.startAtServerMs === startAt));
  assert.equal(
    (
      await (await fetch(base + "/phone-wall/api", { headers })).json()
    ).devices.filter((d) => d.connected).length,
    30,
  );
});
