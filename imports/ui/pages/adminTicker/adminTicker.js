import { Template } from "meteor/templating"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import "./adminTicker.html"

Template.AdminTickerPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.clients", DEFAULT_TICKER_WALL_ID)
  })
})

Template.AdminTickerPage.helpers({
  wall() {
    return TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
  },
  wallJson() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return JSON.stringify(wall ?? {}, null, 2)
  },
  clients() {
    return TickerClients.find(
      { wallId: DEFAULT_TICKER_WALL_ID },
      { sort: { orderIndex: 1, lastSeenAt: -1 } },
    )
  },
  clientCount() {
    return TickerClients.find({ wallId: DEFAULT_TICKER_WALL_ID }).count()
  },
  hasClients() {
    return TickerClients.find({ wallId: DEFAULT_TICKER_WALL_ID }).count() > 0
  },
})
