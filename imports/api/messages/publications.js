import { Meteor } from "meteor/meteor"

import { Messages } from "/imports/api/messages/messages"

Meteor.publish("messages.all", function publishAllMessages() {
  return Messages.find({}, { sort: { receivedAt: -1, createdAt: -1 } })
})

Meteor.publish("messages.featured", function publishFeaturedMessages() {
  return Messages.find(
    { status: "featured" },
    { sort: { receivedAt: -1, createdAt: -1 } },
  )
})
