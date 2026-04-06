import { Meteor } from "meteor/meteor"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import { DEFAULT_WALL_ID, WallClients } from "/imports/api/wall/collections"

const TELEVISION_STOP_FADE_MS = 900
const NGINX_MEDIA_ROOT = "/opt/homebrew/var/www"
const VIDEO_FILE_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm"])
const stopTimersByStateId = new Map()

function ensureTelevisionStateDoc(stateId = DEFAULT_TELEVISION_STATE_ID) {
  return TelevisionStates.upsertAsync(
    { _id: stateId },
    {
      $setOnInsert: {
        sourceUrl: "",
        playbackState: "idle",
        startedAtServerMs: null,
        stopRequestedAtServerMs: null,
        muted: true,
        loop: true,
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    },
  )
}

function clearStopTimer(stateId) {
  const timer = stopTimersByStateId.get(stateId)
  if (timer) {
    Meteor.clearTimeout(timer)
    stopTimersByStateId.delete(stateId)
  }
}

function detectLanIpAddress() {
  const interfaces = os.networkInterfaces()
  for (const interfaceEntries of Object.values(interfaces)) {
    for (const entry of interfaceEntries ?? []) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue
      }

      return entry.address
    }
  }

  return "127.0.0.1"
}

function nginxMediaBaseUrl() {
  const configured = process.env.TELEVISION_MEDIA_BASE_URL || Meteor.settings?.public?.televisionMediaBaseUrl
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim().replace(/\/+$/u, "")
  }

  return `http://${detectLanIpAddress()}:8080`
}

function listNginxVideoSources() {
  if (!fs.existsSync(NGINX_MEDIA_ROOT)) {
    return []
  }

  const baseUrl = nginxMediaBaseUrl()
  return fs.readdirSync(NGINX_MEDIA_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => VIDEO_FILE_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({
      label: name,
      fileName: name,
      sourceUrl: `${baseUrl}/${encodeURIComponent(name)}`,
    }))
}

Meteor.methods({
  "television.listLocalSources"() {
    return {
      baseUrl: nginxMediaBaseUrl(),
      rootDir: NGINX_MEDIA_ROOT,
      sources: listNginxVideoSources(),
    }
  },

  async "television.reportClientMediaState"({
    wallId = DEFAULT_WALL_ID,
    clientId,
    readyState = 0,
    networkState = 0,
    errorCode = null,
    playbackState = "unknown",
  } = {}) {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new Meteor.Error("television.reportClientMediaState.invalidClientId", "clientId is required")
    }

    await WallClients.updateAsync(
      { _id: clientId.trim(), wallId },
      {
        $set: {
          televisionReadyState: Number(readyState) || 0,
          televisionNetworkState: Number(networkState) || 0,
          televisionErrorCode: Number(errorCode) || null,
          televisionPlaybackState: typeof playbackState === "string" ? playbackState : "unknown",
          televisionStatusUpdatedAt: new Date(),
        },
      },
    )

    return { ok: true }
  },

  async "television.loadUrl"({
    stateId = DEFAULT_TELEVISION_STATE_ID,
    sourceUrl,
    muted = true,
    loop = true,
  } = {}) {
    if (typeof sourceUrl !== "string" || !sourceUrl.trim()) {
      throw new Meteor.Error("television.loadUrl.invalidSourceUrl", "sourceUrl is required")
    }

    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          sourceUrl: sourceUrl.trim(),
          playbackState: "loaded",
          startedAtServerMs: null,
          stopRequestedAtServerMs: null,
          muted: Boolean(muted),
          loop: Boolean(loop),
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId, sourceUrl: sourceUrl.trim(), playbackState: "loaded" }
  },

  async "television.playLoaded"({ stateId = DEFAULT_TELEVISION_STATE_ID } = {}) {
    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    const state = await TelevisionStates.findOneAsync({ _id: stateId })
    if (!state?.sourceUrl) {
      throw new Meteor.Error("television.playLoaded.noSource", "No source is loaded")
    }

    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "playing",
          startedAtServerMs: Date.now(),
          stopRequestedAtServerMs: null,
          updatedAt: new Date(),
        },
      },
    )

    return { ok: true, stateId, sourceUrl: state.sourceUrl, playbackState: "playing" }
  },

  async "television.playUrl"({
    stateId = DEFAULT_TELEVISION_STATE_ID,
    sourceUrl,
    muted = true,
    loop = true,
  } = {}) {
    await Meteor.callAsync("television.loadUrl", {
      stateId,
      sourceUrl,
      muted,
      loop,
    })
    return Meteor.callAsync("television.playLoaded", { stateId })
  },

  async "television.stop"({ stateId = DEFAULT_TELEVISION_STATE_ID } = {}) {
    clearStopTimer(stateId)
    await ensureTelevisionStateDoc(stateId)
    await TelevisionStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "stopping",
          stopRequestedAtServerMs: Date.now(),
          updatedAt: new Date(),
        },
      },
    )

    const timer = Meteor.setTimeout(async () => {
      stopTimersByStateId.delete(stateId)
      await TelevisionStates.updateAsync(
        { _id: stateId },
        {
          $set: {
            playbackState: "idle",
            startedAtServerMs: null,
            stopRequestedAtServerMs: null,
            updatedAt: new Date(),
          },
        },
      )
    }, TELEVISION_STOP_FADE_MS)
    stopTimersByStateId.set(stateId, timer)

    return { ok: true, stateId }
  },
})
