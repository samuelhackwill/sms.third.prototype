import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerWalls,
} from "/imports/api/ticker/collections"
import "/imports/api/ticker/publications"
import { VIDEO_DISPLAY_MODE_FIFO, VIDEO_DISPLAY_MODE_SYNC_BATCH } from "/imports/api/video/constants"
import { streamer } from "/imports/both/streamer"
import { getOrCreateClientId, getOrCreateDeviceKey, toShortCode } from "/imports/ui/lib/wallClientIdentity"
import { VIDEO_DEBUG_CONTROL_EVENT, VIDEO_PANIC_EVENT, VIDEO_ROUTE_CONTROL_EVENT } from "./videoEvents"
import "./video.html"

const DEFAULT_VIDEO_ENDPOINT_URL = "https://sms-clips.samuel.ovh/api/random-clips"
const VIDEO_DEBUG_STORAGE_KEY = "video.showDebug"
const VIDEO_REVEAL_STEP_MS = 120
const VIDEO_REVEAL_DURATION_MS = 1200
const VIDEO_FADE_OUT_DURATION_MS = 1000
const VIDEO_SYNC_BATCH_FADE_OUT_DURATION_MS = 3000
const VIDEO_FADE_OUT_LEAD_MS = 1200
const VIDEO_NEXT_CLIP_DELAY_MS = 150
const VIDEO_REFRESH_EVENT = "ticker.refresh"
const VIDEO_TRIM_START_OFFSET_SEC = 1
const VIDEO_TRIM_END_OFFSET_SEC = 1
const VIDEO_HEARTBEAT_MS = 5 * 1000

function currentVideoDisplayMode() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  if (!wall) {
    return null
  }

  return wall?.videoDisplayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH
    ? VIDEO_DISPLAY_MODE_SYNC_BATCH
    : VIDEO_DISPLAY_MODE_FIFO
}

function currentVideoShowDebug() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  if (typeof wall?.videoShowDebug === "boolean") {
    return wall.videoShowDebug
  }

  return readStoredShowDebug()
}

function currentVideoAutoAdvance() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  if (typeof wall?.videoAutoAdvance === "boolean") {
    return wall.videoAutoAdvance
  }

  return true
}

function currentVideoTrimClips() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  return Boolean(wall?.videoTrimClips)
}

function currentVideoTrimStartOffsetSec() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoTrimStartOffsetSec)
  return Number.isFinite(value) ? value : VIDEO_TRIM_START_OFFSET_SEC
}

function currentVideoTrimEndOffsetSec() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoTrimEndOffsetSec)
  return Number.isFinite(value) ? value : VIDEO_TRIM_END_OFFSET_SEC
}

function currentVideoRevealDurationMs() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoRevealDurationMs)
  return Number.isFinite(value) ? value : VIDEO_REVEAL_DURATION_MS
}

function currentVideoFadeOutDurationMs() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoFadeOutDurationMs)
  return Number.isFinite(value) ? value : VIDEO_FADE_OUT_DURATION_MS
}

function currentVideoSyncBatchFadeOutDurationMs() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoSyncBatchFadeOutDurationMs)
  return Number.isFinite(value) ? value : VIDEO_SYNC_BATCH_FADE_OUT_DURATION_MS
}

function currentVideoFadeOutLeadMs() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const value = Number(wall?.videoFadeOutLeadMs)
  return Number.isFinite(value) ? value : VIDEO_FADE_OUT_LEAD_MS
}

function currentVideoTag() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  return ["kiss", "dance", "cry"].includes(wall?.videoTag) ? wall.videoTag : "kiss"
}

function readMediaSnapshot(videoEl) {
  if (!videoEl) {
    return {
      readyState: 0,
      networkState: 0,
      errorCode: null,
      duration: null,
    }
  }

  return {
    readyState: Number(videoEl.readyState) || 0,
    networkState: Number(videoEl.networkState) || 0,
    errorCode: Number(videoEl.error?.code) || null,
    duration: Number.isFinite(videoEl.duration) ? Number(videoEl.duration) : null,
  }
}

function configuredEndpoint() {
  const queryEndpoint = FlowRouter.getQueryParam("endpoint")
  if (queryEndpoint) {
    return queryEndpoint
  }

  return Meteor.settings.public?.videoEndpointUrl ?? DEFAULT_VIDEO_ENDPOINT_URL
}

function configuredEndpointWithTag() {
  const endpoint = configuredEndpoint()
  const tag = currentVideoTag()

  try {
    const url = new URL(endpoint, window.location.href)
    url.searchParams.set("tag", tag)
    return url.toString()
  } catch (error) {
    const separator = endpoint.includes("?") ? "&" : "?"
    return `${endpoint}${separator}tag=${encodeURIComponent(tag)}`
  }
}

function readStoredShowDebug() {
  try {
    const raw = window.localStorage.getItem(VIDEO_DEBUG_STORAGE_KEY)
    if (raw === null) {
      return true
    }
    return raw !== "false"
  } catch (error) {
    return true
  }
}

function storeShowDebug(value) {
  try {
    window.localStorage.setItem(VIDEO_DEBUG_STORAGE_KEY, value ? "true" : "false")
  } catch (error) {
    // ignore storage failures
  }
}

function setVideoOpacity(instance, opacity, durationMs = VIDEO_REVEAL_DURATION_MS, delayMs = 0) {
  const shell = instance.find("#videoRevealShell")
  if (!shell) {
    return
  }

  shell.style.transitionProperty = "opacity"
  shell.style.transitionDuration = `${Math.max(0, durationMs)}ms`
  shell.style.transitionTimingFunction = "ease"
  shell.style.transitionDelay = `${Math.max(0, delayMs)}ms`
  shell.style.opacity = String(opacity)
}

function clearFadeTimers(instance) {
  if (instance.fadeOutTimerId) {
    Meteor.clearTimeout(instance.fadeOutTimerId)
    instance.fadeOutTimerId = null
  }
  if (instance.nextClipTimerId) {
    Meteor.clearTimeout(instance.nextClipTimerId)
    instance.nextClipTimerId = null
  }
}

function resetVideoElement(instance) {
  const videoEl = instance.find("#remoteVideoPlayer")
  if (!videoEl) {
    return
  }

  try {
    videoEl.pause()
  } catch (error) {
    // ignore pause failures
  }

  videoEl.removeAttribute("src")
  videoEl.load()
}

function scheduleNextClip(instance, delayMs = 0) {
  if (!currentVideoAutoAdvance()) {
    return
  }

  const displayMode = currentVideoDisplayMode()
  if (displayMode == null || displayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    return
  }

  if (instance.nextClipTimerId) {
    Meteor.clearTimeout(instance.nextClipTimerId)
  }

  instance.nextClipTimerId = Meteor.setTimeout(() => {
    instance.nextClipTimerId = null
    instance.startedPlaybackKey = null
    instance.trimCompletionStarted = false
    instance.appliedTrim = null
    instance.currentSource.set("")
    instance.currentTrimWindow.set(null)
    instance.currentTrimKey.set("null")
    resetVideoElement(instance)
    loadVideo(instance)
  }, Math.max(0, delayMs))
}

function queueReveal(instance) {
  clearFadeTimers(instance)
  setVideoOpacity(instance, 0, 0, 0)
}

function scheduleFadeOut(instance, revealDelayMs = 0) {
  const videoEl = instance.find("#remoteVideoPlayer")
  if (!videoEl) {
    return
  }

  const remainingDurationSec = remainingPlaybackDurationSec(instance, videoEl)
  if (!Number.isFinite(remainingDurationSec) || remainingDurationSec <= 0) {
    return
  }

  const fadeOutStartsInMs = Math.max(
    0,
    Math.floor((remainingDurationSec * 1000) - currentVideoFadeOutLeadMs() + revealDelayMs),
  )

  if (instance.fadeOutTimerId) {
    Meteor.clearTimeout(instance.fadeOutTimerId)
  }

  instance.fadeOutTimerId = Meteor.setTimeout(() => {
    const fadeOutDurationMs = currentVideoFadeOutDurationMs()
    setVideoOpacity(instance, 0, fadeOutDurationMs, 0)
    scheduleNextClip(instance, fadeOutDurationMs + VIDEO_NEXT_CLIP_DELAY_MS)
    instance.fadeOutTimerId = null
  }, fadeOutStartsInMs)
}

function applyFifoReveal(instance) {
  const delayMs = 0
  instance.appliedRevealKey = `fifo:${instance.currentSource.get() || ""}`
  setVideoOpacity(instance, 1, currentVideoRevealDurationMs(), delayMs)
  scheduleFadeOut(instance, delayMs)
}

function applySyncBatchReveal(instance) {
  const delayMs = 0
  instance.appliedRevealKey = `batch:${instance.currentSource.get() || ""}:${currentBatchToken() || "none"}`
  setVideoOpacity(instance, 1, currentVideoRevealDurationMs(), delayMs)
  scheduleFadeOut(instance, delayMs)
}

function endingFadeDurationMs(instance, videoEl = null) {
  if (currentVideoDisplayMode() !== VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    return currentVideoFadeOutDurationMs()
  }

  const activeVideoEl = videoEl ?? instance.find("#remoteVideoPlayer")
  const durationSec = activeVideoEl ? currentPlaybackDurationSec(instance, activeVideoEl) : null
  const syncBatchFadeOutDurationMs = currentVideoSyncBatchFadeOutDurationMs()
  const defaultFadeOutDurationMs = currentVideoFadeOutDurationMs()
  if (!Number.isFinite(durationSec) || (durationSec * 1000) < syncBatchFadeOutDurationMs) {
    return defaultFadeOutDurationMs
  }

  return syncBatchFadeOutDurationMs
}

function queueNextClipAfterFade(instance) {
  clearFadeTimers(instance)
  instance.startedPlaybackKey = null
  const fadeDurationMs = endingFadeDurationMs(instance)
  setVideoOpacity(instance, 0, fadeDurationMs, 0)
  if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    Meteor.setTimeout(() => {
      reportVideoMediaState(instance, "ended")
    }, fadeDurationMs)
    return
  }

  scheduleNextClip(instance, fadeDurationMs + VIDEO_NEXT_CLIP_DELAY_MS)
}

function currentBatchToken() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  return wall?.videoBatchToken ?? null
}

function currentBatchState() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  return wall?.videoBatchState ?? "idle"
}

function shouldAutoplayCurrentVideo({ preloadOnly = false } = {}) {
  if (preloadOnly) {
    return false
  }

  if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    return false
  }

  return !currentVideoTrimClips()
}

function canStartCurrentPlayback() {
  if (currentVideoDisplayMode() !== VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    return true
  }

  return currentBatchState() === "playing"
}

function reportVideoMediaState(instance, playbackState) {
  const videoEl = instance.find("#remoteVideoPlayer")
  const snapshot = readMediaSnapshot(videoEl)
  const batchToken = currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH
    ? (instance.preloadedBatchToken.get() || currentBatchToken())
    : null

  const nextKey = JSON.stringify({
    playbackState,
    batchToken,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    duration: snapshot.duration,
  })

  if (instance.lastReportedMediaKey === nextKey) {
    return
  }

  instance.lastReportedMediaKey = nextKey
  Meteor.callAsync("video.reportClientMediaState", {
    wallId: DEFAULT_TICKER_WALL_ID,
    clientId: instance.clientId,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    playbackState,
    batchToken,
    durationSec: snapshot.duration,
  }).catch((error) => {
    console.error("[video] failed to report media state", error)
  })
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
}

function absolutizeUrl(maybeUrl, endpoint) {
  if (!maybeUrl || typeof maybeUrl !== "string") {
    return null
  }

  try {
    return new URL(maybeUrl, endpoint || window.location.href).toString()
  } catch (error) {
    return maybeUrl
  }
}

function resolveClipUrl(payload, endpoint) {
  if (!payload) {
    return null
  }

  if (typeof payload === "string") {
    const trimmed = payload.trim()
    return trimmed ? absolutizeUrl(trimmed, endpoint) : null
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const resolved = resolveClipUrl(item, endpoint)
      if (resolved) {
        return resolved
      }
    }
    return null
  }

  if (isObject(payload)) {
    const directKeys = ["media_url", "videoUrl", "url", "src", "playbackUrl", "streamUrl", "mp4"]
    for (const key of directKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }

    const nestedKeys = ["clip", "video", "data", "result", "item", "items", "clips", "videos"]
    for (const key of nestedKeys) {
      const resolved = resolveClipUrl(payload[key], endpoint)
      if (resolved) {
        return resolved
      }
    }
  }

  return null
}

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function extractTrimWindow(payload) {
  if (!isObject(payload)) {
    return null
  }

  const kissStartSec = toFiniteNumber(
    payload.kiss_start_seconds
    ?? payload.kiss_start
    ?? payload.kissStart
    ?? payload.kiss_start_sec,
  )
  const kissEndSec = toFiniteNumber(
    payload.kiss_end_seconds
    ?? payload.kiss_end
    ?? payload.kissEnd
    ?? payload.kiss_end_sec,
  )

  if (kissStartSec === null && kissEndSec === null) {
    return null
  }

  return { kissStartSec, kissEndSec }
}

function resolveClipData(payload, endpoint) {
  if (!payload) {
    return { clipUrl: null, trimWindow: null }
  }

  if (typeof payload === "string") {
    const clipUrl = resolveClipUrl(payload, endpoint)
    return { clipUrl, trimWindow: null }
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const resolved = resolveClipData(item, endpoint)
      if (resolved.clipUrl) {
        return resolved
      }
    }
    return { clipUrl: null, trimWindow: null }
  }

  if (isObject(payload)) {
    const directKeys = ["media_url", "videoUrl", "url", "src", "playbackUrl", "streamUrl", "mp4"]
    for (const key of directKeys) {
      const clipUrl = resolveClipUrl(payload[key], endpoint)
      if (clipUrl) {
        return {
          clipUrl,
          trimWindow: extractTrimWindow(payload),
        }
      }
    }

    const nestedKeys = ["clip", "video", "data", "result", "item", "items", "clips", "videos"]
    for (const key of nestedKeys) {
      const resolved = resolveClipData(payload[key], endpoint)
      if (resolved.clipUrl) {
        return resolved
      }
    }
  }

  return { clipUrl: null, trimWindow: null }
}

function computeAppliedTrim(instance, videoEl) {
  if (!currentVideoTrimClips()) {
    return null
  }

  const trimWindow = instance.currentTrimWindow.get()
  if (!trimWindow) {
    return null
  }

  const durationSec = Number(videoEl.duration)
  const startSec = Math.max(
    0,
    Number.isFinite(trimWindow.kissStartSec) ? trimWindow.kissStartSec - currentVideoTrimStartOffsetSec() : 0,
  )
  const endCandidateSec = Number.isFinite(trimWindow.kissEndSec)
    ? trimWindow.kissEndSec + currentVideoTrimEndOffsetSec()
    : null
  const endSec = Number.isFinite(durationSec) && durationSec > 0 && Number.isFinite(endCandidateSec)
    ? Math.min(durationSec, endCandidateSec)
    : endCandidateSec

  if (Number.isFinite(endSec) && endSec <= startSec) {
    return null
  }

  return {
    startSec,
    endSec: Number.isFinite(endSec) ? endSec : null,
  }
}

function currentPlaybackDurationSec(instance, videoEl) {
  const durationSec = Number(videoEl.duration)
  if (!instance.appliedTrim) {
    return Number.isFinite(durationSec) ? durationSec : null
  }

  const playbackEndSec = Number.isFinite(instance.appliedTrim.endSec)
    ? instance.appliedTrim.endSec
    : durationSec

  if (!Number.isFinite(playbackEndSec)) {
    return null
  }

  return Math.max(0, playbackEndSec - (instance.appliedTrim.startSec ?? 0))
}

function remainingPlaybackDurationSec(instance, videoEl) {
  const playbackDurationSec = currentPlaybackDurationSec(instance, videoEl)
  if (!Number.isFinite(playbackDurationSec)) {
    return null
  }

  const playbackStartSec = Number(instance.appliedTrim?.startSec) || 0
  const currentTimeSec = Number(videoEl.currentTime)
  const elapsedSec = Number.isFinite(currentTimeSec)
    ? Math.max(0, currentTimeSec - playbackStartSec)
    : 0

  return Math.max(0, playbackDurationSec - elapsedSec)
}

function currentBatchStartedAtServerMs() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const startedAtServerMs = Number(wall?.videoBatchStartedAtServerMs)
  return Number.isFinite(startedAtServerMs) ? startedAtServerMs : null
}

function syncBatchPlaybackPosition(instance, videoEl) {
  if (currentVideoDisplayMode() !== VIDEO_DISPLAY_MODE_SYNC_BATCH || currentBatchState() !== "playing") {
    return true
  }

  const startedAtServerMs = currentBatchStartedAtServerMs()
  if (!Number.isFinite(startedAtServerMs)) {
    return true
  }

  const playbackStartSec = Number(instance.appliedTrim?.startSec) || 0
  const playbackDurationSec = currentPlaybackDurationSec(instance, videoEl)
  const elapsedSec = Math.max(0, (Date.now() - startedAtServerMs) / 1000)
  const playbackEndSec = Number.isFinite(playbackDurationSec)
    ? playbackStartSec + playbackDurationSec
    : null
  const targetTimeSec = Number.isFinite(playbackEndSec)
    ? Math.min(playbackEndSec, playbackStartSec + elapsedSec)
    : playbackStartSec + elapsedSec

  if (Number.isFinite(playbackEndSec) && targetTimeSec >= playbackEndSec) {
    queueNextClipAfterFade(instance)
    return false
  }

  try {
    videoEl.currentTime = targetTimeSec
  } catch (error) {
    // ignore seek failures and continue from the current position
  }

  return true
}

function startPlaybackForCurrentClip(instance) {
  const videoEl = instance.find("#remoteVideoPlayer")
  const currentSource = instance.currentSource.get()
  if (!videoEl || !currentSource) {
    return
  }

  if (!canStartCurrentPlayback()) {
    try {
      videoEl.pause()
    } catch (error) {
      // ignore pause failures
    }
    return
  }

  const currentTrimKey = instance.currentTrimKey.get()
  const playbackKey = `${currentSource}::${currentTrimKey}::${currentVideoTrimClips() ? "trim" : "full"}`
  if (instance.startedPlaybackKey === playbackKey) {
    return
  }

  instance.startedPlaybackKey = playbackKey
  instance.trimCompletionStarted = false
  instance.appliedTrim = computeAppliedTrim(instance, videoEl)

  if (instance.appliedTrim && Number.isFinite(instance.appliedTrim.startSec)) {
    try {
      videoEl.currentTime = instance.appliedTrim.startSec
    } catch (error) {
      // ignore seek failures and continue with untrimmed playback
    }
  }

  if (!syncBatchPlaybackPosition(instance, videoEl)) {
    return
  }

  queueReveal(instance)
  videoEl.play()
    .then(() => {
      reportVideoMediaState(instance, "playing")
    })
    .catch(() => {})
  if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
    applySyncBatchReveal(instance)
    return
  }

  applyFifoReveal(instance)
}

async function fetchClipUrl(endpoint) {
  if (!endpoint) {
    throw new Error("No video endpoint configured. Use ?endpoint=... or Meteor.settings.public.videoEndpointUrl.")
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    },
    cache: "no-store",
  })

  if (!response.ok) {
    throw new Error(`Endpoint returned ${response.status}`)
  }

  const contentType = response.headers.get("content-type") ?? ""
  let payload

  if (contentType.includes("text/html")) {
    const htmlPayload = await response.text()
    const error = new Error("Endpoint returned HTML instead of JSON")
    error.responsePayload = htmlPayload
    throw error
  }

  if (contentType.includes("application/json")) {
    payload = await response.json()
  } else {
    payload = await response.text()
  }

  const { clipUrl, trimWindow } = resolveClipData(payload, endpoint)
  if (!clipUrl) {
    const error = new Error("Could not resolve a video URL from endpoint response")
    error.responsePayload = payload
    throw error
  }

  return { clipUrl, trimWindow, payload }
}

async function loadVideo(instance, { preloadOnly = false, batchToken = null } = {}) {
  const endpoint = configuredEndpointWithTag()
  instance.endpoint.set(endpoint)
  instance.isLoading.set(true)
  instance.errorMessage.set("")
  instance.lastResponse.set("[waiting for response]")
  clearFadeTimers(instance)
  setVideoOpacity(instance, 0, 0, 0)
  instance.appliedRevealKey = null

  try {
    const { clipUrl, trimWindow, payload } = await fetchClipUrl(endpoint)
    instance.currentSource.set(clipUrl)
    instance.currentTrimWindow.set(trimWindow)
    instance.currentTrimKey.set(JSON.stringify(trimWindow ?? null))
    instance.preloadedBatchToken.set(batchToken)
    instance.startedBatchToken = null
    instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))

    const videoEl = instance.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    const shouldAutoplay = shouldAutoplayCurrentVideo({ preloadOnly })
    videoEl.autoplay = shouldAutoplay
    if (shouldAutoplay) {
      videoEl.setAttribute("autoplay", "")
    } else {
      videoEl.removeAttribute("autoplay")
      videoEl.pause()
    }

    instance.startedPlaybackKey = null
    instance.trimCompletionStarted = false
    instance.appliedTrim = null

    if (videoEl.getAttribute("src") !== clipUrl) {
      videoEl.src = clipUrl
      videoEl.load()
    }

    videoEl.muted = instance.isMuted.get()
    queueReveal(instance)
    reportVideoMediaState(instance, preloadOnly ? "loading" : "loading")
    if (videoEl.readyState >= 1 && !preloadOnly) {
      startPlaybackForCurrentClip(instance)
    }
  } catch (error) {
    instance.errorMessage.set(error?.message ?? "Failed to load video")
    if (error?.responsePayload !== undefined) {
      const payload = error.responsePayload
      instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))
    } else {
      instance.lastResponse.set(error?.stack || error?.message || "Failed to load video")
    }
    reportVideoMediaState(instance, "error")
  } finally {
    instance.isLoading.set(false)
  }
}

Template.VideoPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.deviceKey = getOrCreateDeviceKey()
  this.shortCode = toShortCode(this.clientId)
  this.endpoint = new ReactiveVar(configuredEndpoint())
  this.isLoading = new ReactiveVar(false)
  this.errorMessage = new ReactiveVar("")
  this.currentSource = new ReactiveVar("")
  this.currentTrimWindow = new ReactiveVar(null)
  this.currentTrimKey = new ReactiveVar("null")
  this.preloadedBatchToken = new ReactiveVar(null)
  this.isMuted = new ReactiveVar(true)
  this.lastResponse = new ReactiveVar("")
  this.showDebug = new ReactiveVar(true)
  this.routeControlHandler = null
  this.debugControlHandler = null
  this.refreshHandler = null
  this.fadeOutTimerId = null
  this.nextClipTimerId = null
  this.appliedRevealKey = null
  this.startedPlaybackKey = null
  this.startedBatchToken = null
  this.trimCompletionStarted = false
  this.appliedTrim = null
  this.lastReportedMediaKey = null
  this.heartbeatTimerId = null
  this.panicHandler = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.client.self", DEFAULT_TICKER_WALL_ID, this.clientId)
  })

  this.autorun(() => {
    currentVideoDisplayMode()
  })

  this.autorun(() => {
    const nextShowDebug = currentVideoShowDebug()
    this.showDebug.set(nextShowDebug)
    storeShowDebug(nextShowDebug)
  })
})

Template.VideoPage.onRendered(function onRendered() {
  this.showDebug.set(readStoredShowDebug())

  Meteor.callAsync("ticker.join", {
    wallId: DEFAULT_TICKER_WALL_ID,
    clientId: this.clientId,
    deviceKey: this.deviceKey,
    shortCode: this.shortCode,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    userAgent: navigator.userAgent,
  }).then(() => Meteor.callAsync("ticker.claimNextSlot", {
    wallId: DEFAULT_TICKER_WALL_ID,
    clientId: this.clientId,
  })).catch((error) => {
    console.error("[video] failed to join wall", error)
  })

  this.heartbeatTimerId = Meteor.setInterval(() => {
    Meteor.callAsync("ticker.heartbeat", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: this.clientId,
    }).catch((error) => {
      console.error("[video] heartbeat failed", error)
    })
  }, VIDEO_HEARTBEAT_MS)

  this.routeControlHandler = (payload) => {
    const target = payload?.target
    if (target !== "ticker" && target !== "television") {
      return
    }

    FlowRouter.go(`/${target}`)
  }

  this.debugControlHandler = (payload) => {
    if (!payload || typeof payload.showDebug !== "boolean") {
      return
    }

    this.showDebug.set(payload.showDebug)
    storeShowDebug(payload.showDebug)
  }

  this.refreshHandler = (payload) => {
    if (payload?.wallId && payload.wallId !== DEFAULT_TICKER_WALL_ID) {
      return
    }

    window.location.reload()
  }

  streamer.on(VIDEO_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  streamer.on(VIDEO_DEBUG_CONTROL_EVENT, this.debugControlHandler)
  streamer.on(VIDEO_REFRESH_EVENT, this.refreshHandler)

  this.autorun(() => {
    const displayMode = currentVideoDisplayMode()
    if (displayMode == null || displayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
      return
    }

    currentVideoTrimClips()
    const currentSource = this.currentSource.get()
    this.currentTrimKey.get()
    const isLoading = this.isLoading.get()

    const videoEl = this.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    if (!currentSource) {
      if (!isLoading) {
        loadVideo(this)
      }
      return
    }

    if (videoEl.readyState < 1) {
      return
    }

    const shouldAutoplay = shouldAutoplayCurrentVideo()
    videoEl.autoplay = shouldAutoplay
    if (shouldAutoplay) {
      videoEl.setAttribute("autoplay", "")
    } else {
      videoEl.removeAttribute("autoplay")
      videoEl.pause()
    }

    this.startedPlaybackKey = null
    this.trimCompletionStarted = false
    this.appliedTrim = null
    startPlaybackForCurrentClip(this)
  })

  this.autorun(() => {
    const displayMode = currentVideoDisplayMode()
    const batchToken = currentBatchToken()
    const batchState = currentBatchState()
    const videoEl = this.find("#remoteVideoPlayer")

    if (!videoEl || displayMode == null || displayMode !== VIDEO_DISPLAY_MODE_SYNC_BATCH) {
      return
    }

    if (!batchToken || batchState === "idle") {
      reportVideoMediaState(this, "idle")
      return
    }

    if (this.preloadedBatchToken.get() !== batchToken) {
      loadVideo(this, {
        preloadOnly: batchState !== "playing",
        batchToken,
      })
      return
    }

    if (this.preloadedBatchToken.get() === batchToken && batchState === "loading") {
      const snapshot = readMediaSnapshot(videoEl)
      if (snapshot.readyState >= 4) {
        reportVideoMediaState(this, "ready")
      } else {
        reportVideoMediaState(this, "loading")
      }
      return
    }

    if (this.preloadedBatchToken.get() === batchToken && batchState === "playing") {
      if (this.startedBatchToken === batchToken) {
        return
      }

      this.startedBatchToken = batchToken
      this.startedPlaybackKey = null
      this.trimCompletionStarted = false
      this.appliedTrim = null
      startPlaybackForCurrentClip(this)
      return
    }

    if (this.preloadedBatchToken.get() === batchToken && batchState === "finished") {
      reportVideoMediaState(this, "ended")
    }
  })

  const videoEl = this.find("#remoteVideoPlayer")
  if (videoEl) {
    videoEl.addEventListener("loadedmetadata", this.handleLoadedMetadata = () => {
      if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
        try {
          videoEl.pause()
        } catch (error) {
          // ignore pause failures
        }
      }

      if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH && currentBatchState() !== "playing") {
        reportVideoMediaState(this, readMediaSnapshot(videoEl).readyState >= 4 ? "ready" : "loading")
        return
      }

      startPlaybackForCurrentClip(this)
    })
    videoEl.addEventListener("canplaythrough", this.handleCanPlayThrough = () => {
      if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_SYNC_BATCH) {
        reportVideoMediaState(this, "ready")
      }
    })
    videoEl.addEventListener("ended", this.handleEnded = () => {
      queueNextClipAfterFade(this)
    })
    videoEl.addEventListener("timeupdate", this.handleTimeUpdate = () => {
      const trimEndSec = this.appliedTrim?.endSec
      if (!Number.isFinite(trimEndSec) || this.trimCompletionStarted) {
        return
      }

      if (videoEl.currentTime >= trimEndSec) {
        this.trimCompletionStarted = true
        videoEl.pause()
        queueNextClipAfterFade(this)
      }
    })
  }

  this.panicHandler = (payload) => {
    if (payload?.wallId && payload.wallId !== DEFAULT_TICKER_WALL_ID) {
      return
    }

    const activeVideoEl = this.find("#remoteVideoPlayer")
    if (!activeVideoEl) {
      return
    }

    clearFadeTimers(this)
    this.startedPlaybackKey = null
    this.startedBatchToken = null
    this.trimCompletionStarted = false
    this.appliedTrim = null
    this.currentSource.set("")
    this.currentTrimWindow.set(null)
    this.currentTrimKey.set("null")
    this.preloadedBatchToken.set(null)

    const fadeOutDurationMs = currentVideoFadeOutDurationMs()
    activeVideoEl.style.transition = `opacity ${fadeOutDurationMs}ms ease`
    activeVideoEl.style.opacity = "0"
    Meteor.setTimeout(() => {
      resetVideoElement(this)
      reportVideoMediaState(this, "idle")
    }, fadeOutDurationMs)
  }
  streamer.on(VIDEO_PANIC_EVENT, this.panicHandler)

})

Template.VideoPage.onDestroyed(function onDestroyed() {
  clearFadeTimers(this)
  if (this.heartbeatTimerId) {
    Meteor.clearInterval(this.heartbeatTimerId)
    this.heartbeatTimerId = null
  }
  if (this.routeControlHandler) {
    streamer.removeListener(VIDEO_ROUTE_CONTROL_EVENT, this.routeControlHandler)
    this.routeControlHandler = null
  }
  if (this.panicHandler) {
    streamer.removeListener(VIDEO_PANIC_EVENT, this.panicHandler)
    this.panicHandler = null
  }
  if (this.debugControlHandler) {
    streamer.removeListener(VIDEO_DEBUG_CONTROL_EVENT, this.debugControlHandler)
    this.debugControlHandler = null
  }
  if (this.refreshHandler) {
    streamer.removeListener(VIDEO_REFRESH_EVENT, this.refreshHandler)
    this.refreshHandler = null
  }
  const videoEl = this.find?.("#remoteVideoPlayer")
  if (videoEl && this.handleLoadedMetadata) {
    videoEl.removeEventListener("loadedmetadata", this.handleLoadedMetadata)
  }
  if (videoEl && this.handleEnded) {
    videoEl.removeEventListener("ended", this.handleEnded)
  }
  if (videoEl && this.handleCanPlayThrough) {
    videoEl.removeEventListener("canplaythrough", this.handleCanPlayThrough)
  }
  if (videoEl && this.handleTimeUpdate) {
    videoEl.removeEventListener("timeupdate", this.handleTimeUpdate)
  }
})

Template.VideoPage.helpers({
  endpointLabel() {
    return Template.instance().endpoint.get() || "No endpoint configured"
  },
  isLoading() {
    return Template.instance().isLoading.get()
  },
  errorMessage() {
    return Template.instance().errorMessage.get()
  },
  currentSource() {
    return Template.instance().currentSource.get()
  },
  trimStatus() {
    const instance = Template.instance()
    const trimWindow = instance.currentTrimWindow.get()
    if (!trimWindow) {
      return "no trim metadata"
    }

    const prefix = currentVideoTrimClips() ? "trim on" : "trim off"
    return `${prefix} · kiss_start=${trimWindow.kissStartSec ?? "?"} · kiss_end=${trimWindow.kissEndSec ?? "?"}`
  },
  lastResponse() {
    return Template.instance().lastResponse.get()
  },
  showDebug() {
    return Template.instance().showDebug.get()
  },
  muteButtonLabel() {
    return Template.instance().isMuted.get() ? "Sound Off" : "Sound On"
  },
})

Template.VideoPage.events({
  'click [data-action="reload-video"]'(event, instance) {
    event.preventDefault()
    loadVideo(instance)
  },
  'click [data-action="toggle-mute"]'(event, instance) {
    event.preventDefault()
    const nextMuted = !instance.isMuted.get()
    instance.isMuted.set(nextMuted)

    const videoEl = instance.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    videoEl.muted = nextMuted
    if (!nextMuted && videoEl.getAttribute("src")) {
      videoEl.play().catch(() => {})
    }
  },
})
