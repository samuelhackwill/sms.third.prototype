import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"

import { streamer } from "/imports/both/streamer"
import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import "/imports/ui/pages/adminTelevision/adminTelevision.html"

const TELEVISION_LOCAL_SOURCES = [
  { label: "Nicole Vertical", sourceUrl: "/nicole-vertical-browser-cropped.mp4" },
  { label: "Premiere", sourceUrl: "/premiere.mp4" },
]

Template.AdminTelevisionPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("television.state", DEFAULT_TELEVISION_STATE_ID)
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
  localSources() {
    return TELEVISION_LOCAL_SOURCES
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
