import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"

import { DEFAULT_TICKER_WALL_ID } from "/imports/api/ticker/collections"
import "/imports/api/ticker/methods"
import "./ticker.html"

function getOrCreateClientId() {
  const existing = sessionStorage.getItem("ticker.clientId")
  if (existing) {
    return existing
  }

  const nextId = crypto.randomUUID()
  sessionStorage.setItem("ticker.clientId", nextId)
  return nextId
}

function toShortCode(clientId) {
  return clientId.replace(/-/g, "").slice(0, 5).toUpperCase()
}

Template.TickerPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.shortCode = toShortCode(this.clientId)
  this.resizeTimeout = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.client.self", DEFAULT_TICKER_WALL_ID, this.clientId)
  })
})

Template.TickerPage.onRendered(function onRendered() {
  Meteor.call("ticker.join", {
    wallId: DEFAULT_TICKER_WALL_ID,
    clientId: this.clientId,
    shortCode: this.shortCode,
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  })

  this.handleResize = () => {
    Meteor.clearTimeout(this.resizeTimeout)
    this.resizeTimeout = Meteor.setTimeout(() => {
      Meteor.call("ticker.updateSize", {
        wallId: DEFAULT_TICKER_WALL_ID,
        clientId: this.clientId,
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }, 120)
  }

  window.addEventListener("resize", this.handleResize)
})

Template.TickerPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
})
