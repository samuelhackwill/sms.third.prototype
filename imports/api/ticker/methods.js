import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import {
  clearTickerQueue,
  dequeueTickerMessage,
  enqueueTickerMessage,
  getTickerQueueSnapshot,
  setTickerPlaying,
} from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

const DEFAULT_TICKER_SPEED_PX_PER_SEC = 120
const START_RUN_DELAY_MS = 800
const TICKER_FONT_FAMILY = "Times New Roman"
const pendingRunTimeouts = new Map()

function withServer(fn) {
  if (!Meteor.isServer) {
    return null
  }

  return fn()
}

async function ensureWall(wallId = DEFAULT_TICKER_WALL_ID) {
  const existing = await TickerWalls.findOneAsync({ _id: wallId })

  if (existing) {
    return existing
  }

  const now = new Date()
  const wall = {
    _id: wallId,
    layoutVersion: 1,
    totalWallWidth: 0,
    minClientHeight: 0,
    speedPxPerSec: DEFAULT_TICKER_SPEED_PX_PER_SEC,
    playing: null,
    createdAt: now,
    updatedAt: now,
  }

  await TickerWalls.insertAsync(wall)
  return wall
}

export async function maybeStartNext(wallId = DEFAULT_TICKER_WALL_ID) {
  if (!Meteor.isServer) {
    return null
  }

  const wall = await ensureWall(wallId)
  if (wall.playing) {
    return null
  }

  const nextMessage = dequeueTickerMessage(wallId)
  if (!nextMessage) {
    return null
  }

  const runId = Random.id()
  const speedPxPerSec = Number(wall.speedPxPerSec) || DEFAULT_TICKER_SPEED_PX_PER_SEC
  const totalWallWidth = Number(wall.totalWallWidth) || 0

  streamer.emit("ticker.measure.request", {
    wallId,
    runId,
    text: String(nextMessage.text ?? ""),
    fontFamily: TICKER_FONT_FAMILY,
    fontSizePx: Number(wall.minClientHeight) || 36,
    speedPxPerSec,
    totalWallWidth,
  })

  return {
    runId,
    wallId,
    text: String(nextMessage.text ?? ""),
  }
}

async function recomputeLayout(wallId = DEFAULT_TICKER_WALL_ID) {
  const clients = await TickerClients.find(
    { wallId },
    { sort: { orderIndex: 1, lastSeenAt: 1 } },
  ).fetchAsync()

  let xStart = 0
  let minClientHeight = Number.POSITIVE_INFINITY
  for (const [index, client] of clients.entries()) {
    const width = Number(client.width) || 0
    const height = Number(client.height) || 0
    await TickerClients.updateAsync(
      { _id: client._id },
      {
        $set: {
          orderIndex: index,
          xStart,
          updatedAt: new Date(),
        },
      },
    )
    xStart += width
    if (height > 0) {
      minClientHeight = Math.min(minClientHeight, height)
    }
  }

  const normalizedMinClientHeight = Number.isFinite(minClientHeight) ? minClientHeight : 0
  const wall = await ensureWall(wallId)
  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        totalWallWidth: xStart,
        minClientHeight: normalizedMinClientHeight,
        layoutVersion: Number(wall.layoutVersion ?? 0) + 1,
        updatedAt: new Date(),
      },
    },
  )
}

Meteor.methods({
  async "ticker.join"({
    wallId = DEFAULT_TICKER_WALL_ID,
    clientId,
    shortCode,
    width,
    height,
    dpr,
    userAgent,
  } = {}) {
    return withServer(async () => {
      if (!clientId) {
        throw new Meteor.Error("ticker.join.missingClientId", "clientId is required")
      }

      await ensureWall(wallId)

      await TickerClients.upsertAsync(
        { _id: clientId },
        {
          $set: {
            wallId,
            shortCode: shortCode ?? null,
            width: Number(width) || 0,
            height: Number(height) || 0,
            dpr: dpr ?? null,
            userAgent: userAgent ?? null,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
          $setOnInsert: {
            createdAt: new Date(),
          },
        },
      )

      await recomputeLayout(wallId)
      return { ok: true }
    })
  },

  async "ticker.updateSize"({ wallId = DEFAULT_TICKER_WALL_ID, clientId, width, height } = {}) {
    return withServer(async () => {
      if (!clientId) {
        throw new Meteor.Error("ticker.updateSize.missingClientId", "clientId is required")
      }

      await TickerClients.updateAsync(
        { _id: clientId, wallId },
        {
          $set: {
            width: Number(width) || 0,
            height: Number(height) || 0,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
        },
      )

      await recomputeLayout(wallId)
      return { ok: true }
    })
  },

  async "ticker.heartbeat"({ wallId = DEFAULT_TICKER_WALL_ID, clientId } = {}) {
    return withServer(async () => {
      if (!clientId) {
        throw new Meteor.Error("ticker.heartbeat.missingClientId", "clientId is required")
      }

      await TickerClients.updateAsync(
        { _id: clientId, wallId },
        {
          $set: {
            lastSeenAt: new Date(),
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true }
    })
  },

  async "ticker.setOrder"({ wallId = DEFAULT_TICKER_WALL_ID, orderedClientIds = [] } = {}) {
    return withServer(async () => {
      for (const [index, clientId] of orderedClientIds.entries()) {
        await TickerClients.updateAsync(
          { _id: clientId, wallId },
          { $set: { orderIndex: index, updatedAt: new Date() } },
        )
      }

      await recomputeLayout(wallId)
      return { ok: true }
    })
  },

  async "ticker.highlightClient"({ wallId = DEFAULT_TICKER_WALL_ID, clientId } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            highlightClientId: clientId ?? null,
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true }
    })
  },

  async "ticker.clearHighlight"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            highlightClientId: null,
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true }
    })
  },

  "ticker.time"() {
    return withServer(() => Date.now())
  },

  async "ticker.startRun"({ wallId = DEFAULT_TICKER_WALL_ID, runId, text, textWidthPx } = {}) {
    return withServer(async () => {
      if (!runId || typeof runId !== "string") {
        throw new Meteor.Error("ticker.startRun.invalidRunId", "runId is required")
      }

      if (typeof text !== "string") {
        throw new Meteor.Error("ticker.startRun.invalidText", "text must be a string")
      }

      const width = Number(textWidthPx)
      if (!Number.isFinite(width) || width < 0) {
        throw new Meteor.Error("ticker.startRun.invalidTextWidth", "textWidthPx must be >= 0")
      }

      const wall = await ensureWall(wallId)
      if (wall.playing) {
        throw new Meteor.Error("ticker.startRun.alreadyPlaying", "wall is already playing")
      }

      const speedPxPerSec = Number(wall.speedPxPerSec) || DEFAULT_TICKER_SPEED_PX_PER_SEC
      if (speedPxPerSec <= 0) {
        throw new Meteor.Error("ticker.startRun.invalidSpeed", "speedPxPerSec must be > 0")
      }

      const totalWallWidthAtStart = Number(wall.totalWallWidth) || 0
      const layoutVersionAtStart = Number(wall.layoutVersion) || 1
      const startedAtServerMs = Date.now() + START_RUN_DELAY_MS
      const durationMs = ((totalWallWidthAtStart + width) / speedPxPerSec) * 1000
      const estimatedDoneAt = new Date(startedAtServerMs + durationMs)

      const playing = {
        runId,
        text,
        startedAtServerMs,
        speedPxPerSec,
        textWidthPx: width,
        totalWallWidthAtStart,
        layoutVersionAtStart,
        estimatedDoneAt,
      }

      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            playing,
            updatedAt: new Date(),
          },
        },
      )
      setTickerPlaying(wallId, playing)

      const previousTimeout = pendingRunTimeouts.get(wallId)
      if (previousTimeout) {
        Meteor.clearTimeout(previousTimeout)
      }

      const timeoutMs = Math.max(0, startedAtServerMs + durationMs - Date.now())
      const timeoutId = Meteor.setTimeout(async () => {
        await TickerWalls.updateAsync(
          { _id: wallId },
          {
            $set: {
              playing: null,
              updatedAt: new Date(),
            },
          },
        )
        setTickerPlaying(wallId, null)
        pendingRunTimeouts.delete(wallId)
        await maybeStartNext(wallId)
      }, timeoutMs)

      pendingRunTimeouts.set(wallId, timeoutId)

      return {
        ok: true,
        runId,
        startedAtServerMs,
        estimatedDoneAt,
      }
    })
  },

  async "ticker.setSpeed"({ wallId = DEFAULT_TICKER_WALL_ID, speedPxPerSec } = {}) {
    return withServer(async () => {
      const speed = Number(speedPxPerSec)
      if (!Number.isFinite(speed) || speed <= 0) {
        throw new Meteor.Error("ticker.setSpeed.invalidSpeed", "speedPxPerSec must be > 0")
      }

      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            speedPxPerSec: speed,
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true, speedPxPerSec: speed }
    })
  },

  async "ticker.enqueueText"({ wallId = DEFAULT_TICKER_WALL_ID, text } = {}) {
    return withServer(async () => {
      const normalized = typeof text === "string" ? text.trim() : ""
      if (!normalized) {
        throw new Meteor.Error("ticker.enqueueText.invalidText", "text must be a non-empty string")
      }

      const id = Random.id()
      enqueueTickerMessage(wallId, {
        id,
        text: normalized,
        receivedAt: new Date(),
      })

      await maybeStartNext(wallId)
      return { ok: true, id }
    })
  },

  "ticker.queueStatus"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(() => {
      const queue = getTickerQueueSnapshot(wallId)
      return {
        wallId,
        queueLength: queue.length,
        head: queue[0] ?? null,
      }
    })
  },

  async "ticker.clearQueue"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      clearTickerQueue(wallId)
      return { ok: true }
    })
  },

  async "ticker.removeClient"({ wallId = DEFAULT_TICKER_WALL_ID, clientId } = {}) {
    return withServer(async () => {
      if (!clientId) {
        throw new Meteor.Error("ticker.removeClient.missingClientId", "clientId is required")
      }

      await TickerClients.removeAsync({ _id: clientId, wallId })
      await recomputeLayout(wallId)
      return { ok: true }
    })
  },

  async "ticker.killClients"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await TickerClients.removeAsync({ wallId })
      await recomputeLayout(wallId)
      return { ok: true }
    })
  },
})
