import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import "./stage.html"

const CHANNEL_NAME = "stage_test"

Template.stage.onCreated(function onCreated() {
  this.lastEvent = new ReactiveVar("no event yet")
  this.stageTestChannel = null
})

Template.stage.onRendered(function onRendered() {
  document.body.classList.add("stage-page")
  this.stageTestChannel = new BroadcastChannel(CHANNEL_NAME)
  this.stageTestChannel.onmessage = (event) => {
    this.lastEvent.set(JSON.stringify(event.data))
  }
})

Template.stage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("stage-page")
  this.stageTestChannel?.close()
  this.stageTestChannel = null
})

Template.stage.helpers({
  lastEvent() {
    return Template.instance().lastEvent.get()
  },
})
