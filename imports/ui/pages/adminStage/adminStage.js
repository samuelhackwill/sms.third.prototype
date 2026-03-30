import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { makeFakeMessages } from "/imports/ui/pages/stage/stageTestData"
import "./adminStage.html"

const DEFAULT_SOURCE = "default"
const CHANNEL_NAME = "stage_test"

function sendSpawn(instance, count) {
  const source = instance.selectedSource.get()
  const payload = {
    type: "spawn",
    source,
    messages: makeFakeMessages(count, source),
  }
  instance.stageTestChannel.postMessage(payload)
  instance.lastPayload.set(JSON.stringify(payload, null, 2))
}

Template.adminStage.onCreated(function onCreated() {
  this.stageTestChannel = new BroadcastChannel(CHANNEL_NAME)
  this.lastPayload = new ReactiveVar("No payload sent yet.")
  this.selectedSource = new ReactiveVar(DEFAULT_SOURCE)
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
  'change [name="message-source"]'(event, instance) {
    instance.selectedSource.set(event.currentTarget.value || DEFAULT_SOURCE)
  },
})

Template.adminStage.helpers({
  lastPayload() {
    return Template.instance().lastPayload.get()
  },
  isSelectedSource(value) {
    return Template.instance().selectedSource.get() === value
  },
})
