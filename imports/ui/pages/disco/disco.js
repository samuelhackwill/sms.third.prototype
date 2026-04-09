import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"

import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import "/imports/api/wall/publications"
import { streamer } from "/imports/both/streamer"
import { getOrCreateClientId, getOrCreateDeviceKey, toShortCode } from "/imports/ui/lib/wallClientIdentity"
import { DISCO_ROUTE_CONTROL_EVENT } from "./discoEvents"
import "./disco.html"

const WALL_REFRESH_EVENT = "ticker.refresh"
const WALL_HEARTBEAT_MS = 5 * 1000
const DEFAULT_DISCO_COLUMN_INTERVAL_MS = 500
const DISCO_PALETTE = [
  "#ff4d6d",
  "#ffd166",
  "#06d6a0",
  "#118ab2",
  "#f72585",
  "#7209b7",
]

function currentDiscoMode() {
  return Walls.findOne({ _id: DEFAULT_WALL_ID })?.discoMode ?? "column_wave"
}

function currentIntervalMs() {
  const value = Number(Walls.findOne({ _id: DEFAULT_WALL_ID })?.discoColumnIntervalMs)
  return Number.isFinite(value) ? value : DEFAULT_DISCO_COLUMN_INTERVAL_MS
}

function currentStartedAtServerMs() {
  const value = Number(Walls.findOne({ _id: DEFAULT_WALL_ID })?.discoStartedAtServerMs)
  return Number.isFinite(value) ? value : Date.now()
}

function activeColorFor(instance) {
  const client = WallClients.findOne({ _id: instance.clientId, wallId: DEFAULT_WALL_ID })
  const colIndex = Number.isInteger(client?.colIndex) ? client.colIndex : 0
  const intervalMs = currentIntervalMs()
  const startedAtServerMs = currentStartedAtServerMs()
  const nowServerMs = Date.now() + instance.offsetMs
  const step = Math.max(0, Math.floor((nowServerMs - startedAtServerMs) / intervalMs))
  const colorIndex = ((step - colIndex) % DISCO_PALETTE.length + DISCO_PALETTE.length) % DISCO_PALETTE.length
  return {
    color: DISCO_PALETTE[colorIndex],
    step,
  }
}

function applyDiscoFrame(instance) {
  const root = instance.find("#discoRoot")
  if (!root) {
    return
  }

  const { color, step } = activeColorFor(instance)
  root.style.transition = `background-color ${Math.max(80, Math.floor(currentIntervalMs() * 0.8))}ms ease`
  root.style.backgroundColor = color
  instance.activeColor.set(color)
  instance.columnStep.set(step)
}

Template.DiscoPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.deviceKey = getOrCreateDeviceKey()
  this.shortCode = toShortCode(this.clientId)
  this.offsetMs = 0
  this.resizeTimeout = null
  this.timeSyncIntervalId = null
  this.heartbeatIntervalId = null
  this.frameIntervalId = null
  this.refreshHandler = null
  this.routeControlHandler = null
  this.activeColor = new ReactiveVar("#000000")
  this.columnStep = new ReactiveVar(0)

  this.autorun(() => {
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.client.self", DEFAULT_WALL_ID, this.clientId)
  })
})

Template.DiscoPage.onRendered(function onRendered() {
  Meteor.callAsync("disco.ensureState", { wallId: DEFAULT_WALL_ID }).catch((error) => {
    console.error("[disco] failed to ensure state", error)
  })

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
      applyDiscoFrame(this)
    })
  }

  this.handleResize = () => {
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

  this.frameIntervalId = Meteor.setInterval(() => {
    applyDiscoFrame(this)
  }, 100)

  window.addEventListener("resize", this.handleResize)
  streamer.on(WALL_REFRESH_EVENT, this.refreshHandler)
  streamer.on(DISCO_ROUTE_CONTROL_EVENT, this.routeControlHandler)

  this.autorun(() => {
    currentIntervalMs()
    currentStartedAtServerMs()
    currentDiscoMode()
    WallClients.findOne({ _id: this.clientId, wallId: DEFAULT_WALL_ID })
    applyDiscoFrame(this)
  })
})

Template.DiscoPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  if (this.timeSyncIntervalId) {
    Meteor.clearInterval(this.timeSyncIntervalId)
  }
  if (this.heartbeatIntervalId) {
    Meteor.clearInterval(this.heartbeatIntervalId)
  }
  if (this.frameIntervalId) {
    Meteor.clearInterval(this.frameIntervalId)
  }
  if (this.refreshHandler) {
    streamer.removeListener(WALL_REFRESH_EVENT, this.refreshHandler)
  }
  if (this.routeControlHandler) {
    streamer.removeListener(DISCO_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  }
})

Template.DiscoPage.helpers({
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
  discoMode() {
    return currentDiscoMode()
  },
  columnIntervalMs() {
    return currentIntervalMs()
  },
  columnStep() {
    return Template.instance().columnStep.get()
  },
  activeColor() {
    return Template.instance().activeColor.get()
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

Template.DiscoPage.events({
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
