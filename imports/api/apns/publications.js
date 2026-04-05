import { Meteor } from "meteor/meteor"

import { ApnsDevices } from "/imports/api/apns/collections"

Meteor.publish("apns.devices", function publishApnsDevices() {
  return ApnsDevices.find({}, { sort: { updatedAt: -1, createdAt: -1 } })
})
