import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Store, hash } from "../store.mjs";
import { defaultState } from "../../../protocol/core.mjs";

test("private legacy import preserves identity, slot and revision without changing export", async () => {
  const root = await mkdtemp(join(tmpdir(), "phone-wall-import-"));
  try {
    const identity = {
      deviceId: "legacy-device-0001",
      token: "legacy-device-secret-000000000000000000",
    };
    const state = defaultState();
    state.revision = 42;
    const bundle = {
      state,
      devices: [
        {
          _id: identity.deviceId,
          tokenHash: hash(identity.token),
          pairingCode: "AABBCCDD",
          paired: true,
          slotIndex: 7,
          geometry: { x: 750, y: 667, width: 375, height: 667 },
        },
      ],
    };
    const file = join(root, "private.json"),
      source = JSON.stringify(bundle);
    await writeFile(file, source, { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [new URL("../import-legacy.mjs", import.meta.url).pathname, file],
      {
        env: { ...process.env, PHONE_WALL_DATA_DIR: join(root, "new") },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const store = new Store(join(root, "new", "controller.sqlite"));
    try {
      assert.equal(store.current().revision, 43);
      assert.equal(store.snapshot(identity.deviceId).device.slotIndex, 7);
      assert.equal(
        store.register({ ...identity, bootSessionId: "import-test-boot" })._id,
        identity.deviceId,
      );
    } finally {
      store.close();
    }
    assert.equal(await readFile(file, "utf8"), source);
    const again = spawnSync(
      process.execPath,
      [new URL("../import-legacy.mjs", import.meta.url).pathname, file],
      {
        env: { ...process.env, PHONE_WALL_DATA_DIR: join(root, "new") },
        encoding: "utf8",
      },
    );
    assert.notEqual(again.status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
