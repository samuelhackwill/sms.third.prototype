import { Meteor } from "meteor/meteor"

import { WallClients, Walls } from "/imports/api/wall/collections"

if (Meteor.isServer) {
  Meteor.publish("wall.current", function publishWall(wallId) {
    if (!wallId) {
      return this.ready()
    }

    return Walls.find({ _id: wallId })
  })

  Meteor.publish("wall.client.self", function publishWallClientSelf(wallId, clientId) {
    if (!wallId || !clientId) {
      return this.ready()
    }

    return WallClients.find({ _id: clientId, wallId })
  })

  Meteor.publish("wall.clients", function publishWallClients(wallId) {
    if (!wallId) {
      return this.ready()
    }

    return WallClients.find({ wallId }, { sort: { orderIndex: 1, lastSeenAt: -1 } })
  })
}
