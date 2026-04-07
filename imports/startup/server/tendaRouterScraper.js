import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { access } from "node:fs/promises"
import { join, resolve } from "node:path"

import { Meteor } from "meteor/meteor"
import { WebApp } from "meteor/webapp"

import { Messages } from "/imports/api/messages/messages"
import {
  canonicalIdForRecord,
  ingestIncomingMessageRecord,
} from "/imports/api/messages/server/ingest"

const SCRAPER_RELATIVE_PATH = join("scripts", "tenda-router-scraper", "scraper.py")

const state = {
  child: null,
  ingestToken: null,
  launchedAt: null,
  lastExit: null,
  lastHeartbeatAt: null,
  lastHeartbeat: null,
  lastIngestAt: null,
  lastIngestCount: 0,
  lastIngestError: null,
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on("error", reject)
  })
}

function localMeteorBaseUrl() {
  const port = process.env.PORT || "3000"
  return `http://127.0.0.1:${port}`
}

function getRouterConfig() {
  const settings = Meteor.settings?.private?.tendaRouter ?? {}
  const password = process.env.TENDA_ROUTER_PASSWORD ?? Meteor.settings?.private?.routerPWD ?? settings.password ?? null

  return {
    enabled:
      String(process.env.TENDA_ROUTER_ENABLED ?? settings.enabled ?? (password ? "true" : "false"))
        .trim()
        .toLowerCase() !== "false",
    baseUrl: process.env.TENDA_ROUTER_BASE_URL ?? settings.baseUrl ?? "http://192.168.1.5",
    username: process.env.TENDA_ROUTER_USERNAME ?? settings.username ?? "admin",
    password,
    pollIntervalSeconds:
      process.env.TENDA_ROUTER_POLL_INTERVAL_SECONDS ??
      String(settings.pollIntervalSeconds ?? "1"),
    pageSize: process.env.TENDA_ROUTER_PAGE_SIZE ?? String(settings.pageSize ?? "200"),
  }
}

function authorizeRequest(req) {
  const header = req.headers.authorization ?? ""
  const expected = state.ingestToken ? `Bearer ${state.ingestToken}` : null
  return Boolean(expected) && header === expected
}

async function handleIngestRequest(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {
      Allow: "POST",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
    return
  }

  if (!authorizeRequest(req)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }))
    return
  }

  try {
    const payload = await parseJsonBody(req)
    const records = Array.isArray(payload?.records) ? payload.records : []
    const rawMessages = Messages.rawCollection()
    let ingestedCount = 0

    for (const record of records) {
      const normalizedRecord = {
        source: "sim_router",
        phoneNumberId: record?.phoneNumberId ?? "sim_router",
        receivedAt: record?.receivedAt ?? null,
        sender: record?.sender ?? null,
        body: record?.body ?? "",
        meta: record?.meta ?? {},
      }
      const existing = await rawMessages.findOne({
        id: canonicalIdForRecord(normalizedRecord),
      })

      if (existing) {
        continue
      }

      await ingestIncomingMessageRecord(normalizedRecord)
      ingestedCount += 1
    }

    state.lastIngestAt = new Date()
    state.lastIngestCount = ingestedCount
    state.lastIngestError = null

    res.writeHead(200, {
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: true, ingestedCount }))
  } catch (error) {
    console.error("[tendaRouterScraper] ingest endpoint failed", error)
    state.lastIngestError = error instanceof Error ? error.message : "Unknown error"
    res.writeHead(500, {
      "Content-Type": "application/json",
    })
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    )
  }
}

WebApp.connectHandlers.use("/api/messages/ingest/tenda-router", handleIngestRequest)

async function handleHeartbeatRequest(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {
      Allow: "POST",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
    return
  }

  if (!authorizeRequest(req)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }))
    return
  }

  try {
    const payload = await parseJsonBody(req)
    state.lastHeartbeatAt = new Date()
    state.lastHeartbeat = {
      ok: Boolean(payload?.ok),
      error: payload?.error || null,
      recordsSeen: Number.parseInt(payload?.recordsSeen, 10) || 0,
      recordsPosted: Number.parseInt(payload?.recordsPosted, 10) || 0,
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: true }))
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json",
    })
    res.end(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      })
    )
  }
}

WebApp.connectHandlers.use("/api/messages/ingest/tenda-router/heartbeat", handleHeartbeatRequest)

WebApp.connectHandlers.use("/api/sanity/tenda-router-scraper", (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, {
      Allow: "GET",
      "Content-Type": "application/json",
    })
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }))
    return
  }

  const heartbeatAgeMs =
    state.lastHeartbeatAt instanceof Date ? Date.now() - state.lastHeartbeatAt.getTime() : null
  const healthy =
    Boolean(state.child) &&
    heartbeatAgeMs != null &&
    heartbeatAgeMs < 15_000

  res.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  })
  res.end(
    JSON.stringify({
      ok: healthy,
      running: Boolean(state.child),
      pid: state.child?.pid ?? null,
      launchedAt: state.launchedAt?.toISOString?.() ?? null,
      lastExit: state.lastExit,
      lastHeartbeatAt: state.lastHeartbeatAt?.toISOString?.() ?? null,
      lastHeartbeat: state.lastHeartbeat,
      lastIngestAt: state.lastIngestAt?.toISOString?.() ?? null,
      lastIngestCount: state.lastIngestCount,
      lastIngestError: state.lastIngestError,
      heartbeatAgeMs,
    })
  )
})

async function scraperScriptPath() {
  const candidates = [
    join(process.cwd(), SCRAPER_RELATIVE_PATH),
    process.env.PWD ? join(process.env.PWD, SCRAPER_RELATIVE_PATH) : null,
    resolve(process.cwd(), "..", "..", "..", "..", "..", SCRAPER_RELATIVE_PATH),
  ].filter(Boolean)

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch (error) {
      // Try next candidate.
    }
  }

  return candidates[0]
}

function logChildOutput(prefix, chunk) {
  const text = String(chunk ?? "")
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .forEach((line) => {
      console.info(`${prefix} ${line}`)
    })
}

export async function startTendaRouterScraper() {
  const config = getRouterConfig()

  if (!config.enabled) {
    console.info("[tendaRouterScraper] Disabled.")
    return
  }

  if (!config.password) {
    console.info("[tendaRouterScraper] No TENDA router password configured. Skipping startup.")
    return
  }

  const scriptPath = await scraperScriptPath()

  try {
    await access(scriptPath)
  } catch (error) {
    console.error(`[tendaRouterScraper] Script not found at ${scriptPath}.`, error)
    return
  }

  if (state.child) {
    return
  }

  state.ingestToken = randomBytes(24).toString("hex")

  const child = spawn("python3", [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      TENDA_ROUTER_BASE_URL: config.baseUrl,
      TENDA_ROUTER_USERNAME: config.username,
      TENDA_ROUTER_PASSWORD: config.password,
      TENDA_ROUTER_POLL_INTERVAL_SECONDS: config.pollIntervalSeconds,
      TENDA_ROUTER_PAGE_SIZE: config.pageSize,
      TENDA_ROUTER_INGEST_URL: `${localMeteorBaseUrl()}/api/messages/ingest/tenda-router`,
      TENDA_ROUTER_INGEST_TOKEN: state.ingestToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  child.stdout.on("data", (chunk) => logChildOutput("[tendaRouterScraper]", chunk))
  child.stderr.on("data", (chunk) => logChildOutput("[tendaRouterScraper][stderr]", chunk))
  child.on("exit", (code, signal) => {
    console.info(`[tendaRouterScraper] exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)
    state.lastExit = {
      code: code ?? null,
      signal: signal ?? null,
      at: new Date().toISOString(),
    }
    if (state.child === child) {
      state.child = null
    }
  })
  child.on("error", (error) => {
    console.error("[tendaRouterScraper] failed to launch", error)
  })

  state.child = child
  state.launchedAt = new Date()
  state.lastExit = null

  console.info(
    `[tendaRouterScraper] launched (baseUrl=${config.baseUrl}, ingestHash=${createHash("sha1")
      .update(state.ingestToken)
      .digest("hex")
      .slice(0, 12)})`
  )
}

export async function stopTendaRouterScraper() {
  if (!state.child) {
    return
  }

  const child = state.child
  state.child = null

  await new Promise((resolve) => {
    const timeout = Meteor.setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 3000)

    child.once("exit", () => {
      Meteor.clearTimeout(timeout)
      resolve()
    })

    child.kill("SIGTERM")
  })
}

process.once("SIGINT", () => {
  stopTendaRouterScraper().catch((error) => {
    console.error("[tendaRouterScraper] stop on SIGINT failed", error)
  })
})

process.once("SIGTERM", () => {
  stopTendaRouterScraper().catch((error) => {
    console.error("[tendaRouterScraper] stop on SIGTERM failed", error)
  })
})
