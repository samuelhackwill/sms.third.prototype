import { Meteor } from "meteor/meteor"

import { DEFAULT_KISS_O_MATIC_STATE_ID, KissOMaticStates } from "/imports/api/kissOMatic/collections"
import { resolveClipData } from "/imports/api/video/clipPayload"
import { DEFAULT_WALL_ID, WallClients } from "/imports/api/wall/collections"

const DEFAULT_VIDEO_ENDPOINT_URL = "https://sms-clips.samuel.ovh/api/random-clips"
const DEFAULT_KISS_O_MATIC_TAG = "kiss"
const KISS_O_MATIC_STOP_FADE_MS = 900
const KISS_O_MATIC_ADVANCE_DELAY_MS = 150
const KISS_O_MATIC_MAX_FETCH_ATTEMPTS = 5

const advanceTimersByStateId = new Map()

function clearAdvanceTimer(stateId) {
  const timerId = advanceTimersByStateId.get(stateId)
  if (timerId) {
    Meteor.clearTimeout(timerId)
    advanceTimersByStateId.delete(stateId)
  }
}

async function ensureKissOMaticStateDoc(stateId = DEFAULT_KISS_O_MATIC_STATE_ID) {
  await KissOMaticStates.upsertAsync(
    { _id: stateId },
    {
      $setOnInsert: {
        sourceUrl: "",
        playbackState: "idle",
        startedAtServerMs: null,
        stopRequestedAtServerMs: null,
        muted: true,
        trimStartSec: null,
        trimEndSec: null,
        clipDurationSec: null,
        clipTag: DEFAULT_KISS_O_MATIC_TAG,
        endpointUrl: "",
        autoAdvance: true,
        lastPayload: null,
        lastError: "",
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    },
  )
}

function configuredEndpoint() {
  const configured = Meteor.settings?.public?.kissOMaticEndpointUrl
    ?? Meteor.settings?.public?.videoEndpointUrl
    ?? process.env.KISS_O_MATIC_ENDPOINT_URL
    ?? process.env.VIDEO_ENDPOINT_URL
    ?? DEFAULT_VIDEO_ENDPOINT_URL

  return typeof configured === "string" ? configured.trim() : DEFAULT_VIDEO_ENDPOINT_URL
}

function endpointWithTag() {
  const endpoint = configuredEndpoint()

  try {
    const url = new URL(endpoint)
    url.searchParams.set("tag", DEFAULT_KISS_O_MATIC_TAG)
    return url.toString()
  } catch (error) {
    const separator = endpoint.includes("?") ? "&" : "?"
    return `${endpoint}${separator}tag=${encodeURIComponent(DEFAULT_KISS_O_MATIC_TAG)}`
  }
}

async function fetchJsonOrText(endpoint) {
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Meteor.Error("kissOMatic.fetchFailed", `Endpoint returned ${response.status}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  if (contentType.includes("text/html")) {
    throw new Meteor.Error("kissOMatic.invalidPayload", "Endpoint returned HTML instead of JSON")
  }

  if (contentType.includes("application/json")) {
    return response.json()
  }

  return response.text()
}

function summarizePayload(payload) {
  if (typeof payload === "string") {
    return payload.slice(0, 400)
  }

  try {
    return JSON.stringify(payload).slice(0, 400)
  } catch (error) {
    return "[unserializable payload]"
  }
}

async function fetchPlayableClip() {
  const endpointUrl = endpointWithTag()
  let lastError = null

  for (let attempt = 1; attempt <= KISS_O_MATIC_MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const payload = await fetchJsonOrText(endpointUrl)
      const { clipUrl, trimWindow } = resolveClipData(payload, endpointUrl)
      const trimStartSec = Number(trimWindow?.kissStartSec)
      const trimEndSec = Number(trimWindow?.kissEndSec)

      if (!clipUrl) {
        throw new Meteor.Error("kissOMatic.invalidPayload", "No clip URL found in clips API response")
      }
      if (!Number.isFinite(trimStartSec) || !Number.isFinite(trimEndSec) || trimEndSec <= trimStartSec) {
        throw new Meteor.Error("kissOMatic.invalidTrimWindow", "Clips API response did not include a valid kiss trim window")
      }

      return {
        endpointUrl,
        payload,
        clipUrl,
        trimStartSec,
        trimEndSec,
        clipDurationSec: Math.max(0, trimEndSec - trimStartSec),
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Meteor.Error("kissOMatic.fetchFailed", "Failed to fetch a playable kiss clip")
}

function scheduleAutoAdvance(stateId, durationMs) {
  clearAdvanceTimer(stateId)
  const timerId = Meteor.setTimeout(() => {
    advanceTimersByStateId.delete(stateId)
    Meteor.callAsync("kissOMatic.fetchNextClipAndPlay", { stateId })
      .catch((error) => {
        console.error("[kiss-o-matic] failed to auto-advance", { stateId, error })
      })
  }, Math.max(0, durationMs))
  advanceTimersByStateId.set(stateId, timerId)
}

async function playFetchedClip(stateId = DEFAULT_KISS_O_MATIC_STATE_ID) {
  await ensureKissOMaticStateDoc(stateId)
  clearAdvanceTimer(stateId)

  await KissOMaticStates.updateAsync(
    { _id: stateId },
    {
      $set: {
        playbackState: "loading",
        lastError: "",
        updatedAt: new Date(),
      },
    },
  )

  const clip = await fetchPlayableClip()
  await KissOMaticStates.updateAsync(
    { _id: stateId },
    {
      $set: {
        sourceUrl: clip.clipUrl,
        playbackState: "playing",
        startedAtServerMs: Date.now(),
        stopRequestedAtServerMs: null,
        muted: true,
        trimStartSec: clip.trimStartSec,
        trimEndSec: clip.trimEndSec,
        clipDurationSec: clip.clipDurationSec,
        clipTag: DEFAULT_KISS_O_MATIC_TAG,
        endpointUrl: clip.endpointUrl,
        lastPayload: summarizePayload(clip.payload),
        lastError: "",
        updatedAt: new Date(),
      },
    },
  )

  const state = await KissOMaticStates.findOneAsync({ _id: stateId })
  if (state?.autoAdvance !== false) {
    scheduleAutoAdvance(
      stateId,
      Math.ceil((clip.clipDurationSec * 1000) + KISS_O_MATIC_ADVANCE_DELAY_MS),
    )
  }

  return {
    ok: true,
    stateId,
    sourceUrl: clip.clipUrl,
    trimStartSec: clip.trimStartSec,
    trimEndSec: clip.trimEndSec,
    clipDurationSec: clip.clipDurationSec,
    playbackState: "playing",
  }
}

Meteor.methods({
  async "kissOMatic.reportClientMediaState"({
    wallId = DEFAULT_WALL_ID,
    clientId,
    readyState = 0,
    networkState = 0,
    errorCode = null,
    playbackState = "unknown",
  } = {}) {
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new Meteor.Error("kissOMatic.reportClientMediaState.invalidClientId", "clientId is required")
    }

    await WallClients.updateAsync(
      { _id: clientId.trim(), wallId },
      {
        $set: {
          kissOMaticReadyState: Number(readyState) || 0,
          kissOMaticNetworkState: Number(networkState) || 0,
          kissOMaticErrorCode: Number(errorCode) || null,
          kissOMaticPlaybackState: typeof playbackState === "string" ? playbackState : "unknown",
          kissOMaticStatusUpdatedAt: new Date(),
        },
      },
    )

    return { ok: true }
  },

  async "kissOMatic.fetchNextClipAndPlay"({ stateId = DEFAULT_KISS_O_MATIC_STATE_ID } = {}) {
    try {
      return await playFetchedClip(stateId)
    } catch (error) {
      await ensureKissOMaticStateDoc(stateId)
      await KissOMaticStates.updateAsync(
        { _id: stateId },
        {
          $set: {
            playbackState: "error",
            lastError: error?.reason || error?.message || String(error),
            updatedAt: new Date(),
          },
        },
      )
      throw error
    }
  },

  async "kissOMatic.setAutoAdvance"({
    stateId = DEFAULT_KISS_O_MATIC_STATE_ID,
    autoAdvance,
  } = {}) {
    await ensureKissOMaticStateDoc(stateId)
    const nextValue = Boolean(autoAdvance)
    await KissOMaticStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          autoAdvance: nextValue,
          updatedAt: new Date(),
        },
      },
    )

    if (!nextValue) {
      clearAdvanceTimer(stateId)
      return { ok: true, autoAdvance: nextValue }
    }

    const state = await KissOMaticStates.findOneAsync({ _id: stateId })
    if (state?.playbackState === "playing" && Number.isFinite(state?.startedAtServerMs) && Number.isFinite(state?.clipDurationSec)) {
      const elapsedMs = Date.now() - Number(state.startedAtServerMs)
      const remainingMs = (Number(state.clipDurationSec) * 1000) - elapsedMs + KISS_O_MATIC_ADVANCE_DELAY_MS
      scheduleAutoAdvance(stateId, remainingMs)
    }

    return { ok: true, autoAdvance: nextValue }
  },

  async "kissOMatic.stop"({ stateId = DEFAULT_KISS_O_MATIC_STATE_ID } = {}) {
    clearAdvanceTimer(stateId)
    await ensureKissOMaticStateDoc(stateId)
    await KissOMaticStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          playbackState: "stopping",
          stopRequestedAtServerMs: Date.now(),
          updatedAt: new Date(),
        },
      },
    )

    Meteor.setTimeout(async () => {
      const state = await KissOMaticStates.findOneAsync({ _id: stateId })
      if (state?.playbackState !== "stopping") {
        return
      }

      await KissOMaticStates.updateAsync(
        { _id: stateId },
        {
          $set: {
            sourceUrl: "",
            playbackState: "idle",
            startedAtServerMs: null,
            stopRequestedAtServerMs: null,
            trimStartSec: null,
            trimEndSec: null,
            clipDurationSec: null,
            updatedAt: new Date(),
          },
        },
      )
    }, KISS_O_MATIC_STOP_FADE_MS)

    return { ok: true, stateId }
  },
})
