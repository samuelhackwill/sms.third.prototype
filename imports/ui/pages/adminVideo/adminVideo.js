import { Template } from "meteor/templating"
import { Meteor } from "meteor/meteor"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerWalls,
} from "/imports/api/ticker/collections"
import {
  buildAdminWallRouteTargets,
  buildAdminWallTabs,
  emitWallRouteTarget,
} from "/imports/ui/lib/adminWallNav"
import {
  VIDEO_DISPLAY_MODE_DIAGONAL,
  VIDEO_DISPLAY_MODE_FIFO,
} from "/imports/api/video/constants"
import { VIDEO_DEBUG_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/pages/adminVideo/adminVideo.html"

Template.AdminVideoPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
  })
})

Template.AdminVideoPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.AdminVideoPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.AdminVideoPage.events({
  'click .js-move-wall-clients'(event) {
    event.preventDefault()
    emitWallRouteTarget(event.currentTarget.dataset.target)
  },
  'click [data-action="toggle-video-debug"]'(event, instance) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextValue = !(wall?.showDebug ?? true)
    streamer.emit(VIDEO_DEBUG_CONTROL_EVENT, {
      showDebug: nextValue,
    })
  },
  'change [name="video-display-mode"]'(event) {
    const nextMode = event.currentTarget.value
    Meteor.callAsync("video.setDisplayMode", {
      wallId: DEFAULT_TICKER_WALL_ID,
      displayMode: nextMode,
    }).catch((error) => {
      console.error("[admin/video] failed to set display mode", error)
    })
  },
})

Template.AdminVideoPage.helpers({
  adminWallTabs() {
    return buildAdminWallTabs()
  },
  adminWallRouteTargets() {
    return buildAdminWallRouteTargets()
  },
  debugToggleLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.showDebug ?? true) ? "Hide Debug" : "Show Debug"
  },
  fifoCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoDisplayMode ?? VIDEO_DISPLAY_MODE_FIFO) === VIDEO_DISPLAY_MODE_FIFO ? "checked" : null
  },
  diagonalCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoDisplayMode ?? VIDEO_DISPLAY_MODE_FIFO) === VIDEO_DISPLAY_MODE_DIAGONAL ? "checked" : null
  },
})
