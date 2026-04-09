import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import { DEFAULT_KISS_O_MATIC_STATE_ID, KissOMaticStates } from "/imports/api/kissOMatic/collections"
import "/imports/api/kissOMatic/publications"
import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import { streamer } from "/imports/both/streamer"
import { getOrCreateClientId, getOrCreateDeviceKey, toShortCode } from "/imports/ui/lib/wallClientIdentity"
import { KISS_O_MATIC_ROUTE_CONTROL_EVENT } from "./kissOMaticEvents"
import "./kissOMatic.html"

const WALL_REFRESH_EVENT = "ticker.refresh"
const WALL_HEARTBEAT_MS = 5 * 1000
const KISS_O_MATIC_WALL_COLS = 5
const KISS_O_MATIC_WALL_ROWS = 6
const DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC = 1
const DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC = 1

function canSeekVideo(videoEl) {
  return Boolean(videoEl) && Number(videoEl.readyState) >= 1
}

function safelySetCurrentTime(videoEl, nextTime) {
  if (!canSeekVideo(videoEl) || !Number.isFinite(nextTime)) {
    return
  }

  try {
    videoEl.currentTime = nextTime
  } catch (error) {
    // Ignore transient readiness failures on mobile browsers.
  }
}

function readMediaSnapshot(videoEl) {
  if (!videoEl) {
    return {
      paused: true,
      readyState: 0,
      networkState: 0,
      currentTime: 0,
      duration: null,
      errorCode: null,
      src: "",
    }
  }

  return {
    paused: Boolean(videoEl.paused),
    readyState: Number(videoEl.readyState) || 0,
    networkState: Number(videoEl.networkState) || 0,
    currentTime: Number.isFinite(videoEl.currentTime) ? Number(videoEl.currentTime) : 0,
    duration: Number.isFinite(videoEl.duration) ? Number(videoEl.duration) : null,
    errorCode: Number(videoEl.error?.code) || null,
    src: videoEl.currentSrc || videoEl.getAttribute("src") || "",
  }
}

function currentState() {
  return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID }) ?? null
}

function currentClip(state = currentState()) {
  return state?.currentClip ?? null
}

function nextClip(state = currentState()) {
  return state?.nextClip ?? null
}

function effectiveTrimWindow(clip, state, videoEl) {
  const rawTrimStartSec = Number(clip?.trimStartSec)
  const rawTrimEndSec = Number(clip?.trimEndSec)
  const trimStartOffsetSec = Number(state?.trimStartOffsetSec)
  const trimEndOffsetSec = Number(state?.trimEndOffsetSec)
  const durationSec = Number(videoEl?.duration)

  if (!Number.isFinite(rawTrimStartSec) || !Number.isFinite(rawTrimEndSec)) {
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return null
    }

    return {
      startSec: 0,
      endSec: durationSec,
    }
  }

  if (!Number.isFinite(rawTrimStartSec) || !Number.isFinite(rawTrimEndSec) || rawTrimEndSec <= rawTrimStartSec) {
    return null
  }

  const startSec = Math.max(
    0,
    rawTrimStartSec - (Number.isFinite(trimStartOffsetSec) ? trimStartOffsetSec : DEFAULT_KISS_O_MATIC_TRIM_START_OFFSET_SEC),
  )
  const unclampedEndSec = rawTrimEndSec + (
    Number.isFinite(trimEndOffsetSec) ? trimEndOffsetSec : DEFAULT_KISS_O_MATIC_TRIM_END_OFFSET_SEC
  )
  const endSec = Number.isFinite(durationSec) && durationSec > 0
    ? Math.min(durationSec, unclampedEndSec)
    : unclampedEndSec

  if (!Number.isFinite(endSec) || endSec <= startSec) {
    return null
  }

  return { startSec, endSec }
}

function maybeReportMediaState(instance, playbackState = null) {
  const snapshot = instance.mediaSnapshot.get()
  const nextKey = JSON.stringify({
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    playbackState,
    activeBufferKey: instance.activeBufferKey,
  })

  if (instance.lastReportedMediaKey === nextKey) {
    return
  }

  instance.lastReportedMediaKey = nextKey
  Meteor.callAsync("kissOMatic.reportClientMediaState", {
    wallId: DEFAULT_WALL_ID,
    clientId: instance.clientId,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    playbackState,
  }).catch((error) => {
    console.error("[kiss-o-matic] failed to report media state", error)
  })
}

function videoForBuffer(instance, key) {
  const id = key === "a" ? "#kissOMaticWallVideoA" : "#kissOMaticWallVideoB"
  return instance.find(id)
}

function otherBufferKey(key) {
  return key === "a" ? "b" : "a"
}

function bufferState(instance, key) {
  return instance.buffers[key]
}

function clipIdentityKey(clip) {
  if (!clip) {
    return "none"
  }

  return clip.token || `${clip.sourceUrl || ""}:${clip.trimStartSec || 0}:${clip.trimEndSec || 0}`
}

function updateMediaSnapshotFromActive(instance) {
  const activeVideoEl = videoForBuffer(instance, instance.activeBufferKey)
  instance.mediaSnapshot.set(readMediaSnapshot(activeVideoEl))
}

function applyBufferVisibility(instance) {
  for (const key of ["a", "b"]) {
    const videoEl = videoForBuffer(instance, key)
    if (!videoEl) {
      continue
    }

    const isActive = key === instance.activeBufferKey
    videoEl.style.visibility = isActive ? "visible" : "hidden"
    videoEl.style.zIndex = isActive ? "2" : "1"
  }
}

function syncVideoViewport(instance) {
  const selfClient = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
  const colIndex = Number.isInteger(selfClient?.colIndex) ? selfClient.colIndex : 0
  const rowIndex = Number.isInteger(selfClient?.rowIndex) ? selfClient.rowIndex : 0
  const clientWidth = Math.max(1, window.innerWidth)
  const clientHeight = Math.max(1, window.innerHeight)
  const totalWallWidth = clientWidth * KISS_O_MATIC_WALL_COLS
  const totalWallHeight = clientHeight * KISS_O_MATIC_WALL_ROWS
  const xStart = colIndex * clientWidth
  const yStart = rowIndex * clientHeight

  for (const key of ["a", "b"]) {
    const videoEl = videoForBuffer(instance, key)
    if (!videoEl) {
      continue
    }

    videoEl.style.width = `${totalWallWidth}px`
    videoEl.style.height = `${totalWallHeight}px`
    videoEl.style.left = `${-xStart}px`
    videoEl.style.top = `${-yStart}px`
    videoEl.style.objectFit = "cover"
  }
}

function unloadBuffer(instance, key) {
  const videoEl = videoForBuffer(instance, key)
  const state = bufferState(instance, key)
  if (!videoEl || !state) {
    return
  }

  try {
    videoEl.pause()
  } catch (error) {
    // ignore pause failures
  }

  state.clipKey = null
  state.isPrimed = false
  videoEl.removeAttribute("src")
  videoEl.load()
}

function ensureBufferLoaded(instance, key, clip) {
  const videoEl = videoForBuffer(instance, key)
  const state = bufferState(instance, key)
  if (!videoEl || !state) {
    return
  }

  const nextClipKey = clipIdentityKey(clip)
  if (!clip || !clip.sourceUrl) {
    unloadBuffer(instance, key)
    return
  }

  if (state.clipKey === nextClipKey && videoEl.getAttribute("src") === clip.sourceUrl) {
    return
  }

  state.clipKey = nextClipKey
  state.isPrimed = false
  videoEl.src = clip.sourceUrl
  videoEl.load()
}

function primeBufferAtClipStart(instance, key, clip, stateDoc) {
  const videoEl = videoForBuffer(instance, key)
  const state = bufferState(instance, key)
  if (!videoEl || !state || !clip) {
    return false
  }

  const trimWindow = effectiveTrimWindow(clip, stateDoc, videoEl)
  if (!trimWindow) {
    return false
  }

  if (!state.isPrimed && canSeekVideo(videoEl)) {
    safelySetCurrentTime(videoEl, trimWindow.startSec)
    state.isPrimed = true
  }

  return state.isPrimed
}

function promoteCurrentClipBuffer(instance, clip) {
  const currentKey = clipIdentityKey(clip)
  if (instance.pendingSwitchClipKey && instance.pendingSwitchClipKey !== currentKey) {
    return
  }

  if (bufferState(instance, instance.activeBufferKey)?.clipKey === currentKey) {
    if (instance.pendingSwitchClipKey === currentKey) {
      instance.pendingSwitchClipKey = null
    }
    return
  }

  const alternateKey = otherBufferKey(instance.activeBufferKey)
  if (bufferState(instance, alternateKey)?.clipKey === currentKey) {
    instance.activeBufferKey = alternateKey
    applyBufferVisibility(instance)
    if (instance.pendingSwitchClipKey === currentKey) {
      instance.pendingSwitchClipKey = null
    }
  }
}

function syncVideoPlayback(instance) {
  const stateDoc = currentState()
  const current = currentClip(stateDoc)
  const upcoming = nextClip(stateDoc)

  if (!current?.sourceUrl) {
    instance.pendingSwitchClipKey = null
    unloadBuffer(instance, "a")
    unloadBuffer(instance, "b")
    applyBufferVisibility(instance)
    updateMediaSnapshotFromActive(instance)
    maybeReportMediaState(instance, "idle")
    return
  }

  promoteCurrentClipBuffer(instance, current)
  ensureBufferLoaded(instance, instance.activeBufferKey, current)
  ensureBufferLoaded(instance, otherBufferKey(instance.activeBufferKey), upcoming)

  const activeVideoEl = videoForBuffer(instance, instance.activeBufferKey)
  const inactiveKey = otherBufferKey(instance.activeBufferKey)
  const inactiveVideoEl = videoForBuffer(instance, inactiveKey)
  if (!activeVideoEl) {
    return
  }

  activeVideoEl.muted = true
  if (inactiveVideoEl) {
    inactiveVideoEl.muted = true
  }

  if (Number(activeVideoEl.readyState) < 1) {
    updateMediaSnapshotFromActive(instance)
    maybeReportMediaState(instance, "loading")
    return
  }

  const activeTrimWindow = effectiveTrimWindow(current, stateDoc, activeVideoEl)
  const startedAtServerMs = Number(stateDoc?.startedAtServerMs)
  const switchAtServerMs = Number(stateDoc?.switchAtServerMs)
  if (!activeTrimWindow || !Number.isFinite(startedAtServerMs)) {
    updateMediaSnapshotFromActive(instance)
    maybeReportMediaState(instance, "invalid-trim")
    return
  }

  if (stateDoc?.playbackState === "stopping") {
    try {
      activeVideoEl.pause()
      inactiveVideoEl?.pause()
    } catch (error) {
      // ignore pause failures
    }
    updateMediaSnapshotFromActive(instance)
    maybeReportMediaState(instance, "stopping")
    return
  }

  const nowServerMs = Date.now() + instance.offsetMs
  const elapsedSec = Math.max(0, (nowServerMs - startedAtServerMs) / 1000)
  const targetTime = Math.min(activeTrimWindow.endSec, activeTrimWindow.startSec + elapsedSec)
  if (canSeekVideo(activeVideoEl) && Math.abs(activeVideoEl.currentTime - targetTime) > 0.35) {
    safelySetCurrentTime(activeVideoEl, targetTime)
  }

  const remainingMs = Math.max(0, switchAtServerMs - nowServerMs)
  const shouldSwitchNow = Boolean(upcoming?.sourceUrl) && Number.isFinite(switchAtServerMs) && remainingMs <= 0
  const nextSwitchClipKey = shouldSwitchNow ? clipIdentityKey(upcoming) : null

  if (shouldSwitchNow && inactiveVideoEl && primeBufferAtClipStart(instance, inactiveKey, upcoming, stateDoc)) {
    instance.pendingSwitchClipKey = nextSwitchClipKey
    instance.activeBufferKey = inactiveKey
    applyBufferVisibility(instance)
    inactiveVideoEl.play().catch(() => {})
    try {
      activeVideoEl.pause()
    } catch (error) {
      // ignore pause failures
    }
  } else {
    if (!instance.pendingSwitchClipKey) {
      applyBufferVisibility(instance)
    }
    if (inactiveVideoEl) {
      inactiveVideoEl.pause()
      primeBufferAtClipStart(instance, inactiveKey, upcoming, stateDoc)
    }
  }

  activeVideoEl.play()
    .then(() => {
      instance.lastPlayError.set("")
      updateMediaSnapshotFromActive(instance)
      maybeReportMediaState(instance, "playing")
    })
    .catch((error) => {
      instance.lastPlayError.set(error?.message || String(error))
      updateMediaSnapshotFromActive(instance)
      maybeReportMediaState(instance, "play-error")
    })
}

Template.KissOMaticPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.deviceKey = getOrCreateDeviceKey()
  this.shortCode = toShortCode(this.clientId)
  this.offsetMs = 0
  this.resizeTimeout = null
  this.timeSyncIntervalId = null
  this.heartbeatIntervalId = null
  this.refreshHandler = null
  this.routeControlHandler = null
  this.mediaPollIntervalId = null
  this.mediaEventHandlers = []
  this.activeBufferKey = "a"
  this.pendingSwitchClipKey = null
  this.buffers = {
    a: { clipKey: null, isPrimed: false },
    b: { clipKey: null, isPrimed: false },
  }
  this.mediaSnapshot = new ReactiveVar(readMediaSnapshot(null))
  this.lastMediaEvent = new ReactiveVar("none")
  this.lastPlayError = new ReactiveVar("")
  this.lastReportedMediaKey = null

  this.autorun(() => {
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.client.self", DEFAULT_WALL_ID, this.clientId)
    this.subscribe("kissOMatic.state", DEFAULT_KISS_O_MATIC_STATE_ID)
  })
})

Template.KissOMaticPage.onRendered(function onRendered() {
  const syncServerTimeOffset = () => {
    const t0 = Date.now()
    Meteor.call("ticker.time", (error, serverTimeMs) => {
      if (error || typeof serverTimeMs !== "number") {
        return
      }

      const t1 = Date.now()
      const rtt = t1 - t0
      const estimatedServerNowAtT1 = serverTimeMs + (rtt / 2)
      this.offsetMs = estimatedServerNowAtT1 - t1
      syncVideoPlayback(this)
    })
  }

  this.handleResize = () => {
    syncVideoViewport(this)
    Meteor.clearTimeout(this.resizeTimeout)
    this.resizeTimeout = Meteor.setTimeout(() => {
      Meteor.callAsync("ticker.updateSize", {
        wallId: DEFAULT_WALL_ID,
        clientId: this.clientId,
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }, 120)
  }

  this.refreshHandler = (payload) => {
    if (payload?.wallId && payload.wallId !== DEFAULT_WALL_ID) {
      return
    }

    window.location.reload()
  }

  this.routeControlHandler = (payload) => {
    const target = payload?.target
    if (target !== "ticker" && target !== "video" && target !== "television" && target !== "kiss-o-matic" && target !== "disco") {
      return
    }

    FlowRouter.go(`/${target}`)
  }

  Meteor.callAsync("ticker.join", {
    wallId: DEFAULT_WALL_ID,
    clientId: this.clientId,
    deviceKey: this.deviceKey,
    shortCode: this.shortCode,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  })

  syncServerTimeOffset()
  this.timeSyncIntervalId = Meteor.setInterval(syncServerTimeOffset, 5000)
  this.heartbeatIntervalId = Meteor.setInterval(() => {
    Meteor.callAsync("ticker.heartbeat", {
      wallId: DEFAULT_WALL_ID,
      clientId: this.clientId,
    })
  }, WALL_HEARTBEAT_MS)

  window.addEventListener("resize", this.handleResize)
  streamer.on(WALL_REFRESH_EVENT, this.refreshHandler)
  streamer.on(KISS_O_MATIC_ROUTE_CONTROL_EVENT, this.routeControlHandler)

  const mediaEvents = [
    "loadstart",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "play",
    "playing",
    "pause",
    "waiting",
    "stalled",
    "suspend",
    "abort",
    "emptied",
    "ended",
    "error",
  ]

  this.mediaEventHandlers = ["a", "b"].flatMap((key) => {
    const videoEl = videoForBuffer(this, key)
    if (!videoEl) {
      return []
    }

    videoEl.style.visibility = key === this.activeBufferKey ? "visible" : "hidden"
    videoEl.style.zIndex = key === this.activeBufferKey ? "2" : "1"

    return mediaEvents.map((eventName) => {
      const handler = () => {
        const suffix = videoEl.error?.code ? ` error=${videoEl.error.code}` : ""
        this.lastMediaEvent.set(`${key}:${eventName}${suffix}`)
        updateMediaSnapshotFromActive(this)
        maybeReportMediaState(this, eventName)
        if (eventName === "ended" && key === this.activeBufferKey) {
          Meteor.callAsync("kissOMatic.advancePlaylistIfCurrent", {
            stateId: DEFAULT_KISS_O_MATIC_STATE_ID,
            currentClipToken: currentClip()?.token ?? null,
          }).catch((error) => {
            console.error("[kiss-o-matic] failed to advance on ended", error)
          })
        }
        if (eventName === "loadedmetadata") {
          const clip = key === this.activeBufferKey ? currentClip() : nextClip()
          primeBufferAtClipStart(this, key, clip, currentState())
          syncVideoViewport(this)
          syncVideoPlayback(this)
        }
      }

      videoEl.addEventListener(eventName, handler)
      return { key, eventName, handler }
    })
  })

  this.mediaPollIntervalId = Meteor.setInterval(() => {
    updateMediaSnapshotFromActive(this)
    maybeReportMediaState(this, currentState()?.playbackState ?? "unknown")
  }, 500)

  this.autorun(() => {
    syncVideoViewport(this)
    syncVideoPlayback(this)
  })
})

Template.KissOMaticPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  if (this.mediaPollIntervalId) {
    Meteor.clearInterval(this.mediaPollIntervalId)
  }
  if (this.timeSyncIntervalId) {
    Meteor.clearInterval(this.timeSyncIntervalId)
  }
  if (this.heartbeatIntervalId) {
    Meteor.clearInterval(this.heartbeatIntervalId)
  }
  if (this.refreshHandler) {
    streamer.removeListener(WALL_REFRESH_EVENT, this.refreshHandler)
  }
  if (this.routeControlHandler) {
    streamer.removeListener(KISS_O_MATIC_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  }

  for (const item of this.mediaEventHandlers ?? []) {
    const videoEl = videoForBuffer(this, item.key)
    videoEl?.removeEventListener(item.eventName, item.handler)
  }
})

Template.KissOMaticPage.helpers({
  shortCode() {
    const instance = Template.instance()
    return WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })?.shortCode ?? "-----"
  },
  rowIndex() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Number.isInteger(doc?.rowIndex) ? doc.rowIndex : "-"
  },
  colIndex() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Number.isInteger(doc?.colIndex) ? doc.colIndex : "-"
  },
  slotIndex() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Number.isInteger(doc?.slotIndex) ? doc.slotIndex : "-"
  },
  currentSource() {
    return currentClip()?.sourceUrl ?? "none"
  },
  playbackState() {
    return currentState()?.playbackState ?? "idle"
  },
  trimRange() {
    const clip = currentClip()
    const trimWindow = effectiveTrimWindow(clip, currentState(), null)
    if (!trimWindow) {
      return "none"
    }

    return `${trimWindow.startSec.toFixed(2)}-${trimWindow.endSec.toFixed(2)}`
  },
  showDebug() {
    return Walls.findOne({ _id: DEFAULT_WALL_ID })?.showDebug !== false
  },
  mediaPaused() {
    return Template.instance().mediaSnapshot.get().paused ? "yes" : "no"
  },
  mediaReadyState() {
    return Template.instance().mediaSnapshot.get().readyState
  },
  mediaReadyStateClass() {
    const readyState = Template.instance().mediaSnapshot.get().readyState
    if (readyState >= 4) {
      return "text-emerald-300"
    }
    if (readyState >= 3) {
      return "text-amber-300"
    }
    return "text-red-300"
  },
  mediaNetworkState() {
    return Template.instance().mediaSnapshot.get().networkState
  },
  mediaCurrentTime() {
    return Template.instance().mediaSnapshot.get().currentTime.toFixed(2)
  },
  mediaDuration() {
    const duration = Template.instance().mediaSnapshot.get().duration
    return Number.isFinite(duration) ? duration.toFixed(2) : "-"
  },
  mediaErrorCode() {
    return Template.instance().mediaSnapshot.get().errorCode ?? "-"
  },
  lastMediaEvent() {
    return Template.instance().lastMediaEvent.get()
  },
  lastPlayError() {
    return Template.instance().lastPlayError.get() || "none"
  },
  isProvisioningMode() {
    const instance = Template.instance()
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Boolean(wall?.provisioningEnabled) && !Number.isInteger(doc?.slotIndex)
  },
})

Template.KissOMaticPage.events({
  "click main"(event, instance) {
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    if (!wall?.provisioningEnabled || Number.isInteger(doc?.slotIndex)) {
      return
    }

    Meteor.callAsync("ticker.claimNextSlot", {
      wallId: DEFAULT_WALL_ID,
      clientId: instance.clientId,
    })
  },
})
