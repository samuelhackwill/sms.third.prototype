import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import { ReactiveVar } from "meteor/reactive-var"

import { ApnsDevices } from "/imports/api/apns/collections"
import "./adminPush.html"

Template.AdminPushPage.onCreated(function onCreated() {
  this.lastResult = new ReactiveVar("")

  this.autorun(() => {
    this.subscribe("apns.devices")
  })
})

Template.AdminPushPage.onRendered(function onRendered() {
  document.body.classList.add("admin-page")
})

Template.AdminPushPage.onDestroyed(function onDestroyed() {
  document.body.classList.remove("admin-page")
})

Template.AdminPushPage.helpers({
  devices() {
    return ApnsDevices.find({}, { sort: { updatedAt: -1, createdAt: -1 } }).map((device) => ({
      ...device,
      deviceLabel: device.deviceName || "Unnamed iPhone",
      bundleIdLabel: device.bundleId || "Unknown bundle",
      updatedAtLabel: device.updatedAt instanceof Date ? device.updatedAt.toLocaleString() : "unknown",
      lastSentAtLabel: device.lastSentAt instanceof Date ? device.lastSentAt.toLocaleString() : "never",
      tokenPreview: typeof device.token === "string" ? `${device.token.slice(0, 16)}...` : "unknown",
      lastStatusLabel: device.lastSendError
        ? `error: ${device.lastSendError}`
        : device.lastSendResult
          ? `last status ${device.lastSendResult.statusCode ?? "unknown"}`
          : "never sent",
    }))
  },
  hasDevices() {
    return ApnsDevices.find().count() > 0
  },
  deviceCount() {
    return ApnsDevices.find().count()
  },
  lastResult() {
    return Template.instance().lastResult.get()
  },
})

Template.AdminPushPage.events({
  'click [data-action="send-yo"]'(event, instance) {
    event.preventDefault()
    const token = event.currentTarget.dataset.token

    Meteor.callAsync("apns.sendYoToToken", { token })
      .then((result) => {
        instance.lastResult.set(JSON.stringify(result, null, 2))
      })
      .catch((error) => {
        instance.lastResult.set(error?.stack || error?.message || String(error))
      })
  },
  'click [data-action="send-yo-to-all"]'(event, instance) {
    event.preventDefault()

    Meteor.callAsync("apns.sendYoToAll")
      .then((result) => {
        instance.lastResult.set(JSON.stringify(result, null, 2))
      })
      .catch((error) => {
        instance.lastResult.set(error?.stack || error?.message || String(error))
      })
  },
  'click [data-action="delete-device"]'(event, instance) {
    event.preventDefault()
    const token = event.currentTarget.dataset.token

    Meteor.callAsync("apns.deleteDevice", { token })
      .then((result) => {
        instance.lastResult.set(JSON.stringify(result, null, 2))
      })
      .catch((error) => {
        instance.lastResult.set(error?.stack || error?.message || String(error))
      })
  },
  'click [data-action="flush-devices"]'(event, instance) {
    event.preventDefault()

    Meteor.callAsync("apns.flushDevices")
      .then((result) => {
        instance.lastResult.set(JSON.stringify(result, null, 2))
      })
      .catch((error) => {
        instance.lastResult.set(error?.stack || error?.message || String(error))
      })
  },
})
