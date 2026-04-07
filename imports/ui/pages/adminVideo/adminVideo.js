import { Template } from "meteor/templating"
import { Meteor } from "meteor/meteor"

import { streamer } from "/imports/both/streamer"
import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import {
  VIDEO_DISPLAY_MODE_FIFO,
  VIDEO_DISPLAY_MODE_SYNC_BATCH,
} from "/imports/api/video/constants"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_PANIC_EVENT, VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import "/imports/ui/pages/adminVideo/adminVideo.html"

Template.AdminVideoPage.onCreated(function onCreated() {
  this.tuningForm = null
  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("wall.clients", DEFAULT_TICKER_WALL_ID)
  })
})

Template.AdminVideoPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
  Meteor.callAsync("video.resetBatchState", { wallId: DEFAULT_TICKER_WALL_ID }).catch((error) => {
    console.error("[admin/video] failed to reset batch state on panel load", error)
  })
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
  'click [data-action="start-batch"]'(event) {
    event.preventDefault()
    Meteor.callAsync("video.startBatch", { wallId: DEFAULT_TICKER_WALL_ID }).catch((error) => {
      console.error("[admin/video] failed to start batch", error)
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
  'click [data-action="toggle-video-trim-clips"]'(event) {
    event.preventDefault()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const nextValue = !(wall?.videoTrimClips ?? false)
    Meteor.callAsync("video.setTrimClips", {
      wallId: DEFAULT_TICKER_WALL_ID,
      trimClips: nextValue,
    }).catch((error) => {
      console.error("[admin/video] failed to set trimClips", error)
    })
  },
  'click [data-action="panic-stop"]'(event) {
    event.preventDefault()
    Meteor.callAsync("video.panicStop", { wallId: DEFAULT_TICKER_WALL_ID })
      .catch((error) => {
        console.error("[admin/video] failed to panic stop", error)
      })
      .finally(() => {
        streamer.emit(VIDEO_PANIC_EVENT, { wallId: DEFAULT_TICKER_WALL_ID, requestedAt: Date.now() })
      })
  },
  'submit [data-action="playback-tuning"]'(event) {
    event.preventDefault()
    const form = event.currentTarget
    Meteor.callAsync("video.updatePlaybackTuning", {
      wallId: DEFAULT_TICKER_WALL_ID,
      trimStartOffsetSec: form.trimStartOffsetSec.value,
      trimEndOffsetSec: form.trimEndOffsetSec.value,
      revealDurationMs: form.revealDurationMs.value,
      fadeOutDurationMs: form.fadeOutDurationMs.value,
      syncBatchFadeOutDurationMs: form.syncBatchFadeOutDurationMs.value,
      fadeOutLeadMs: form.fadeOutLeadMs.value,
    }).catch((error) => {
      console.error("[admin/video] failed to update playback tuning", error)
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
  isAutoAdvanceEnabled() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoAutoAdvance ?? true
  },
  trimClipsToggleLabel() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoTrimClips ?? false) ? "Disable Trim Clips" : "Enable Trim Clips"
  },
  fifoCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return (wall?.videoDisplayMode ?? VIDEO_DISPLAY_MODE_FIFO) === VIDEO_DISPLAY_MODE_FIFO ? "checked" : null
  },
  syncBatchCheckedAttr() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoDisplayMode === VIDEO_DISPLAY_MODE_SYNC_BATCH ? "checked" : null
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
  videoBatchState() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoBatchState ?? "idle"
  },
  trimStartOffsetSec() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoTrimStartOffsetSec ?? 1
  },
  trimEndOffsetSec() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoTrimEndOffsetSec ?? 1
  },
  revealDurationMs() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoRevealDurationMs ?? 1200
  },
  fadeOutDurationMs() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoFadeOutDurationMs ?? 1000
  },
  syncBatchFadeOutDurationMs() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoSyncBatchFadeOutDurationMs ?? 3000
  },
  fadeOutLeadMs() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.videoFadeOutLeadMs ?? 1200
  },
  readinessRows() {
    const assignedClients = TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID, slotIndex: { $ne: null } },
      { sort: { slotIndex: 1 } },
    ).fetch()

    const slots = Array.from({ length: 30 }, (_, index) => {
      const client = assignedClients.find((entry) => entry.slotIndex === index)
      const readyState = Number(client?.videoReadyState) || 0
      const networkState = Number(client?.videoNetworkState) || 0
      const errorCode = Number(client?.videoErrorCode) || null
      const playbackState = client?.videoPlaybackState || "unknown"
      const statusClass = playbackState === "ended"
        ? "border-cyan-500 bg-cyan-500/20 text-cyan-100"
        : playbackState === "playing"
          ? "border-fuchsia-500 bg-fuchsia-500/20 text-fuchsia-100"
          : playbackState === "ready" || readyState >= 4
            ? "border-emerald-500 bg-emerald-500/20 text-emerald-100"
            : readyState >= 3
              ? "border-amber-500 bg-amber-500/20 text-amber-100"
              : "border-slate-700 bg-slate-950 text-slate-300"

      return {
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
