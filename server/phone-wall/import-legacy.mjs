import { readFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { Store } from "./store.mjs";
import { initialConfig, validateConfig } from "./config.mjs";

// Input is a private export bundle, never a live MongoDB connection.
const source = process.argv[2],
  directory = process.env.PHONE_WALL_DATA_DIR;
if (!source || !directory)
  throw new Error(
    "Usage: PHONE_WALL_DATA_DIR=/new/data node import-legacy.mjs /private/export.json",
  );
const input = JSON.parse(readFileSync(source, "utf8"));
const store = new Store(join(resolve(directory), "controller.sqlite"));
try {
  if (store.devices().length || store.history().length !== 1)
    throw new Error("destination must be unused");
  const config = {
    ...initialConfig(),
    ...input.state,
    installationId: store.current().installationId,
    groups: input.state.groups ?? {},
    overrides: {},
    schedule: input.schedule ?? null,
  };
  delete config._id;
  config.layout = {
    ...config.layout,
    slots: input.devices
      .filter((d) => d.paired)
      .map((d) => ({
        deviceId: d._id,
        slotIndex: d.slotIndex,
        geometry: d.geometry,
      })),
  };
  validateConfig(config);
  const assets = input.assets ?? [];
  const mediaDir = join(resolve(directory), "media");
  mkdirSync(mediaDir, { recursive: true });
  for (const asset of assets) {
    if (!/^[a-f0-9]{64}$/.test(asset._id) || !process.env.LEGACY_MEDIA_DIR)
      throw new Error("invalid asset or missing LEGACY_MEDIA_DIR");
    const file = join(process.env.LEGACY_MEDIA_DIR, asset._id);
    if (
      !existsSync(file) ||
      createHash("sha256").update(readFileSync(file)).digest("hex") !==
        asset._id
    )
      throw new Error("asset checksum failed");
    copyFileSync(file, join(mediaDir, asset._id));
  }
  store.transaction(() => {
    for (const d of input.devices) {
      if (!/^[a-f0-9]{64}$/.test(d.tokenHash))
        throw new Error("missing device credential hash");
      const { tokenHash, ...safe } = d;
      store.db
        .prepare("INSERT INTO devices VALUES(?,?,?,?)")
        .run(d._id, tokenHash, d.pairingCode, JSON.stringify(safe));
    }
    for (const a of assets)
      store.db
        .prepare("INSERT INTO assets VALUES(?,?,?)")
        .run(a._id, a.mime, a.bytes);
    const revision = Math.max(2, Number(input.state.revision) || 0) + 1;
    config.revision = revision;
    store.db
      .prepare("INSERT INTO configurations VALUES(?,?,?)")
      .run(revision, JSON.stringify(config), Date.now());
    store.db
      .prepare("UPDATE current_state SET revision=? WHERE id=1")
      .run(revision);
  });
  console.log(
    `Imported ${input.devices.length} devices and ${assets.length} media records. Source data unchanged.`,
  );
} finally {
  store.close();
}
