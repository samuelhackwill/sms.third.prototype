import { Template } from "meteor/templating"

import { DEFAULT_TICKER_WALL_ID } from "/imports/api/ticker/collections"
import "./adminTicker.html"

Template.AdminTickerPage.onCreated(function onCreated() {
  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.clients", DEFAULT_TICKER_WALL_ID)
  })
})
