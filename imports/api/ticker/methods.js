import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import { setTickerPlaying } from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

const DEFAULT_TICKER_SPEED_PX_PER_SEC = 120
const START_RUN_DELAY_MS = 800
const TICKER_PROVISIONING_SLOT_COUNT = 30
const TICKER_DISPLAY_MODE_CHORUS = "chorus"
const TICKER_DISPLAY_MODE_WALL = "wall"
const TICKER_DISPLAY_MODE_VERTICAL = "vertical"
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000
const TICKER_REFRESH_EVENT = "ticker.refresh"

function isActiveClient(client, nowMs = Date.now()) {
  const lastSeenAtMs = new Date(client?.lastSeenAt).getTime()
  if (!Number.isFinite(lastSeenAtMs)) {
    return false
  }

  return (nowMs - lastSeenAtMs) <= TICKER_CLIENT_STALE_AFTER_MS
}

function withServer(fn) {
  if (!Meteor.isServer) {
    return null
  }

  return fn()
}

async function ensureWall(wallId = DEFAULT_TICKER_WALL_ID) {
  const existing = await TickerWalls.findOneAsync({ _id: wallId })

  if (existing) {
    const patch = {}
    if (!existing.displayMode) {
      patch.displayMode = TICKER_DISPLAY_MODE_CHORUS
    }
    if (typeof existing.provisioningEnabled !== "boolean") {
      patch.provisioningEnabled = false
    }
    if (typeof existing.showDebug !== "boolean") {
      patch.showDebug = true
    }
    if (!Number.isFinite(existing.renderHeightPx)) {
      patch.renderHeightPx = Number(existing.minClientHeight) || 0
    }
    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date()
      await TickerWalls.updateAsync({ _id: wallId }, { $set: patch })
      return { ...existing, ...patch }
    }

    return existing
  }

  const now = new Date()
  const wall = {
    _id: wallId,
    layoutVersion: 1,
    totalWallWidth: 0,
    minClientHeight: 0,
    speedPxPerSec: DEFAULT_TICKER_SPEED_PX_PER_SEC,
    displayMode: TICKER_DISPLAY_MODE_CHORUS,
    provisioningEnabled: false,
    showDebug: true,
    renderHeightPx: 0,
    playing: null,
    createdAt: now,
    updatedAt: now,
  }

  await TickerWalls.insertAsync(wall)
  return wall
}

function estimateTickerTextWidthPx(text, fontSizePx) {
  const normalizedText = typeof text === "string" ? text : ""
  const normalizedFontSize = Number(fontSizePx) > 0 ? Number(fontSizePx) : 36
  return Math.max(1, Math.ceil(normalizedText.length * normalizedFontSize * 0.62))
}

async function startRunInternal({
  wallId = DEFAULT_TICKER_WALL_ID,
  runId,
  text,
  textWidthPx,
} = {}) {
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

  const playing = {
    runId,
    text,
    startedAtServerMs,
    speedPxPerSec,
    textWidthPx: width,
    totalWallWidthAtStart,
    layoutVersionAtStart,
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

  return {
    ok: true,
    runId,
    startedAtServerMs,
  }
}

async function recomputeLayout(wallId = DEFAULT_TICKER_WALL_ID) {
  const wall = await ensureWall(wallId)
  const displayMode = wall?.displayMode === TICKER_DISPLAY_MODE_WALL
    ? TICKER_DISPLAY_MODE_WALL
    : wall?.displayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? TICKER_DISPLAY_MODE_VERTICAL
      : TICKER_DISPLAY_MODE_CHORUS
  const clients = await TickerClients.find(
    { wallId },
    { sort: { slotIndex: 1, orderIndex: 1, lastSeenAt: 1 } },
  ).fetchAsync()

  const explicitlyAssignedClients = clients.filter((client) => Number.isInteger(client.slotIndex) && client.slotIndex >= 0)
  const assignedClients = explicitlyAssignedClients.length > 0
    ? explicitlyAssignedClients
    : clients
  const layoutClients = assignedClients.map((client, index) => {
    const slotIndex = Number.isInteger(client.slotIndex) ? Number(client.slotIndex) : index
    const rowIndex = Math.floor(slotIndex / 5)
    const colIndex = slotIndex % 5

    return {
      ...client,
      slotIndex,
      rowIndex,
      colIndex,
    }
  })

  const columnWidths = Array.from({ length: 5 }, () => 0)
  const columnStackHeights = Array.from({ length: 5 }, () => 0)
  for (const client of layoutClients) {
    columnWidths[client.colIndex] = Math.max(columnWidths[client.colIndex], Number(client.width) || 0)
    columnStackHeights[client.colIndex] += Number(client.height) || 0
  }
  const columnXStarts = []
  let columnCursorX = 0
  for (let colIndex = 0; colIndex < 5; colIndex += 1) {
    columnXStarts[colIndex] = columnCursorX
    columnCursorX += columnWidths[colIndex]
  }

  let xStart = 0
  let rowWidth = 0
  let minClientHeight = Number.POSITIVE_INFINITY
  const columnYCursor = Array.from({ length: 5 }, () => 0)
  for (const [index, client] of layoutClients.entries()) {
    const width = Number(client.width) || 0
    const height = Number(client.height) || 0
    const { rowIndex, colIndex } = client

    if (displayMode === TICKER_DISPLAY_MODE_CHORUS && colIndex === 0) {
      rowWidth = 0
    }

    const nextXStart = displayMode === TICKER_DISPLAY_MODE_WALL
      ? xStart
      : displayMode === TICKER_DISPLAY_MODE_VERTICAL
        ? columnXStarts[colIndex]
        : rowWidth
    const nextYStart = displayMode === TICKER_DISPLAY_MODE_VERTICAL ? columnYCursor[colIndex] : 0
    const stackHeight = displayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? columnStackHeights[colIndex]
      : height
    await TickerClients.updateAsync(
      { _id: client._id },
      {
        $set: {
          orderIndex: index,
          rowIndex,
          colIndex,
          xStart: nextXStart,
          yStart: nextYStart,
          stackHeight,
          updatedAt: new Date(),
        },
      },
    )
    xStart += width
    rowWidth += width
    columnYCursor[colIndex] += height
    if (height > 0) {
      minClientHeight = Math.min(minClientHeight, height)
    }
  }

  const unassignedClients = explicitlyAssignedClients.length > 0
    ? clients.filter((client) => !Number.isInteger(client.slotIndex) || client.slotIndex < 0)
    : []
  for (const client of unassignedClients) {
    await TickerClients.updateAsync(
      { _id: client._id },
      {
        $set: {
          xStart: null,
          yStart: null,
          stackHeight: null,
          rowIndex: null,
          colIndex: null,
          updatedAt: new Date(),
        },
      },
    )
  }

  const normalizedMinClientHeight = Number.isFinite(minClientHeight) ? minClientHeight : 0
  const normalizedTotalWallWidth = displayMode === TICKER_DISPLAY_MODE_WALL
    ? xStart
    : displayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? columnCursorX
    : Math.max(
      0,
      ...layoutClients.reduce((widths, client) => {
        widths[client.rowIndex] = (widths[client.rowIndex] || 0) + (Number(client.width) || 0)
        return widths
      }, []),
    )
  const normalizedRenderHeight = displayMode === TICKER_DISPLAY_MODE_VERTICAL
    ? Math.max(0, ...columnStackHeights)
    : normalizedMinClientHeight
  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        totalWallWidth: normalizedTotalWallWidth,
        minClientHeight: normalizedMinClientHeight,
        renderHeightPx: normalizedRenderHeight,
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
    deviceKey,
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

      const previousClientForDevice = deviceKey
        ? await TickerClients.findOneAsync({
          wallId,
          deviceKey,
          _id: { $ne: clientId },
        })
        : null

      const inheritedSlotIndex = Number.isInteger(previousClientForDevice?.slotIndex)
        ? Number(previousClientForDevice.slotIndex)
        : null
      const inheritedOrderIndex = Number.isInteger(previousClientForDevice?.orderIndex)
        ? Number(previousClientForDevice.orderIndex)
        : null

      await TickerClients.upsertAsync(
        { _id: clientId },
        {
          $set: {
            wallId,
            deviceKey: deviceKey ?? null,
            shortCode: shortCode ?? null,
            width: Number(width) || 0,
            height: Number(height) || 0,
            dpr: dpr ?? null,
            userAgent: userAgent ?? null,
            lastSeenAt: new Date(),
            updatedAt: new Date(),
            ...(inheritedSlotIndex != null ? { slotIndex: inheritedSlotIndex } : {}),
            ...(inheritedOrderIndex != null ? { orderIndex: inheritedOrderIndex } : {}),
          },
          $setOnInsert: {
            createdAt: new Date(),
            slotIndex: inheritedSlotIndex,
            orderIndex: inheritedOrderIndex,
          },
        },
      )

      if (previousClientForDevice) {
        await TickerClients.removeAsync({ _id: previousClientForDevice._id, wallId })
      }

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

  async "ticker.claimNextSlot"({ wallId = DEFAULT_TICKER_WALL_ID, clientId } = {}) {
    return withServer(async () => {
      if (!clientId) {
        throw new Meteor.Error("ticker.claimNextSlot.missingClientId", "clientId is required")
      }

      const client = await TickerClients.findOneAsync({ _id: clientId, wallId })
      if (!client) {
        throw new Meteor.Error("ticker.claimNextSlot.clientNotFound", "client must join before claiming a slot")
      }

      if (Number.isInteger(client.slotIndex) && client.slotIndex >= 0) {
        return { ok: true, slotIndex: client.slotIndex, alreadyAssigned: true }
      }

      const assignedClients = await TickerClients.find(
        { wallId, slotIndex: { $ne: null } },
        { sort: { slotIndex: 1 } },
      ).fetchAsync()
      const assignedSlotIndexes = new Set(
        assignedClients
          .map((item) => item.slotIndex)
          .filter((value) => Number.isInteger(value) && value >= 0),
      )

      let nextSlotIndex = null
      for (let slotIndex = 0; slotIndex < TICKER_PROVISIONING_SLOT_COUNT; slotIndex += 1) {
        if (!assignedSlotIndexes.has(slotIndex)) {
          nextSlotIndex = slotIndex
          break
        }
      }

      if (nextSlotIndex == null) {
        throw new Meteor.Error("ticker.claimNextSlot.full", "All provisioning slots are already assigned")
      }

      await TickerClients.updateAsync(
        { _id: clientId, wallId },
        {
          $set: {
            slotIndex: nextSlotIndex,
            updatedAt: new Date(),
          },
        },
      )

      await recomputeLayout(wallId)
      return { ok: true, slotIndex: nextSlotIndex, alreadyAssigned: false }
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
    return withServer(async () => startRunInternal({ wallId, runId, text, textWidthPx }))
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

  async "ticker.setDisplayMode"({ wallId = DEFAULT_TICKER_WALL_ID, displayMode } = {}) {
    return withServer(async () => {
      const normalizedDisplayMode = displayMode === TICKER_DISPLAY_MODE_WALL
        ? TICKER_DISPLAY_MODE_WALL
        : displayMode === TICKER_DISPLAY_MODE_CHORUS
          ? TICKER_DISPLAY_MODE_CHORUS
          : displayMode === TICKER_DISPLAY_MODE_VERTICAL
            ? TICKER_DISPLAY_MODE_VERTICAL
          : null

      if (!normalizedDisplayMode) {
        throw new Meteor.Error("ticker.setDisplayMode.invalidDisplayMode", "displayMode is invalid")
      }

      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            displayMode: normalizedDisplayMode,
            updatedAt: new Date(),
          },
        },
      )

      await recomputeLayout(wallId)
      return { ok: true, displayMode: normalizedDisplayMode }
    })
  },

  async "ticker.setProvisioningEnabled"({ wallId = DEFAULT_TICKER_WALL_ID, enabled } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            provisioningEnabled: Boolean(enabled),
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true, enabled: Boolean(enabled) }
    })
  },

  async "ticker.setShowDebug"({ wallId = DEFAULT_TICKER_WALL_ID, showDebug } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            showDebug: Boolean(showDebug),
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true, showDebug: Boolean(showDebug) }
    })
  },

  async "ticker.forceRefreshClients"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      streamer.emit(TICKER_REFRESH_EVENT, { wallId })
      return { ok: true }
    })
  },

  async "ticker.enqueueText"({ wallId = DEFAULT_TICKER_WALL_ID, text } = {}) {
    return withServer(async () => Meteor.callAsync("ticker.playNow", { wallId, text }))
  },

  async "ticker.playNow"({ wallId = DEFAULT_TICKER_WALL_ID, text } = {}) {
    return withServer(async () => {
      const normalized = typeof text === "string" ? text.trim() : ""
      if (!normalized) {
        throw new Meteor.Error("ticker.playNow.invalidText", "text must be a non-empty string")
      }

      await ensureWall(wallId)

      setTickerPlaying(wallId, null)

      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            playing: null,
            updatedAt: new Date(),
          },
        },
      )

      const wall = await ensureWall(wallId)
      const runId = Random.id()
      const textWidthPx = estimateTickerTextWidthPx(normalized, Number(wall.renderHeightPx) || Number(wall.minClientHeight) || 36)

      return startRunInternal({
        wallId,
        runId,
        text: normalized,
        textWidthPx,
      })
    })
  },

  async "ticker.panicStop"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)

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

  async "ticker.resetAll"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)

      setTickerPlaying(wallId, null)
      await TickerClients.removeAsync({ wallId })
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            totalWallWidth: 0,
            minClientHeight: 0,
            renderHeightPx: 0,
            playing: null,
            highlightClientId: null,
            displayMode: TICKER_DISPLAY_MODE_CHORUS,
            provisioningEnabled: false,
            showDebug: true,
            updatedAt: new Date(),
          },
          $inc: {
            layoutVersion: 1,
          },
        },
      )

      return { ok: true }
    })
  },
})
