import { Meteor } from "meteor/meteor"
import { Random } from "meteor/random"

import { DEFAULT_KISS_O_MATIC_STATE_ID, KissOMaticStates } from "/imports/api/kissOMatic/collections"
import { resolveClipData } from "/imports/api/video/clipPayload"
import { DEFAULT_WALL_ID, WallClients } from "/imports/api/wall/collections"

const DEFAULT_VIDEO_ENDPOINT_URL = "https://sms-clips.samuel.ovh/api/random-clips"
const DEFAULT_KISS_O_MATIC_TAG = "kiss"
const KISS_O_MATIC_STOP_FADE_MS = 900
const KISS_O_MATIC_ADVANCE_DELAY_MS = 150
const KISS_O_MATIC_MAX_FETCH_ATTEMPTS = 5
const DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC = 1
const DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC = 1

const advanceTimersByStateId = new Map()
const KISS_O_MATIC_ALLOWED_TAGS = new Set(["kiss", "dance", "phone", "cry"])

function clearAdvanceTimer(stateId) {
  const timerId = advanceTimersByStateId.get(stateId)
  if (timerId) {
    Meteor.clearTimeout(timerId)
    advanceTimersByStateId.delete(stateId)
  }
}

function normalizeTag(tag) {
  return KISS_O_MATIC_ALLOWED_TAGS.has(tag) ? tag : DEFAULT_KISS_O_MATIC_TAG
}

async function ensureKissOMaticStateDoc(stateId = DEFAULT_KISS_O_MATIC_STATE_ID) {
  await KissOMaticStates.upsertAsync(
    { _id: stateId },
    {
      $setOnInsert: {
        sourceUrl: "",
        playbackState: "idle",
        startedAtServerMs: null,
        switchAtServerMs: null,
        stopRequestedAtServerMs: null,
        muted: true,
        trimStartSec: null,
        trimEndSec: null,
        clipDurationSec: null,
        trimStartOffsetSec: DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC,
        trimEndOffsetSec: DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC,
        clipTag: DEFAULT_KISS_O_MATIC_TAG,
        endpointUrl: "",
        autoAdvance: true,
        currentClip: null,
        nextClip: null,
        lastPayload: null,
        lastError: "",
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    },
  )
}

function normalizeSeconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return fallback
  }

  return Math.max(0, Math.round(number * 100) / 100)
}

function effectivePlaybackWindow({
  trimStartSec,
  trimEndSec,
  trimStartOffsetSec = DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC,
  trimEndOffsetSec = DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC,
}) {
  const rawTrimStartSec = Number(trimStartSec)
  const rawTrimEndSec = Number(trimEndSec)
  const startOffsetSec = Number(trimStartOffsetSec)
  const endOffsetSec = Number(trimEndOffsetSec)

  if (!Number.isFinite(rawTrimStartSec) || !Number.isFinite(rawTrimEndSec) || rawTrimEndSec <= rawTrimStartSec) {
    return null
  }

  const effectiveStartSec = Math.max(
    0,
    rawTrimStartSec - (Number.isFinite(startOffsetSec) ? startOffsetSec : DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC),
  )
  const effectiveEndSec = rawTrimEndSec + (
    Number.isFinite(endOffsetSec) ? endOffsetSec : DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC
  )

  if (!Number.isFinite(effectiveEndSec) || effectiveEndSec <= effectiveStartSec) {
    return null
  }

  return {
    startSec: effectiveStartSec,
    endSec: effectiveEndSec,
    durationSec: Math.max(0, effectiveEndSec - effectiveStartSec),
  }
}

function configuredEndpoint() {
  const configured = Meteor.settings?.public?.kissOMaticEndpointUrl
    ?? Meteor.settings?.public?.videoEndpointUrl
    ?? process.env.KISS_O_MATIC_ENDPOINT_URL
    ?? process.env.VIDEO_ENDPOINT_URL
    ?? DEFAULT_VIDEO_ENDPOINT_URL

  return typeof configured === "string" ? configured.trim() : DEFAULT_VIDEO_ENDPOINT_URL
}

function endpointWithTag(tag = DEFAULT_KISS_O_MATIC_TAG) {
  const endpoint = configuredEndpoint()
  const normalizedTag = normalizeTag(tag)

  try {
    const url = new URL(endpoint)
    url.searchParams.set("tag", normalizedTag)
    return url.toString()
  } catch (error) {
    const separator = endpoint.includes("?") ? "&" : "?"
    return `${endpoint}${separator}tag=${encodeURIComponent(normalizedTag)}`
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

async function fetchPlayableClip(tag = DEFAULT_KISS_O_MATIC_TAG) {
  const endpointUrl = endpointWithTag(tag)
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
      const hasValidTrimWindow = Number.isFinite(trimStartSec) && Number.isFinite(trimEndSec) && trimEndSec > trimStartSec
      if (trimWindow && !hasValidTrimWindow) {
        throw new Meteor.Error("kissOMatic.invalidTrimWindow", "Clips API response did not include a valid kiss trim window")
      }

      return {
        endpointUrl,
        payload,
        clipUrl,
        trimStartSec: hasValidTrimWindow ? trimStartSec : null,
        trimEndSec: hasValidTrimWindow ? trimEndSec : null,
      }
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Meteor.Error("kissOMatic.fetchFailed", "Failed to fetch a playable kiss clip")
}

function clipFromFetchResult(rawClip, state) {
  const playbackWindow = Number.isFinite(Number(rawClip.trimStartSec)) && Number.isFinite(Number(rawClip.trimEndSec))
    ? effectivePlaybackWindow({
      trimStartSec: rawClip.trimStartSec,
      trimEndSec: rawClip.trimEndSec,
      trimStartOffsetSec: state?.trimStartOffsetSec,
      trimEndOffsetSec: state?.trimEndOffsetSec,
    })
    : null

  if ((rawClip.trimStartSec !== null || rawClip.trimEndSec !== null) && !playbackWindow) {
    throw new Meteor.Error("kissOMatic.invalidTrimWindow", "Computed playback window is invalid")
  }

  return {
    token: Random.id(),
    sourceUrl: rawClip.clipUrl,
    trimStartSec: rawClip.trimStartSec,
    trimEndSec: rawClip.trimEndSec,
    clipDurationSec: playbackWindow?.durationSec ?? null,
  }
}

function rootClipPatch(currentClip) {
  return {
    sourceUrl: currentClip?.sourceUrl ?? "",
    trimStartSec: currentClip?.trimStartSec ?? null,
    trimEndSec: currentClip?.trimEndSec ?? null,
    clipDurationSec: currentClip?.clipDurationSec ?? null,
  }
}

async function applyClipState(stateId, {
  playbackState,
  startedAtServerMs,
  currentClip,
  nextClip,
  endpointUrl = "",
  payloadSummary = null,
  lastError = "",
}) {
  const switchAtServerMs = currentClip && Number.isFinite(currentClip?.clipDurationSec)
    ? Math.round(startedAtServerMs + (Number(currentClip.clipDurationSec) * 1000))
    : null

  await KissOMaticStates.updateAsync(
    { _id: stateId },
    {
      $set: {
        playbackState,
        startedAtServerMs,
        switchAtServerMs,
        stopRequestedAtServerMs: null,
        currentClip: currentClip ?? null,
        nextClip: nextClip ?? null,
        endpointUrl,
        lastPayload: payloadSummary,
        lastError,
        muted: true,
        updatedAt: new Date(),
        ...rootClipPatch(currentClip),
      },
    },
  )
}

function scheduleAdvance(stateId, delayMs) {
  clearAdvanceTimer(stateId)
  const timerId = Meteor.setTimeout(() => {
    advanceTimersByStateId.delete(stateId)
    Meteor.callAsync("kissOMatic.advancePlaylist", { stateId }).catch((error) => {
      console.error("[kiss-o-matic] failed to advance playlist", { stateId, error })
    })
  }, Math.max(0, delayMs))
  advanceTimersByStateId.set(stateId, timerId)
}

async function scheduleAdvanceFromState(stateId) {
  const state = await KissOMaticStates.findOneAsync({ _id: stateId })
  if (!state || state.autoAdvance === false || state.playbackState !== "playing" || !Number.isFinite(state.switchAtServerMs)) {
    clearAdvanceTimer(stateId)
    return
  }

  const remainingMs = Number(state.switchAtServerMs) - Date.now() + KISS_O_MATIC_ADVANCE_DELAY_MS
  scheduleAdvance(stateId, remainingMs)
}

async function buildNextClip(state) {
  const fetchedClip = await fetchPlayableClip(state?.clipTag)
  const clip = clipFromFetchResult(fetchedClip, state)
  return {
    clip,
    endpointUrl: fetchedClip.endpointUrl,
    payloadSummary: summarizePayload(fetchedClip.payload),
  }
}

async function refreshClipDurations(stateId) {
  const state = await KissOMaticStates.findOneAsync({ _id: stateId })
  if (!state) {
    return null
  }

  const updateClip = (clip) => {
    if (!clip) {
      return null
    }

    const playbackWindow = effectivePlaybackWindow({
      trimStartSec: clip.trimStartSec,
      trimEndSec: clip.trimEndSec,
      trimStartOffsetSec: state.trimStartOffsetSec,
      trimEndOffsetSec: state.trimEndOffsetSec,
    })

    if (!Number.isFinite(Number(clip?.trimStartSec)) || !Number.isFinite(Number(clip?.trimEndSec))) {
      return {
        ...clip,
        clipDurationSec: null,
      }
    }

    if (!playbackWindow) {
      return clip
    }

    return {
      ...clip,
      clipDurationSec: playbackWindow.durationSec,
    }
  }

  const currentClip = updateClip(state.currentClip)
  const nextClip = updateClip(state.nextClip)
  const patch = {
    currentClip,
    nextClip,
    updatedAt: new Date(),
    ...rootClipPatch(currentClip),
  }

  if (Number.isFinite(state.startedAtServerMs) && currentClip) {
    patch.switchAtServerMs = Math.round(Number(state.startedAtServerMs) + (Number(currentClip.clipDurationSec) * 1000))
    patch.clipDurationSec = currentClip.clipDurationSec
  }

  await KissOMaticStates.updateAsync({ _id: stateId }, { $set: patch })
  return KissOMaticStates.findOneAsync({ _id: stateId })
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
    clearAdvanceTimer(stateId)
    await ensureKissOMaticStateDoc(stateId)
    const state = await KissOMaticStates.findOneAsync({ _id: stateId })

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

    try {
      const [currentResult, nextResult] = await Promise.all([
        buildNextClip(state),
        buildNextClip(state),
      ])
      const startedAtServerMs = Date.now()
      await applyClipState(stateId, {
        playbackState: "playing",
        startedAtServerMs,
        currentClip: currentResult.clip,
        nextClip: nextResult.clip,
        endpointUrl: nextResult.endpointUrl || currentResult.endpointUrl,
        payloadSummary: nextResult.payloadSummary || currentResult.payloadSummary,
      })
      await scheduleAdvanceFromState(stateId)

      return {
        ok: true,
        stateId,
        playbackState: "playing",
        currentClip: currentResult.clip,
        nextClip: nextResult.clip,
      }
    } catch (error) {
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

  async "kissOMatic.advancePlaylist"({ stateId = DEFAULT_KISS_O_MATIC_STATE_ID } = {}) {
    clearAdvanceTimer(stateId)
    await ensureKissOMaticStateDoc(stateId)
    const state = await KissOMaticStates.findOneAsync({ _id: stateId })
    if (!state?.currentClip) {
      return Meteor.callAsync("kissOMatic.fetchNextClipAndPlay", { stateId })
    }

    try {
      const nextCurrentClip = state.nextClip ?? (await buildNextClip(state)).clip
      const nextResult = await buildNextClip(state)
      const startedAtServerMs = Date.now()

      await applyClipState(stateId, {
        playbackState: "playing",
        startedAtServerMs,
        currentClip: nextCurrentClip,
        nextClip: nextResult.clip,
        endpointUrl: nextResult.endpointUrl || state.endpointUrl,
        payloadSummary: nextResult.payloadSummary || state.lastPayload,
      })
      await scheduleAdvanceFromState(stateId)

      return {
        ok: true,
        stateId,
        playbackState: "playing",
        currentClip: nextCurrentClip,
        nextClip: nextResult.clip,
      }
    } catch (error) {
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

  async "kissOMatic.advancePlaylistIfCurrent"({
    stateId = DEFAULT_KISS_O_MATIC_STATE_ID,
    currentClipToken,
  } = {}) {
    await ensureKissOMaticStateDoc(stateId)
    const state = await KissOMaticStates.findOneAsync({ _id: stateId })
    if (!state?.currentClip?.token || state.currentClip.token !== currentClipToken) {
      return { ok: true, skipped: true }
    }

    return Meteor.callAsync("kissOMatic.advancePlaylist", { stateId })
  },

  async "kissOMatic.updatePlaybackTuning"({
    stateId = DEFAULT_KISS_O_MATIC_STATE_ID,
    trimStartOffsetSec,
    trimEndOffsetSec,
  } = {}) {
    await ensureKissOMaticStateDoc(stateId)

    const patch = {
      updatedAt: new Date(),
    }

    if (trimStartOffsetSec !== undefined) {
      patch.trimStartOffsetSec = normalizeSeconds(trimStartOffsetSec, DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC)
    }
    if (trimEndOffsetSec !== undefined) {
      patch.trimEndOffsetSec = normalizeSeconds(trimEndOffsetSec, DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC)
    }

    await KissOMaticStates.updateAsync({ _id: stateId }, { $set: patch })
    const refreshedState = await refreshClipDurations(stateId)
    await scheduleAdvanceFromState(stateId)

    return {
      ok: true,
      trimStartOffsetSec: refreshedState?.trimStartOffsetSec ?? DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC,
      trimEndOffsetSec: refreshedState?.trimEndOffsetSec ?? DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC,
      clipDurationSec: refreshedState?.clipDurationSec ?? null,
    }
  },

  async "kissOMatic.setTag"({
    stateId = DEFAULT_KISS_O_MATIC_STATE_ID,
    tag,
  } = {}) {
    await ensureKissOMaticStateDoc(stateId)
    const normalizedTag = normalizeTag(tag)

    await KissOMaticStates.updateAsync(
      { _id: stateId },
      {
        $set: {
          clipTag: normalizedTag,
          updatedAt: new Date(),
        },
      },
    )

    return {
      ok: true,
      tag: normalizedTag,
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

    await scheduleAdvanceFromState(stateId)
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
            switchAtServerMs: null,
            stopRequestedAtServerMs: null,
            trimStartSec: null,
            trimEndSec: null,
            clipDurationSec: null,
            currentClip: null,
            nextClip: null,
            updatedAt: new Date(),
          },
        },
      )
    }, KISS_O_MATIC_STOP_FADE_MS)

    return { ok: true, stateId }
  },
})
