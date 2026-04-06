import { Meteor } from "meteor/meteor"

import { TelevisionStates } from "/imports/api/television/collections"

if (Meteor.isServer) {
  Meteor.publish("television.state", function publishTelevisionState(stateId) {
    if (!stateId) {
      return this.ready()
    }

    return TelevisionStates.find({ _id: stateId })
  })
}
