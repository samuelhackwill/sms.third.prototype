import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import {
  clearTickerQueue,
  createDefaultMachineState,
  dequeueTickerMessage,
  enqueueTickerMessage,
  getTickerQueueSnapshot,
  TICKER_MACHINE_STATE_ACTIVE,
  TICKER_MACHINE_STATE_IDLE,
  TICKER_ROW_COUNT,
  TICKER_ROW_STATE_IDLE,
  TICKER_ROW_STATE_PLAYING,
} from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

const DEFAULT_TICKER_SPEED_PX_PER_SEC = 120
const START_RUN_DELAY_MS = 800
const TICKER_PROVISIONING_SLOT_COUNT = 30
const TICKER_DISPLAY_MODE_CHORUS = "chorus"
const TICKER_DISPLAY_MODE_WALL = "wall"
const TICKER_DISPLAY_MODE_VERTICAL = "vertical"
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000
const TICKER_REFRESH_EVENT = "ticker.refresh"
const TICKER_WORKER_INTERVAL_MS = 250

let tickerWorkerTimer = null
let tickerWorkerInFlight = false

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

function normalizeRowState(row, rowIndex) {
  const defaults = createDefaultMachineState().rows[rowIndex]
  return {
    ...defaults,
    ...row,
    rowIndex,
    state: row?.state ?? defaults.state,
    playing: row?.playing ?? null,
  }
}

function normalizeMachineState(queueState) {
  const defaults = createDefaultMachineState()
  const nextRows = Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) =>
    normalizeRowState(queueState?.rows?.[rowIndex], rowIndex))

  return {
    ...defaults,
    ...queueState,
    rows: nextRows,
    queuedCount: Number(queueState?.queuedCount) || 0,
    totalEnqueued: Number(queueState?.totalEnqueued) || 0,
    totalDequeued: Number(queueState?.totalDequeued) || 0,
    totalCompleted: Number(queueState?.totalCompleted) || 0,
    queuePreview: Array.isArray(queueState?.queuePreview) ? queueState.queuePreview : [],
  }
}

function machineStateForRows(rows, queuedCount) {
  if (queuedCount > 0 || rows.some((row) => row.state === TICKER_ROW_STATE_PLAYING)) {
    return TICKER_MACHINE_STATE_ACTIVE
  }

  return TICKER_MACHINE_STATE_IDLE
}

function estimateTickerTextWidthPx(text, fontSizePx) {
  const normalizedText = typeof text === "string" ? text : ""
  const normalizedFontSize = Number(fontSizePx) > 0 ? Number(fontSizePx) : 36
  return Math.max(1, Math.ceil(normalizedText.length * normalizedFontSize * 0.62))
}

function getRowRenderHeightPx(wall, rowIndex) {
  const rowMetrics = wall?.rowMetrics?.[rowIndex]
  const height = Number(rowMetrics?.renderHeightPx)
  if (Number.isFinite(height) && height > 0) {
    return height
  }

  const wallRenderHeight = Number(wall?.renderHeightPx)
  if (Number.isFinite(wallRenderHeight) && wallRenderHeight > 0) {
    return wallRenderHeight
  }

  const minClientHeight = Number(wall?.minClientHeight)
  if (Number.isFinite(minClientHeight) && minClientHeight > 0) {
    return minClientHeight
  }

  return 36
}

function getRowWidthPx(wall, rowIndex) {
  const width = Number(wall?.rowMetrics?.[rowIndex]?.widthPx)
  return Number.isFinite(width) && width > 0 ? width : 0
}

function computeRunTiming({ wall, rowIndex, text, runId }) {
  const speedPxPerSec = Number(wall?.speedPxPerSec) || DEFAULT_TICKER_SPEED_PX_PER_SEC
  const rowWidthPx = getRowWidthPx(wall, rowIndex)
  const textWidthPx = estimateTickerTextWidthPx(text, getRowRenderHeightPx(wall, rowIndex))
  const startedAtServerMs = Date.now() + START_RUN_DELAY_MS
  const travelDistancePx = rowWidthPx + textWidthPx
  const durationMs = Math.max(1000, Math.ceil((travelDistancePx / speedPxPerSec) * 1000))

  return {
    runId,
    text,
    startedAtServerMs,
    speedPxPerSec,
    textWidthPx,
    rowWidthPx,
    durationMs,
    completedAtServerMs: startedAtServerMs + durationMs,
  }
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
    if (!existing.queueState || !Array.isArray(existing.queueState.rows)) {
      patch.queueState = normalizeMachineState(existing.queueState)
    }
    if (!Array.isArray(existing.rowMetrics) || existing.rowMetrics.length !== TICKER_ROW_COUNT) {
      patch.rowMetrics = Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) => ({
        rowIndex,
        widthPx: 0,
        renderHeightPx: 0,
        activeClientCount: 0,
      }))
    }

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = new Date()
      await TickerWalls.updateAsync({ _id: wallId }, { $set: patch })
      return { ...existing, ...patch }
    }

    return {
      ...existing,
      queueState: normalizeMachineState(existing.queueState),
    }
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
    rowMetrics: Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) => ({
      rowIndex,
      widthPx: 0,
      renderHeightPx: 0,
      activeClientCount: 0,
    })),
    queueState: createDefaultMachineState(),
    createdAt: now,
    updatedAt: now,
  }

  await TickerWalls.insertAsync(wall)
  return wall
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

  const rowMetrics = Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) => {
    const rowClients = layoutClients.filter((client) => client.rowIndex === rowIndex)
    const widthPx = rowClients.reduce((sum, client) => sum + (Number(client.width) || 0), 0)
    const renderHeightPx = displayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? normalizedRenderHeight
      : rowClients.reduce((maxHeight, client) => Math.max(maxHeight, Number(client.height) || 0), 0)

    return {
      rowIndex,
      widthPx,
      renderHeightPx,
      activeClientCount: rowClients.filter(isActiveClient).length,
    }
  })

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        totalWallWidth: normalizedTotalWallWidth,
        minClientHeight: normalizedMinClientHeight,
        renderHeightPx: normalizedRenderHeight,
        rowMetrics,
        layoutVersion: Number(wall.layoutVersion ?? 0) + 1,
        updatedAt: new Date(),
      },
    },
  )
}

async function updateWallQueueState(wallId, mutate, extraSet = {}) {
  const wall = await ensureWall(wallId)
  const queueState = normalizeMachineState(wall.queueState)
  const nextQueueState = normalizeMachineState(mutate(queueState, wall) ?? queueState)
  nextQueueState.queuedCount = getTickerQueueSnapshot(wallId).length
  nextQueueState.queuePreview = getTickerQueueSnapshot(wallId).slice(0, 5)
  nextQueueState.machineState = machineStateForRows(nextQueueState.rows, nextQueueState.queuedCount)
  nextQueueState.lastWorkerTickAt = nextQueueState.lastWorkerTickAt ?? null

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        queueState: nextQueueState,
        updatedAt: new Date(),
        ...extraSet,
      },
    },
  )

  return nextQueueState
}

async function enqueueTextInternal({ wallId = DEFAULT_TICKER_WALL_ID, text, sender = null, receivedAt = null, messageId = null } = {}) {
  const normalizedText = typeof text === "string" ? text.trim() : ""
  if (!normalizedText) {
    throw new Meteor.Error("ticker.enqueueText.invalidText", "text must be a non-empty string")
  }

  await ensureWall(wallId)

  const enqueued = enqueueTickerMessage(wallId, {
    id: messageId ?? Random.id(),
    text: normalizedText,
    sender,
    receivedAt: receivedAt ?? new Date(),
    enqueuedAt: new Date(),
  })

  const nowIso = new Date().toISOString()

  await updateWallQueueState(wallId, (queueState) => ({
    ...queueState,
    totalEnqueued: Number(queueState.totalEnqueued) + 1,
    lastEnqueuedAt: nowIso,
  }))

  await runTickerWorkerCycle(wallId, { cause: "enqueue" })

  return {
    ok: true,
    enqueued,
    queuedCount: getTickerQueueSnapshot(wallId).length,
  }
}

async function assignQueuedMessagesToFreeRows(wallId, queueState, wall) {
  let nextQueueState = queueState
  const nowIso = new Date().toISOString()

  for (const row of nextQueueState.rows) {
    if (row.state !== TICKER_ROW_STATE_IDLE) {
      continue
    }

    const queued = dequeueTickerMessage(wallId)
    if (!queued) {
      break
    }

    const runId = Random.id()
    const playing = {
      messageId: queued.id,
      sender: queued.sender ?? null,
      receivedAt: queued.receivedAt,
      enqueuedAt: queued.enqueuedAt,
      ...computeRunTiming({ wall, rowIndex: row.rowIndex, text: queued.text, runId }),
    }

    nextQueueState = normalizeMachineState({
      ...nextQueueState,
      totalDequeued: Number(nextQueueState.totalDequeued) + 1,
      lastDequeuedAt: nowIso,
      rows: nextQueueState.rows.map((currentRow) => currentRow.rowIndex === row.rowIndex
        ? {
          ...currentRow,
          state: TICKER_ROW_STATE_PLAYING,
          playing,
          lastMessageId: queued.id,
          lastMessageText: queued.text,
          updatedAt: nowIso,
        }
        : currentRow),
    })
  }

  nextQueueState.queuedCount = getTickerQueueSnapshot(wallId).length
  nextQueueState.queuePreview = getTickerQueueSnapshot(wallId).slice(0, 5)
  nextQueueState.machineState = machineStateForRows(nextQueueState.rows, nextQueueState.queuedCount)

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        queueState: nextQueueState,
        updatedAt: new Date(),
      },
    },
  )

  return nextQueueState
}

async function runTickerWorkerCycle(wallId = DEFAULT_TICKER_WALL_ID, { cause = "tick" } = {}) {
  const wall = await ensureWall(wallId)
  let queueState = normalizeMachineState(wall.queueState)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()

  let didChange = false
  const rows = queueState.rows.map((row) => {
    let nextRow = { ...row }

    if (nextRow.playing && Number(nextRow.playing.completedAtServerMs) <= nowMs) {
      nextRow = {
        ...nextRow,
        state: TICKER_ROW_STATE_IDLE,
        playing: null,
        updatedAt: nowIso,
      }
      didChange = true
    }

    return nextRow
  })

  if (didChange) {
    queueState = normalizeMachineState({
      ...queueState,
      rows,
      totalCompleted: Number(queueState.totalCompleted) + rows.filter((row, index) => queueState.rows[index].playing && !row.playing).length,
      lastCompletedAt: nowIso,
    })
  } else {
    queueState = normalizeMachineState({
      ...queueState,
      rows,
    })
  }

  queueState.lastWorkerTickAt = nowIso
  queueState.queuedCount = getTickerQueueSnapshot(wallId).length
  queueState.queuePreview = getTickerQueueSnapshot(wallId).slice(0, 5)

  const freeRows = queueState.rows.filter((row) => row.state === TICKER_ROW_STATE_IDLE)

  if (freeRows.length > 0 && queueState.queuedCount > 0) {
    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          queueState: queueState,
          updatedAt: new Date(),
        },
      },
    )
    queueState = await assignQueuedMessagesToFreeRows(wallId, queueState, wall)
  } else {
    queueState.machineState = machineStateForRows(queueState.rows, queueState.queuedCount)
    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          queueState,
          updatedAt: new Date(),
        },
      },
    )
  }

  return queueState
}

function startTickerWorker() {
  if (!Meteor.isServer || tickerWorkerTimer) {
    return
  }

  tickerWorkerTimer = Meteor.setInterval(async () => {
    if (tickerWorkerInFlight) {
      return
    }

    tickerWorkerInFlight = true

    try {
      const walls = await TickerWalls.find({}, { fields: { _id: 1 } }).fetchAsync()
      const wallIds = walls.length > 0 ? walls.map((wall) => wall._id) : [DEFAULT_TICKER_WALL_ID]

      for (const wallId of wallIds) {
        await runTickerWorkerCycle(wallId)
      }
    } catch (error) {
      console.error("[ticker.worker] tick failed", error)
    } finally {
      tickerWorkerInFlight = false
    }
  }, TICKER_WORKER_INTERVAL_MS)
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
      await runTickerWorkerCycle(wallId)
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
      await runTickerWorkerCycle(wallId)
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
      await runTickerWorkerCycle(wallId)
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
      await runTickerWorkerCycle(wallId)
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

      await runTickerWorkerCycle(wallId)
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
      await runTickerWorkerCycle(wallId)
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

  async "ticker.enqueueText"({ wallId = DEFAULT_TICKER_WALL_ID, text, sender, receivedAt, messageId } = {}) {
    return withServer(async () => enqueueTextInternal({ wallId, text, sender, receivedAt, messageId }))
  },

  async "ticker.playNow"({ wallId = DEFAULT_TICKER_WALL_ID, text } = {}) {
    return withServer(async () => enqueueTextInternal({ wallId, text }))
  },

  async "ticker.panicStop"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      clearTickerQueue(wallId)

      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            queueState: createDefaultMachineState(),
            updatedAt: new Date(),
          },
        },
      )

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
      await runTickerWorkerCycle(wallId)
      return { ok: true }
    })
  },

  async "ticker.killClients"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await TickerClients.removeAsync({ wallId })
      await recomputeLayout(wallId)
      await runTickerWorkerCycle(wallId)
      return { ok: true }
    })
  },

  async "ticker.resetAll"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)

      clearTickerQueue(wallId)
      await TickerClients.removeAsync({ wallId })
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            totalWallWidth: 0,
            minClientHeight: 0,
            renderHeightPx: 0,
            rowMetrics: Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) => ({
              rowIndex,
              widthPx: 0,
              renderHeightPx: 0,
              activeClientCount: 0,
            })),
            queueState: createDefaultMachineState(),
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

if (Meteor.isServer) {
  Meteor.startup(() => {
    startTickerWorker()
  })
}
