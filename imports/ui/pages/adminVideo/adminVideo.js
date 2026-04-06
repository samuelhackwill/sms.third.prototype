import { Template } from "meteor/templating"
import { Meteor } from "meteor/meteor"

import { streamer } from "/imports/both/streamer"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerWalls,
} from "/imports/api/ticker/collections"
import {
  VIDEO_DISPLAY_MODE_FIFO,
} from "/imports/api/video/constants"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
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
  'click [data-action="move-all-clients-to-video"]'(event) {
    event.preventDefault()
    const payload = { target: "video" }
    streamer.emit(TICKER_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(TELEVISION_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, payload)
  },
  'click [data-action="refresh-clients"]'(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.forceRefreshClients", { wallId: DEFAULT_TICKER_WALL_ID }).catch((error) => {
      console.error("[admin/video] failed to refresh clients", error)
    })
  },
  'click [data-action="toggle-video-debug"]'(event) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextValue = !(wall?.videoShowDebug ?? true)
    Meteor.callAsync("video.setShowDebug", {
      wallId: DEFAULT_TICKER_WALL_ID,
      showDebug: nextValue,
    }).catch((error) => {
      console.error("[admin/video] failed to set showDebug", error)
    })
  },
  'click [data-action="toggle-video-auto-advance"]'(event) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextValue = !(wall?.videoAutoAdvance ?? true)
    Meteor.callAsync("video.setAutoAdvance", {
      wallId: DEFAULT_TICKER_WALL_ID,
      autoAdvance: nextValue,
    }).catch((error) => {
      console.error("[admin/video] failed to set autoAdvance", error)
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
  'change [name="video-tag"]'(event) {
    const nextTag = event.currentTarget.value
    Meteor.callAsync("video.setTag", {
      wallId: DEFAULT_TICKER_WALL_ID,
      tag: nextTag,
    }).catch((error) => {
      console.error("[admin/video] failed to set tag", error)
    })
  },
})

Template.AdminVideoPage.helpers({
  debugToggleLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoShowDebug ?? true) ? "Hide Debug" : "Show Debug"
  },
  autoAdvanceToggleLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoAutoAdvance ?? true) ? "Disable Auto Advance" : "Enable Auto Advance"
  },
  fifoCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoDisplayMode ?? VIDEO_DISPLAY_MODE_FIFO) === VIDEO_DISPLAY_MODE_FIFO ? "checked" : null
  },
  kissCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoTag ?? "kiss") === "kiss" ? "checked" : null
  },
  danceCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoTag ?? "kiss") === "dance" ? "checked" : null
  },
  cryCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoTag ?? "kiss") === "cry" ? "checked" : null
  },
})
