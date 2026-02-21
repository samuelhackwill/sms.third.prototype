import { Meteor } from "meteor/meteor"

import { TickerClients, TickerWalls } from "/imports/api/ticker/collections"

if (Meteor.isServer) {
  Meteor.publish("ticker.wall", function publishTickerWall(wallId) {
    if (!wallId) {
      return this.ready()
    }

    return TickerWalls.find({ _id: wallId })
  })

  Meteor.publish("ticker.client.self", function publishTickerClientSelf(wallId, clientId) {
    if (!wallId || !clientId) {
      return this.ready()
    }

    return TickerClients.find({ _id: clientId, wallId })
  })

  Meteor.publish("ticker.clients", function publishTickerClients(wallId) {
    if (!wallId) {
      return this.ready()
    }

    return TickerClients.find({ wallId }, { sort: { orderIndex: 1, lastSeenAt: -1 } })
  })
}
