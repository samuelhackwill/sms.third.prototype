import { Meteor } from "meteor/meteor"

import { VIDEO_DISPLAY_MODE_DIAGONAL, VIDEO_DISPLAY_MODE_FIFO } from "/imports/api/video/constants"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"

const VIDEO_REVEAL_STEP_MS = 120
const VIDEO_SYNC_START_DELAY_MS = 500
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000

function normalizeDisplayMode(displayMode) {
  return displayMode === VIDEO_DISPLAY_MODE_DIAGONAL
    ? VIDEO_DISPLAY_MODE_DIAGONAL
    : VIDEO_DISPLAY_MODE_FIFO
}

function isActiveClient(client, nowMs = Date.now()) {
  const lastSeenAtMs = new Date(client?.lastSeenAt).getTime()
  if (!Number.isFinite(lastSeenAtMs)) {
    return false
  }

  return (nowMs - lastSeenAtMs) <= TICKER_CLIENT_STALE_AFTER_MS
}

function groupedVideoClients(clients) {
  const explicitlyAssignedClients = clients.filter((client) => Number.isInteger(client.slotIndex) && client.slotIndex >= 0)
  return explicitlyAssignedClients.length > 0 ? explicitlyAssignedClients : clients
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
  if (wall.videoRevealPlan === undefined) {
    patch.videoRevealPlan = null
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date()
    await TickerWalls.updateAsync({ _id: wallId }, { $set: patch })
    return { ...wall, ...patch }
  }

  return wall
}

Meteor.methods({
  async "video.setDisplayMode"({ wallId = DEFAULT_TICKER_WALL_ID, displayMode } = {}) {
    const normalizedDisplayMode = normalizeDisplayMode(displayMode)
    await ensureVideoWallFields(wallId)

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoDisplayMode: normalizedDisplayMode,
          videoRevealPlan: null,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, displayMode: normalizedDisplayMode }
  },

  async "video.markClientReady"({ wallId = DEFAULT_TICKER_WALL_ID, clientId } = {}) {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new Meteor.Error("video.invalidClientId", "clientId is required")
    }

    const normalizedClientId = clientId.trim()
    const wall = await ensureVideoWallFields(wallId)
    const displayMode = normalizeDisplayMode(wall.videoDisplayMode)

    if (displayMode !== VIDEO_DISPLAY_MODE_DIAGONAL) {
      return {
        ok: true,
        displayMode,
        revealPlan: null,
      }
    }

    const nowMs = Date.now()
    const clients = await TickerClients.find({ wallId }, { sort: { slotIndex: 1, orderIndex: 1, lastSeenAt: 1 } }).fetchAsync()
    const expectedClientIds = groupedVideoClients(clients)
      .filter((client) => isActiveClient(client, nowMs))
      .map((client) => client._id)

    const currentPlan = wall.videoRevealPlan
    const shouldResetPlan = !currentPlan
      || currentPlan.displayMode !== VIDEO_DISPLAY_MODE_DIAGONAL
      || (Number.isFinite(Number(currentPlan.revealStartServerMs)) && Number(currentPlan.revealStartServerMs) < (nowMs - 5000))

    const nextPlan = shouldResetPlan
      ? {
          generation: Number(currentPlan?.generation || 0) + 1,
          displayMode: VIDEO_DISPLAY_MODE_DIAGONAL,
          readyClientIds: [normalizedClientId],
          expectedClientIds,
          revealStartServerMs: null,
          updatedAtServerMs: nowMs,
        }
      : {
          ...currentPlan,
          displayMode: VIDEO_DISPLAY_MODE_DIAGONAL,
          expectedClientIds,
          readyClientIds: Array.from(new Set([...(currentPlan.readyClientIds || []), normalizedClientId])),
          updatedAtServerMs: nowMs,
        }

    const allReady = nextPlan.expectedClientIds.length > 0
      && nextPlan.expectedClientIds.every((id) => nextPlan.readyClientIds.includes(id))

    if (allReady && !Number.isFinite(Number(nextPlan.revealStartServerMs))) {
      nextPlan.revealStartServerMs = nowMs + VIDEO_SYNC_START_DELAY_MS
      nextPlan.revealStepMs = VIDEO_REVEAL_STEP_MS
    }

    await TickerWalls.updateAsync(
      { _id: wallId },
      {
        $set: {
          videoRevealPlan: nextPlan,
          updatedAt: new Date(),
        },
      },
    )

    return {
      ok: true,
      displayMode,
      revealPlan: nextPlan,
    }
  },
})
