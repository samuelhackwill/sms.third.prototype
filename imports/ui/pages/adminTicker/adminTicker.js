import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import { streamer } from "/imports/both/streamer"
import { FAKE_MESSAGES } from "/imports/ui/pages/stage/stageTestData"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/pages/adminTicker/adminTickerPage.html"

const PROVISIONING_ROWS = 6
const PROVISIONING_COLS = 5
const PROVISIONING_SLOT_COUNT = PROVISIONING_ROWS * PROVISIONING_COLS
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function isActiveClient(client) {
  const lastSeenAtMs = new Date(client?.lastSeenAt).getTime()
  if (!Number.isFinite(lastSeenAtMs)) {
    return false
  }

  return (Date.now() - lastSeenAtMs) <= TICKER_CLIENT_STALE_AFTER_MS
}

Template.AdminTickerPage.onCreated(function onCreated() {
  this.panelWidth = new ReactiveVar(0)
  this.draggingClientId = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.clients", DEFAULT_TICKER_WALL_ID)
  })
})

Template.AdminTickerPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")

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
  document.body.classList.remove("admin-page")

  if (this.updatePanelWidth) {
    window.removeEventListener("resize", this.updatePanelWidth)
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
  playingSummary() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const rows = wall?.queueState?.rows ?? []
    const activeRows = rows
      .filter((row) => row?.playing?.text)
      .map((row) => `r${row.rowIndex + 1}: ${row.playing.text}`)

    return activeRows.length > 0 ? activeRows.join(" | ") : "none"
  },
  activeClientCount() {
    return TickerClients.find({ wallId: DEFAULT_TICKER_WALL_ID }).fetch().filter(isActiveClient).length
  },
  wallDebugJson() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return JSON.stringify(wall ?? {}, null, 2)
  },
  clientsDebugJson() {
    const clients = TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID },
      { sort: { slotIndex: 1, orderIndex: 1, lastSeenAt: -1 } },
    ).fetch()
    return JSON.stringify(clients, null, 2)
  },
  provisioningButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.provisioningEnabled
      ? "Disable Provisioning Blink"
      : "Enable Provisioning Blink"
  },
  debugButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.showDebug === false ? "Show Debug" : "Hide Debug"
  },
  isDisplayModeChorus() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.displayMode ?? "chorus") === "chorus"
  },
  isDisplayModeWall() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.displayMode === "wall"
  },
  isDisplayModeVertical() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.displayMode === "vertical"
  },
  queueMachineState() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.machineState ?? "idle"
  },
  queueDepth() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.queuedCount ?? 0
  },
  tickerRows() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const rows = wall?.queueState?.rows ?? []
    const rowMetrics = wall?.rowMetrics ?? []

    return rows.map((row) => {
      const metrics = rowMetrics.find((candidate) => candidate.rowIndex === row.rowIndex)
      return {
        rowIndex: row.rowIndex,
        rowNumber: row.rowIndex + 1,
        state: row.state,
        isInverted: Boolean(row.isInverted),
        widthPx: metrics?.widthPx ?? 0,
        activeClientCount: metrics?.activeClientCount ?? 0,
        rowContent: row?.playing?.text ?? "none",
        overflowFlashCount: row?.overflowFlashCount ?? 0,
      }
    })
  },
  provisioningRows() {
    const assignedClients = TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID, slotIndex: { $ne: null } },
      { sort: { slotIndex: 1 } },
    ).fetch()
    const slots = Array.from({ length: PROVISIONING_SLOT_COUNT }, (_, index) => {
      const assignedClient = assignedClients.find((client) => client.slotIndex === index)

      return {
        slotIndex: index,
        slotNumber: index + 1,
        shortCode: assignedClient?.shortCode ?? null,
        clientId: assignedClient?._id ?? null,
      }
    })
    const rows = []

    for (let rowIndex = 0; rowIndex < PROVISIONING_ROWS; rowIndex += 1) {
      rows.push(
        slots.slice(rowIndex * PROVISIONING_COLS, (rowIndex + 1) * PROVISIONING_COLS),
      )
    }

    return rows
  },
})

Template.AdminTickerPage.events({
  "pointerdown .js-client-card"(event) {
    const clientId = event.currentTarget.dataset.clientId
    Meteor.callAsync("ticker.highlightClient", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId,
    })
  },
  "pointerup .js-client-card, pointercancel .js-client-card, pointerleave .js-client-card"() {
    Meteor.callAsync("ticker.clearHighlight", { wallId: DEFAULT_TICKER_WALL_ID })
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

    Meteor.callAsync("ticker.setOrder", {
      wallId: DEFAULT_TICKER_WALL_ID,
      orderedClientIds: orderedIds,
    })
  },
  "click .js-remove-client"(event) {
    event.preventDefault()
    event.stopPropagation()

    Meteor.callAsync("ticker.removeClient", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: event.currentTarget.dataset.clientId,
    })
  },
  "click .js-set-speed"(event, instance) {
    event.preventDefault()
    const speedInput = instance.find("#tickerSpeedInput")
    const speedPxPerSec = Number(speedInput?.value)

    Meteor.callAsync("ticker.setSpeed", {
      wallId: DEFAULT_TICKER_WALL_ID,
      speedPxPerSec,
    })
  },
  "click .js-send-random-text"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.enqueueText", {
      wallId: DEFAULT_TICKER_WALL_ID,
      text: randomFrom(FAKE_MESSAGES),
    })
  },
  "click .js-move-ticker-clients-to-video"(event) {
    event.preventDefault()
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, {
      from: "ticker",
      target: "video",
    })
  },
  "click .js-toggle-provisioning"(event, instance) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextEnabled = !Boolean(wall?.provisioningEnabled)
    Meteor.callAsync("ticker.setProvisioningEnabled", {
      wallId: DEFAULT_TICKER_WALL_ID,
      enabled: nextEnabled,
    })
  },
  "click .js-toggle-debug"(event) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    Meteor.callAsync("ticker.setShowDebug", {
      wallId: DEFAULT_TICKER_WALL_ID,
      showDebug: wall?.showDebug === false,
    })
  },
  "change input[name='tickerDisplayMode']"(event) {
    const displayMode = event.currentTarget.value
    Meteor.callAsync("ticker.setDisplayMode", {
      wallId: DEFAULT_TICKER_WALL_ID,
      displayMode,
    })
  },
  "click .js-panic-stop"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.panicStop", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "click .js-kill-clients"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.killClients", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "click .js-reset-ticker"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.resetAll", { wallId: DEFAULT_TICKER_WALL_ID })
  },
  "click .js-refresh-clients"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.forceRefreshClients", { wallId: DEFAULT_TICKER_WALL_ID })
  },
})
