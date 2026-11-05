import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { initialConfig, validateConfig } from "./config.mjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function equal(a, b) {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
  );
}
export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS configurations(revision INTEGER PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS current_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS previews(device_id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, device_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);`);
    this.db.exec("CREATE INDEX IF NOT EXISTS events_at ON events(at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS events_error_recent ON events(id DESC) WHERE json_extract(data,'$.kind')='error'");
    if (!this.db.prepare("SELECT revision FROM current_state WHERE id=1").get())
      this.commit(initialConfig(), 0);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  current() {
    return JSON.parse(
      this.db
        .prepare(
          "SELECT data FROM configurations WHERE revision=(SELECT revision FROM current_state WHERE id=1)",
        )
        .get().data,
    );
  }
  commit(config, expectedRevision, operationId) {
    return this.transaction(() => {
      if (operationId) {
        const saved = this.db
          .prepare("SELECT result FROM receipts WHERE id=?")
          .get(operationId);
        if (saved) return JSON.parse(saved.result);
      }
      const previous =
        this.db.prepare("SELECT revision FROM current_state WHERE id=1").get()
          ?.revision ?? 0;
      if (expectedRevision !== previous) throw new Error("revision-conflict");
      const value = validateConfig(structuredClone(config));
      value.revision = previous + 1;
      if (previous) {
        const current = this.current();
        value.layoutRevision =
          current.layoutRevision +
          (JSON.stringify(value.layout) !== JSON.stringify(current.layout)
            ? 1
            : 0);
      }
      this.db
        .prepare("INSERT INTO configurations VALUES(?,?,?)")
        .run(value.revision, JSON.stringify(value), Date.now());
      this.db
        .prepare(
          "INSERT INTO current_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
        )
        .run(value.revision);
      if (operationId)
        this.db
          .prepare("INSERT INTO receipts VALUES(?,?)")
          .run(operationId, JSON.stringify(value));
      return value;
    });
  }
  history() {
    return this.db
      .prepare(
        "SELECT revision, created FROM configurations ORDER BY revision DESC LIMIT 100",
      )
      .all();
  }
  revision(n) {
    const row = this.db
      .prepare("SELECT data FROM configurations WHERE revision=?")
      .get(n);
    if (!row) throw new Error("unknown-revision");
    return JSON.parse(row.data);
  }
  device(id) {
    const d = this.db.prepare("SELECT * FROM devices WHERE id=?").get(id);
    return d
      ? {
          ...JSON.parse(d.data),
          _id: d.id,
          pairingCode: d.code,
          tokenHash: d.token_hash,
        }
      : null;
  }
  devices() {
    return this.db
      .prepare("SELECT id FROM devices")
      .all()
      .map((row) => this.device(row.id));
  }
  updateDevice(id, patch) {
    const d = this.device(id);
    if (!d) throw new Error("unknown-device");
    delete d.tokenHash;
    this.db
      .prepare("UPDATE devices SET data=? WHERE id=?")
      .run(JSON.stringify({ ...d, ...patch }), id);
  }
  register(p) {
    let d = this.device(p.deviceId);
    if (d && !equal(d.tokenHash, hash(p.token)))
      throw new Error("unauthorized-device");
    if (!d) {
      if (this.devices().length >= 200) throw new Error("device-capacity");
      this.db
        .prepare("INSERT INTO devices VALUES(?,?,?,?)")
        .run(
          p.deviceId,
          hash(p.token),
          randomBytes(4).toString("hex").toUpperCase(),
          JSON.stringify({ createdAt: new Date().toISOString() }),
        );
    }
    this.updateDevice(p.deviceId, {
      capabilities: p.capabilities ?? {},
      appVersion: String(p.appVersion ?? "").slice(0, 40),
      runtimeVersion: String(p.runtimeVersion ?? "1.0").slice(0, 40),
      lastSeenAt: new Date().toISOString(),
      bootSessionId: p.bootSessionId,
    });
    return this.device(p.deviceId);
  }
  preview(ids, patch, durationMs) {
    this.transaction(() => {
      const stmt = this.db.prepare(
        "INSERT INTO previews VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET data=excluded.data,expires=excluded.expires",
      );
      for (const id of ids)
        stmt.run(id, JSON.stringify(patch), Date.now() + durationMs);
    });
  }
  snapshot(id) {
    const state = this.current(),
      slot = state.layout.slots.find((s) => s.deviceId === id);
    if (!slot) return null;
    const preview = this.db
      .prepare("SELECT * FROM previews WHERE device_id=? AND expires>?")
      .get(id, Date.now());
    return {
      ...state,
      ...(state.overrides?.[id] ?? {}),
      ...(preview ? JSON.parse(preview.data) : {}),
      previewUntil: preview?.expires ?? null,
      logicalWidth: Math.max(
        1,
        ...state.layout.slots.map((s) => s.geometry.x + s.geometry.width),
      ),
      device: { deviceId: id, ...slot },
    };
  }
  asset(id) {
    return this.db.prepare("SELECT * FROM assets WHERE hash=?").get(id);
  }
  event(id, data) {
    this.db
      .prepare("INSERT INTO events(device_id,at,data) VALUES(?,?,?)")
      .run(id, Date.now(), JSON.stringify(data));
  }
  errors(limit=100) {
    return this.db.prepare("SELECT device_id AS deviceId,at,data FROM events WHERE json_extract(data,'$.kind')='error' ORDER BY id DESC LIMIT ?").all(limit).map(row=>({record:JSON.parse(row.data),deviceId:row.deviceId,at:row.at}));
  }
  prune() {
    this.db
      .prepare("DELETE FROM events WHERE at<?")
      .run(Date.now() - 7 * 86400000);
    this.db.prepare("DELETE FROM previews WHERE expires<?").run(Date.now());
  }
  close() {
    this.db.close();
  }
}
