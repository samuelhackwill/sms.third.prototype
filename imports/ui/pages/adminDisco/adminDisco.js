import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"

import { streamer } from "/imports/both/streamer"
import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import { DISCO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/disco/discoEvents"
import { KISS_O_MATIC_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/kissOMatic/kissOMaticEvents"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/pages/adminDisco/adminDisco.html"

Template.AdminDiscoPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.clients", DEFAULT_WALL_ID)
  })
})

Template.AdminDiscoPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
  Meteor.callAsync("disco.ensureState", { wallId: DEFAULT_WALL_ID }).catch((error) => {
    console.error("[admin/disco] failed to ensure state", error)
  })
})

Template.AdminDiscoPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

function staleLabel(client) {
  const lastSeenAtMs = new Date(client?.lastSeenAt).getTime()
  if (!Number.isFinite(lastSeenAtMs)) {
    return "seen: unknown"
  }

  const ageSec = Math.max(0, Math.round((Date.now() - lastSeenAtMs) / 1000))
  return `seen: ${ageSec}s ago`
}

Template.AdminDiscoPage.helpers({
  columnIntervalMs() {
    const value = Number(Walls.findOne({ _id: DEFAULT_WALL_ID })?.discoColumnIntervalMs)
    return Number.isFinite(value) ? value : 500
  },
  debugToggleLabel() {
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    return wall?.showDebug === false ? "Show Debug" : "Hide Debug"
  },
  readinessRows() {
    const assignedClients = WallClients.find(
      { wallId: DEFAULT_WALL_ID, slotIndex: { $ne: null } },
      { sort: { slotIndex: 1 } },
    ).fetch()

    const slots = Array.from({ length: 30 }, (_, index) => {
      const client = assignedClients.find((entry) => entry.slotIndex === index)
      return {
        slotNumber: index + 1,
        shortCode: client?.shortCode ?? "-----",
        rowIndex: Number.isInteger(client?.rowIndex) ? client.rowIndex : "-",
        colIndex: Number.isInteger(client?.colIndex) ? client.colIndex : "-",
        lastSeenLabel: staleLabel(client),
        statusClass: client
          ? "border-cyan-500 bg-cyan-500/20 text-cyan-100"
          : "border-slate-700 bg-slate-950 text-slate-300",
      }
    })

    const rows = []
    for (let rowIndex = 0; rowIndex < 6; rowIndex += 1) {
      rows.push(slots.slice(rowIndex * 5, (rowIndex + 1) * 5))
    }
    return rows
  },
})

Template.AdminDiscoPage.events({
  "click [data-action='move-all-clients-to-disco']"(event) {
    event.preventDefault()
    const payload = { target: "disco" }
    streamer.emit(TICKER_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(TELEVISION_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(KISS_O_MATIC_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(DISCO_ROUTE_CONTROL_EVENT, payload)
  },
  "click [data-action='refresh-clients']"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.forceRefreshClients", { wallId: DEFAULT_WALL_ID }).catch((error) => {
      console.error("[admin/disco] failed to refresh clients", error)
    })
  },
  "click [data-action='toggle-debug']"(event) {
    event.preventDefault()
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    Meteor.callAsync("ticker.setShowDebug", {
      wallId: DEFAULT_WALL_ID,
      showDebug: wall?.showDebug === false,
    }).catch((error) => {
      console.error("[admin/disco] failed to toggle debug", error)
    })
  },
  "click [data-action='restart']"(event) {
    event.preventDefault()
    Meteor.callAsync("disco.restart", { wallId: DEFAULT_WALL_ID }).catch((error) => {
      console.error("[admin/disco] failed to restart disco", error)
    })
  },
  "submit [data-action='settings']"(event) {
    event.preventDefault()
    const form = event.currentTarget
    Meteor.callAsync("disco.updateSettings", {
      wallId: DEFAULT_WALL_ID,
      columnIntervalMs: form.columnIntervalMs.value,
      mode: "column_wave",
    }).catch((error) => {
      console.error("[admin/disco] failed to update settings", error)
    })
  },
})
