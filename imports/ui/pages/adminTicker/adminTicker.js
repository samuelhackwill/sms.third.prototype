import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { Messages } from "/imports/api/messages/messages"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import { streamer } from "/imports/both/streamer"
import { FAKE_MESSAGE_SOURCES, nextFakeMessageBody } from "/imports/ui/pages/stage/stageTestData"
import { KISS_O_MATIC_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/kissOMatic/kissOMaticEvents"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import "/imports/ui/pages/adminTicker/adminTickerPage.html"

const PROVISIONING_ROWS = 6
const PROVISIONING_COLS = 5
const PROVISIONING_SLOT_COUNT = PROVISIONING_ROWS * PROVISIONING_COLS
const TICKER_CLIENT_STALE_AFTER_MS = 30 * 1000
const TICKER_DISPATCH_MODE_AUTO = "auto"
const TICKER_DISPATCH_MODE_BUCKET_HOLD = "bucket_hold"

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
  this.selectedFakeSource = new ReactiveVar("drague")
  this.stageBucketDrainTimer = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.clients", DEFAULT_TICKER_WALL_ID)
    this.subscribe("messages.featured")
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

  if (this.stageBucketDrainTimer) {
    globalThis.clearTimeout(this.stageBucketDrainTimer)
    this.stageBucketDrainTimer = null
  }
})

Template.AdminTickerPage.helpers({
  wall() {
    return TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  },
  fakeMessageSources() {
    const selectedSource = Template.instance().selectedFakeSource.get()
    return Object.keys(FAKE_MESSAGE_SOURCES).map((key) => ({
      key,
      label: key === "default" ? "Default" : `${key.charAt(0).toUpperCase()}${key.slice(1)}`,
      checked: selectedSource === key ? "checked" : null,
    }))
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
  isRendererModeBitmap() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.rendererMode ?? "bitmap") === "bitmap"
  },
  isRendererModeText() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.rendererMode === "text"
  },
  isBarthesMode() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.specialMode === "barthes"
  },
  barthesModeButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.specialMode === "barthes"
      ? "Exit ROLAND BARTHES MODE"
      : "Enter ROLAND BARTHES MODE"
  },
  queueMachineState() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.machineState ?? "idle"
  },
  queueDepth() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.queuedCount ?? 0
  },
  queueDispatchMode() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.dispatchMode ?? TICKER_DISPATCH_MODE_AUTO
  },
  isBucketModeEnabled() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.dispatchMode === TICKER_DISPATCH_MODE_BUCKET_HOLD
  },
  bucketModeButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.dispatchMode === TICKER_DISPATCH_MODE_BUCKET_HOLD
      ? "Disable Bucket Mode"
      : "Enable Bucket Mode"
  },
  emptyBucketButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const queuedCount = Number(wall?.queueState?.queuedCount) || 0
    return queuedCount > 0 ? `Ticker Empty Bucket (${queuedCount})` : "Ticker Empty Bucket"
  },
  emptyBucketDisabledAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const queueState = wall?.queueState
    const rows = Array.isArray(queueState?.rows) ? queueState.rows : []
    const hasIdleRows = rows.some((row) => row?.state === "idle")
    const queuedCount = Number(queueState?.queuedCount) || 0
    return queuedCount > 0 && hasIdleRows ? null : "disabled"
  },
  stageEmptyBucketButtonLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const queuedCount = Number(wall?.queueState?.queuedCount) || 0
    return queuedCount > 0 ? `Stage Empty Bucket (${queuedCount})` : "Stage Empty Bucket"
  },
  stageEmptyBucketDisabledAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return Number(wall?.queueState?.queuedCount) > 0 ? null : "disabled"
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
        widthPx: metrics?.widthPx ?? 0,
        activeClientCount: metrics?.activeClientCount ?? 0,
        rowContent: row?.playing?.text ?? "none",
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
  featuredMessages() {
    return Messages.find(
      { status: "featured" },
      { sort: { receivedAt: -1, createdAt: -1 } },
    ).map((message) => ({
      ...message,
      senderLabel: message.sender || "unknown",
      receivedAtLabel: message.receivedAt instanceof Date
        ? message.receivedAt.toLocaleString()
        : "unknown",
    }))
  },
  hasFeaturedMessages() {
    return Messages.find({ status: "featured" }).count() > 0
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
  "click .js-send-random-text"(event, instance) {
    event.preventDefault()
    Meteor.callAsync("ticker.enqueueText", {
      wallId: DEFAULT_TICKER_WALL_ID,
      text: nextFakeMessageBody(instance.selectedFakeSource.get()),
    })
  },
  "change [name='fake-message-source']"(event, instance) {
    instance.selectedFakeSource.set(event.currentTarget.value || "drague")
  },
  "click .js-move-all-clients-to-ticker"(event) {
    event.preventDefault()
    const payload = { target: "ticker" }
    streamer.emit(TICKER_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(TELEVISION_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(KISS_O_MATIC_ROUTE_CONTROL_EVENT, payload)
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
  "change input[name='tickerRendererMode']"(event) {
    const rendererMode = event.currentTarget.value
    Meteor.callAsync("ticker.setRendererMode", {
      wallId: DEFAULT_TICKER_WALL_ID,
      rendererMode,
    })
  },
  async "click .js-toggle-barthes-mode"(event) {
    event.preventDefault()
    try {
      await Meteor.callAsync("ticker.toggleBarthesMode", {
        wallId: DEFAULT_TICKER_WALL_ID,
      })
    } catch (error) {
      console.error("[adminTicker] failed to toggle Barthes mode", error)
      globalThis.alert?.(error?.reason || error?.message || "Failed to toggle Barthes mode")
    }
  },
  "click .js-toggle-bucket-mode"(event) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextDispatchMode = wall?.queueState?.dispatchMode === TICKER_DISPATCH_MODE_BUCKET_HOLD
      ? TICKER_DISPATCH_MODE_AUTO
      : TICKER_DISPATCH_MODE_BUCKET_HOLD

    Meteor.callAsync("ticker.setDispatchMode", {
      wallId: DEFAULT_TICKER_WALL_ID,
      dispatchMode: nextDispatchMode,
    })
  },
  "click .js-empty-bucket"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.emptyBucket", {
      wallId: DEFAULT_TICKER_WALL_ID,
    })
  },
  "click .js-empty-stage-bucket"(event) {
    event.preventDefault()
    const instance = Template.instance()

    async function consumeNext() {
      const result = await Meteor.callAsync("ticker.emptyStageBucket", {
        wallId: DEFAULT_TICKER_WALL_ID,
      })

      if ((Number(result?.queuedCount) || 0) > 0) {
        instance.stageBucketDrainTimer = globalThis.setTimeout(consumeNext, 1000)
      } else {
        instance.stageBucketDrainTimer = null
      }
    }

    if (instance.stageBucketDrainTimer) {
      return
    }

    consumeNext().catch((error) => {
      instance.stageBucketDrainTimer = null
      console.error("[adminTicker] failed to drain stage bucket", error)
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
  "click .js-send-featured-message"(event) {
    event.preventDefault()
    const messageId = event.currentTarget.dataset.messageId
    const message = Messages.findOne({ id: messageId })

    if (!message?.body) {
      return
    }

    Meteor.callAsync("ticker.enqueueText", {
      wallId: DEFAULT_TICKER_WALL_ID,
      text: message.body,
      sender: message.sender ?? null,
      receivedAt: message.receivedAt ?? null,
      messageId: message.id,
    })
  },
})
