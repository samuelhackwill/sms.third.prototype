import { Meteor } from "meteor/meteor"

import { DEFAULT_WALL_ID, Walls } from "/imports/api/wall/collections"

const DEFAULT_DISCO_COLUMN_INTERVAL_MS = 500
const DEFAULT_DISCO_MODE = "column_wave"
const DISCO_ALLOWED_MODES = new Set(["column_wave"])

function normalizeMilliseconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.max(50, Math.round(number))
}

function normalizeMode(value) {
  return DISCO_ALLOWED_MODES.has(value) ? value : DEFAULT_DISCO_MODE
}

async function ensureDiscoFields(wallId = DEFAULT_WALL_ID) {
  const wall = await Walls.findOneAsync({ _id: wallId })
  if (!wall) {
    throw new Meteor.Error("disco.wallMissing", "Wall not found")
  }

  const patch = {}
  if (!wall.discoMode) {
    patch.discoMode = DEFAULT_DISCO_MODE
  }
  if (!Number.isFinite(Number(wall.discoColumnIntervalMs))) {
    patch.discoColumnIntervalMs = DEFAULT_DISCO_COLUMN_INTERVAL_MS
  }
  if (!Number.isFinite(Number(wall.discoStartedAtServerMs))) {
    patch.discoStartedAtServerMs = Date.now()
  }
  if (typeof wall.discoFadeToBlack !== "boolean") {
    patch.discoFadeToBlack = false
  }
  if (wall.discoPausedAtServerMs !== undefined && !Number.isFinite(Number(wall.discoPausedAtServerMs))) {
    patch.discoPausedAtServerMs = null
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date()
    await Walls.updateAsync({ _id: wallId }, { $set: patch })
    return { ...wall, ...patch }
  }

  return wall
}

Meteor.methods({
  async "disco.ensureState"({ wallId = DEFAULT_WALL_ID } = {}) {
    const wall = await ensureDiscoFields(wallId)
    return {
      ok: true,
      mode: normalizeMode(wall.discoMode),
      columnIntervalMs: Number(wall.discoColumnIntervalMs) || DEFAULT_DISCO_COLUMN_INTERVAL_MS,
      startedAtServerMs: Number(wall.discoStartedAtServerMs) || Date.now(),
      fadeToBlack: wall.discoFadeToBlack === true,
    }
  },

  async "disco.updateSettings"({
    wallId = DEFAULT_WALL_ID,
    columnIntervalMs,
    mode,
  } = {}) {
    await ensureDiscoFields(wallId)

    const patch = {
      updatedAt: new Date(),
    }

    if (columnIntervalMs !== undefined) {
      patch.discoColumnIntervalMs = normalizeMilliseconds(columnIntervalMs, DEFAULT_DISCO_COLUMN_INTERVAL_MS)
    }
    if (mode !== undefined) {
      patch.discoMode = normalizeMode(mode)
    }

    await Walls.updateAsync({ _id: wallId }, { $set: patch })
    const wall = await Walls.findOneAsync({ _id: wallId })

    return {
      ok: true,
      mode: normalizeMode(wall?.discoMode),
      columnIntervalMs: Number(wall?.discoColumnIntervalMs) || DEFAULT_DISCO_COLUMN_INTERVAL_MS,
      startedAtServerMs: Number(wall?.discoStartedAtServerMs) || Date.now(),
      fadeToBlack: wall?.discoFadeToBlack === true,
    }
  },

  async "disco.setFadeToBlack"({ wallId = DEFAULT_WALL_ID, fadeToBlack } = {}) {
    const wall = await ensureDiscoFields(wallId)
    const shouldFadeToBlack = fadeToBlack === true
    const patch = {
      discoFadeToBlack: shouldFadeToBlack,
      updatedAt: new Date(),
    }

    if (shouldFadeToBlack) {
      patch.discoPausedAtServerMs = Date.now()
    } else {
      const pausedAtServerMs = Number(wall.discoPausedAtServerMs)
      if (Number.isFinite(pausedAtServerMs)) {
        const startedAtServerMs = Number(wall.discoStartedAtServerMs) || Date.now()
        patch.discoStartedAtServerMs = startedAtServerMs + Math.max(0, Date.now() - pausedAtServerMs)
      }
      patch.discoPausedAtServerMs = null
    }

    await Walls.updateAsync(
      { _id: wallId },
      {
        $set: patch,
      },
    )

    return {
      ok: true,
      fadeToBlack: shouldFadeToBlack,
    }
  },

  async "disco.restart"({ wallId = DEFAULT_WALL_ID } = {}) {
    await ensureDiscoFields(wallId)
    const startedAtServerMs = Date.now()
    await Walls.updateAsync(
      { _id: wallId },
      {
        $set: {
          discoFadeToBlack: false,
          discoPausedAtServerMs: null,
          discoStartedAtServerMs: startedAtServerMs,
          updatedAt: new Date(),
        },
      },
    )

    return {
      ok: true,
      startedAtServerMs,
    }
  },
})
