import { Meteor } from "meteor/meteor"

import { VIDEO_DISPLAY_MODE_FIFO } from "/imports/api/video/constants"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerWalls,
} from "/imports/api/ticker/collections"

function normalizeDisplayMode(displayMode) {
  return VIDEO_DISPLAY_MODE_FIFO
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

  async "video.setDisplayMode"({ wallId = DEFAULT_TICKER_WALL_ID, displayMode } = {}) {
    const normalizedDisplayMode = normalizeDisplayMode(displayMode)
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoDisplayMode: normalizedDisplayMode,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, displayMode: normalizedDisplayMode }
  },
})
