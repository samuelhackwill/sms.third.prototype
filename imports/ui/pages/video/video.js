import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import "/imports/api/ticker/publications"
import {
  VIDEO_DISPLAY_MODE_DIAGONAL,
  VIDEO_DISPLAY_MODE_FIFO,
} from "/imports/api/video/constants"
import { streamer } from "/imports/both/streamer"
import { WALL_ROUTE_CONTROL_EVENT } from "/imports/ui/lib/wallRouteControl"
import { getOrCreateClientId } from "/imports/ui/lib/wallClientIdentity"
import { VIDEO_DEBUG_CONTROL_EVENT } from "./videoEvents"
import "./video.html"

const DEFAULT_VIDEO_ENDPOINT_URL = "https://sms-clips.samuel.ovh/api/random-clips"
const VIDEO_DEBUG_STORAGE_KEY = "video.showDebug"
const VIDEO_REVEAL_STEP_MS = 120
const VIDEO_REVEAL_DURATION_MS = 1200
const VIDEO_FADE_OUT_DURATION_MS = 1000
const VIDEO_FADE_OUT_LEAD_MS = 1200

function currentVideoDisplayMode() {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  return wall?.videoDisplayMode === VIDEO_DISPLAY_MODE_DIAGONAL
    ? VIDEO_DISPLAY_MODE_DIAGONAL
    : VIDEO_DISPLAY_MODE_FIFO
}

function configuredEndpoint() {
  const queryEndpoint = FlowRouter.getQueryParam("endpoint")
  if (queryEndpoint) {
    return queryEndpoint
  }

  return Meteor.settings.public?.videoEndpointUrl ?? DEFAULT_VIDEO_ENDPOINT_URL
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

function slotIndexForClient(client) {
  if (Number.isInteger(client?.slotIndex) && client.slotIndex >= 0) {
    return client.slotIndex
  }

  if (Number.isInteger(client?.rowIndex) && Number.isInteger(client?.colIndex)) {
    return (client.rowIndex * 5) + client.colIndex
  }

  return 0
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

  const durationSec = Number(videoEl.duration)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return
  }

  const fadeOutStartsInMs = Math.max(
    0,
    Math.floor((durationSec * 1000) - VIDEO_FADE_OUT_LEAD_MS + revealDelayMs),
  )

  if (instance.fadeOutTimerId) {
    Meteor.clearTimeout(instance.fadeOutTimerId)
  }

  instance.fadeOutTimerId = Meteor.setTimeout(() => {
    setVideoOpacity(instance, 0, VIDEO_FADE_OUT_DURATION_MS, 0)
    instance.fadeOutTimerId = null
  }, fadeOutStartsInMs)
}

function applyFifoReveal(instance) {
  const delayMs = 0
  instance.appliedRevealKey = `fifo:${instance.currentSource.get() || ""}`
  setVideoOpacity(instance, 1, VIDEO_REVEAL_DURATION_MS, delayMs)
  scheduleFadeOut(instance, delayMs)
}

async function registerDiagonalReady(instance) {
  try {
    await Meteor.callAsync("video.markClientReady", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: instance.clientId,
    })
  } catch (error) {
    console.error("[video] failed to register ready state", error)
  }
}

function maybeApplyDiagonalReveal(instance) {
  const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  const plan = wall?.videoRevealPlan

  if (!plan || !Number.isFinite(Number(plan.revealStartServerMs))) {
    return
  }

  const client = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
  const slotIndex = slotIndexForClient(client)
  const stepMs = Number(plan.revealStepMs) || VIDEO_REVEAL_STEP_MS
  const revealAtMs = Number(plan.revealStartServerMs) + (slotIndex * stepMs)
  const revealDelayMs = Math.max(0, revealAtMs - Date.now())
  const revealKey = `${plan.generation}:${slotIndex}`

  if (instance.appliedRevealKey === revealKey) {
    return
  }

  instance.appliedRevealKey = revealKey
  setVideoOpacity(instance, 1, VIDEO_REVEAL_DURATION_MS, revealDelayMs)
  scheduleFadeOut(instance, revealDelayMs)
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

  const clipUrl = resolveClipUrl(payload, endpoint)
  if (!clipUrl) {
    const error = new Error("Could not resolve a video URL from endpoint response")
    error.responsePayload = payload
    throw error
  }

  return { clipUrl, payload }
}

async function loadVideo(instance) {
  const endpoint = instance.endpoint.get()
  instance.isLoading.set(true)
  instance.errorMessage.set("")
  instance.lastResponse.set("[waiting for response]")
  clearFadeTimers(instance)
  setVideoOpacity(instance, 0, 0, 0)
  instance.appliedRevealKey = null

  try {
    const { clipUrl, payload } = await fetchClipUrl(endpoint)
    instance.currentSource.set(clipUrl)
    instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))

    const videoEl = instance.find("#remoteVideoPlayer")
    if (!videoEl) {
      return
    }

    if (videoEl.getAttribute("src") !== clipUrl) {
      videoEl.src = clipUrl
      videoEl.load()
    }

    videoEl.muted = instance.isMuted.get()
    queueReveal(instance)
    await videoEl.play().catch(() => {})
  } catch (error) {
    instance.errorMessage.set(error?.message ?? "Failed to load video")
    if (error?.responsePayload !== undefined) {
      const payload = error.responsePayload
      instance.lastResponse.set(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2))
    } else {
      instance.lastResponse.set(error?.stack || error?.message || "Failed to load video")
    }
  } finally {
    instance.isLoading.set(false)
  }
}

Template.VideoPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.endpoint = new ReactiveVar(configuredEndpoint())
  this.isLoading = new ReactiveVar(false)
  this.errorMessage = new ReactiveVar("")
  this.currentSource = new ReactiveVar("")
  this.isMuted = new ReactiveVar(true)
  this.lastResponse = new ReactiveVar("")
  this.showDebug = new ReactiveVar(true)
  this.routeControlHandler = null
  this.debugControlHandler = null
  this.fadeOutTimerId = null
  this.appliedRevealKey = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.client.self", DEFAULT_TICKER_WALL_ID, this.clientId)
  })

  this.autorun(() => {
    if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_DIAGONAL) {
      maybeApplyDiagonalReveal(this)
    }
  })
})

Template.VideoPage.onRendered(function onRendered() {
  this.showDebug.set(readStoredShowDebug())

  this.routeControlHandler = (payload) => {
    if (!payload || !payload.target) {
      return
    }

    FlowRouter.go(`/${payload.target}`)
  }

  this.debugControlHandler = (payload) => {
    if (!payload || typeof payload.showDebug !== "boolean") {
      return
    }

    this.showDebug.set(payload.showDebug)
    storeShowDebug(payload.showDebug)
  }

  streamer.on(WALL_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  streamer.on(VIDEO_DEBUG_CONTROL_EVENT, this.debugControlHandler)

  const videoEl = this.find("#remoteVideoPlayer")
  if (videoEl) {
    videoEl.addEventListener("loadedmetadata", this.handleLoadedMetadata = () => {
      if (currentVideoDisplayMode() === VIDEO_DISPLAY_MODE_DIAGONAL) {
        registerDiagonalReady(this)
      } else {
        applyFifoReveal(this)
      }
    })
    videoEl.addEventListener("ended", this.handleEnded = () => {
      clearFadeTimers(this)
      setVideoOpacity(this, 0, VIDEO_FADE_OUT_DURATION_MS, 0)
    })
  }

  loadVideo(this)
})

Template.VideoPage.onDestroyed(function onDestroyed() {
  clearFadeTimers(this)
  if (this.routeControlHandler) {
    streamer.removeListener(WALL_ROUTE_CONTROL_EVENT, this.routeControlHandler)
    this.routeControlHandler = null
  }
  if (this.debugControlHandler) {
    streamer.removeListener(VIDEO_DEBUG_CONTROL_EVENT, this.debugControlHandler)
    this.debugControlHandler = null
  }
  const videoEl = this.find?.("#remoteVideoPlayer")
  if (videoEl && this.handleLoadedMetadata) {
    videoEl.removeEventListener("loadedmetadata", this.handleLoadedMetadata)
  }
  if (videoEl && this.handleEnded) {
    videoEl.removeEventListener("ended", this.handleEnded)
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
