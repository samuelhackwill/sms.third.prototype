import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { streamer } from "/imports/both/streamer"
import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import { DEFAULT_WALL_ID, Walls } from "/imports/api/wall/collections"
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
