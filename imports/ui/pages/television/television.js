import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import "/imports/api/ticker/methods"
import { streamer } from "/imports/both/streamer"
import { getOrCreateClientId, getOrCreateDeviceKey, toShortCode } from "/imports/ui/lib/wallClientIdentity"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import "./television.html"

const WALL_REFRESH_EVENT = "ticker.refresh"
const WALL_HEARTBEAT_MS = 5 * 1000
const TELEVISION_WALL_COLS = 5
const TELEVISION_WALL_ROWS = 6
const TELEVISION_STOP_FADE_MS = 900
const TELEVISION_STARTUP_WATCHDOG_MS = 4000
const TELEVISION_RETRY_MIN_DELAY_MS = 2500
const TELEVISION_RETRY_MAX_DELAY_MS = 4500
const TELEVISION_MAX_RETRY_COUNT = 4

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
    // Ignore transient media readiness errors on mobile browsers.
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

function maybeReportMediaState(instance, playbackState = null) {
  const snapshot = instance.mediaSnapshot.get()
  const nextKey = JSON.stringify({
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    playbackState,
  })

  if (instance.lastReportedMediaKey === nextKey) {
    return
  }

  instance.lastReportedMediaKey = nextKey
  Meteor.callAsync("television.reportClientMediaState", {
    wallId: DEFAULT_WALL_ID,
    clientId: instance.clientId,
    readyState: snapshot.readyState,
    networkState: snapshot.networkState,
    errorCode: snapshot.errorCode,
    playbackState,
  }).catch((error) => {
    console.error("[television] failed to report media state", error)
  })
}

function retryDelayMs() {
  const span = TELEVISION_RETRY_MAX_DELAY_MS - TELEVISION_RETRY_MIN_DELAY_MS
  return TELEVISION_RETRY_MIN_DELAY_MS + Math.floor(Math.random() * (span + 1))
}

function clearStartupWatchdog(instance) {
  if (instance.startupWatchdogTimerId) {
    Meteor.clearTimeout(instance.startupWatchdogTimerId)
    instance.startupWatchdogTimerId = null
  }
}

function markStartupHealthy(instance, reason = "") {
  clearStartupWatchdog(instance)
  instance.retryCount.set(0)
  if (reason) {
    instance.watchdogStatus.set(reason)
  }
}

function scheduleVideoRetry(instance, reason) {
  const videoEl = instance.find("#televisionWallVideo")
  const televisionState = TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })
  if (!videoEl || !televisionState?.sourceUrl) {
    clearStartupWatchdog(instance)
    return
  }

  const nextRetryCount = instance.retryCount.get() + 1
  instance.retryCount.set(nextRetryCount)

  if (nextRetryCount > TELEVISION_MAX_RETRY_COUNT) {
    clearStartupWatchdog(instance)
    instance.watchdogStatus.set(`gave up after ${TELEVISION_MAX_RETRY_COUNT} retries (${reason})`)
    return
  }

  const delayMs = retryDelayMs()
  instance.watchdogStatus.set(`retry ${nextRetryCount}/${TELEVISION_MAX_RETRY_COUNT} in ${delayMs}ms (${reason})`)

  clearStartupWatchdog(instance)
  instance.startupWatchdogTimerId = Meteor.setTimeout(() => {
    instance.startupWatchdogTimerId = null
    const activeVideoEl = instance.find("#televisionWallVideo")
    const state = TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })
    if (!activeVideoEl || !state?.sourceUrl || state.playbackState !== "playing") {
      return
    }

    activeVideoEl.pause()
    activeVideoEl.removeAttribute("src")
    activeVideoEl.load()
    activeVideoEl.src = state.sourceUrl
    activeVideoEl.load()
    instance.mediaSnapshot.set(readMediaSnapshot(activeVideoEl))
    startStartupWatchdog(instance, "retry-load")
  }, delayMs)
}

function startStartupWatchdog(instance, reason = "startup") {
  const videoEl = instance.find("#televisionWallVideo")
  const televisionState = TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })
  if (!videoEl || televisionState?.playbackState !== "playing" || !televisionState?.sourceUrl) {
    clearStartupWatchdog(instance)
    return
  }

  if (Number(videoEl.readyState) >= 3) {
    markStartupHealthy(instance, `healthy (${reason})`)
    return
  }

  clearStartupWatchdog(instance)
  instance.watchdogStatus.set(`watching (${reason})`)
  instance.startupWatchdogTimerId = Meteor.setTimeout(() => {
    instance.startupWatchdogTimerId = null
    const activeVideoEl = instance.find("#televisionWallVideo")
    const snapshot = readMediaSnapshot(activeVideoEl)
    instance.mediaSnapshot.set(snapshot)

    if (snapshot.readyState >= 3) {
      markStartupHealthy(instance, `healthy after ${reason}`)
      return
    }

    if (snapshot.readyState === 0) {
      scheduleVideoRetry(instance, `stuck at readyState 0 after ${reason}`)
      return
    }

    instance.watchdogStatus.set(`waiting at readyState ${snapshot.readyState} after ${reason}`)
  }, TELEVISION_STARTUP_WATCHDOG_MS)
}

function syncVideoViewport(instance) {
  const videoEl = instance.find("#televisionWallVideo")
  if (!videoEl) {
    return
  }

  const selfClient = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
  const colIndex = Number.isInteger(selfClient?.colIndex) ? selfClient.colIndex : 0
  const rowIndex = Number.isInteger(selfClient?.rowIndex) ? selfClient.rowIndex : 0
  const clientWidth = Math.max(1, window.innerWidth)
  const clientHeight = Math.max(1, window.innerHeight)
  const totalWallWidth = clientWidth * TELEVISION_WALL_COLS
  const totalWallHeight = clientHeight * TELEVISION_WALL_ROWS
  const xStart = colIndex * clientWidth
  const yStart = rowIndex * clientHeight

  videoEl.style.width = `${totalWallWidth}px`
  videoEl.style.height = `${totalWallHeight}px`
  videoEl.style.left = `${-xStart}px`
  videoEl.style.top = `${-yStart}px`
  videoEl.style.objectFit = "cover"
}

function syncVideoPlayback(instance) {
  const videoEl = instance.find("#televisionWallVideo")
  const televisionState = TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })
  if (!videoEl) {
    return
  }

  const stateUpdatedAtMs = new Date(televisionState?.updatedAt).getTime()
  const isFreshCommand = Number.isFinite(stateUpdatedAtMs) && stateUpdatedAtMs >= instance.routeEnteredAtMs

  if (televisionState?.sourceUrl && !instance.hasAcceptedTelevisionCommand && !isFreshCommand) {
    instance.watchdogStatus.set("waiting for admin command")
    if (videoEl.getAttribute("src")) {
      videoEl.pause()
      videoEl.removeAttribute("src")
      videoEl.load()
    }
    maybeReportMediaState(instance, "waiting")
    return
  }

  if (isFreshCommand) {
    instance.hasAcceptedTelevisionCommand = true
  }

  if (!televisionState?.sourceUrl) {
    markStartupHealthy(instance, "no source")
    if (videoEl.getAttribute("src")) {
      videoEl.pause()
      videoEl.removeAttribute("src")
      videoEl.load()
    }
    instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
    maybeReportMediaState(instance, "idle")
    return
  }

  videoEl.muted = televisionState.muted !== false
  if (videoEl.getAttribute("src") !== televisionState.sourceUrl) {
    videoEl.src = televisionState.sourceUrl
    videoEl.load()
    startStartupWatchdog(instance, "src-change")
  }

  if (televisionState.playbackState === "loaded") {
    markStartupHealthy(instance, "loaded")
    if (instance.stopFadeKey !== null) {
      instance.stopFadeKey = null
    }
    videoEl.style.transition = `opacity ${TELEVISION_STOP_FADE_MS}ms ease`
    videoEl.style.opacity = "1"
    if (canSeekVideo(videoEl) && Math.abs(videoEl.currentTime) > 0.1) {
      safelySetCurrentTime(videoEl, 0)
    }
    videoEl.pause()
    instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
    maybeReportMediaState(instance, "loaded")
    return
  }

  if (televisionState.playbackState === "stopping") {
    markStartupHealthy(instance, "stopping")
    const stopKey = Number(televisionState.stopRequestedAtServerMs) || 0
    if (instance.stopFadeKey !== stopKey) {
      instance.stopFadeKey = stopKey
      videoEl.style.transition = `opacity ${TELEVISION_STOP_FADE_MS}ms ease`
      videoEl.style.opacity = "0"
      Meteor.clearTimeout(instance.stopFadeTimerId)
      instance.stopFadeTimerId = Meteor.setTimeout(() => {
        videoEl.pause()
        instance.stopFadeTimerId = null
      }, TELEVISION_STOP_FADE_MS)
    }
    instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
    maybeReportMediaState(instance, "stopping")
    return
  }

  if (televisionState.playbackState !== "playing") {
    markStartupHealthy(instance, `state=${televisionState.playbackState}`)
    instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
    maybeReportMediaState(instance, televisionState.playbackState)
    return
  }

  if (instance.stopFadeKey !== null) {
    instance.stopFadeKey = null
  }
  Meteor.clearTimeout(instance.stopFadeTimerId)
  instance.stopFadeTimerId = null
  videoEl.style.transition = `opacity ${TELEVISION_STOP_FADE_MS}ms ease`
  videoEl.style.opacity = "1"

  const duration = Number(videoEl.duration)
  if (!Number.isFinite(duration) || duration <= 0) {
    return
  }

  const elapsedSec = Math.max(0, ((Date.now() + instance.offsetMs) - Number(televisionState.startedAtServerMs)) / 1000)
  const targetTime = televisionState.loop === false
    ? Math.min(duration, elapsedSec)
    : elapsedSec % duration

  if (canSeekVideo(videoEl) && Math.abs(videoEl.currentTime - targetTime) > 0.35) {
    safelySetCurrentTime(videoEl, targetTime)
  }

  videoEl.play()
    .then(() => {
      instance.lastPlayError.set("")
      instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
      maybeReportMediaState(instance, "playing")
      if (Number(videoEl.readyState) >= 3) {
        markStartupHealthy(instance, "play resolved")
      } else {
        startStartupWatchdog(instance, "play-resolved")
      }
    })
    .catch((error) => {
      instance.lastPlayError.set(error?.message || String(error))
      instance.mediaSnapshot.set(readMediaSnapshot(videoEl))
      maybeReportMediaState(instance, "play-error")
      startStartupWatchdog(instance, "play-rejected")
    })
}

Template.TelevisionPage.onCreated(function onCreated() {
  this.routeEnteredAtMs = Date.now()
  this.hasAcceptedTelevisionCommand = false
  this.clientId = getOrCreateClientId()
  this.deviceKey = getOrCreateDeviceKey()
  this.shortCode = toShortCode(this.clientId)
  this.resizeTimeout = null
  this.timeSyncIntervalId = null
  this.heartbeatIntervalId = null
  this.offsetMs = 0
  this.refreshHandler = null
  this.routeControlHandler = null
  this.stopFadeTimerId = null
  this.stopFadeKey = null
  this.startupWatchdogTimerId = null
  this.mediaPollIntervalId = null
  this.mediaSnapshot = new ReactiveVar(readMediaSnapshot(null))
  this.lastMediaEvent = new ReactiveVar("none")
  this.lastPlayError = new ReactiveVar("")
  this.retryCount = new ReactiveVar(0)
  this.watchdogStatus = new ReactiveVar("idle")
  this.lastReportedMediaKey = null

  this.autorun(() => {
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.client.self", DEFAULT_WALL_ID, this.clientId)
    this.subscribe("television.state", DEFAULT_TELEVISION_STATE_ID)
  })
})

Template.TelevisionPage.onRendered(function onRendered() {
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
    if (target !== "ticker" && target !== "video" && target !== "kiss-o-matic" && target !== "disco") {
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
  streamer.on(TELEVISION_ROUTE_CONTROL_EVENT, this.routeControlHandler)

  const videoEl = this.find("#televisionWallVideo")
  if (videoEl) {
    videoEl.style.opacity = "1"
    videoEl.style.transition = `opacity ${TELEVISION_STOP_FADE_MS}ms ease`
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
    this.mediaEventHandlers = mediaEvents.map((eventName) => {
      const handler = () => {
        const suffix = videoEl.error?.code ? ` error=${videoEl.error.code}` : ""
        this.lastMediaEvent.set(`${eventName}${suffix}`)
        this.mediaSnapshot.set(readMediaSnapshot(videoEl))
        maybeReportMediaState(this, eventName)
        if (eventName === "playing" || Number(videoEl.readyState) >= 3) {
          markStartupHealthy(this, eventName)
        }
        if ((eventName === "stalled" || eventName === "abort" || eventName === "error") && Number(videoEl.readyState) === 0) {
          scheduleVideoRetry(this, eventName)
        }
      }
      videoEl.addEventListener(eventName, handler)
      return { eventName, handler }
    })
  }
  videoEl?.addEventListener("loadedmetadata", () => {
    syncVideoViewport(this)
    syncVideoPlayback(this)
    startStartupWatchdog(this, "loadedmetadata")
  })

  this.mediaPollIntervalId = Meteor.setInterval(() => {
    const activeVideoEl = this.find("#televisionWallVideo")
    this.mediaSnapshot.set(readMediaSnapshot(activeVideoEl))
    maybeReportMediaState(this, TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })?.playbackState ?? "unknown")
  }, 500)

  this.autorun(() => {
    syncVideoViewport(this)
    syncVideoPlayback(this)
  })
})

Template.TelevisionPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  Meteor.clearTimeout(this.stopFadeTimerId)
  clearStartupWatchdog(this)
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
    streamer.removeListener(TELEVISION_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  }
  const videoEl = this.find?.("#televisionWallVideo")
  for (const item of this.mediaEventHandlers ?? []) {
    videoEl?.removeEventListener(item.eventName, item.handler)
  }
})

Template.TelevisionPage.helpers({
  clientDoc() {
    const instance = Template.instance()
    return WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID }) ?? null
  },
  shortCode() {
    const instance = Template.instance()
    return WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })?.shortCode ?? "-----"
  },
  wallId() {
    return DEFAULT_WALL_ID
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
  hasAssignedSlice() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Number.isInteger(doc?.rowIndex) && Number.isInteger(doc?.colIndex)
  },
  xStart() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return (Number.isInteger(doc?.colIndex) ? doc.colIndex : 0) * window.innerWidth
  },
  yStart() {
    const instance = Template.instance()
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return (Number.isInteger(doc?.rowIndex) ? doc.rowIndex : 0) * window.innerHeight
  },
  currentSource() {
    return TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })?.sourceUrl ?? "none"
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
  isMediaReadyStateFull() {
    return Template.instance().mediaSnapshot.get().readyState >= 4
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
  retryCount() {
    return Template.instance().retryCount.get()
  },
  watchdogStatus() {
    return Template.instance().watchdogStatus.get()
  },
  isProvisioningMode() {
    const instance = Template.instance()
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    const doc = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
    return Boolean(wall?.provisioningEnabled) && !Number.isInteger(doc?.slotIndex)
  },
})

Template.TelevisionPage.events({
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
