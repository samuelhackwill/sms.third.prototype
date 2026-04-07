import { Meteor } from "meteor/meteor"

import { VIDEO_DISPLAY_MODE_FIFO, VIDEO_DISPLAY_MODE_SYNC_BATCH } from "/imports/api/video/constants"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"

function normalizeDisplayMode(displayMode) {
  return displayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH
    ? VIDEO_DISPLAY_MODE_SYNC_BATCH
    : VIDEO_DISPLAY_MODE_FIFO
}

const VIDEO_CLIENT_STALE_AFTER_MS = 30 * 1000

function isActiveClient(client) {
  const lastSeenAtMs = new Date(client?.lastSeenAt).getTime()
  if (!Number.isFinite(lastSeenAtMs)) {
    return false
  }

  return (Date.now() - lastSeenAtMs) <= VIDEO_CLIENT_STALE_AFTER_MS
}

async function activeProvisionedClients(wallId = DEFAULT_TICKER_WALL_ID) {
  const clients = await TickerClients.find(
    { wallId, slotIndex: { $ne: null } },
    { sort: { slotIndex: 1, lastSeenAt: -1 } },
  ).fetchAsync()

  return clients.filter(isActiveClient)
}

async function startSyncBatchLoad(wallId = DEFAULT_TICKER_WALL_ID) {
  const batchToken = Random.id()
  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchToken: batchToken,
        videoBatchState: "loading",
        videoBatchStartedAtServerMs: null,
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
  if (!wall || wall.videoDisplayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH || wall.videoBatchState !== "loading" || !wall.videoBatchToken) {
    return false
  }

  const clients = await activeProvisionedClients(wallId)
  if (clients.length === 0) {
    return false
  }

  const allReady = clients.every((client) =>
    client.videoBatchToken === wall.videoBatchToken
    && Number(client.videoReadyState) >= 4
    && client.videoPlaybackState === "loaded")

  if (!allReady) {
    return false
  }

  await TickerWalls.updateAsync(
    { _id: wallId },
    {
      $set: {
        videoBatchState: "playing",
        videoBatchStartedAtServerMs: Date.now(),
        updatedAt: new Date(),
      },
    },
  )

  return true
}

async function maybeAdvanceSyncBatch(wallId = DEFAULT_TICKER_WALL_ID) {
  const wall = await TickerWalls.findOneAsync({ _id: wallId })
  if (!wall || wall.videoDisplayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH || wall.videoBatchState !== "playing" || !wall.videoBatchToken) {
    return false
  }

  const clients = await activeProvisionedClients(wallId)
  if (clients.length === 0) {
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
          videoBatchState: "idle",
          updatedAt: new Date(),
        },
      },
    )
    return true
  }

  await startSyncBatchLoad(wallId)
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
  if (!wall.videoBatchState) {
    patch.videoBatchState = "idle"
  }
  if (wall.videoBatchToken === undefined) {
    patch.videoBatchToken = null
  }
  if (wall.videoBatchStartedAtServerMs === undefined) {
    patch.videoBatchStartedAtServerMs = null
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
      await maybeAdvanceSyncBatch(wallId)
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

  async "video.setDisplayMode"({ wallId = DEFAULT_TICKER_WALL_ID, displayMode } = {}) {
    const normalizedDisplayMode = normalizeDisplayMode(displayMode)
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoDisplayMode: normalizedDisplayMode,
          ...(normalizedDisplayMode === VIDEO_DISPLAY_MODE_FIFO
            ? {
              videoBatchState: "idle",
              videoBatchToken: null,
              videoBatchStartedAtServerMs: null,
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
