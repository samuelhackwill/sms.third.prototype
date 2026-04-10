import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"
import fs from "node:fs"
import path from "node:path"

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
  STAGE_DISPATCH_MODE_AUTO,
  STAGE_DISPATCH_MODE_BUCKET_HOLD,
  TICKER_DISPATCH_MODE_AUTO,
  TICKER_DISPATCH_MODE_BUCKET_HOLD,
  TICKER_MACHINE_STATE_ACTIVE,
  TICKER_MACHINE_STATE_IDLE,
  TICKER_ROW_COUNT,
  TICKER_ROW_STATE_IDLE,
  TICKER_ROW_STATE_PLAYING,
} from "/imports/api/ticker/queue"
import { streamer } from "/imports/both/streamer"

const DEFAULT_TICKER_SPEED_PX_PER_SEC = 6000
const START_RUN_DELAY_MS = 800
const TICKER_PROVISIONING_SLOT_COUNT = 30
const TICKER_RENDERER_MODE_BITMAP = "bitmap"
const TICKER_RENDERER_MODE_TEXT = "text"
const TICKER_SPECIAL_MODE_NONE = "none"
const TICKER_SPECIAL_MODE_BARTHES = "barthes"
const TICKER_DISPLAY_MODE_CHORUS = "chorus"
const TICKER_DISPLAY_MODE_WALL = "wall"
const TICKER_DISPLAY_MODE_VERTICAL = "vertical"
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000
const TICKER_REFRESH_EVENT = "ticker.refresh"
const BARTHES_QUEUE_LOW_WATERMARK = 12
const BARTHES_SPEED_MIN_PX_PER_SEC = 1000
const BARTHES_SPEED_MAX_PX_PER_SEC = 6000
const TICKER_DISPATCH_EVENT_MESSAGE_ENQUEUED = "message_enqueued"
const TICKER_DISPATCH_EVENT_ROW_COMPLETED = "row_completed"
const TICKER_DISPATCH_EVENT_STARTUP_SYNC = "startup_sync"
const TICKER_DISPATCH_EVENT_EMPTY_BUCKET_CLICKED = "empty_bucket_clicked"

const rowCompletionTimersByWall = new Map()
const wallOperationChains = new Map()
let barthesSentenceCache = null

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

function normalizeRendererMode(rendererMode) {
  return rendererMode === TICKER_RENDERER_MODE_BITMAP
    ? TICKER_RENDERER_MODE_BITMAP
    : TICKER_RENDERER_MODE_TEXT
}

function normalizeSpecialMode(specialMode) {
  return specialMode === TICKER_SPECIAL_MODE_BARTHES
    ? TICKER_SPECIAL_MODE_BARTHES
    : TICKER_SPECIAL_MODE_NONE
}

function normalizeDispatchMode(dispatchMode) {
  return dispatchMode === TICKER_DISPATCH_MODE_BUCKET_HOLD
    ? TICKER_DISPATCH_MODE_BUCKET_HOLD
    : TICKER_DISPATCH_MODE_AUTO
}

function normalizeStageDispatchMode(dispatchMode) {
  return dispatchMode === STAGE_DISPATCH_MODE_BUCKET_HOLD
    ? STAGE_DISPATCH_MODE_BUCKET_HOLD
    : STAGE_DISPATCH_MODE_AUTO
}

function transitionTickerDispatchMode({ dispatchMode, eventType }) {
  const normalizedMode = normalizeDispatchMode(dispatchMode)

  if (normalizedMode === TICKER_DISPATCH_MODE_BUCKET_HOLD) {
    return {
      dispatchMode: normalizedMode,
      shouldAssignQueuedMessages: eventType === TICKER_DISPATCH_EVENT_EMPTY_BUCKET_CLICKED,
    }
  }

  return {
    dispatchMode: normalizedMode,
    shouldAssignQueuedMessages: [
      TICKER_DISPATCH_EVENT_MESSAGE_ENQUEUED,
      TICKER_DISPATCH_EVENT_ROW_COMPLETED,
      TICKER_DISPATCH_EVENT_STARTUP_SYNC,
      TICKER_DISPATCH_EVENT_EMPTY_BUCKET_CLICKED,
    ].includes(eventType),
  }
}

function shouldContinueManualDrain(queueState, eventType) {
  return Boolean(queueState?.drainUntilEmpty) && eventType === TICKER_DISPATCH_EVENT_ROW_COMPLETED
}

function resolveBarthesSourcePath() {
  const candidateRoots = [
    process.env.PWD,
    path.resolve(process.cwd(), "../../../../../"),
    path.resolve(process.cwd(), "../../../../"),
    process.cwd(),
  ].filter(Boolean)

  for (const root of candidateRoots) {
    const candidatePath = path.resolve(root, "output/barthes-sentences.ndjson")
    if (fs.existsSync(candidatePath)) {
      return candidatePath
    }
  }

  throw new Error(`Barthes source file not found from cwd ${process.cwd()}`)
}

function loadBarthesSentences() {
  if (barthesSentenceCache) {
    return barthesSentenceCache
  }

  const raw = fs.readFileSync(resolveBarthesSourcePath(), "utf8")
  const sentences = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .map((record, index) => ({
      index: Number(record?.index) || index + 1,
      text: typeof record?.text === "string" ? record.text.trim() : "",
      chapter: record?.chapter ?? null,
    }))
    .filter((record) => Boolean(record.text))

  if (sentences.length === 0) {
    throw new Error("Barthes source file is empty")
  }

  barthesSentenceCache = sentences
  return barthesSentenceCache
}

function ensureWallTimerMap(wallId) {
  if (!rowCompletionTimersByWall.has(wallId)) {
    rowCompletionTimersByWall.set(wallId, new Map())
  }

  return rowCompletionTimersByWall.get(wallId)
}

function clearRowCompletionTimer(wallId, rowIndex) {
  const timers = rowCompletionTimersByWall.get(wallId)
  const timer = timers?.get(rowIndex)
  if (timer) {
    Meteor.clearTimeout(timer)
    timers.delete(rowIndex)
  }
}

function enqueueWallOperation(wallId, operation) {
  const previous = wallOperationChains.get(wallId) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(operation)

  wallOperationChains.set(wallId, next)

  return next.finally(() => {
    if (wallOperationChains.get(wallId) === next) {
      wallOperationChains.delete(wallId)
    }
  })
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
    dispatchMode: normalizeDispatchMode(queueState?.dispatchMode),
    stageDispatchMode: normalizeStageDispatchMode(queueState?.stageDispatchMode),
    drainUntilEmpty: Boolean(queueState?.drainUntilEmpty),
    queuedCount: Number(queueState?.queuedCount) || 0,
    totalEnqueued: Number(queueState?.totalEnqueued) || 0,
    totalDequeued: Number(queueState?.totalDequeued) || 0,
    totalCompleted: Number(queueState?.totalCompleted) || 0,
    stageConsumedCount: Number(queueState?.stageConsumedCount) || 0,
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

function randomBarthesSpeedPxPerSec() {
  const min = BARTHES_SPEED_MIN_PX_PER_SEC
  const max = BARTHES_SPEED_MAX_PX_PER_SEC
  return Math.floor(Math.random() * ((max - min) + 1)) + min
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

function computeRunTiming({ wall, rowIndex, text, runId, speedPxPerSec: speedOverridePxPerSec = null }) {
  const speedPxPerSec = Number(speedOverridePxPerSec) > 0
    ? Number(speedOverridePxPerSec)
    : Number(wall?.speedPxPerSec) || DEFAULT_TICKER_SPEED_PX_PER_SEC
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
    if (!existing.rendererMode) {
      patch.rendererMode = TICKER_RENDERER_MODE_TEXT
    }
    if (!existing.specialMode) {
      patch.specialMode = TICKER_SPECIAL_MODE_NONE
    }
    if (!Number.isInteger(existing.barthesCursor)) {
      patch.barthesCursor = 0
    }
    if (!Number.isFinite(existing.renderHeightPx)) {
      patch.renderHeightPx = Number(existing.minClientHeight) || 0
    }
    if (!Number.isFinite(existing.matrixWallWidthPx)) {
      patch.matrixWallWidthPx = 0
    }
    if (!Number.isFinite(existing.matrixWallHeightPx)) {
      patch.matrixWallHeightPx = 0
    }
    if (!existing.queueState || !Array.isArray(existing.queueState.rows)) {
      patch.queueState = normalizeMachineState(existing.queueState)
    } else if (
      normalizeDispatchMode(existing.queueState?.dispatchMode) !== existing.queueState?.dispatchMode ||
      normalizeStageDispatchMode(existing.queueState?.stageDispatchMode) !== existing.queueState?.stageDispatchMode
    ) {
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
    rendererMode: TICKER_RENDERER_MODE_TEXT,
    specialMode: TICKER_SPECIAL_MODE_NONE,
    barthesCursor: 0,
    displayMode: TICKER_DISPLAY_MODE_CHORUS,
    provisioningEnabled: false,
    showDebug: true,
    renderHeightPx: 0,
    matrixWallWidthPx: 0,
    matrixWallHeightPx: 0,
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
  const rowHeights = Array.from({ length: TICKER_ROW_COUNT }, () => 0)
  for (const client of layoutClients) {
    columnWidths[client.colIndex] = Math.max(columnWidths[client.colIndex], Number(client.width) || 0)
    columnStackHeights[client.colIndex] += Number(client.height) || 0
    rowHeights[client.rowIndex] = Math.max(rowHeights[client.rowIndex], Number(client.height) || 0)
  }
  const columnXStarts = []
  let columnCursorX = 0
  for (let colIndex = 0; colIndex < 5; colIndex += 1) {
    columnXStarts[colIndex] = columnCursorX
    columnCursorX += columnWidths[colIndex]
  }
  const rowYStarts = []
  let rowCursorY = 0
  for (let rowIndex = 0; rowIndex < TICKER_ROW_COUNT; rowIndex += 1) {
    rowYStarts[rowIndex] = rowCursorY
    rowCursorY += rowHeights[rowIndex]
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
          matrixXStart: columnXStarts[colIndex],
          matrixYStart: rowYStarts[rowIndex],
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
          matrixXStart: null,
          matrixYStart: null,
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
        matrixWallWidthPx: columnCursorX,
        matrixWallHeightPx: rowCursorY,
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

async function maybeAssignQueuedMessagesForEvent(wallId, queueStateOrWall, eventType) {
  const queueState = normalizeMachineState(queueStateOrWall?.queueState ?? queueStateOrWall)
  const transition = transitionTickerDispatchMode({
    dispatchMode: queueState.dispatchMode,
    eventType,
  })
  const shouldAssignQueuedMessages =
    transition.shouldAssignQueuedMessages || shouldContinueManualDrain(queueState, eventType)

  if (!shouldAssignQueuedMessages || getTickerQueueSnapshot(wallId).length === 0) {
    return normalizeMachineState(queueState)
  }

  const nextQueueState = await assignQueuedMessagesToFreeRows(wallId)

  if (queueState.drainUntilEmpty && getTickerQueueSnapshot(wallId).length === 0) {
    return updateWallQueueState(wallId, (currentQueueState) => ({
      ...currentQueueState,
      dispatchMode: TICKER_DISPATCH_MODE_AUTO,
      stageDispatchMode: STAGE_DISPATCH_MODE_AUTO,
      drainUntilEmpty: false,
    }))
  }

  return nextQueueState
}

async function refillBarthesQueueIfNeeded(wallId = DEFAULT_TICKER_WALL_ID) {
  return enqueueWallOperation(wallId, async () => {
    const wall = await ensureWall(wallId)
    if (normalizeSpecialMode(wall?.specialMode) !== TICKER_SPECIAL_MODE_BARTHES) {
      return { addedCount: 0, queueDepth: getTickerQueueSnapshot(wallId).length }
    }

    const currentQueueDepth = getTickerQueueSnapshot(wallId).length
    if (currentQueueDepth >= BARTHES_QUEUE_LOW_WATERMARK) {
      return { addedCount: 0, queueDepth: currentQueueDepth }
    }

    let sentences
    try {
      sentences = loadBarthesSentences()
    } catch (error) {
      throw new Meteor.Error("ticker.barthes.loadFailed", error.message)
    }

    let cursor = Number.isInteger(wall?.barthesCursor) ? wall.barthesCursor : 0
    const neededCount = BARTHES_QUEUE_LOW_WATERMARK - currentQueueDepth
    const addedItems = []

    for (let index = 0; index < neededCount; index += 1) {
      const sourceRecord = sentences[cursor % sentences.length]
      const sequence = cursor
      cursor += 1

      const queued = enqueueTickerMessage(wallId, {
        id: `barthes-${sequence}-${sourceRecord.index}-${Random.id()}`,
        text: sourceRecord.text,
        sender: "Roland Barthes",
        receivedAt: new Date(),
        enqueuedAt: new Date(),
        skipClamp: true,
      })

      if (queued) {
        addedItems.push(queued)
      }
    }

    if (addedItems.length === 0) {
      return { addedCount: 0, queueDepth: getTickerQueueSnapshot(wallId).length }
    }

    const nowIso = new Date().toISOString()
    await updateWallQueueState(
      wallId,
      (queueState) => ({
        ...queueState,
        totalEnqueued: Number(queueState.totalEnqueued) + addedItems.length,
        lastEnqueuedAt: nowIso,
      }),
      {
        barthesCursor: cursor,
      },
    )

    return { addedCount: addedItems.length, queueDepth: getTickerQueueSnapshot(wallId).length }
  })
}

async function panicStopWall(wallId = DEFAULT_TICKER_WALL_ID, extraSet = {}) {
  const wall = await ensureWall(wallId)
  clearTickerQueue(wallId)
  const currentQueueState = normalizeMachineState(wall.queueState)
  const queueState = await updateWallQueueState(
    wallId,
    () => ({
      ...createDefaultMachineState(),
      dispatchMode: currentQueueState.dispatchMode,
    }),
    extraSet,
  )
  for (const row of queueState.rows) {
    clearRowCompletionTimer(wallId, row.rowIndex)
  }

  return { ok: true }
}

async function completeRowRun(wallId, rowIndex, runId) {
  const shouldAssign = await enqueueWallOperation(wallId, async () => {
    clearRowCompletionTimer(wallId, rowIndex)

    const wall = await ensureWall(wallId)
    const queueState = normalizeMachineState(wall.queueState)
    const row = queueState.rows[rowIndex]

    if (!row?.playing || row.playing.runId !== runId) {
      return false
    }

    const nowIso = new Date().toISOString()
    const nextQueueState = normalizeMachineState({
      ...queueState,
      totalCompleted: Number(queueState.totalCompleted) + 1,
      lastCompletedAt: nowIso,
      rows: queueState.rows.map((currentRow) => currentRow.rowIndex === rowIndex
        ? {
          ...currentRow,
          state: TICKER_ROW_STATE_IDLE,
          playing: null,
          updatedAt: nowIso,
        }
        : currentRow),
    })
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

    return true
  })

  if (shouldAssign) {
    await refillBarthesQueueIfNeeded(wallId)
    const wall = await ensureWall(wallId)
    const nextQueueState = await maybeAssignQueuedMessagesForEvent(
      wallId,
      wall.queueState,
      TICKER_DISPATCH_EVENT_ROW_COMPLETED,
    )
    await refillBarthesQueueIfNeeded(wallId)
    return nextQueueState
  }

  return null
}

function scheduleRowCompletion(wallId, rowIndex, playing) {
  if (!playing?.runId) {
    return
  }

  clearRowCompletionTimer(wallId, rowIndex)

  const delayMs = Math.max(0, Number(playing.completedAtServerMs) - Date.now())
  const timers = ensureWallTimerMap(wallId)
  const timer = Meteor.setTimeout(() => {
    completeRowRun(wallId, rowIndex, playing.runId).catch((error) => {
      console.error("[ticker] row completion failed", { wallId, rowIndex, runId: playing.runId, error })
    })
  }, delayMs)

  timers.set(rowIndex, timer)
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

  const wall = await ensureWall(wallId)
  await maybeAssignQueuedMessagesForEvent(
    wallId,
    wall.queueState,
    TICKER_DISPATCH_EVENT_MESSAGE_ENQUEUED,
  )

  return {
    ok: true,
    enqueued,
    queuedCount: getTickerQueueSnapshot(wallId).length,
  }
}

async function assignQueuedMessagesToFreeRows(wallId = DEFAULT_TICKER_WALL_ID) {
  return enqueueWallOperation(wallId, async () => {
    const wall = await ensureWall(wallId)
    const isBarthesMode = normalizeSpecialMode(wall?.specialMode) === TICKER_SPECIAL_MODE_BARTHES
    let nextQueueState = normalizeMachineState(wall.queueState)
    const nowIso = new Date().toISOString()
    const scheduledRuns = []
    let lastAssignedSpeedPxPerSec = null

    for (const row of nextQueueState.rows) {
      if (row.state !== TICKER_ROW_STATE_IDLE) {
        continue
      }

      const queued = dequeueTickerMessage(wallId)
      if (!queued) {
        break
      }

      const runId = Random.id()
      const runSpeedPxPerSec = isBarthesMode
        ? randomBarthesSpeedPxPerSec()
        : null
      const playing = {
        messageId: queued.id,
        sender: queued.sender ?? null,
        receivedAt: queued.receivedAt,
        enqueuedAt: queued.enqueuedAt,
        ...computeRunTiming({
          wall,
          rowIndex: row.rowIndex,
          text: queued.text,
          runId,
          speedPxPerSec: runSpeedPxPerSec,
        }),
      }
      lastAssignedSpeedPxPerSec = Number(playing.speedPxPerSec) || lastAssignedSpeedPxPerSec

      scheduledRuns.push({ rowIndex: row.rowIndex, playing })

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
          ...(lastAssignedSpeedPxPerSec ? { speedPxPerSec: lastAssignedSpeedPxPerSec } : {}),
          updatedAt: new Date(),
        },
      },
    )

    for (const { rowIndex, playing } of scheduledRuns) {
      scheduleRowCompletion(wallId, rowIndex, playing)
    }

    return nextQueueState
  })
}

async function consumeOneQueuedMessageForStage(wallId = DEFAULT_TICKER_WALL_ID) {
  return enqueueWallOperation(wallId, async () => {
    const wall = await ensureWall(wallId)
    const queueState = normalizeMachineState(wall.queueState)
    const queued = dequeueTickerMessage(wallId)

    if (!queued) {
      const nextQueueState = normalizeMachineState({
        ...queueState,
        queuedCount: getTickerQueueSnapshot(wallId).length,
        queuePreview: getTickerQueueSnapshot(wallId).slice(0, 5),
      })
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

      return {
        ok: true,
        drainedCount: 0,
        queuedCount: nextQueueState.queuedCount,
        consumedCount: nextQueueState.stageConsumedCount,
      }
    }

    streamer.emit("stage.raw.spawn", {
      messages: [{
        id: queued.id,
        phone: queued.sender ?? null,
        body: queued.text,
        receivedAt: queued.receivedAt,
      }],
    })

    const nowIso = new Date().toISOString()
    const nextQueueState = normalizeMachineState({
      ...queueState,
      stageConsumedCount: Number(queueState.stageConsumedCount) + 1,
      lastStageConsumedAt: nowIso,
    })
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

    return {
      ok: true,
      drainedCount: 1,
      queuedCount: nextQueueState.queuedCount,
      consumedCount: nextQueueState.stageConsumedCount,
    }
  })
}

async function initializeTickerCompletionTimers() {
  const walls = await TickerWalls.find({}, { fields: { _id: 1, queueState: 1, specialMode: 1 } }).fetchAsync()

  for (const wall of walls) {
    const queueState = normalizeMachineState(wall.queueState)
    const activeRows = queueState.rows.filter((row) => row.state === TICKER_ROW_STATE_PLAYING && row.playing)

    for (const row of activeRows) {
      if (Number(row.playing.completedAtServerMs) <= Date.now()) {
        await completeRowRun(wall._id, row.rowIndex, row.playing.runId)
      } else {
        scheduleRowCompletion(wall._id, row.rowIndex, row.playing)
      }
    }

    if (normalizeSpecialMode(wall?.specialMode) === TICKER_SPECIAL_MODE_BARTHES) {
      await refillBarthesQueueIfNeeded(wall._id)
    }

    if (getTickerQueueSnapshot(wall._id).length > 0) {
      await maybeAssignQueuedMessagesForEvent(
        wall._id,
        wall.queueState,
        TICKER_DISPATCH_EVENT_STARTUP_SYNC,
      )
    }
  }
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

  async "ticker.setRendererMode"({ wallId = DEFAULT_TICKER_WALL_ID, rendererMode } = {}) {
    return withServer(async () => {
      const normalizedRendererMode = normalizeRendererMode(rendererMode)

      await ensureWall(wallId)
      await TickerWalls.updateAsync(
        { _id: wallId },
        {
          $set: {
            rendererMode: normalizedRendererMode,
            updatedAt: new Date(),
          },
        },
      )

      return { ok: true, rendererMode: normalizedRendererMode }
    })
  },

  async "ticker.toggleBarthesMode"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      const wall = await ensureWall(wallId)
      const nextEnabled = normalizeSpecialMode(wall?.specialMode) !== TICKER_SPECIAL_MODE_BARTHES

      if (!nextEnabled) {
      await panicStopWall(wallId, {
        speedPxPerSec: DEFAULT_TICKER_SPEED_PX_PER_SEC,
          specialMode: TICKER_SPECIAL_MODE_NONE,
          rendererMode: TICKER_RENDERER_MODE_TEXT,
          barthesCursor: 0,
          updatedAt: new Date(),
        })
        return { ok: true, specialMode: TICKER_SPECIAL_MODE_NONE }
      }

      try {
        loadBarthesSentences()
      } catch (error) {
        throw new Meteor.Error("ticker.barthes.loadFailed", error.message)
      }

      await panicStopWall(wallId, {
        speedPxPerSec: BARTHES_SPEED_MIN_PX_PER_SEC,
        specialMode: TICKER_SPECIAL_MODE_BARTHES,
        rendererMode: TICKER_RENDERER_MODE_BITMAP,
        barthesCursor: 0,
        updatedAt: new Date(),
      })

      await refillBarthesQueueIfNeeded(wallId)
      const nextWall = await ensureWall(wallId)
      await maybeAssignQueuedMessagesForEvent(
        wallId,
        nextWall.queueState,
        TICKER_DISPATCH_EVENT_STARTUP_SYNC,
      )
      await refillBarthesQueueIfNeeded(wallId)

      return { ok: true, specialMode: TICKER_SPECIAL_MODE_BARTHES }
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

  async "ticker.setDispatchMode"({ wallId = DEFAULT_TICKER_WALL_ID, dispatchMode } = {}) {
    return withServer(async () => {
      await ensureWall(wallId)
      const normalizedDispatchMode = normalizeDispatchMode(dispatchMode)
      const normalizedStageDispatchMode = normalizedDispatchMode === TICKER_DISPATCH_MODE_BUCKET_HOLD
        ? STAGE_DISPATCH_MODE_BUCKET_HOLD
        : STAGE_DISPATCH_MODE_AUTO
      const queueState = await updateWallQueueState(wallId, (currentQueueState) => ({
        ...currentQueueState,
        dispatchMode: normalizedDispatchMode,
        stageDispatchMode: normalizedStageDispatchMode,
      }))

      if (normalizedDispatchMode === TICKER_DISPATCH_MODE_AUTO) {
        await maybeAssignQueuedMessagesForEvent(
          wallId,
          queueState,
          TICKER_DISPATCH_EVENT_STARTUP_SYNC,
        )
      }

      return { ok: true, dispatchMode: queueState.dispatchMode }
    })
  },

  async "ticker.emptyBucket"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => {
      await updateWallQueueState(wallId, (queueState) => ({
        ...queueState,
        drainUntilEmpty: true,
      }))
      const wall = await ensureWall(wallId)
      const queueState = await maybeAssignQueuedMessagesForEvent(
        wallId,
        wall.queueState,
        TICKER_DISPATCH_EVENT_EMPTY_BUCKET_CLICKED,
      )

      return {
        ok: true,
        dispatchMode: queueState.dispatchMode,
        queuedCount: getTickerQueueSnapshot(wallId).length,
      }
    })
  },

  async "ticker.emptyStageBucket"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    return withServer(async () => consumeOneQueuedMessageForStage(wallId))
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
    return withServer(async () => panicStopWall(wallId))
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

      clearTickerQueue(wallId)
      for (let rowIndex = 0; rowIndex < TICKER_ROW_COUNT; rowIndex += 1) {
        clearRowCompletionTimer(wallId, rowIndex)
      }
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
            rendererMode: TICKER_RENDERER_MODE_TEXT,
            specialMode: TICKER_SPECIAL_MODE_NONE,
            barthesCursor: 0,
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
    initializeTickerCompletionTimers().catch((error) => {
      console.error("[ticker] timer initialization failed", error)
    })
  })
}
