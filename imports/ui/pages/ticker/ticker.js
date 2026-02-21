import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import * as PIXI from "pixi.js"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import "/imports/api/ticker/methods"
import "./ticker.html"

const FONT_FAMILY = "Arial"
const FONT_SIZE = 36
const FONT_FILL = 0xffffff
const SESSION_CLIENT_ID_KEY = "clientId"
const LEGACY_SESSION_CLIENT_ID_KEY = "ticker.clientId"

function createTickerRenderer(mountEl) {
  const app = new PIXI.Application({
    background: 0x000000,
    antialias: true,
    resizeTo: mountEl,
    autoDensity: true,
  })
  mountEl.appendChild(app.view)

  const world = new PIXI.Container()
  app.stage.addChild(world)

  const maskGraphics = new PIXI.Graphics()
  app.stage.addChild(maskGraphics)
  world.mask = maskGraphics

  let textDisplay = null
  let playing = null
  let xStart = 0
  let offsetMs = 0

  function drawMask() {
    maskGraphics.clear()
    maskGraphics.beginFill(0xffffff)
    maskGraphics.drawRect(0, 0, app.screen.width, app.screen.height)
    maskGraphics.endFill()
  }

  function ensureTextDisplay() {
    if (textDisplay) {
      return textDisplay
    }

    textDisplay = new PIXI.Text("", {
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      fill: FONT_FILL,
    })
    textDisplay.y = Math.max(0, (app.screen.height - FONT_SIZE) / 2)
    world.addChild(textDisplay)
    return textDisplay
  }

  function clearPlaying() {
    playing = null
    if (textDisplay) {
      textDisplay.text = ""
      textDisplay.visible = false
    }
  }

  function setPlaying(nextPlaying) {
    if (!nextPlaying) {
      clearPlaying()
      return
    }

    playing = {
      text: String(nextPlaying.text ?? ""),
      startedAtServerMs: Number(nextPlaying.startedAtServerMs) || 0,
      speedPxPerSec: Number(nextPlaying.speedPxPerSec) || 0,
      totalWallWidthAtStart: Number(nextPlaying.totalWallWidthAtStart) || 0,
    }

    const display = ensureTextDisplay()
    display.text = playing.text
    display.visible = true
    display.y = Math.max(0, (app.screen.height - display.height) / 2)
  }

  function setSliceXStart(nextXStart) {
    xStart = Number(nextXStart) || 0
  }

  function setServerOffset(nextOffsetMs) {
    offsetMs = Number(nextOffsetMs) || 0
  }

  function resize() {
    drawMask()
    if (textDisplay && textDisplay.visible) {
      textDisplay.y = Math.max(0, (app.screen.height - textDisplay.height) / 2)
    }
  }

  function tick() {
    if (!playing || !textDisplay || !textDisplay.visible) {
      return
    }

    const serverNowMs = Date.now() + offsetMs
    const tSec = Math.max(0, (serverNowMs - playing.startedAtServerMs) / 1000)
    const scrollX = tSec * playing.speedPxPerSec
    const textWorldX = playing.totalWallWidthAtStart - scrollX
    textDisplay.x = textWorldX - xStart
  }

  app.ticker.add(tick)
  drawMask()

  return {
    setPlaying,
    clearPlaying,
    setSliceXStart,
    setServerOffset,
    resize,
    destroy() {
      app.ticker.remove(tick)
      app.destroy(true, { children: true })
    },
  }
}

function getOrCreateClientId() {
  const existing = sessionStorage.getItem(SESSION_CLIENT_ID_KEY)
  if (existing) {
    return existing
  }

  const legacy = sessionStorage.getItem(LEGACY_SESSION_CLIENT_ID_KEY)
  if (legacy) {
    sessionStorage.setItem(SESSION_CLIENT_ID_KEY, legacy)
    return legacy
  }

  const nextId = crypto.randomUUID()
  sessionStorage.setItem(SESSION_CLIENT_ID_KEY, nextId)
  return nextId
}

function toShortCode(clientId) {
  return clientId.replace(/-/g, "").slice(0, 5).toUpperCase()
}

Template.TickerPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.shortCode = toShortCode(this.clientId)
  this.resizeTimeout = null
  this.timeSyncIntervalId = null
  this.offsetMs = 0
  this.renderer = null

  this.autorun(() => {
    this.subscribe("ticker.wall", DEFAULT_TICKER_WALL_ID)
    this.subscribe("ticker.client.self", DEFAULT_TICKER_WALL_ID, this.clientId)
  })
})

Template.TickerPage.onRendered(function onRendered() {
  const mountEl = this.find("#tickerCanvasHost")
  if (!mountEl) {
    return
  }

  this.renderer = createTickerRenderer(mountEl)

  const syncServerTimeOffset = () => {
    const t0 = Date.now()
    Meteor.call("ticker.time", (error, serverTimeMs) => {
      if (error || typeof serverTimeMs !== "number") {
        return
      }

      const t1 = Date.now()
      const rtt = t1 - t0
      const estimatedServerNowAtT1 = serverTimeMs + (rtt / 2)
      this.offsetMs = estimatedServerNowAtT1 - t1
      this.renderer?.setServerOffset(this.offsetMs)
    })
  }

  syncServerTimeOffset()
  this.timeSyncIntervalId = Meteor.setInterval(syncServerTimeOffset, 5000)

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
    this.renderer?.resize()
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

  this.autorun(() => {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    if (!wall?.playing) {
      this.renderer?.clearPlaying()
      return
    }

    this.renderer?.setPlaying(wall.playing)
  })

  this.autorun(() => {
    const selfClient = TickerClients.findOne({ _id: this.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    this.renderer?.setSliceXStart(selfClient?.xStart ?? 0)
  })
})

Template.TickerPage.onDestroyed(function onDestroyed() {
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  if (this.timeSyncIntervalId) {
    Meteor.clearInterval(this.timeSyncIntervalId)
  }
  this.renderer?.destroy()
  this.renderer = null
})

Template.TickerPage.helpers({
  shortCode() {
    const instance = Template.instance()
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    return doc?.shortCode ?? "-----"
  },
  wallId() {
    return DEFAULT_TICKER_WALL_ID
  },
  xStart() {
    const instance = Template.instance()
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    return doc?.xStart ?? 0
  },
  isHighlighted() {
    const instance = Template.instance()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.highlightClientId === instance.clientId
  },
})
