import { randomUUID } from "node:crypto";
import { releaseHash, validateDefinition } from "./scenes.mjs";
import { validateConfig } from "./config.mjs";

export class Releases {
  constructor(store, pixiHash) {
    this.store = store;
    this.db = store.db;
    this.pixiHash = pixiHash;
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS artwork_releases(id TEXT PRIMARY KEY,data TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artwork_deployments(id TEXT PRIMARY KEY,data TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artwork_assignments(device_id TEXT PRIMARY KEY,active TEXT,pending TEXT);
      CREATE INDEX IF NOT EXISTS artwork_deployment_phase ON artwork_deployments(json_extract(data,'$.phase'));
      CREATE UNIQUE INDEX IF NOT EXISTS artwork_version ON artwork_releases(json_extract(data,'$.definition.artworkId'),json_extract(data,'$.definition.artworkVersion'));`);
  }
  release(id) {
    const row = this.db
      .prepare("SELECT data FROM artwork_releases WHERE id=?")
      .get(id);
    if (!row) throw new Error("unknown-artwork-release");
    return JSON.parse(row.data);
  }
  deployment(id) {
    const row = this.db
      .prepare("SELECT data FROM artwork_deployments WHERE id=?")
      .get(id);
    if (!row) throw new Error("unknown-deployment");
    return JSON.parse(row.data);
  }
  save(d) {
    this.db
      .prepare("UPDATE artwork_deployments SET data=? WHERE id=?")
      .run(JSON.stringify(d), d.id);
  }
  list() {
    return {
      releases: this.db
        .prepare(
          "SELECT id,data,created FROM artwork_releases ORDER BY created DESC LIMIT 100",
        )
        .all()
        .map((r) => ({
          id: r.id,
          created: r.created,
          definition: JSON.parse(r.data).definition,
        })),
      deployments: this.db
        .prepare(
          "SELECT data FROM artwork_deployments ORDER BY created DESC LIMIT 50",
        )
        .all()
        .map((r) => JSON.parse(r.data)),
    };
  }
  create(definition, layout) {
    definition = validateDefinition(structuredClone(definition));
    layout = structuredClone(layout ?? this.store.current().layout);
    validateConfig({ ...this.store.current(), layout });
    for (const slot of layout.slots)
      if (!this.store.device(slot.deviceId))
        throw new Error("unknown-layout-device");
    const kinds = new Map([
      ["image", "image/"],
      ["video", "video/"],
      ["web", "text/javascript"],
    ]);
    const hashes = new Set(
      definition.elements.filter((e) => e.asset).map((e) => e.asset),
    );
    for (const e of definition.elements)
      if (e.asset) {
        const a = this.store.asset(e.asset);
        if (!a || !a.mime.startsWith(kinds.get(e.type)))
          throw new Error("artwork-asset-type-mismatch");
      }
    for (const r of definition.resources ?? []) hashes.add(r.hash);
    const web = definition.elements.some((e) => e.type === "web");
    if (web) hashes.add(this.pixiHash);
    const assets = [...hashes].sort().map((hash) => {
      const a = this.store.asset(hash);
      if (!a) throw new Error("unknown-artwork-asset");
      return { hash, mime: a.mime, bytes: a.bytes };
    });
    if (assets.reduce((sum, a) => sum + a.bytes, 0) > 200 * 1024 * 1024)
      throw new Error("release-asset-budget-exceeded");
    const content = {
      definition,
      layout,
      assets,
      runtime: { minimumVersion: "2.0", sceneSchemaVersion: 1 },
      ...(web ? { pixiHash: this.pixiHash } : {}),
    };
    const id = releaseHash(content),
      release = { id, ...content };
    const existing = this.db
      .prepare(
        "SELECT id FROM artwork_releases WHERE json_extract(data,'$.definition.artworkId')=? AND json_extract(data,'$.definition.artworkVersion')=?",
      )
      .get(definition.artworkId, definition.artworkVersion);
    if (existing && existing.id !== id)
      throw new Error("artwork-version-already-immutable");
    this.db
      .prepare("INSERT OR IGNORE INTO artwork_releases VALUES(?,?,?)")
      .run(id, JSON.stringify(release), Date.now());
    return release;
  }
  deploy(
    releaseId,
    ids,
    { delayMs = 3000, timeoutMs = 60000, operationId } = {},
  ) {
    this.tick(new Set(), Date.now());
    const release = this.release(releaseId);
    if (
      !ids.length ||
      !Number.isInteger(delayMs) ||
      delayMs < 1000 ||
      delayMs > 30000 ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 120000
    )
      throw new Error("invalid-deployment");
    for (const id of ids) {
      const d = this.store.device(id);
      if(release.definition.artworkId==='live-ticker'&&d?.capabilities?.liveTicker!==1)throw new Error('phone-app-2.3-required-for-live-messages');
      if (
        !release.layout.slots.some((s) => s.deviceId === id) ||
        !Array.isArray(d?.capabilities?.sceneSchemaVersions) ||
        !d.capabilities.sceneSchemaVersions.includes(1) ||
        !/^\d+\.\d+(?:\.\d+)?$/.test(d.runtimeVersion) ||
        Number(d.runtimeVersion.split(".")[0]) < 2
      )
        throw new Error("runtime-upgrade-or-slot-required");
    }
    return this.store.transaction(() => {
      if (operationId) {
        const saved = this.db
          .prepare("SELECT result FROM receipts WHERE id=?")
          .get("deployment:" + operationId);
        if (saved) {
          const old = JSON.parse(saved.result);
          if (
            old.releaseId !== releaseId ||
            JSON.stringify(Object.keys(old.targets).sort()) !==
              JSON.stringify([...ids].sort())
          )
            throw new Error("deployment-operation-conflict");
          return this.deployment(old.id);
        }
      }
      for (const id of ids)
        if (
          this.db
            .prepare(
              "SELECT pending FROM artwork_assignments WHERE device_id=?",
            )
            .get(id)?.pending
        )
          throw new Error("device-has-pending-deployment");
      const d = {
        id: randomUUID(),
        releaseId,
        phase: "preparing",
        createdAt: Date.now(),
        deadlineMs: Date.now() + timeoutMs,
        delayMs,
        startAtServerMs: null,
        targets: Object.fromEntries(
          ids.map((id) => [id, { status: "pending" }]),
        ),
      };
      this.db
        .prepare("INSERT INTO artwork_deployments VALUES(?,?,?)")
        .run(d.id, JSON.stringify(d), d.createdAt);
      for (const id of ids)
        this.db
          .prepare(
            "INSERT INTO artwork_assignments(device_id,pending) VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET pending=excluded.pending",
          )
          .run(id, d.id);
      if (operationId)
        this.db
          .prepare("INSERT INTO receipts VALUES(?,?)")
          .run("deployment:" + operationId, JSON.stringify(d));
      return d;
    });
  }
  describe(id) {
    if (!id) return null;
    const d = this.deployment(id);
    return {
      deploymentId: d.id,
      releaseId: d.releaseId,
      phase: d.phase,
      startAtServerMs: d.startAtServerMs,
      deadlineMs: d.deadlineMs,
      release: this.release(d.releaseId),
    };
  }
  snapshot(id) {
    const a = this.db
      .prepare(
        "SELECT active,pending FROM artwork_assignments WHERE device_id=?",
      )
      .get(id);
    return {
      active: this.describe(a?.active),
      pending: this.describe(a?.pending),
    };
  }
  acknowledge(deviceId, p) {
    if (!["ready", "displayed", "error"].includes(p.status))
      throw new Error("invalid-artwork-status");
    const d = this.deployment(p.deploymentId);
    const assignment = this.db
      .prepare(
        "SELECT active,pending FROM artwork_assignments WHERE device_id=?",
      )
      .get(deviceId);
    if (assignment?.active !== d.id && assignment?.pending !== d.id) return;
    if (!d.targets[deviceId] || p.releaseId !== d.releaseId)
      throw new Error("artwork-ack-mismatch");
    if (["failed", "cancelled"].includes(d.phase)) return;
    if (
      p.status === "displayed" &&
      (!d.startAtServerMs || Date.now() < d.startAtServerMs - 100)
    )
      throw new Error("early-artwork-display");
    const previous = d.targets[deviceId];
    if (previous.status === "displayed" && p.status === "ready") return;
    d.targets[deviceId] = {
      status: p.status,
      at: Date.now(),
      code: String(p.code ?? "").slice(0, 200),
    };
    this.save(d);
    this.store.updateDevice(deviceId, {
      artworkStatus: {
        deploymentId: d.id,
        releaseId: d.releaseId,
        ...d.targets[deviceId],
      },
    });
    if (p.status === "error" && d.phase === "preparing")
      this.fail(d, "target-preparation-failed");
  }
  fail(d, reason, phase = "failed") {
    this.store.transaction(() => {
      d.phase = phase;
      d.reason = reason;
      this.save(d);
      this.db
        .prepare("UPDATE artwork_assignments SET pending=NULL WHERE pending=?")
        .run(d.id);
    });
  }
  cancel(id) {
    const d = this.deployment(id);
    if (d.phase !== "preparing")
      throw new Error("deployment-already-committed");
    this.fail(d, "operator-cancelled", "cancelled");
  }
  tick(online, now = Date.now()) {
    const changed = new Set();
    const rows = this.db
      .prepare(
        "SELECT data FROM artwork_deployments WHERE json_extract(data,'$.phase') IN ('preparing','scheduled')",
      )
      .all();
    for (const row of rows) {
      const d = JSON.parse(row.data),
        ids = Object.keys(d.targets);
      if (d.phase === "preparing") {
        if (now >= d.deadlineMs) {
          this.fail(d, "preparation-timeout");
          ids.forEach((id) => changed.add(id));
        } else if (
          ids.every((id) => d.targets[id].status === "ready" && online.has(id))
        ) {
          d.phase = "scheduled";
          d.startAtServerMs = now + d.delayMs;
          this.save(d);
          ids.forEach((id) => changed.add(id));
        }
      } else if (d.phase === "scheduled" && now >= d.startAtServerMs) {
        this.store.transaction(() => {
          d.phase = "active";
          this.save(d);
          this.db
            .prepare(
              "UPDATE artwork_assignments SET active=pending,pending=NULL WHERE pending=?",
            )
            .run(d.id);
        });
        ids.forEach((id) => changed.add(id));
      }
    }
    return changed;
  }
}
