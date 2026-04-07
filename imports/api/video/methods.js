import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"

import { VIDEO_DISPLAY_MODE_FIFO, VIDEO_DISPLAY_MODE_SYNC_BATCH } from "/imports/api/video/constants"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"

const VIDEO_WALL_SLOT_COUNT = 30
const VIDEO_BATCH_STATE_IDLE = "idle"
const VIDEO_BATCH_STATE_LOADING = "loading"
const VIDEO_BATCH_STATE_PLAYING = "playing"
const VIDEO_BATCH_STATE_FINISHED = "finished"
const VIDEO_BATCH_HOLD_FINISHED_MS = 300
const DEFAULT_VIDEO_TRIM_START_OFFSET_SEC = 1
const DEFAULT_VIDEO_TRIM_END_OFFSET_SEC = 1
const DEFAULT_VIDEO_REVEAL_DURATION_MS = 1200
const DEFAULT_VIDEO_FADE_OUT_DURATION_MS = 1000
const DEFAULT_VIDEO_SYNC_BATCH_FADE_OUT_DURATION_MS = 3000
const DEFAULT_VIDEO_FADE_OUT_LEAD_MS = 1200

const syncBatchAdvanceTimersByWall = new Map()

function normalizeDisplayMode(displayMode) {
  return displayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH
    ? VIDEO_DISPLAY_MODE_SYNC_BATCH
    : VIDEO_DISPLAY_MODE_FIFO
}

function normalizeSeconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.max(0, Math.round(number * 100) / 100)
}

function normalizeMilliseconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.max(0, Math.round(number))
}

async function assignedProvisionedClients(wallId = DEFAULT_TICKER_WALL_ID) {
  return TickerClients.find(
    { wallId, slotIndex: { $ne: null } },
    { sort: { slotIndex: 1, lastSeenAt: -1 } },
  ).fetchAsync()
}

async function currentBatchClients(wallId = DEFAULT_TICKER_WALL_ID) {
  const clients = await assignedProvisionedClients(wallId)
  const clientsBySlot = new Map()

  for (const client of clients) {
    const slotIndex = Number(client?.slotIndex)
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= VIDEO_WALL_SLOT_COUNT) {
      continue
    }

    if (!clientsBySlot.has(slotIndex)) {
      clientsBySlot.set(slotIndex, client)
    }
  }

  return Array.from({ length: VIDEO_WALL_SLOT_COUNT }, (_, slotIndex) => clientsBySlot.get(slotIndex) ?? null)
}

function clearSyncBatchAdvanceTimer(wallId = DEFAULT_TICKER_WALL_ID) {
  const timerId = syncBatchAdvanceTimersByWall.get(wallId)
  if (timerId) {
    Meteor.clearTimeout(timerId)
    syncBatchAdvanceTimersByWall.delete(wallId)
  }
}

function scheduleNextSyncBatchLoad(wallId = DEFAULT_TICKER_WALL_ID) {
  clearSyncBatchAdvanceTimer(wallId)
  const timerId = Meteor.setTimeout(() => {
    syncBatchAdvanceTimersByWall.delete(wallId)
    startSyncBatchLoad(wallId).catch((error) => {
      console.error("[video] failed to auto-advance sync batch", { wallId, error })
    })
  }, VIDEO_BATCH_HOLD_FINISHED_MS)
  syncBatchAdvanceTimersByWall.set(wallId, timerId)
}

async function resetSyncBatchState(wallId = DEFAULT_TICKER_WALL_ID) {
  clearSyncBatchAdvanceTimer(wallId)

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchState: VIDEO_BATCH_STATE_IDLE,
        videoBatchToken: null,
        videoBatchStartedAtServerMs: null,
        videoBatchFinishedAtServerMs: null,
        updatedAt: new Date(),
      },
    },
  )

  await TickerClients.updateAsync(
    { wallId },
    {
      $unset: {
        videoReadyState: "",
        videoNetworkState: "",
        videoErrorCode: "",
        videoPlaybackState: "",
        videoBatchToken: "",
        videoClipDurationSec: "",
      },
      $set: {
        updatedAt: new Date(),
      },
    },
    { multi: true },
  )

  return { ok: true }
}

async function startSyncBatchLoad(wallId = DEFAULT_TICKER_WALL_ID) {
  clearSyncBatchAdvanceTimer(wallId)
  const batchToken = Random.id()
  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchToken: batchToken,
        videoBatchState: VIDEO_BATCH_STATE_LOADING,
        videoBatchStartedAtServerMs: null,
        videoBatchFinishedAtServerMs: null,
        updatedAt: new Date(),
      },
    },
  )

  await TickerClients.updateAsync(
    { wallId },
    {
      $unset: {
        videoReadyState: "",
        videoNetworkState: "",
        videoErrorCode: "",
        videoPlaybackState: "",
        videoBatchToken: "",
        videoClipDurationSec: "",
      },
      $set: {
        updatedAt: new Date(),
      },
    },
    { multi: true },
  )

  return batchToken
}

async function maybeStartSyncBatchPlayback(wallId = DEFAULT_TICKER_WALL_ID) {
  const wall = await TickerWalls.findOneAsync({ _id: wallId })
  if (!wall || wall.videoDisplayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH || wall.videoBatchState !== VIDEO_BATCH_STATE_LOADING || !wall.videoBatchToken) {
    return false
  }

  const clients = await currentBatchClients(wallId)
  if (clients.some((client) => !client)) {
    return false
  }

  const allReady = clients.every((client) =>
    client.videoBatchToken === wall.videoBatchToken
    && Number(client.videoReadyState) >= 4
    && client.videoPlaybackState === "ready")

  if (!allReady) {
    return false
  }

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchState: VIDEO_BATCH_STATE_PLAYING,
        videoBatchStartedAtServerMs: Date.now(),
        videoBatchFinishedAtServerMs: null,
        updatedAt: new Date(),
      },
    },
  )

  return true
}

async function maybeAdvanceSyncBatch(wallId = DEFAULT_TICKER_WALL_ID) {
  const wall = await TickerWalls.findOneAsync({ _id: wallId })
  if (!wall || wall.videoDisplayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH || wall.videoBatchState !== VIDEO_BATCH_STATE_PLAYING || !wall.videoBatchToken) {
    return false
  }

  const clients = await currentBatchClients(wallId)
  if (clients.some((client) => !client)) {
    return false
  }

  const allEnded = clients.every((client) =>
    client.videoBatchToken === wall.videoBatchToken
    && client.videoPlaybackState === "ended")

  if (!allEnded) {
    return false
  }

  if (wall.videoAutoAdvance === false) {
    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoBatchState: VIDEO_BATCH_STATE_FINISHED,
          videoBatchStartedAtServerMs: wall.videoBatchStartedAtServerMs ?? Date.now(),
          videoBatchFinishedAtServerMs: Date.now(),
          updatedAt: new Date(),
        },
      },
    )
    return true
  }

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchState: VIDEO_BATCH_STATE_FINISHED,
        videoBatchStartedAtServerMs: wall.videoBatchStartedAtServerMs ?? Date.now(),
        videoBatchFinishedAtServerMs: Date.now(),
        updatedAt: new Date(),
      },
    },
  )

  scheduleNextSyncBatchLoad(wallId)
  return true
}

async function ensureVideoWallFields(wallId = DEFAULT_TICKER_WALL_ID) {
  const wall = await TickerWalls.findOneAsync({ _id: wallId })
  if (!wall) {
    throw new Meteor.Error("video.wallMissing", "Ticker wall not found")
  }

  const patch = {}
  if (!wall.videoDisplayMode) {
    patch.videoDisplayMode = VIDEO_DISPLAY_MODE_FIFO
  }
  if (wall.videoShowDebug === undefined) {
    patch.videoShowDebug = true
  }
  if (wall.videoAutoAdvance === undefined) {
    patch.videoAutoAdvance = true
  }
  if (wall.videoTrimClips === undefined) {
    patch.videoTrimClips = false
  }
  if (wall.videoTrimStartOffsetSec === undefined) {
    patch.videoTrimStartOffsetSec = DEFAULT_VIDEO_TRIM_START_OFFSET_SEC
  }
  if (wall.videoTrimEndOffsetSec === undefined) {
    patch.videoTrimEndOffsetSec = DEFAULT_VIDEO_TRIM_END_OFFSET_SEC
  }
  if (wall.videoRevealDurationMs === undefined) {
    patch.videoRevealDurationMs = DEFAULT_VIDEO_REVEAL_DURATION_MS
  }
  if (wall.videoFadeOutDurationMs === undefined) {
    patch.videoFadeOutDurationMs = DEFAULT_VIDEO_FADE_OUT_DURATION_MS
  }
  if (wall.videoSyncBatchFadeOutDurationMs === undefined) {
    patch.videoSyncBatchFadeOutDurationMs = DEFAULT_VIDEO_SYNC_BATCH_FADE_OUT_DURATION_MS
  }
  if (wall.videoFadeOutLeadMs === undefined) {
    patch.videoFadeOutLeadMs = DEFAULT_VIDEO_FADE_OUT_LEAD_MS
  }
  if (!wall.videoBatchState) {
    patch.videoBatchState = VIDEO_BATCH_STATE_IDLE
  }
  if (wall.videoBatchToken === undefined) {
    patch.videoBatchToken = null
  }
  if (wall.videoBatchStartedAtServerMs === undefined) {
    patch.videoBatchStartedAtServerMs = null
  }
  if (wall.videoBatchFinishedAtServerMs === undefined) {
    patch.videoBatchFinishedAtServerMs = null
  }
  if (!wall.videoTag) {
    patch.videoTag = "kiss"
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date()
    await TickerWalls.updateAsync({ _id: wallId }, { $set: patch })
    return { ...wall, ...patch }
  }

  return wall
}

Meteor.methods({
  async "video.setTag"({ wallId = DEFAULT_TICKER_WALL_ID, tag } = {}) {
    const normalizedTag = ["kiss", "dance", "cry"].includes(tag) ? tag : "kiss"
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoTag: normalizedTag,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, tag: normalizedTag }
  },

  async "video.setAutoAdvance"({ wallId = DEFAULT_TICKER_WALL_ID, autoAdvance } = {}) {
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoAutoAdvance: Boolean(autoAdvance),
          updatedAt: new Date(),
        },
      },
    )

    if (Boolean(autoAdvance)) {
      const wall = await TickerWalls.findOneAsync({ _id: wallId })
      if (wall?.videoDisplayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH && wall.videoBatchState === VIDEO_BATCH_STATE_FINISHED) {
        scheduleNextSyncBatchLoad(wallId)
      } else {
        await maybeAdvanceSyncBatch(wallId)
      }
    }

    return { ok: true, autoAdvance: Boolean(autoAdvance) }
  },

  async "video.setShowDebug"({ wallId = DEFAULT_TICKER_WALL_ID, showDebug } = {}) {
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoShowDebug: Boolean(showDebug),
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, showDebug: Boolean(showDebug) }
  },

  async "video.setTrimClips"({ wallId = DEFAULT_TICKER_WALL_ID, trimClips } = {}) {
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoTrimClips: Boolean(trimClips),
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, trimClips: Boolean(trimClips) }
  },

  async "video.updatePlaybackTuning"({
    wallId = DEFAULT_TICKER_WALL_ID,
    trimStartOffsetSec,
    trimEndOffsetSec,
    revealDurationMs,
    fadeOutDurationMs,
    syncBatchFadeOutDurationMs,
    fadeOutLeadMs,
  } = {}) {
    await ensureVideoWallFields(wallId)

    const patch = {
      updatedAt: new Date(),
    }

    if (trimStartOffsetSec !== undefined) {
      patch.videoTrimStartOffsetSec = normalizeSeconds(trimStartOffsetSec, DEFAULT_VIDEO_TRIM_START_OFFSET_SEC)
    }
    if (trimEndOffsetSec !== undefined) {
      patch.videoTrimEndOffsetSec = normalizeSeconds(trimEndOffsetSec, DEFAULT_VIDEO_TRIM_END_OFFSET_SEC)
    }
    if (revealDurationMs !== undefined) {
      patch.videoRevealDurationMs = normalizeMilliseconds(revealDurationMs, DEFAULT_VIDEO_REVEAL_DURATION_MS)
    }
    if (fadeOutDurationMs !== undefined) {
      patch.videoFadeOutDurationMs = normalizeMilliseconds(fadeOutDurationMs, DEFAULT_VIDEO_FADE_OUT_DURATION_MS)
    }
    if (syncBatchFadeOutDurationMs !== undefined) {
      patch.videoSyncBatchFadeOutDurationMs = normalizeMilliseconds(syncBatchFadeOutDurationMs, DEFAULT_VIDEO_SYNC_BATCH_FADE_OUT_DURATION_MS)
    }
    if (fadeOutLeadMs !== undefined) {
      patch.videoFadeOutLeadMs = normalizeMilliseconds(fadeOutLeadMs, DEFAULT_VIDEO_FADE_OUT_LEAD_MS)
    }

    await TickerWalls.updateAsync({ _id: wallId }, { $set: patch })

    return { ok: true }
  },

  async "video.setDisplayMode"({ wallId = DEFAULT_TICKER_WALL_ID, displayMode } = {}) {
    const normalizedDisplayMode = normalizeDisplayMode(displayMode)
    await ensureVideoWallFields(wallId)
    if (normalizedDisplayMode === VIDEO_DISPLAY_MODE_FIFO) {
      await resetSyncBatchState(wallId)
    }

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoDisplayMode: normalizedDisplayMode,
          ...(normalizedDisplayMode === VIDEO_DISPLAY_MODE_FIFO
            ? {
              videoBatchState: VIDEO_BATCH_STATE_IDLE,
              videoBatchToken: null,
              videoBatchStartedAtServerMs: null,
              videoBatchFinishedAtServerMs: null,
            }
            : {}),
          updatedAt: new Date(),
        },
      },
    )

    if (normalizedDisplayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
      await startSyncBatchLoad(wallId)
    }

    return { ok: true, displayMode: normalizedDisplayMode }
  },

  async "video.resetBatchState"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    await ensureVideoWallFields(wallId)
    await resetSyncBatchState(wallId)
    return { ok: true, batchState: VIDEO_BATCH_STATE_IDLE }
  },

  async "video.startBatch"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    const wall = await ensureVideoWallFields(wallId)
    if (wall.videoDisplayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH) {
      throw new Meteor.Error("video.startBatch.invalidMode", "Batch start requires sync_batch display mode")
    }

    const batchToken = await startSyncBatchLoad(wallId)
    return { ok: true, batchState: VIDEO_BATCH_STATE_LOADING, batchToken }
  },

  async "video.panicStop"({ wallId = DEFAULT_TICKER_WALL_ID } = {}) {
    await ensureVideoWallFields(wallId)
    clearSyncBatchAdvanceTimer(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoAutoAdvance: false,
          updatedAt: new Date(),
        },
      },
    )

    await resetSyncBatchState(wallId)
    return { ok: true, batchState: VIDEO_BATCH_STATE_IDLE, autoAdvance: false }
  },

  async "video.reportClientMediaState"({
    wallId = DEFAULT_TICKER_WALL_ID,
    clientId,
    readyState,
    networkState,
    errorCode,
    playbackState,
    batchToken = null,
    durationSec = null,
  } = {}) {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new Meteor.Error("video.reportClientMediaState.invalidClientId", "clientId is required")
    }

    await ensureVideoWallFields(wallId)

    await TickerClients.updateAsync(
      { _id: clientId.trim(), wallId },
      {
        $set: {
          videoReadyState: Number(readyState) || 0,
          videoNetworkState: Number(networkState) || 0,
          videoErrorCode: Number(errorCode) || null,
          videoPlaybackState: playbackState || "unknown",
          videoBatchToken: batchToken || null,
          videoClipDurationSec: Number.isFinite(Number(durationSec)) ? Number(durationSec) : null,
          updatedAt: new Date(),
        },
      },
    )

    await maybeStartSyncBatchPlayback(wallId)
    await maybeAdvanceSyncBatch(wallId)

    return { ok: true }
  },
})
