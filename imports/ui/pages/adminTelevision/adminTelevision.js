import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"

import { DEFAULT_TELEVISION_STATE_ID, TelevisionStates } from "/imports/api/television/collections"
import {
  buildAdminWallRouteTargets,
  buildAdminWallTabs,
  emitWallRouteTarget,
} from "/imports/ui/lib/adminWallNav"
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
  adminWallTabs() {
    return buildAdminWallTabs()
  },
  adminWallRouteTargets() {
    return buildAdminWallRouteTargets()
  },
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
  "click .js-move-wall-clients"(event) {
    event.preventDefault()
    emitWallRouteTarget(event.currentTarget.dataset.target)
  },
  async "click .js-play-url"(event, instance) {
    event.preventDefault()
    const sourceUrl = instance.find("#televisionSourceUrl")?.value ?? ""
    await Meteor.callAsync("television.playUrl", {
      stateId: DEFAULT_TELEVISION_STATE_ID,
      sourceUrl,
    })
  },
  async "click .js-stop-video"(event) {
    event.preventDefault()
    await Meteor.callAsync("television.stop", { stateId: DEFAULT_TELEVISION_STATE_ID })
  },
  async "click .js-play-local-source"(event, instance) {
    event.preventDefault()
    const sourceUrl = event.currentTarget.dataset.sourceUrl
    if (!sourceUrl) {
      return
    }

    const input = instance.find("#televisionSourceUrl")
    if (input) {
      input.value = sourceUrl
    }

    await Meteor.callAsync("television.playUrl", {
      stateId: DEFAULT_TELEVISION_STATE_ID,
      sourceUrl,
    })
  },
})
