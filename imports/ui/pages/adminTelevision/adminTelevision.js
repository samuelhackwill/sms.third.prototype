import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { streamer } from "/imports/both/streamer"
import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import "/imports/ui/pages/adminTelevision/adminTelevision.html"

Template.AdminTelevisionPage.onCreated(function onCreated() {
  this.localSources = new ReactiveVar([])
  this.mediaBaseUrl = new ReactiveVar("")
  this.mediaRootDir = new ReactiveVar("")

  this.autorun(() => {
    this.subscribe("television.state", DEFAULT_TELEVISION_STATE_ID)
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.clients", DEFAULT_WALL_ID)
  })

  Meteor.callAsync("television.listLocalSources")
    .then((result) => {
      this.localSources.set(Array.isArray(result?.sources) ? result.sources : [])
      this.mediaBaseUrl.set(result?.baseUrl ?? "")
      this.mediaRootDir.set(result?.rootDir ?? "")
    })
    .catch((error) => {
      console.error("[admin/television] failed to list nginx media sources", error)
      this.localSources.set([])
    })
})

Template.AdminTelevisionPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.AdminTelevisionPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.AdminTelevisionPage.helpers({
  sourceUrlValue() {
    return TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })?.sourceUrl ?? ""
  },
  currentSource() {
    return TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })?.sourceUrl ?? "none"
  },
  playbackState() {
    return TelevisionStates.findOne({ _id: DEFAULT_TELEVISION_STATE_ID })?.playbackState ?? "idle"
  },
  mediaBaseUrl() {
    return Template.instance().mediaBaseUrl.get() || "unknown"
  },
  mediaRootDir() {
    return Template.instance().mediaRootDir.get() || "unknown"
  },
  debugToggleLabel() {
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    return wall?.showDebug === false ? "Show Debug" : "Hide Debug"
  },
  localSources() {
    return Template.instance().localSources.get()
  },
  readinessRows() {
    const assignedClients = WallClients.find(
      { wallId: DEFAULT_WALL_ID, slotIndex: { $ne: null } },
      { sort: { slotIndex: 1 } },
    ).fetch()

    const slots = Array.from({ length: 30 }, (_, index) => {
      const client = assignedClients.find((entry) => entry.slotIndex === index)
      const readyState = Number(client?.televisionReadyState) || 0
      const networkState = Number(client?.televisionNetworkState) || 0
      const errorCode = Number(client?.televisionErrorCode) || null
      const playbackState = client?.televisionPlaybackState || "unknown"
      const statusClass = readyState >= 4
        ? "border-emerald-500 bg-emerald-500/20 text-emerald-100"
        : readyState >= 3
          ? "border-amber-500 bg-amber-500/20 text-amber-100"
          : "border-slate-700 bg-slate-950 text-slate-300"

      return {
        slotIndex: index,
        slotNumber: index + 1,
        shortCode: client?.shortCode ?? "-----",
        readyState,
        networkState,
        errorCode: errorCode ?? "-",
        playbackState,
        statusClass,
      }
    })

    const rows = []
    for (let rowIndex = 0; rowIndex < 6; rowIndex += 1) {
      rows.push(slots.slice(rowIndex * 5, (rowIndex + 1) * 5))
    }
    return rows
  },
})

Template.AdminTelevisionPage.events({
  "click [data-action='move-all-clients-to-television']"(event) {
    event.preventDefault()
    const payload = { target: "television" }
    streamer.emit(TICKER_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(TELEVISION_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, payload)
  },
  async "click .js-load-url"(event, instance) {
    event.preventDefault()
    const sourceUrl = instance.find("#televisionSourceUrl")?.value ?? ""
    await Meteor.callAsync("television.loadUrl", {
      stateId: DEFAULT_TELEVISION_STATE_ID,
      sourceUrl,
    })
  },
  async "click .js-play-loaded"(event) {
    event.preventDefault()
    await Meteor.callAsync("television.playLoaded", { stateId: DEFAULT_TELEVISION_STATE_ID })
  },
  async "click .js-stop-video"(event) {
    event.preventDefault()
    await Meteor.callAsync("television.stop", { stateId: DEFAULT_TELEVISION_STATE_ID })
  },
  "click .js-refresh-clients"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.forceRefreshClients", { wallId: DEFAULT_WALL_ID })
  },
  "click .js-toggle-debug"(event) {
    event.preventDefault()
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    Meteor.callAsync("ticker.setShowDebug", {
      wallId: DEFAULT_WALL_ID,
      showDebug: wall?.showDebug === false,
    })
  },
  async "click .js-load-local-source"(event, instance) {
    event.preventDefault()
    const sourceUrl = event.currentTarget.dataset.sourceUrl
    if (!sourceUrl) {
      return
    }

    const input = instance.find("#televisionSourceUrl")
    if (input) {
      input.value = sourceUrl
    }

    await Meteor.callAsync("television.loadUrl", {
      stateId: DEFAULT_TELEVISION_STATE_ID,
      sourceUrl,
    })
  },
})
