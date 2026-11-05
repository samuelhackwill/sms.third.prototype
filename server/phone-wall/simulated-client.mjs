import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { randomUUID, randomBytes } from "node:crypto";
import { envelope, backoff, clockOffset } from "../../protocol/core.mjs";

export class SimulatedClient extends EventEmitter {
  constructor(
    endpoint,
    identity = {
      deviceId: randomUUID(),
      token: randomBytes(32).toString("hex"),
    },
  ) {
    super();
    Object.assign(this, {
      endpoint,
      identity,
      stopped: false,
      attempt: 0,
      connections: 0,
      bootSessionId:randomUUID(),
      state: null,
      offset: 0,
      samples: [],
      autoPrepare: true,
      preparedReleases: new Set(),
    });
  }
  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.endpoint);
    this.ws = ws;
    const send = (type, payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(envelope(type, payload)));
    };
    ws.on("open", () =>
      send("client.hello", {
        ...this.identity,
        bootSessionId: this.bootSessionId,
        appVersion: "simulator-2",
        runtimeVersion: "2.0",
        capabilities: {
          sceneSchemaVersions: [1],
          liveTicker:1,
          kissingWall:1,
          kissingDrain:1,
          model: "iPhone6s-simulated",
          osVersion: "15.8",
          width: 375,
          height: 667,
          scale: 2,
        },
      }),
    );
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "server.welcome") {
        this.attempt = 0;
        this.connections++;
        this.welcome = m.payload;
        this.emit("welcome", m.payload);
        send("state.request", {});
        send("time.request", { sent: Date.now() });
        this.heartbeat = setInterval(() => {
          send("client.heartbeat", {
            battery: 0.95,
            charging: true,
            thermalState: 0,
            lastRevision: this.state?.revision ?? 0,
            currentSceneId: this.state?.scene.id ?? "none",
          });
          send("time.request", { sent: Date.now() });
        }, 12000);
      }
      if (m.type === "state.snapshot") {
        if (
          this.state?.installationId === m.payload.installationId &&
          this.state?.revision > m.revision
        )
          return;
        this.state = m.payload;
        this.emit("snapshot", this.state);
        send("client.ack", { result: "applied", revision: m.revision });
        this.handleArtwork(m.payload.artwork, send);
      }
      if (m.type === "time.response") {
        this.samples.push({
          sent: m.payload.sent,
          received: Date.now(),
          server: m.serverTimeMs,
        });
        this.samples = this.samples.slice(-20);
        this.offset = clockOffset(this.samples);
      }
      if (m.type === "command") {
        this.command = m.payload;
        this.emit("command", m.payload);
        if (["reload-state", "reloadState"].includes(m.payload.name))
          send("state.request", {});
        send("client.ack", {
          result: "applied",
          commandId: m.payload.commandId,
        });
      }
      if (m.type === "server.error") this.emit("protocolError", m.payload.code);
      if(m.type==='pairing.state'){this.pairing=m.payload;this.emit('pairing',m.payload);}
      if(m.type==='ticker.snapshot'){this.ticker=m.payload;this.emit('ticker',m.payload);}
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearInterval(this.heartbeat);
      if (!this.stopped)
        this.retry = setTimeout(() => this.connect(), backoff(this.attempt++));
    });
    return this;
  }
  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    clearTimeout(this.activation);
    this.ws?.terminate();
  }
  handleArtwork(artwork, send) {
    const d = artwork?.pending ?? artwork?.active;
    if (!d) return;
    const report = (status) =>
      send("artwork.status", {
        deploymentId: d.deploymentId,
        releaseId: d.releaseId,
        status,
      });
    if (d.phase === "preparing" && this.autoPrepare) {
      this.preparedReleases.add(d.releaseId);
      report("ready");
    }
    if (["scheduled", "active"].includes(d.phase)) {
      clearTimeout(this.activation);
      this.activation = setTimeout(
        () => {
          this.activeArtwork = d;
          this.emit("artwork", d);
          report("displayed");
        },
        Math.max(0, d.startAtServerMs - Date.now() - this.offset),
      );
    }
  }
}
