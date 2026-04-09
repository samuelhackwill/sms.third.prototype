import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"

import { DEFAULT_KISS_O_MATIC_STATE_ID, KissOMaticStates } from "/imports/api/kissOMatic/collections"
import { streamer } from "/imports/both/streamer"
import { DEFAULT_WALL_ID, WallClients, Walls } from "/imports/api/wall/collections"
import "/imports/ui/components/adminWallNav/adminWallNav.js"
import { KISS_O_MATIC_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/kissOMatic/kissOMaticEvents"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import { TELEVISION_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/television/televisionEvents"
import { VIDEO_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/video/videoEvents"
import "/imports/ui/pages/adminKissOMatic/adminKissOMatic.html"

Template.AdminKissOMaticPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("kissOMatic.state", DEFAULT_KISS_O_MATIC_STATE_ID)
    this.subscribe("wall.current", DEFAULT_WALL_ID)
    this.subscribe("wall.clients", DEFAULT_WALL_ID)
  })
})

Template.AdminKissOMaticPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.AdminKissOMaticPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.AdminKissOMaticPage.helpers({
  playbackState() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.playbackState ?? "idle"
  },
  currentSource() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.sourceUrl ?? "none"
  },
  trimRange() {
    const state = KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })
    const trimStartSec = Number(state?.trimStartSec)
    const trimEndSec = Number(state?.trimEndSec)
    const trimStartOffsetSec = Number(state?.trimStartOffsetSec)
    const trimEndOffsetSec = Number(state?.trimEndOffsetSec)
    if (!Number.isFinite(trimStartSec) || !Number.isFinite(trimEndSec)) {
      return "none"
    }
    const effectiveStartSec = Math.max(0, trimStartSec - (Number.isFinite(trimStartOffsetSec) ? trimStartOffsetSec : 1))
    const effectiveEndSec = trimEndSec + (Number.isFinite(trimEndOffsetSec) ? trimEndOffsetSec : 1)
    return `${effectiveStartSec.toFixed(2)}s - ${effectiveEndSec.toFixed(2)}s`
  },
  clipDuration() {
    const duration = Number(KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.clipDurationSec)
    return Number.isFinite(duration) ? `${duration.toFixed(2)}s` : "unknown"
  },
  trimStartOffsetSec() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.trimStartOffsetSec ?? 1
  },
  trimEndOffsetSec() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.trimEndOffsetSec ?? 1
  },
  startFadeDurationMs() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.startFadeDurationMs ?? 1200
  },
  endFadeDurationMs() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.endFadeDurationMs ?? 1000
  },
  endFadeLeadMs() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.endFadeLeadMs ?? 1200
  },
  endpointUrl() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.endpointUrl ?? "unknown"
  },
  lastPayload() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.lastPayload ?? "none"
  },
  lastError() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.lastError ?? ""
  },
  autoAdvanceStatus() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.autoAdvance === false ? "disabled" : "enabled"
  },
  autoAdvanceToggleLabel() {
    return KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })?.autoAdvance === false
      ? "Enable Auto Advance"
      : "Disable Auto Advance"
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
      const readyState = Number(client?.kissOMaticReadyState) || 0
      const networkState = Number(client?.kissOMaticNetworkState) || 0
      const errorCode = Number(client?.kissOMaticErrorCode) || null
      const playbackState = client?.kissOMaticPlaybackState || "unknown"
      const statusClass = playbackState === "ended"
        ? "border-cyan-500 bg-cyan-500/20 text-cyan-100"
        : readyState >= 4
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

Template.AdminKissOMaticPage.events({
  "click [data-action='fetch-next']"(event) {
    event.preventDefault()
    Meteor.callAsync("kissOMatic.fetchNextClipAndPlay", { stateId: DEFAULT_KISS_O_MATIC_STATE_ID })
      .catch((error) => {
        console.error("[admin/kiss-o-matic] failed to fetch next clip", error)
      })
  },
  "click [data-action='refresh-clients']"(event) {
    event.preventDefault()
    Meteor.callAsync("ticker.forceRefreshClients", { wallId: DEFAULT_WALL_ID })
      .catch((error) => {
        console.error("[admin/kiss-o-matic] failed to refresh clients", error)
      })
  },
  "click [data-action='toggle-debug']"(event) {
    event.preventDefault()
    const wall = Walls.findOne({ _id: DEFAULT_WALL_ID })
    Meteor.callAsync("ticker.setShowDebug", {
      wallId: DEFAULT_WALL_ID,
      showDebug: wall?.showDebug === false,
    }).catch((error) => {
      console.error("[admin/kiss-o-matic] failed to toggle debug", error)
    })
  },
  "click [data-action='toggle-auto-advance']"(event) {
    event.preventDefault()
    const state = KissOMaticStates.findOne({ _id: DEFAULT_KISS_O_MATIC_STATE_ID })
    Meteor.callAsync("kissOMatic.setAutoAdvance", {
      stateId: DEFAULT_KISS_O_MATIC_STATE_ID,
      autoAdvance: state?.autoAdvance === false,
    }).catch((error) => {
      console.error("[admin/kiss-o-matic] failed to toggle auto-advance", error)
    })
  },
  "submit [data-action='playback-tuning']"(event) {
    event.preventDefault()
    const form = event.currentTarget
    Meteor.callAsync("kissOMatic.updatePlaybackTuning", {
      stateId: DEFAULT_KISS_O_MATIC_STATE_ID,
      trimStartOffsetSec: form.trimStartOffsetSec.value,
      trimEndOffsetSec: form.trimEndOffsetSec.value,
      startFadeDurationMs: form.startFadeDurationMs.value,
      endFadeDurationMs: form.endFadeDurationMs.value,
      endFadeLeadMs: form.endFadeLeadMs.value,
    }).catch((error) => {
      console.error("[admin/kiss-o-matic] failed to update playback tuning", error)
    })
  },
  "click [data-action='stop']"(event) {
    event.preventDefault()
    Meteor.callAsync("kissOMatic.stop", { stateId: DEFAULT_KISS_O_MATIC_STATE_ID })
      .catch((error) => {
        console.error("[admin/kiss-o-matic] failed to stop", error)
      })
  },
  "click [data-action='move-all-clients-to-kiss-o-matic']"(event) {
    event.preventDefault()
    const payload = { target: "kiss-o-matic" }
    streamer.emit(TICKER_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(TELEVISION_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(VIDEO_ROUTE_CONTROL_EVENT, payload)
    streamer.emit(KISS_O_MATIC_ROUTE_CONTROL_EVENT, payload)
  },
})
