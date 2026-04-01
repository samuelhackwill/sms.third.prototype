import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { Messages } from "/imports/api/messages/messages"
import { streamer } from "/imports/both/streamer"
import {
  STAGE_BACKGROUND_EVENT,
  STAGE_CURATION_EVENT,
  STAGE_TEST_EVENT,
} from "/imports/ui/pages/stage/stageEvents"
import { makeFakeMessages } from "/imports/ui/pages/stage/stageTestData"
import {
  DEFAULT_STAGE_VIDEO_KEY,
  STAGE_VIDEOS,
} from "/imports/ui/pages/stage/stageVideos"
import "./adminStage.html"

const DEFAULT_SOURCE = "default"
const DEFAULT_CURATION_REVEAL_MS = 1400

function sendSpawn(instance, count) {
  const source = instance.selectedSource.get()
  const payload = {
    type: "spawn",
    source,
    messages: makeFakeMessages(count, source),
  }
  streamer.emit(STAGE_TEST_EVENT, payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

function sendVideoSelection(instance) {
  const payload = {
    type: "background",
    videoKey: instance.selectedVideo.get(),
    videoSrc: STAGE_VIDEOS[instance.selectedVideo.get()] ?? STAGE_VIDEOS[DEFAULT_STAGE_VIDEO_KEY],
    action: "play",
  }
  streamer.emit(STAGE_BACKGROUND_EVENT, payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

function sendVideoStop(instance) {
  const payload = {
    type: "background",
    action: "stop",
  }
  streamer.emit(STAGE_BACKGROUND_EVENT, payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

function sendCurationMessage(instance, message) {
  const revealDurationMs = instance.curationRevealMs.get()
  const payload = {
    action: "show",
    messageId: message?.id ?? null,
    sender: message?.sender ?? null,
    body: typeof message?.body === "string" ? message.body : "",
    animationDurationMs: revealDurationMs,
    animationStepMs: Math.max(220, Math.round(revealDurationMs * 0.85)),
  }
  streamer.emit(STAGE_CURATION_EVENT, payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

function hideCurationMessage(instance) {
  const payload = {
    action: "hide",
  }
  streamer.emit(STAGE_CURATION_EVENT, payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

Template.adminStage.onCreated(function onCreated() {
  this.lastPayload = new ReactiveVar("No payload sent yet.")
  this.selectedSource = new ReactiveVar(DEFAULT_SOURCE)
  this.selectedVideo = new ReactiveVar(DEFAULT_STAGE_VIDEO_KEY)
  this.curationRevealMs = new ReactiveVar(DEFAULT_CURATION_REVEAL_MS)

  this.autorun(() => {
    this.subscribe("messages.featured")
  })
})

Template.adminStage.events({
  'click [data-action="send-1"]'(event, instance) {
    event.preventDefault()
    sendSpawn(instance, 1)
  },
  'click [data-action="send-5"]'(event, instance) {
    event.preventDefault()
    sendSpawn(instance, 5)
  },
  'click [data-action="send-10"]'(event, instance) {
    event.preventDefault()
    sendSpawn(instance, 10)
  },
  'click [data-action="clear"]'(event, instance) {
    event.preventDefault()
    const payload = { type: "clear" }
    streamer.emit(STAGE_TEST_EVENT, payload)
    instance.lastPayload.set(JSON.stringify(payload, null, 2))
  },
  'click [data-action="play-stage-video"]'(event, instance) {
    event.preventDefault()
    sendVideoSelection(instance)
  },
  'click [data-action="stop-stage-video"]'(event, instance) {
    event.preventDefault()
    sendVideoStop(instance)
  },
  'click [data-action="show-featured-message"]'(event, instance) {
    event.preventDefault()
    const messageId = event.currentTarget.dataset.messageId
    const message = Messages.findOne({ id: messageId, status: "featured" })

    if (!message) {
      return
    }

    sendCurationMessage(instance, message)
  },
  'click [data-action="hide-curation-message"]'(event, instance) {
    event.preventDefault()
    hideCurationMessage(instance)
  },
  'input [name="curation-reveal-ms"]'(event, instance) {
    const nextValue = Number.parseInt(event.currentTarget.value, 10)
    instance.curationRevealMs.set(Number.isFinite(nextValue) ? nextValue : DEFAULT_CURATION_REVEAL_MS)
  },
  'change [name="message-source"]'(event, instance) {
    instance.selectedSource.set(event.currentTarget.value || DEFAULT_SOURCE)
  },
  'change [name="stage-video"]'(event, instance) {
    instance.selectedVideo.set(event.currentTarget.value || DEFAULT_STAGE_VIDEO_KEY)
  },
})

Template.adminStage.helpers({
  lastPayload() {
    return Template.instance().lastPayload.get()
  },
  isSelectedSource(value) {
    return Template.instance().selectedSource.get() === value
  },
  isSelectedVideo(value) {
    return Template.instance().selectedVideo.get() === value
  },
  featuredMessages() {
    return Messages.find(
      { status: "featured" },
      { sort: { receivedAt: -1, createdAt: -1 } },
    ).map((message) => ({
      ...message,
      receivedAtLabel: message.receivedAt instanceof Date ? message.receivedAt.toLocaleString() : "unknown",
    }))
  },
  hasFeaturedMessages() {
    return Messages.find({ status: "featured" }).count() > 0
  },
  curationRevealMs() {
    return Template.instance().curationRevealMs.get()
  },
})
