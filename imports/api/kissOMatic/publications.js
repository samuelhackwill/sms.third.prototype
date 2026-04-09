import { Meteor } from "meteor/meteor"

import { KissOMaticStates } from "/imports/api/kissOMatic/collections"

if (Meteor.isServer) {
  Meteor.publish("kissOMatic.state", function publishKissOMaticState(stateId) {
    if (!stateId) {
      return this.ready()
    }

    return KissOMaticStates.find({ _id: stateId })
  })
}
