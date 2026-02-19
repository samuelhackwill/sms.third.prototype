import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { makeFakeMessages } from "./stageTestData"
import "./adminStage.html"

const CHANNEL_NAME = "stage_test"

function sendSpawn(instance, count) {
  const payload = { type: "spawn", messages: makeFakeMessages(count) }
  instance.stageTestChannel.postMessage(payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

Template.adminStage.onCreated(function onCreated() {
  this.stageTestChannel = new BroadcastChannel(CHANNEL_NAME)
  this.lastPayload = new ReactiveVar("No payload sent yet.")
})

Template.adminStage.onDestroyed(function onDestroyed() {
  this.stageTestChannel?.close()
  this.stageTestChannel = null
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
    instance.stageTestChannel.postMessage(payload)
    instance.lastPayload.set(JSON.stringify(payload, null, 2))
  },
})

Template.adminStage.helpers({
  lastPayload() {
    return Template.instance().lastPayload.get()
  },
})
