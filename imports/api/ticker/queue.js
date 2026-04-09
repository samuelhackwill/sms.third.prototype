import { Random } from "meteor/random"

const TICKER_TEXT_MAX_CHARS = 100
const TICKER_TEXT_CLAMP_SUFFIX = "[...]"

export const TICKER_ROW_COUNT = 6
export const TICKER_ROW_STATE_IDLE = "idle"
export const TICKER_ROW_STATE_PLAYING = "playing"
export const TICKER_MACHINE_STATE_IDLE = "idle"
export const TICKER_MACHINE_STATE_ACTIVE = "active"
export const TICKER_DISPATCH_MODE_AUTO = "auto"
export const TICKER_DISPATCH_MODE_BUCKET_HOLD = "bucket_hold"

const queuesByWall = new Map()

function ensureQueue(wallId) {
  if (!queuesByWall.has(wallId)) {
    queuesByWall.set(wallId, [])
  }

  return queuesByWall.get(wallId)
}

function normalizeText(text, { skipClamp = false } = {}) {
  const normalized = typeof text === "string"
    ? text.trim()
    : text == null
      ? ""
      : String(text).trim()

  if (!normalized) {
    return ""
  }

  if (skipClamp || normalized.length <= TICKER_TEXT_MAX_CHARS) {
    return normalized
  }

  const maxBodyLength = Math.max(0, TICKER_TEXT_MAX_CHARS - TICKER_TEXT_CLAMP_SUFFIX.length)
  return `${normalized.slice(0, maxBodyLength)}${TICKER_TEXT_CLAMP_SUFFIX}`
}

function normalizeDate(value, fallback = new Date()) {
  const parsed = value ? new Date(value) : fallback
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

function normalizeQueueItem(item = {}) {
  const text = normalizeText(item.text ?? item.body, {
    skipClamp: Boolean(item.skipClamp),
  })
  if (!text) {
    return null
  }

  return {
    id: item.id ?? Random.id(),
    text,
    sender: item.sender ?? item.phone ?? null,
    receivedAt: normalizeDate(item.receivedAt).toISOString(),
    enqueuedAt: normalizeDate(item.enqueuedAt).toISOString(),
  }
}

export function createDefaultRowState(rowIndex) {
  return {
    rowIndex,
    state: TICKER_ROW_STATE_IDLE,
    playing: null,
    lastMessageId: null,
    lastMessageText: null,
    updatedAt: new Date().toISOString(),
  }
}

export function createDefaultMachineState() {
  return {
    machineState: TICKER_MACHINE_STATE_IDLE,
    dispatchMode: TICKER_DISPATCH_MODE_AUTO,
    queuedCount: 0,
    queuePreview: [],
    totalEnqueued: 0,
    totalDequeued: 0,
    totalCompleted: 0,
    stageConsumedCount: 0,
    lastEnqueuedAt: null,
    lastDequeuedAt: null,
    lastCompletedAt: null,
    lastStageConsumedAt: null,
    lastWorkerTickAt: null,
    rows: Array.from({ length: TICKER_ROW_COUNT }, (_, rowIndex) => createDefaultRowState(rowIndex)),
  }
}

export function enqueueTickerMessage(wallId, item) {
  const normalized = normalizeQueueItem(item)
  if (!normalized) {
    return null
  }

  const queue = ensureQueue(wallId)
  queue.push(normalized)
  return normalized
}

export function dequeueTickerMessage(wallId) {
  const queue = ensureQueue(wallId)
  return queue.shift() ?? null
}

export function getTickerQueueSnapshot(wallId) {
  const queue = ensureQueue(wallId)
  return [...queue]
}

export function clearTickerQueue(wallId) {
  queuesByWall.set(wallId, [])
}
