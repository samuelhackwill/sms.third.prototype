import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { streamer } from "/imports/both/streamer"
import {
  STAGE_BACKGROUND_EVENT,
  STAGE_TEST_EVENT,
} from "/imports/ui/pages/stage/stageEvents"
import { makeFakeMessages } from "/imports/ui/pages/stage/stageTestData"
import {
  DEFAULT_STAGE_VIDEO_KEY,
  STAGE_VIDEOS,
} from "/imports/ui/pages/stage/stageVideos"
import "./adminStage.html"

const DEFAULT_SOURCE = "default"

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

Template.adminStage.onCreated(function onCreated() {
  this.lastPayload = new ReactiveVar("No payload sent yet.")
  this.selectedSource = new ReactiveVar(DEFAULT_SOURCE)
  this.selectedVideo = new ReactiveVar(DEFAULT_STAGE_VIDEO_KEY)
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
})
