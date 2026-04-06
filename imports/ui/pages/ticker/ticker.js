import { Meteor } from "meteor/meteor"
import { Template } from "meteor/templating"
import * as PIXI from "pixi.js"

import {
  DEFAULT_TICKER_WALL_ID,
  TickerClients,
  TickerWalls,
} from "/imports/api/ticker/collections"
import "/imports/api/ticker/methods"
import { streamer } from "/imports/both/streamer"
import { FlowRouter } from "meteor/ostrio:flow-router-extra"
import { TICKER_ROUTE_CONTROL_EVENT } from "/imports/ui/pages/ticker/tickerEvents"
import "./ticker.html"

const FONT_FILL_DEFAULT = 0xff0000
const FONT_FILL_BARTHES = 0x00ff00
const BACKGROUND_DEFAULT = 0x000000
const TEXT_FONT_FAMILY = "Georgia, 'Times New Roman', serif"
const BITMAP_FONT_NAME = "LibreBaskerville-Regular"
const BITMAP_FONT_URL = "/fonts/ticker-msdf/LibreBaskerville-Regular.fnt"
const BITMAP_FONT_BASE_SIZE = 192
const BITMAP_FONT_CALIBRATION_TEXT = "HpxgylA"
const TICKER_BASELINE_LIFT_PX = 150
const TICKER_TEXT_SCALE_FACTOR = 0.88
const TICKER_SPAWN_OFFSET_PX = 150
const TICKER_RENDERER_MODE_BITMAP = "bitmap"
const TICKER_RENDERER_MODE_TEXT = "text"
const SESSION_CLIENT_ID_KEY = "clientId"
const LEGACY_SESSION_CLIENT_ID_KEY = "ticker.clientId"
const LOCAL_STORAGE_CLIENT_ID_KEY = "ticker.clientId"
const DEVICE_KEY_STORAGE_KEY = "ticker.deviceKey"
const TICKER_REFRESH_EVENT = "ticker.refresh"
const TICKER_HEARTBEAT_MS = 5 * 1000
const TICKER_DISPLAY_MODE_VERTICAL = "vertical"
const TICKER_SPECIAL_MODE_BARTHES = "barthes"
let tickerFontLoadPromise = null

function normalizeRendererMode(rendererMode) {
  return rendererMode === TICKER_RENDERER_MODE_TEXT
    ? TICKER_RENDERER_MODE_TEXT
    : TICKER_RENDERER_MODE_BITMAP
}

function ensureTickerFontLoaded() {
  if (!tickerFontLoadPromise) {
    tickerFontLoadPromise = PIXI.Assets.load(BITMAP_FONT_URL)
  }

  return tickerFontLoadPromise
}

function readStorage(storage, key) {
  try {
    return storage?.getItem(key) ?? null
  } catch (error) {
    return null
  }
}

function writeStorage(storage, key, value) {
  try {
    storage?.setItem(key, value)
  } catch (error) {
    // Ignore storage access failures and fall back to the other store.
  }
}

function createTickerRenderer(mountEl, rendererMode = TICKER_RENDERER_MODE_BITMAP) {
  const app = new PIXI.Application({
    background: BACKGROUND_DEFAULT,
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
  let yStart = 0
  let offsetMs = 0
  let minClientHeight = Math.max(1, Math.floor(app.screen.height))
  let displayMode = "chorus"
  let textScale = Math.max(0.1, (minClientHeight / BITMAP_FONT_BASE_SIZE) * TICKER_TEXT_SCALE_FACTOR)
  let referenceTextBaseHeight = null
  let textFill = FONT_FILL_DEFAULT
  const resolvedRendererMode = normalizeRendererMode(rendererMode)

  function drawMask() {
    maskGraphics.clear()
    maskGraphics.beginFill(0xffffff)
    maskGraphics.drawRect(0, 0, app.screen.width, app.screen.height)
    maskGraphics.endFill()
  }

  function bitmapFontOptions() {
    return {
      fontName: BITMAP_FONT_NAME,
      fontSize: BITMAP_FONT_BASE_SIZE,
      tint: textFill,
    }
  }

  function textStyleOptions() {
    return {
      fontFamily: TEXT_FONT_FAMILY,
      fontSize: BITMAP_FONT_BASE_SIZE,
      fill: textFill,
    }
  }

  function ensureTextDisplay() {
    if (textDisplay) {
      return textDisplay
    }

    textDisplay = resolvedRendererMode === TICKER_RENDERER_MODE_TEXT
      ? new PIXI.Text("", textStyleOptions())
      : new PIXI.BitmapText("", bitmapFontOptions())
    textDisplay.tint = textFill
    world.addChild(textDisplay)
    return textDisplay
  }

  function getReferenceTextHeight() {
    if (referenceTextBaseHeight == null) {
      const calibrationText = resolvedRendererMode === TICKER_RENDERER_MODE_TEXT
        ? new PIXI.Text(BITMAP_FONT_CALIBRATION_TEXT, textStyleOptions())
        : new PIXI.BitmapText(BITMAP_FONT_CALIBRATION_TEXT, bitmapFontOptions())
      referenceTextBaseHeight = Math.max(1, calibrationText.height)
      calibrationText.destroy()
    }

    return referenceTextBaseHeight * textScale
  }

  function layoutTextDisplay() {
    if (!textDisplay) {
      return
    }

    textDisplay.scale.set(textScale)
    textDisplay.x = 0

    const referenceHeight = getReferenceTextHeight()
    textDisplay.y = displayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? (-yStart - TICKER_BASELINE_LIFT_PX)
      : (app.screen.height - referenceHeight - TICKER_BASELINE_LIFT_PX)
    textDisplay.visible = Boolean(textDisplay.text)
  }

  function replaceTextDisplay(nextText) {
    const display = ensureTextDisplay()
    display.text = String(nextText ?? "")
    if (resolvedRendererMode === TICKER_RENDERER_MODE_TEXT) {
      display.style = new PIXI.TextStyle(textStyleOptions())
    } else {
      display.fontName = BITMAP_FONT_NAME
      display.fontSize = BITMAP_FONT_BASE_SIZE
      display.tint = textFill
    }
    layoutTextDisplay()
    return display
  }

  function applyViewportTextStyle() {
    if (!textDisplay) {
      return
    }

    if (resolvedRendererMode === TICKER_RENDERER_MODE_TEXT) {
      textDisplay.style = new PIXI.TextStyle(textStyleOptions())
    } else {
      textDisplay.fontName = BITMAP_FONT_NAME
      textDisplay.fontSize = BITMAP_FONT_BASE_SIZE
      textDisplay.tint = textFill
    }
    layoutTextDisplay()
  }

  function clearPlaying() {
    playing = null
    if (textDisplay) {
      world.removeChild(textDisplay)
      textDisplay.destroy()
      textDisplay = null
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
      rowWidthPx: Number(nextPlaying.rowWidthPx) || 0,
    }

    replaceTextDisplay(playing.text)
  }

  function setSliceXStart(nextXStart) {
    xStart = Number(nextXStart) || 0
  }

  function setSliceYStart(nextYStart) {
    yStart = Number(nextYStart) || 0
    layoutTextDisplay()
  }

  function setServerOffset(nextOffsetMs) {
    offsetMs = Number(nextOffsetMs) || 0
  }

  function setTextRenderHeight(nextHeight) {
    const height = Number(nextHeight)
    if (Number.isFinite(height) && height > 0) {
      minClientHeight = Math.max(1, Math.floor(height))
      textScale = Math.max(0.1, (minClientHeight / BITMAP_FONT_BASE_SIZE) * TICKER_TEXT_SCALE_FACTOR)
      applyViewportTextStyle()
    }
  }

  function setDisplayMode(nextDisplayMode) {
    displayMode = nextDisplayMode === TICKER_DISPLAY_MODE_VERTICAL
      ? TICKER_DISPLAY_MODE_VERTICAL
      : "chorus"
    layoutTextDisplay()
  }

  function setTextFill(nextTextFill) {
    textFill = Number.isFinite(Number(nextTextFill)) ? Number(nextTextFill) : FONT_FILL_DEFAULT
    applyViewportTextStyle()
  }

  function resize() {
    drawMask()
    applyViewportTextStyle()
  }

  function tick() {
    if (!playing || !textDisplay || !textDisplay.visible) {
      return
    }

    const serverNowMs = Date.now() + offsetMs
    const tSec = Math.max(0, (serverNowMs - playing.startedAtServerMs) / 1000)
    const scrollX = tSec * playing.speedPxPerSec
    const textWorldX = playing.rowWidthPx + TICKER_SPAWN_OFFSET_PX - scrollX
    textDisplay.x = textWorldX - xStart
  }

  app.ticker.add(tick)
  drawMask()

  return {
    rendererMode: resolvedRendererMode,
    setPlaying,
    clearPlaying,
    setSliceXStart,
    setSliceYStart,
    setServerOffset,
    setTextRenderHeight,
    setDisplayMode,
    setTextFill,
    resize,
    destroy() {
      app.ticker.remove(tick)
      app.destroy(true, { children: true })
    },
  }
}

function getOrCreateClientId() {
  const existing = readStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY)
    || readStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY)
  if (existing) {
    writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, existing)
    writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, existing)
    return existing
  }

  const legacy = readStorage(globalThis.localStorage, LEGACY_SESSION_CLIENT_ID_KEY)
    || readStorage(globalThis.sessionStorage, LEGACY_SESSION_CLIENT_ID_KEY)
  if (legacy) {
    writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, legacy)
    writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, legacy)
    return legacy
  }

  const nextId = makeClientId()
  writeStorage(globalThis.localStorage, LOCAL_STORAGE_CLIENT_ID_KEY, nextId)
  writeStorage(globalThis.sessionStorage, SESSION_CLIENT_ID_KEY, nextId)
  return nextId
}

function getOrCreateDeviceKey() {
  const existing = readStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY)
    || readStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY)
  if (existing) {
    writeStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY, existing)
    writeStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY, existing)
    return existing
  }

  const nextKey = makeClientId()
  writeStorage(globalThis.localStorage, DEVICE_KEY_STORAGE_KEY, nextKey)
  writeStorage(globalThis.sessionStorage, DEVICE_KEY_STORAGE_KEY, nextKey)
  return nextKey
}

function makeClientId() {
  const browserCrypto = globalThis.crypto
  if (browserCrypto && typeof browserCrypto.randomUUID === "function") {
    return browserCrypto.randomUUID()
  }

  if (browserCrypto && typeof browserCrypto.getRandomValues === "function") {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toShortCode(clientId) {
  return clientId.replace(/-/g, "").slice(0, 5).toUpperCase()
}

function findRowState(wall, rowIndex) {
  if (!Array.isArray(wall?.queueState?.rows) || !Number.isInteger(rowIndex) || rowIndex < 0) {
    return null
  }

  return wall.queueState.rows.find((row) => row.rowIndex === rowIndex) ?? null
}

Template.TickerPage.onCreated(function onCreated() {
  this.clientId = getOrCreateClientId()
  this.deviceKey = getOrCreateDeviceKey()
  this.shortCode = toShortCode(this.clientId)
  this.resizeTimeout = null
  this.timeSyncIntervalId = null
  this.heartbeatIntervalId = null
  this.offsetMs = 0
  this.renderer = null
  this.currentRendererMode = null
  this.refreshHandler = null
  this.routeControlHandler = null
  this.isDestroyed = false

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

  this.mountEl = mountEl
  this.rendererInitVersion = 0
  this.initializeRenderer = async (rendererMode) => {
    const normalizedRendererMode = normalizeRendererMode(rendererMode)
    const initVersion = this.rendererInitVersion + 1
    this.rendererInitVersion = initVersion

    if (normalizedRendererMode === TICKER_RENDERER_MODE_BITMAP) {
      try {
        await ensureTickerFontLoaded()
      } catch (error) {
        console.error("[ticker] failed to load MSDF font", error)
        return
      }
    }

    if (this.isDestroyed || this.rendererInitVersion !== initVersion) {
      return
    }

    this.renderer?.destroy()
    this.renderer = createTickerRenderer(this.mountEl, normalizedRendererMode)
    this.currentRendererMode = normalizedRendererMode

    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const selfClient = TickerClients.findOne({ _id: this.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    const rowState = findRowState(wall, selfClient?.rowIndex)
    this.renderer.setDisplayMode(wall?.displayMode)
    this.renderer.setTextFill(wall?.specialMode === TICKER_SPECIAL_MODE_BARTHES ? FONT_FILL_BARTHES : FONT_FILL_DEFAULT)
    this.renderer.setTextRenderHeight(selfClient?.stackHeight ?? wall?.minClientHeight)
    this.renderer.setSliceXStart(selfClient?.xStart ?? 0)
    this.renderer.setSliceYStart(selfClient?.yStart ?? 0)
    this.renderer.setServerOffset(this.offsetMs)
    if (rowState?.playing) {
      this.renderer.setPlaying(rowState.playing)
    } else {
      this.renderer.clearPlaying()
    }
  }

  ;(async () => {
    if (this.isDestroyed) {
      return
    }

    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    await this.initializeRenderer(wall?.rendererMode)

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

    Meteor.callAsync("ticker.join", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: this.clientId,
      deviceKey: this.deviceKey,
      shortCode: this.shortCode,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      userAgent: navigator.userAgent,
    })

    this.heartbeatIntervalId = Meteor.setInterval(() => {
      Meteor.callAsync("ticker.heartbeat", {
        wallId: DEFAULT_TICKER_WALL_ID,
        clientId: this.clientId,
      })
    }, TICKER_HEARTBEAT_MS)

    this.handleResize = () => {
      this.renderer?.resize()
      Meteor.clearTimeout(this.resizeTimeout)
      this.resizeTimeout = Meteor.setTimeout(() => {
        Meteor.callAsync("ticker.updateSize", {
          wallId: DEFAULT_TICKER_WALL_ID,
          clientId: this.clientId,
          width: window.innerWidth,
          height: window.innerHeight,
        })
      }, 120)
    }

    window.addEventListener("resize", this.handleResize)

    this.refreshHandler = (payload) => {
      if (payload?.wallId && payload.wallId !== DEFAULT_TICKER_WALL_ID) {
        return
      }

      window.location.reload()
    }

  streamer.on(TICKER_REFRESH_EVENT, this.refreshHandler)

    this.routeControlHandler = (payload) => {
      const target = payload?.target
      if (target !== "video" && target !== "television") {
        return
      }

      FlowRouter.go(`/${target}`)
    }

    streamer.on(TICKER_ROUTE_CONTROL_EVENT, this.routeControlHandler)
  })()

  this.autorun(() => {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const selfClient = TickerClients.findOne({ _id: this.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    const rowState = findRowState(wall, selfClient?.rowIndex)
    const nextRendererMode = normalizeRendererMode(wall?.rendererMode)
    if (nextRendererMode !== this.currentRendererMode) {
      this.initializeRenderer?.(nextRendererMode)
      return
    }
    this.renderer?.setDisplayMode(wall?.displayMode)
    this.renderer?.setTextFill(wall?.specialMode === TICKER_SPECIAL_MODE_BARTHES ? FONT_FILL_BARTHES : FONT_FILL_DEFAULT)
    if (!rowState?.playing) {
      this.renderer?.clearPlaying()
      return
    }

    this.renderer?.setPlaying(rowState.playing)
  })

  this.autorun(() => {
    const selfClient = TickerClients.findOne({ _id: this.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    this.renderer?.setTextRenderHeight(selfClient?.stackHeight ?? TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })?.minClientHeight)
    this.renderer?.setSliceXStart(selfClient?.xStart ?? 0)
    this.renderer?.setSliceYStart(selfClient?.yStart ?? 0)
  })
})

Template.TickerPage.onDestroyed(function onDestroyed() {
  this.isDestroyed = true
  window.removeEventListener("resize", this.handleResize)
  Meteor.clearTimeout(this.resizeTimeout)
  if (this.timeSyncIntervalId) {
    Meteor.clearInterval(this.timeSyncIntervalId)
  }
  if (this.heartbeatIntervalId) {
    Meteor.clearInterval(this.heartbeatIntervalId)
  }
  if (this.refreshHandler) {
    streamer.removeListener(TICKER_REFRESH_EVENT, this.refreshHandler)
    this.refreshHandler = null
  }
  if (this.routeControlHandler) {
    streamer.removeListener(TICKER_ROUTE_CONTROL_EVENT, this.routeControlHandler)
    this.routeControlHandler = null
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
  rowIndex() {
    const instance = Template.instance()
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    return Number.isInteger(doc?.rowIndex) ? doc.rowIndex : "-"
  },
  rowStateLabel() {
    const instance = Template.instance()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    return findRowState(wall, doc?.rowIndex)?.state ?? "idle"
  },
  queueMachineState() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.machineState ?? "idle"
  },
  queuedCount() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.queueState?.queuedCount ?? 0
  },
  showDebug() {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.showDebug !== false
  },
  isHighlighted() {
    const instance = Template.instance()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    return wall?.highlightClientId === instance.clientId
  },
  isProvisioningMode() {
    const instance = Template.instance()
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    return Boolean(wall?.provisioningEnabled) && !Number.isInteger(doc?.slotIndex)
  },
})

Template.TickerPage.events({
  "click main"(event, instance) {
    const wall = TickerWalls.findOne({ _id: DEFAULT_TICKER_WALL_ID })
    const doc = TickerClients.findOne({ _id: instance.clientId, wallId: DEFAULT_TICKER_WALL_ID })
    if (!wall?.provisioningEnabled || Number.isInteger(doc?.slotIndex)) {
      return
    }

    Meteor.callAsync("ticker.claimNextSlot", {
      wallId: DEFAULT_TICKER_WALL_ID,
      clientId: instance.clientId,
    })
  },
})
