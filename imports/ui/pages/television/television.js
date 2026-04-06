import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import "/imports/api/ticker/methods"
import "/imports/api/television/methods"
import { streamer } from "/imports/both/streamer"
import { getOrCreateClientId, getOrCreateDeviceKey, toShortCode } from "/imports/ui/lib/wallClientIdentity"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import "./television.html"

const WALL_REFRESH_EVENT = "ticker.refresh"
const WALL_HEARTBEAT_MS = 5 * 1000
const TELEVISION_WALL_COLS = 5
const TELEVISION_WALL_ROWS = 6
const TELEVISION_STOP_FADE_MS = 900

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

  if (!televisionState?.sourceUrl) {
    if (videoEl.getAttribute("src")) {
      videoEl.pause()
      videoEl.removeAttribute("src")
      videoEl.load()
    }
    return
  }

  videoEl.muted = televisionState.muted !== false
  if (videoEl.getAttribute("src") !== televisionState.sourceUrl) {
    videoEl.src = televisionState.sourceUrl
    videoEl.load()
  }

  if (televisionState.playbackState === "loaded") {
    if (instance.stopFadeKey !== null) {
      instance.stopFadeKey = null
    }
    videoEl.style.transition = `opacity ${TELEVISION_STOP_FADE_MS}ms ease`
    videoEl.style.opacity = "1"
    if (canSeekVideo(videoEl) && Math.abs(videoEl.currentTime) > 0.1) {
      safelySetCurrentTime(videoEl, 0)
    }
    videoEl.pause()
    return
  }

  if (televisionState.playbackState === "stopping") {
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
    return
  }

  if (televisionState.playbackState !== "playing") {
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

  videoEl.play().catch(() => {})
}

Template.TelevisionPage.onCreated(function onCreated() {
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
    if (target !== "ticker" && target !== "video") {
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
  }
  videoEl?.addEventListener("loadedmetadata", () => {
    syncVideoViewport(this)
    syncVideoPlayback(this)
  })

  this.autorun(() => {
    syncVideoViewport(this)
    syncVideoPlayback(this)
  })
})

Template.TelevisionPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  Meteor.clearTimeout(this.stopFadeTimerId)
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
})

Template.TelevisionPage.helpers({
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
