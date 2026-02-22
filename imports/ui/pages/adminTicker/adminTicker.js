import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"
import * as PIXI from "pixi.js"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import { streamer } from "/imports/both/streamer"
import { FAKE_MESSAGES } from "/imports/ui/pages/stage/stageTestData"
import "./adminTicker.html"

const DEFAULT_MEASURE_FONT_SIZE = 36
const DEFAULT_MEASURE_FONT_FAMILY = "Times New Roman"

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function measureTextWidthPx(text, { fontFamily, fontSizePx } = {}) {
  const normalizedFontFamily = typeof fontFamily === "string" && fontFamily.trim()
    ? fontFamily
    : DEFAULT_MEASURE_FONT_FAMILY
  const normalizedFontSize = Number.isFinite(Number(fontSizePx)) && Number(fontSizePx) > 0
    ? Number(fontSizePx)
    : DEFAULT_MEASURE_FONT_SIZE

  const metrics = PIXI.TextMetrics.measureText(
    text,
    new PIXI.TextStyle({
      fontFamily: normalizedFontFamily,
      fontSize: normalizedFontSize,
    }),
  )

  return Math.ceil(metrics.width)
}

Template.AdminTickerPage.onCreated(function onCreated() {
  this.panelWidth = new ReactiveVar(0)
  this.queueStatus = new ReactiveVar({ queueLength: 0, head: null })
  this.draggingClientId = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.clients", DEFAULT_TICKER_WALL_ID)
  })

  this.queuePollIntervalId = Meteor.setInterval(() => {
    Meteor.call("ticker.queueStatus", { wallId: DEFAULT_TICKER_WALL_ID }, (error, result) => {
      if (!error && result) {
        this.queueStatus.set(result)
      }
    })
  }, 1000)

  this.measureRequestHandler = (payload) => {
    if (!payload || payload.wallId !== DEFAULT_TICKER_WALL_ID) {
      return
    }

    const text = typeof payload.text === "string" ? payload.text : ""
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const textWidthPx = measureTextWidthPx(text, {
      fontFamily: payload.fontFamily,
      fontSizePx: payload.fontSizePx ?? wall?.minClientHeight,
    })

    Meteor.call("ticker.startRun", {
      wallId: payload.wallId,
      runId: payload.runId,
      text,
      textWidthPx,
    })
  }

  streamer.on("ticker.measure.request", this.measureRequestHandler)
})

Template.AdminTickerPage.onRendered(function onRendered() {
  const panel = this.find("#clientsPanel")
  const updatePanelWidth = () => {
    if (!panel) {
      return
    }

    this.panelWidth.set(panel.clientWidth || 0)
  }

  this.updatePanelWidth = updatePanelWidth
  updatePanelWidth()
  window.addEventListener("resize", updatePanelWidth)
})

Template.AdminTickerPage.onDestroyed(function onDestroyed() {
  if (this.queuePollIntervalId) {
    Meteor.clearInterval(this.queuePollIntervalId)
  }

  if (this.updatePanelWidth) {
    window.removeEventListener("resize", this.updatePanelWidth)
  }

  if (this.measureRequestHandler) {
    streamer.removeListener("ticker.measure.request", this.measureRequestHandler)
  }
})

Template.AdminTickerPage.helpers({
  wall() {
    return TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  },
  wallJson() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return JSON.stringify(wall ?? {}, null, 2)
  },
  clients() {
    return TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID },
      { sort: { orderIndex: 1, lastSeenAt: -1 } },
    )
  },
  clientCount() {
    return TickerClients.find({ wallId: DEFAULT_TICKER_WALL_ID }).count()
  },
  hasClients() {
    return TickerClients.find({ wallId: DEFAULT_TICKER_WALL_ID }).count() > 0
  },
  clientsForPanel() {
    const instance = Template.instance()
    const clients = TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID },
      { sort: { orderIndex: 1, lastSeenAt: -1 } },
    ).fetch()

    const totalWidth = clients.reduce((sum, client) => sum + (Number(client.width) || 0), 0)
    const panelWidth = instance.panelWidth.get()
    const scale = totalWidth > 0 && panelWidth > 0
      ? Math.min(0.25, panelWidth / totalWidth)
      : 0.25

    return clients.map((client) => {
      const trueWidth = Number(client.width) || 0
      const trueHeight = Number(client.height) || 0
      const rectWidth = Math.max(60, Math.round(trueWidth * scale))
      const rectHeight = Math.max(48, Math.round(trueHeight * scale))

      return {
        ...client,
        rectWidth,
        rectHeight,
        tooltip: `${client.shortCode || "-----"} | ${client.userAgent || "unknown ua"}`,
      }
    })
  },
  playingText() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.playing?.text ?? "none"
  },
  queueLength() {
    return Template.instance().queueStatus.get().queueLength ?? 0
  },
  queueHead() {
    return Template.instance().queueStatus.get().head?.text ?? "none"
  },
})

Template.AdminTickerPage.events({
  "pointerdown .js-client-card"(event) {
    const clientId = event.currentTarget.dataset.clientId
    Meteor.call("ticker.highlightClient", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId,
    })
  },
  "pointerup .js-client-card, pointercancel .js-client-card, pointerleave .js-client-card"() {
    Meteor.call("ticker.clearHighlight", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "dragstart .js-client-card"(event, instance) {
    const clientId = event.currentTarget.dataset.clientId
    instance.draggingClientId = clientId
    const dataTransfer = event.originalEvent?.dataTransfer ?? event.dataTransfer
    if (dataTransfer) {
      dataTransfer.effectAllowed = "move"
      dataTransfer.setData("text/plain", clientId)
    }
  },
  "dragover #clientsRow"(event) {
    event.preventDefault()
  },
  "drop #clientsRow"(event, instance) {
    event.preventDefault()
    const dataTransfer = event.originalEvent?.dataTransfer ?? event.dataTransfer
    const draggedClientId = instance.draggingClientId || dataTransfer?.getData("text/plain")
    const dropTarget = event.target.closest(".js-client-card")

    if (!draggedClientId || !dropTarget) {
      return
    }

    const targetClientId = dropTarget.dataset.clientId
    const clients = TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID },
      { sort: { orderIndex: 1, lastSeenAt: -1 } },
    ).fetch()
    const orderedIds = clients.map((client) => client._id)

    const fromIndex = orderedIds.indexOf(draggedClientId)
    const toIndex = orderedIds.indexOf(targetClientId)
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return
    }

    orderedIds.splice(fromIndex, 1)
    orderedIds.splice(toIndex, 0, draggedClientId)

    Meteor.call("ticker.setOrder", {
      wallId: DEFAULT_TICKER_WALL_ID,
      orderedClientIds: orderedIds,
    })
  },
  "click .js-remove-client"(event) {
    event.preventDefault()
    event.stopPropagation()

    Meteor.call("ticker.removeClient", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: event.currentTarget.dataset.clientId,
    })
  },
  "click .js-set-speed"(event, instance) {
    event.preventDefault()
    const speedInput = instance.find("#tickerSpeedInput")
    const speedPxPerSec = Number(speedInput?.value)

    Meteor.call("ticker.setSpeed", {
      wallId: DEFAULT_TICKER_WALL_ID,
      speedPxPerSec,
    })
  },
  "click .js-send-random-text"(event) {
    event.preventDefault()
    Meteor.call("ticker.enqueueText", {
      wallId: DEFAULT_TICKER_WALL_ID,
      text: randomFrom(FAKE_MESSAGES),
    })
  },
  "click .js-clear-queue"(event) {
    event.preventDefault()
    Meteor.call("ticker.clearQueue", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "click .js-panic-stop"(event) {
    event.preventDefault()
    Meteor.call("ticker.panicStop", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "click .js-kill-clients"(event) {
    event.preventDefault()
    Meteor.call("ticker.killClients", { wallId: DEFAULT_TICKER_WALL_ID })
  },
})
